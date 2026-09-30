/**
 * Setup is user-local and explicit. It verifies a pinned upstream archive and
 * installs Python packages in a dedicated environment; it never needs sudo,
 * changes Electron dependencies, or registers a machine-wide background service.
 */
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream, constants } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import crypto from 'node:crypto'
import { installHome, cacheHome, api, exec, readJson, writeJson, localUrl } from './core.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export async function findCommand(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, name)
    try { await fs.access(candidate, constants.X_OK); return candidate } catch {}
  }
  return null
}
export async function ollamaBinary() {
  if (process.env.WORKBENCH_AI_OLLAMA) return process.env.WORKBENCH_AI_OLLAMA
  const installed = await readJson(path.join(installHome, 'ollama-install.json')).catch(() => null)
  if (installed?.binary) {
    try { await fs.access(installed.binary, constants.X_OK); return installed.binary } catch {}
  }
  return findCommand('ollama')
}
export const pythonBinary = () => path.join(installHome, 'docling-venv', 'bin', 'python')
export async function doctor(ctx) {
  const status = { node: process.version, platform: process.platform, root: ctx.root, cache: ctx.cache, ollamaUrl: ctx.config.ollamaUrl, ollamaBinary: await ollamaBinary(), docling: null, service: null, models: [] }
  try { status.docling = (await exec(pythonBinary(), ['-c', "import importlib.metadata; print(importlib.metadata.version('docling'))"])).stdout.trim() } catch {}
  try {
    status.service = (await api(ctx.config, '/api/version')).version
    status.models = (await api(ctx.config, '/api/tags')).models.map(m => ({ name: m.name, digest: m.digest, bytes: m.size }))
  } catch (error) { status.serviceError = error.message }
  status.ready = Boolean(status.docling && status.models.some(m => m.name === ctx.config.embeddingModel) && status.models.some(m => m.name === ctx.config.chatModel))
  return status
}
export function child(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: 'inherit', ...options })
    process.once('error', reject)
    process.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(path.basename(command) + ' exited with ' + (signal || code))))
  })
}
export async function setup(progress = () => {}) {
  if (process.platform === 'win32') throw new Error('Run these tools inside the Ubuntu/WSL project terminal on Windows')
  let binary = await ollamaBinary()
  await fs.mkdir(installHome, { recursive: true, mode: 0o700 })
  if (!binary) {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Install Ollama for this platform first (on macOS: brew install ollama), then rerun setup')
    const version = '0.33.3', digest = 'c13cea8f3389db4145f8a6cb88d1747242a48639d7c13e3bda7c1ebdc6eebb2f'
    const url = 'https://github.com/ollama/ollama/releases/download/v' + version + '/ollama-linux-amd64.tar.zst'
    const archive = path.join(installHome, 'ollama-v' + version + '.tar.zst')
    const dest = path.join(installHome, 'ollama-v' + version)
    progress('Downloading verified Ollama archive (1.43 GB)')
    const response = await fetch(url, { signal: AbortSignal.timeout(1200000) })
    if (!response.ok || !response.body) throw new Error('Ollama download failed: ' + response.status)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { mode: 0o600 }))
    const sha = crypto.createHash('sha256')
    for await (const chunk of createReadStream(archive)) sha.update(chunk)
    if (sha.digest('hex') !== digest) throw new Error('Ollama checksum mismatch; archive was not extracted')
    await fs.mkdir(dest, { recursive: true })
    const tar = spawn('tar', ['-xf', '-', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] })
    let errorText = ''
    tar.stderr.on('data', data => { errorText += data.toString().slice(0, 1000) })
    const completion = new Promise((resolve, reject) => {
      tar.once('error', reject)
      tar.once('exit', code => code === 0 ? resolve() : reject(new Error('Archive extraction failed: ' + errorText)))
    })
    await Promise.all([pipeline(createReadStream(archive), createZstdDecompress(), tar.stdin), completion])
    binary = path.join(dest, 'bin', 'ollama')
    await writeJson(path.join(installHome, 'ollama-install.json'), { version, sha256: digest, binary, source: url })
    await fs.unlink(archive)
  }
  const uv = await findCommand('uv')
  if (!uv) throw new Error('Install uv from https://docs.astral.sh/uv/getting-started/installation/ and rerun setup; Ollama installation has been preserved')
  try { await fs.access(pythonBinary()) } catch {
    progress('Creating isolated Python 3.12 environment')
    await child(uv, ['venv', '--python', '3.12', path.join(installHome, 'docling-venv')])
  }
  progress('Installing pinned Docling packages (CPU conversion)')
  // CPU wheels keep the PDF pipeline from taking GPU memory away from the local
  // assistant; Ollama independently selects CUDA or Metal for inference.
  await child(uv, ['pip', 'install', '--quiet', '--python', pythonBinary(), '--torch-backend', 'cpu', '-r', path.join(here, 'requirements.txt')])
  return { ollamaBinary: binary, python: pythonBinary(), next: 'Run serve in a project terminal, then models in another terminal.' }
}
export async function serve(ctx) {
  const binary = await ollamaBinary()
  if (!binary) throw new Error('Ollama is not installed; run setup first')
  const url = new URL(localUrl(ctx.config.ollamaUrl))
  await fs.mkdir(path.join(cacheHome, 'models'), { recursive: true, mode: 0o700 })
  await child(binary, ['serve'], { env: { ...process.env, OLLAMA_HOST: url.host, OLLAMA_NO_CLOUD: '1', OLLAMA_MODELS: path.join(cacheHome, 'models'), OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' } })
}
export async function pullModels(ctx, progress = () => {}) {
  for (const model of [ctx.config.embeddingModel, ctx.config.chatModel]) {
    progress('Pulling ' + model)
    await api(ctx.config, '/api/pull', { model, stream: false }, 1800000)
  }
  const models = (await api(ctx.config, '/api/tags')).models.map(m => ({ name: m.name, digest: m.digest, bytes: m.size }))
  await writeJson(path.join(installHome, 'models-installed.json'), { installedAt: new Date().toISOString(), models })
  return { models }
}
export async function ingest(source, out, { ocr = false, offline = false, maxPages = 200 } = {}) {
  if (!source || /^https?:/i.test(source)) throw new Error('Provide a local PDF path')
  const input = await fs.realpath(path.resolve(source))
  if (!(await fs.stat(input)).isFile() || path.extname(input).toLowerCase() !== '.pdf') throw new Error('Provide a local PDF file')
  const args = [path.join(here, 'ingest.py'), input, '--out', path.resolve(out), '--max-pages', String(maxPages)]
  if (ocr) args.push('--ocr')
  if (offline) args.push('--offline')
  await child(pythonBinary(), args, { env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' } })
  return readJson(path.join(path.resolve(out), 'manifest.json'))
}
