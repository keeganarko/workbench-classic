/**
 * Small indexes use exact cosine search so there is no database to operate and
 * no approximate-retrieval parameter hiding evaluation mistakes. Incremental
 * reuse is keyed by both source content and the installed model digest. Line
 * citations are checked against the current file before they are returned.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { exec, hash, inside, relativePath, embed, modelIdentity, readJson, writeJson } from './core.mjs'

const deniedSegments = /^(?:\..*|node_modules|vendor|dist|out|release|coverage|vault|artifacts|__pycache__|credentials?|secrets?)$/i
const deniedName = /(?:^|[._-])(?:secret|credentials?|private[-_]?key|token)(?:[._-]|$)|\.(?:pem|key|p12|pfx|kdbx)$|^id_(?:rsa|ed25519)$/i
const secretContent = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:hf_[A-Za-z0-9]{25,}|gh[pousr]_[A-Za-z0-9]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/
const beneath = (file, prefix) => prefix === '.' || file === prefix || file.startsWith(prefix + '/')

export function allowed(file, config) {
  try { relativePath(file) } catch { return false }
  if (file.split('/').some(s => deniedSegments.test(s)) || deniedName.test(path.posix.basename(file))) return false
  return config.include.some(p => beneath(file, p)) && !config.exclude.some(p => beneath(file, p)) && config.extensions.includes(path.posix.extname(file).toLowerCase())
}
async function plainFiles(root, config) {
  const found = new Set()
  async function visit(rel) {
    if (found.size > 20000) throw new Error('File scan exceeds 20,000 files; narrow include')
    const parts = rel.split('/').filter(p => p !== '.')
    if (parts.some(p => deniedSegments.test(p)) || config.exclude.some(p => beneath(rel, p))) return
    const stat = await fs.lstat(path.join(root, rel)).catch(e => { if (e.code === 'ENOENT') return null; throw e })
    if (!stat || stat.isSymbolicLink()) return
    if (stat.isFile()) { found.add(rel.replace(/^\.\//, '')); return }
    if (stat.isDirectory()) for (const entry of await fs.readdir(path.join(root, rel))) await visit(path.posix.join(rel, entry))
  }
  for (const include of config.include) await visit(include)
  return [...found]
}
export async function sourceFiles(ctx) {
  let files
  if (ctx.config.respectGitIgnore) {
    try {
      const result = await exec('git', ['-C', ctx.root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { maxBuffer: 8 * 1024 * 1024 })
      files = [...new Set(result.stdout.split('\0').filter(Boolean))]
    } catch { throw new Error('Source scan requires a Git project. For a reviewed, standalone folder set respectGitIgnore to false explicitly.') }
  } else files = await plainFiles(ctx.root, ctx.config)
  if (ctx.config.respectGitIgnore) {
    // ls-files applies ignore rules to untracked files only. A once-committed
    // file can later become private, so apply the current rules to tracked
    // paths as well, without changing the project's index or working tree.
    const candidates = files.filter(f => allowed(f, ctx.config)), ignored = new Set()
    for (let i = 0; i < candidates.length; i += 128) {
      let stdout
      try {
        const pending = exec('git', ['-C', ctx.root, 'check-ignore', '--no-index', '-z', '--stdin'], { maxBuffer: 1024 * 1024 })
        pending.child.stdin.end(candidates.slice(i, i + 128).join('\0') + '\0')
        ;({ stdout } = await pending)
      }
      catch (error) { if (error.code !== 1) throw error; stdout = error.stdout || '' }
      stdout.split('\0').filter(Boolean).forEach(f => ignored.add(f))
    }
    files = files.filter(f => !ignored.has(f))
  }
  const documents = [], skipped = []
  for (const file of files.filter(f => allowed(f, ctx.config)).sort()) {
    const full = path.join(ctx.root, file)
    try {
      // lstat on every component also rejects links pointing elsewhere inside
      // the project: the allowed folder list describes real sources, not aliases.
      let current = ctx.root, linked = false
      for (const part of file.split('/')) { current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) { linked = true; break } }
      if (linked || !inside(ctx.root, await fs.realpath(full))) { skipped.push({ file, reason: 'symlink' }); continue }
      const stat = await fs.stat(full)
      if (!stat.isFile() || stat.size > ctx.config.maxFileBytes) { skipped.push({ file, reason: 'size or type' }); continue }
      const text = await fs.readFile(full, 'utf8')
      if (text.includes('\0') || secretContent.test(text)) { skipped.push({ file, reason: 'binary or credential pattern' }); continue }
      documents.push({ file, text, hash: hash(text), bytes: stat.size })
    } catch (error) { if (error.code !== 'ENOENT') throw error; skipped.push({ file, reason: 'removed during scan' }) }
  }
  return { documents, skipped }
}
export function chunksFor(document, maxChars = 1800) {
  const lines = document.text.split(/\r?\n/), result = []
  let start = 0
  while (start < lines.length) {
    let end = start, length = 0
    while (end < lines.length && length + lines[end].length + 1 <= maxChars) { length += lines[end].length + 1; end++ }
    if (end === start) {
      // Minified or unusually long source lines need several bounded pieces;
      // all pieces correctly cite that same line rather than inventing offsets.
      for (let offset = 0; offset < lines[start].length; offset += maxChars) {
        const text = lines[start].slice(offset, offset + maxChars)
        result.push({ file: document.file, start: start + 1, end: start + 1, text, sourceHash: document.hash })
      }
      start++; continue
    }
    const text = lines.slice(start, end).join('\n')
    if (text.trim()) result.push({ file: document.file, start: start + 1, end, text, sourceHash: document.hash })
    if (end === lines.length) break
    start = Math.max(start + 1, end - 3)
  }
  return result.map(c => ({ ...c, id: hash(JSON.stringify([c.file, c.start, c.end, c.text])) }))
}
export async function buildIndex(ctx, { lexicalOnly = false, progress = () => {} } = {}) {
  const begin = performance.now()
  const { documents, skipped } = await sourceFiles(ctx)
  const chunks = documents.flatMap(d => chunksFor(d, ctx.config.chunkChars))
  if (!chunks.length) throw new Error('No permitted source text found; check include and extensions')
  if (chunks.length > ctx.config.maxChunks) throw new Error(`${chunks.length} chunks exceed the ${ctx.config.maxChunks} limit. Narrow include or explicitly raise maxChunks.`)
  const identity = lexicalOnly ? null : await modelIdentity(ctx.config, ctx.config.embeddingModel)
  const old = await readJson(ctx.indexFile).catch(() => null)
  const reusable = old?.version === 1 && old.root === ctx.root && old.model?.digest === identity?.digest ? new Map(old.chunks.map(c => [c.id, c.vector])) : new Map()
  let embedded = 0, reused = 0
  if (identity) {
    const pending = []
    for (const chunk of chunks) {
      const vector = reusable.get(chunk.id)
      if (vector) { chunk.vector = vector; reused++ } else pending.push(chunk)
    }
    for (let i = 0; i < pending.length; i += 12) {
      const batch = pending.slice(i, i + 12)
      const vectors = await embed(ctx.config, batch.map(c => `File: ${c.file}\n${c.text}`))
      batch.forEach((c, j) => { c.vector = vectors[j] })
      embedded += batch.length; progress({ embedded, reused, total: chunks.length })
    }
  }
  const index = { version: 1, root: ctx.root, createdAt: new Date().toISOString(), model: identity,
    selection: { include: ctx.config.include, exclude: ctx.config.exclude },
    documents: documents.map(({ file, hash, bytes }) => ({ file, hash, bytes })), chunks, skipped,
    stats: { files: documents.length, chunks: chunks.length, embedded, reused, durationMs: Math.round(performance.now() - begin) } }
  await writeJson(ctx.indexFile, index)
  return { ...index.stats, skipped, model: identity, indexFile: ctx.indexFile }
}
const stop = new Set('a an the is are was were do does how what where when why which can i we you our my to for of and or in on with it this that from be by'.split(' '))
export function tokens(text) {
  return (text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter(t => !stop.has(t))
}
export function cosine(a, b) {
  if (a.length !== b.length) throw new Error('Embedding dimensions differ; rebuild the index')
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2 }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}
export function lexicalRank(chunks, query) {
  const terms = [...new Set(tokens(query))]
  const docs = chunks.map(c => tokens(c.file + ' ' + c.text))
  const avg = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1)
  const df = new Map(terms.map(t => [t, docs.filter(d => d.includes(t)).length]))
  return chunks.map((chunk, i) => {
    let score = 0
    for (const term of terms) {
      const tf = docs[i].filter(t => t === term).length
      if (tf) score += Math.log(1 + (chunks.length - df.get(term) + 0.5) / (df.get(term) + 0.5)) * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * docs[i].length / (avg || 1)))
    }
    return { chunk, score }
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
}
export function rankChunks(index, query, mode, vector) {
  const lexical = lexicalRank(index.chunks, query)
  if (mode === 'lexical') return lexical
  const semantic = index.chunks.map(chunk => ({ chunk, score: cosine(chunk.vector, vector) })).sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
  if (mode === 'semantic') return semantic
  // Reciprocal-rank fusion keeps BM25 magnitudes and cosine values separate;
  // scores are ranking signals, never a probability that a source is correct.
  const scores = new Map()
  for (const ranking of [lexical, semantic]) ranking.slice(0, 100).forEach((r, i) => {
    const old = scores.get(r.chunk.id) || { chunk: r.chunk, score: 0 }
    old.score += 1 / (60 + i + 1); scores.set(r.chunk.id, old)
  })
  return [...scores.values()].sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
}
export async function search(ctx, query, { mode = 'hybrid', limit = 5, index: suppliedIndex, identityChecked = false } = {}) {
  if (!['lexical', 'semantic', 'hybrid'].includes(mode)) throw new Error('Search mode must be lexical, semantic, or hybrid')
  if (!query?.trim() || query.length > 2000) throw new Error('Query must contain 1–2000 characters')
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be between 1 and 20')
  const begin = performance.now()
  const index = suppliedIndex || await readJson(ctx.indexFile).catch(() => { throw new Error('No project index. Run index first (or index --lexical-only for keyword search).') })
  if (index.version !== 1 || index.root !== ctx.root) throw new Error('Index does not match this project; rebuild it')
  let vector
  if (mode !== 'lexical') {
    if (!index.model) throw new Error('This index contains keywords only. Rebuild without --lexical-only.')
    if (!identityChecked && index.model.digest !== (await modelIdentity(ctx.config, ctx.config.embeddingModel)).digest) throw new Error('Embedding model changed. Rebuild the index before searching.')
    ;[vector] = await embed(ctx.config, [`Instruct: Given a question about this project, retrieve relevant source passages.\nQuery: ${query}`])
  }
  const ranked = rankChunks(index, query, mode, vector), hits = [], stale = [], seen = new Set(), checked = new Map()
  for (const { chunk, score } of ranked) {
    if (seen.has(chunk.file) || !allowed(chunk.file, ctx.config)) continue
    if (!checked.has(chunk.file)) {
      let same = false
      try {
        const full = path.join(ctx.root, chunk.file)
        const real = await fs.realpath(full)
        same = inside(ctx.root, real) && real === full && hash(await fs.readFile(full, 'utf8')) === chunk.sourceHash
      } catch { /* Deleted and moved files require a rebuild just like edits. */ }
      checked.set(chunk.file, same)
    }
    if (!checked.get(chunk.file)) { if (!stale.includes(chunk.file)) stale.push(chunk.file); continue }
    seen.add(chunk.file)
    hits.push({ file: chunk.file, start: chunk.start, end: chunk.end, text: chunk.text, score, citation: `${chunk.file}:${chunk.start}`, sourceHash: chunk.sourceHash })
    if (hits.length >= limit) break
  }
  return { query, mode, hits, stale, durationMs: Math.round(performance.now() - begin), indexedAt: index.createdAt, model: mode === 'lexical' ? null : index.model }
}
export function searchMarkdown(result) {
  return `# Project search\n\n${result.query}\n\nMode: ${result.mode}. ${result.durationMs} ms. Scores indicate rank, not confidence.\n\n` + result.hits.map((h, i) => `## ${i + 1}. ${h.citation}\n\nLines ${h.start}–${h.end}.\n\n${h.text.split('\n').map(l => '> ' + l).join('\n')}\n`).join('\n') + (result.stale.length ? `\nExcluded changed sources: ${result.stale.join(', ')}. Rebuild the index.\n` : '') + (!result.hits.length ? '\nNo current sources matched.\n' : '')
}
