#!/usr/bin/env node
/**
 * A command can be used by a person or either existing Workbench assistant.
 * Output documents use the existing preview pane. --json is for agent calls;
 * normal output stays short and reports where the complete evidence was saved.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { configuration, readJson, outputDir } from './ai/core.mjs'
import { buildIndex, search, searchMarkdown, sourceFiles, chunksFor } from './ai/search.mjs'
import { doctor, setup, serve, pullModels, ingest } from './ai/runtime.mjs'
import { runBench, exportPrompts, compareBench, evaluateSearch } from './ai/bench.mjs'
import { makeDemo, makeFixturePdf, checkIntake } from './ai/demo.mjs'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const help = `Workbench local AI prototype

  node scripts/ai.mjs doctor
  node scripts/ai.mjs setup
  node scripts/ai.mjs serve                    Keep running in a terminal
  node scripts/ai.mjs models                   Download two local models
  node scripts/ai.mjs index --dry-run          Review selected source counts
  node scripts/ai.mjs index                    Build / refresh project index
  node scripts/ai.mjs search "your question"   Search with source lines
  node scripts/ai.mjs ingest file.pdf --out artifacts/intake/run-1
  node scripts/ai.mjs eval-search             Compare three retrieval methods
  node scripts/ai.mjs eval-models             Run 20 bounded local model tasks
  node scripts/ai.mjs baseline-prompts        Export prompts for your assistant
  node scripts/ai.mjs compare --local run.json --baseline reference.json
  node scripts/ai.mjs demo                    Build sample-data demo package
  node scripts/ai.mjs fixture-pdf             Generate 20-page test specimen
  node scripts/ai.mjs check-intake --input artifacts/intake/run-1
  node scripts/ai.mjs catalog                 Show curated model/dataset sources

Options:
  --root PATH --config FILE   Select a project and reviewed source folders
  --out PATH                 Report folder (or Markdown file for search)
  --mode hybrid|semantic|lexical --limit 5
  --lexical-only             Index without a model; search with --mode lexical
  --ocr --offline --max-pages 200   PDF conversion options
  --suite FILE               Alternative search or model evaluation dataset
  --json                     Machine-readable output
Default project: current folder; default config: ai/workbench.config.json if present.
No paid services or public hosting are used. Native Windows: run inside WSL.
`

async function main() {
  const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' },
    mode: { type: 'string', default: 'hybrid' }, limit: { type: 'string', default: '5' },
    suite: { type: 'string' }, local: { type: 'string' }, baseline: { type: 'string' }, input: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    'lexical-only': { type: 'boolean' }, ocr: { type: 'boolean' }, offline: { type: 'boolean' }, 'max-pages': { type: 'string', default: '200' }
  } })
  const [command, ...args] = positionals
  if (!command || opts.help || command === 'help') { console.log(help); return }
  if (process.platform === 'win32') throw new Error('Run this command inside your Ubuntu/WSL project terminal')
  const root = path.resolve(opts.root || '.')
  let configFile = opts.config
  if (!configFile) {
    const candidate = path.join(root, 'ai', 'workbench.config.json')
    try { await fs.access(candidate); configFile = candidate } catch {}
  }
  const ctx = await configuration(root, configFile)
  let lastProgress = 0
  const progress = info => {
    if (Date.now() - lastProgress > 15000 || typeof info === 'string') {
      console.error(typeof info === 'string' ? info : JSON.stringify(info)); lastProgress = Date.now()
    }
  }
  const defaultOut = path.join(root, 'artifacts', 'ai', command + '-' + new Date().toISOString().replace(/[:.]/g, '-'))
  let result
  switch (command) {
    case 'doctor': result = await doctor(ctx); break
    case 'setup': result = await setup(progress); break
    case 'serve': await serve(ctx); return
    case 'models': result = await pullModels(ctx, progress); break
    case 'index':
      if (opts['dry-run']) {
        const { documents, skipped } = await sourceFiles(ctx)
        result = { files: documents.length, chunks: documents.flatMap(d => chunksFor(d, ctx.config.chunkChars)).length, bytes: documents.reduce((n, d) => n + d.bytes, 0), selected: documents.map(d => d.file), skipped, noInference: true }
      } else result = await buildIndex(ctx, { lexicalOnly: opts['lexical-only'], progress })
      break
    case 'search':
      result = await search(ctx, args.join(' '), { mode: opts.mode, limit: Number(opts.limit) })
      if (opts.out) { await fs.mkdir(path.dirname(path.resolve(opts.out)), { recursive: true }); await fs.writeFile(path.resolve(opts.out), searchMarkdown(result)) }
      if (!opts.json) {
        console.log(result.hits.map((h, i) => (i + 1) + '. ' + h.citation + '\n   ' + h.text.replace(/\s+/g, ' ').slice(0, 180)).join('\n') || 'No current sources matched.')
        console.log(result.mode + ' · ' + result.durationMs + ' ms' + (opts.out ? ' · ' + path.resolve(opts.out) : ''))
        if (result.stale.length) console.log('Changed sources excluded; run index to refresh.')
        return
      }
      break
    case 'ingest': {
      const out = opts.out || defaultOut
      const manifest = await ingest(args[0], out, { ocr: opts.ocr, offline: opts.offline, maxPages: Number(opts['max-pages']) })
      result = { pages: manifest.pageCount, seconds: manifest.durationSeconds, status: manifest.status, output: path.resolve(out) }; break
    }
    case 'eval-search':
      result = await evaluateSearch(ctx, await readJson(opts.suite || path.join(repo, 'ai/evals/search-questions.json')), await outputDir(opts.out || defaultOut), progress); break
    case 'eval-models': {
      const run = await runBench(ctx, await readJson(opts.suite || path.join(repo, 'ai/evals/model-tasks.json')), await outputDir(opts.out || defaultOut), progress)
      result = { model: run.model.name, ...run.summary, output: path.resolve(opts.out || defaultOut), baseline: 'pending' }; break
    }
    case 'baseline-prompts':
      result = await exportPrompts(await readJson(opts.suite || path.join(repo, 'ai/evals/model-tasks.json')), await outputDir(opts.out || defaultOut)); break
    case 'compare':
      if (!opts.local || !opts.baseline) throw new Error('Provide --local and --baseline result files')
      result = await compareBench(await readJson(opts.suite || path.join(repo, 'ai/evals/model-tasks.json')), await readJson(opts.local), await readJson(opts.baseline), await outputDir(opts.out || defaultOut)); break
    case 'demo':
      result = await makeDemo(repo, await outputDir(opts.out || defaultOut), { lexicalOnly: opts['lexical-only'], progress }); break
    case 'fixture-pdf':
      result = await makeFixturePdf(await outputDir(opts.out || defaultOut)); break
    case 'check-intake':
      if (!opts.input) throw new Error('Provide the conversion folder with --input')
      result = await checkIntake(path.resolve(opts.input), await outputDir(opts.out || defaultOut)); break
    case 'catalog':
      result = await readJson(path.join(repo, 'ai/catalog.json')); break
    default: throw new Error('Unknown command: ' + command + '. Run --help.')
  }
  if (opts.json) console.log(JSON.stringify(result, null, 2))
  else if (command === 'doctor') {
    console.log((result.ready ? 'Local AI ready' : 'Setup incomplete') + '\nOllama: ' + (result.service || 'not running') + ' · Docling: ' + (result.docling || 'not installed'))
    console.log('Models: ' + (result.models.map(m => m.name).join(', ') || 'none'))
    console.log('Endpoint: ' + result.ollamaUrl)
  } else if (command === 'index') {
    console.log(result.files + ' files · ' + result.chunks + ' chunks · ' + result.skipped.length + ' skipped')
    console.log(opts['dry-run'] ? 'Preview only; use --json for the selected filenames.' : result.embedded + ' embedded · ' + result.reused + ' reused · ' + result.durationMs + ' ms')
  } else if (command === 'eval-search') {
    for (const row of result.summary) console.log(row.mode + ': ' + row.hits + '/' + row.questions + ' sources in top five · median ' + row.medianMs + ' ms')
    console.log('Reports: ' + result.output)
  } else if (command === 'catalog') {
    for (const model of result.models) console.log(model.name + ' — ' + model.use)
    console.log('Datasets: ' + result.datasets.map(d => d.name).join(', '))
    console.log('Plan: Hugging Face Free. Use --json for source links, licenses, and revision details.')
  }
  else {
    const summary = { ...result }
    if (summary.selected) summary.selected = summary.selected.length + ' paths (use --json to review)'
    if (summary.skipped) summary.skipped = summary.skipped.length + ' files'
    console.log(JSON.stringify(summary, null, 2))
  }
}
main().catch(error => { console.error('AI: ' + error.message); process.exitCode = 1 })
