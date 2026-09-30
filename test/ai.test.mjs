/**
 * Local tools can read project files and create convincing-looking evidence.
 * These tests cover that boundary and the evaluation accounting, rather than
 * checking implementation details or depending on a GPU/network in CI.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { configuration, localUrl, defaults, api, jsonForHtml, csv, writeJson, readJson, hash } from '../scripts/ai/core.mjs'
import { allowed, chunksFor, sourceFiles, buildIndex, search, cosine } from '../scripts/ai/search.mjs'
import { grade, validateSuite, summarize, compareBench, exportPrompts } from '../scripts/ai/bench.mjs'
import { fixturePdf, makeFixturePdf, checkIntake, makeDemo } from '../scripts/ai/demo.mjs'

async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-ai-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}
async function context(t, files, extra = {}) {
  const root = await folder(t)
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), content)
  }
  const configFile = path.join(root, 'test-config.json')
  await writeJson(configFile, { ...defaults, include: ['docs'], respectGitIgnore: false, ...extra })
  const ctx = await configuration(root, configFile)
  ctx.cache = path.join(root, 'cache'); ctx.indexFile = path.join(ctx.cache, 'index.json')
  return ctx
}
async function server(t, handler) {
  const instance = http.createServer(handler)
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => instance.close(resolve)))
  return 'http://127.0.0.1:' + instance.address().port
}
test('local inference refuses remote URLs, credentials, redirects, and cloud models', async t => {
  for (const url of ['https://127.0.0.1', 'http://localhost', 'http://example.com', 'http://127.0.0.1@evil.test', 'http://127.0.0.1/path', 'http://127.0.0.1?token=x']) assert.throws(() => localUrl(url))
  assert.equal(localUrl('http://127.0.0.1:11435'), 'http://127.0.0.1:11435')
  const url = await server(t, (_, response) => { response.writeHead(302, { location: 'https://example.com' }); response.end() })
  await assert.rejects(() => api({ ollamaUrl: url }, '/api/tags'), /failed/)
  await assert.rejects(() => context(t, {}, { chatModel: 'qwen-cloud' }), /Invalid local/)
})
test('selection excludes links, hidden files, credentials, generated files, and current git ignores', async t => {
  const ctx = await context(t, {
    'docs/allowed.md': 'Searchable project documentation.',
    'docs/ignored.md': 'Must remain excluded even if tracked.',
    'docs/.hidden.md': 'hidden',
    'docs/credentials.md': 'secret filename',
    'docs/key-material.md': '-----BEGIN PRIVATE KEY-----',
    'docs/binary.md': 'hello\0world',
    'docs/vault/private.md': 'excluded directory',
    'docs/huge.md': 'x'.repeat(1001),
    '.gitignore': 'docs/ignored.md\n'
  }, { respectGitIgnore: true, maxFileBytes: 1000 })
  execFileSync('git', ['init', '-q', ctx.root])
  execFileSync('git', ['-C', ctx.root, 'add', '-f', 'docs/ignored.md'])
  const outside = await folder(t)
  await fs.writeFile(path.join(outside, 'external.md'), 'outside')
  // Windows requires elevated privileges for file symlinks. A directory
  // junction exercises the same escape boundary without changing machine
  // settings; POSIX hosts also cover the individual linked-file case.
  if (process.platform !== 'win32') await fs.symlink(path.join(outside, 'external.md'), path.join(ctx.root, 'docs/link.md'))
  await fs.symlink(outside, path.join(ctx.root, 'docs/linked-folder'), process.platform === 'win32' ? 'junction' : 'dir')
  const { documents, skipped } = await sourceFiles(ctx)
  assert.deepEqual(documents.map(d => d.file), ['docs/allowed.md'])
  assert(skipped.some(s => s.reason === 'symlink'))
  assert.equal(allowed('../outside.md', ctx.config), false)
  assert.equal(allowed('docs/.env.md', ctx.config), false)
})
test('chunking preserves source lines including oversized individual lines', () => {
  const text = 'First\n' + 'a'.repeat(700) + '\nLast'
  const chunks = chunksFor({ file: 'docs/a.md', text, hash: hash(text) }, 256)
  assert(chunks.every(c => c.text.length <= 256))
  assert(chunks.filter(c => c.start === 2 && c.end === 2).length >= 3)
  assert(chunks.some(c => c.text.includes('Last') && c.end === 3))
})
test('lexical search returns real source citations and excludes changed or deleted files', async t => {
  const ctx = await context(t, { 'docs/search.md': '# Index\nCitations retain the source page.', 'docs/other.md': '# Notes\nA different unrelated topic.' })
  await buildIndex(ctx, { lexicalOnly: true })
  const first = await search(ctx, 'source page citations', { mode: 'lexical' })
  assert.equal(first.hits[0].file, 'docs/search.md')
  assert.equal(first.hits[0].citation, 'docs/search.md:1')
  await fs.writeFile(path.join(ctx.root, 'docs/search.md'), 'Changed content')
  const stale = await search(ctx, 'source page citations', { mode: 'lexical' })
  assert.equal(stale.hits.length, 0)
  assert.deepEqual(stale.stale, ['docs/search.md'])
  await assert.rejects(() => search(ctx, 'question', { limit: NaN }), /limit/)
  await assert.rejects(() => search(ctx, 'question'), /keywords only/)
})
test('semantic index reuses unchanged chunks and refuses changed model revisions', async t => {
  let calls = 0, digest = 'revision-a'
  const url = await server(t, async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/tags') return response.end(JSON.stringify({ models: [{ name: defaults.embeddingModel, digest }] }))
    const buffers = []; for await (const data of request) buffers.push(data)
    const body = JSON.parse(Buffer.concat(buffers))
    assert.equal(body.truncate, false)
    calls++
    response.end(JSON.stringify({ embeddings: body.input.map(text => text.includes('cats') ? [1, 0] : [0, 1]) }))
  })
  const ctx = await context(t, { 'docs/cats.md': 'cats are quiet', 'docs/dogs.md': 'dogs are loud' }, { ollamaUrl: url })
  const first = await buildIndex(ctx)
  assert.equal(first.embedded, 2)
  const second = await buildIndex(ctx)
  assert.equal(second.reused, 2)
  assert.equal(calls, 1)
  const result = await search(ctx, 'cats', { mode: 'semantic' })
  assert.equal(result.hits[0].file, 'docs/cats.md')
  digest = 'revision-b'
  await assert.rejects(() => search(ctx, 'cats'), /model changed/)
  assert.throws(() => cosine([1, 0], [1]), /dimensions/)
})
test('benchmark grading preserves JSON types and rejects missing, duplicate, and mismatched results', async t => {
  assert.equal(grade(false, '{"answer":false}').pass, true)
  assert.equal(grade(false, '{"answer":"false"}').pass, false)
  assert.equal(grade(null, '{}').pass, false)
  assert.equal(grade(['a', 'b'], '{"answer":["b","a"]}').pass, false)
  const suite = { version: 1, tasks: [{ id: 'one', prompt: 'Return true', expected: true }] }
  assert.throws(() => validateSuite({ ...suite, tasks: [...suite.tasks, ...suite.tasks] }), /duplicate/)
  const out = await folder(t)
  await exportPrompts(suite, out)
  assert(!(await fs.readFile(path.join(out, 'baseline-prompts.md'), 'utf8')).includes('"expected"'))
  const baseline = await readJson(path.join(out, 'baseline-template.json'))
  const local = { ...baseline, provider: 'local', tasks: [{ id: 'one', content: '{"answer":true}', durationMs: 20 }] }
  await assert.rejects(() => compareBench(suite, local, baseline, out), /Identify/)
  baseline.provider = 'reference'
  await assert.rejects(() => compareBench(suite, local, baseline, out), /Missing/)
  baseline.tasks[0].content = '{"answer":false}'
  const compared = await compareBench(suite, local, baseline, out)
  assert.equal(compared.local.passed, 1)
  assert.equal(compared.baseline.passed, 0)
  assert.equal(compared.baseline.medianMs, null)
  assert.equal(summarize([{ pass: false, durationMs: 0 }]).medianMs, 0)
})
test('export escaping keeps source strings out of executable HTML and spreadsheet formulas', () => {
  assert(!jsonForHtml({ text: '</script><script>alert(1)</script>' }).includes('<'))
  assert(csv([['=1+1', '"quoted"']]).startsWith('"\'=1+1"'))
})
test('PDF fixture is deterministic and intake checking cannot score an unrelated source', async t => {
  const a = fixturePdf(), b = fixturePdf()
  assert.deepEqual(a.pdf, b.pdf)
  assert.equal(a.expected.length, 20)
  const out = await folder(t)
  await makeFixturePdf(out)
  const input = path.join(out, 'converted')
  await fs.mkdir(input)
  await writeJson(path.join(input, 'manifest.json'), { sourceSha256: 'wrong' })
  await assert.rejects(() => checkIntake(input, out), /only for the generated/)
  const pages = []
  for (const page of a.expected) {
    const markdown = 'page-' + page.page + '.md'
    await fs.writeFile(path.join(input, markdown), page.required.join(' '))
    pages.push({ page: page.page, markdown })
  }
  await writeJson(path.join(input, 'manifest.json'), { sourceSha256: hash(a.pdf), pageCount: 20, pages })
  assert.equal((await checkIntake(input, out)).passed, 20)
  await fs.writeFile(path.join(input, 'page-2.md'), 'Missing record')
  assert.equal((await checkIntake(input, out)).passed, 19)
})
test('sample demo works without a model and exports only its dedicated corpus', async t => {
  const repo = await folder(t)
  const root = path.join(repo, 'ai/fixtures/demo')
  await fs.mkdir(root, { recursive: true })
  for (const file of ['project.md', 'access.md', 'intake.md']) await fs.writeFile(path.join(root, file), '# Sample\nProject owner Mina. Source citations change. PDF intake produces Markdown. Public hosting pending.')
  const out = path.join(repo, 'demo')
  await fs.mkdir(out)
  const result = await makeDemo(repo, out, { lexicalOnly: true })
  assert.equal(result.questions, 4)
  const document = await fs.readFile(path.join(out, 'demo.html'), 'utf8')
  assert(document.includes('No live inference'))
  assert(!document.includes('fetch('))
  for (const script of document.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(script[1]))
  assert.equal((await fs.readdir(path.join(out, 'samples'))).length, 3)
})
