/**
 * Local AI experiments deliberately live outside Electron's privileged process.
 * A project chooses its own source folders; indexes stay in a user cache rather
 * than appearing in git or silently becoming part of a shared demo. The HTTP
 * boundary accepts literal loopback addresses only, even after redirects, so a
 * config change cannot turn a local search into an upload to a hosted service.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const exec = promisify(execFile)
export const installHome = process.env.WORKBENCH_AI_HOME || path.join(os.homedir(), '.local', 'share', 'workbench-ai')
export const cacheHome = process.env.WORKBENCH_AI_CACHE || path.join(os.homedir(), '.cache', 'workbench-ai')
export const defaults = {
  version: 1, include: ['README.md', 'docs', 'src'], exclude: [],
  extensions: ['.md', '.markdown', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.css'],
  respectGitIgnore: true, maxFileBytes: 524288, maxChunks: 5000, chunkChars: 1800,
  ollamaUrl: 'http://127.0.0.1:11435', embeddingModel: 'qwen3-embedding:0.6b', chatModel: 'qwen3.5:4b'
}
export const hash = value => crypto.createHash('sha256').update(value).digest('hex')
export const html = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const jsonForHtml = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
export const csv = rows => rows.map(row => row.map(value => {
  let s = String(value ?? '')
  // CSVs are opened in spreadsheets as well as the preview pane. Source text
  // must remain data when its first character happens to be a formula marker.
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s
  return '"' + s.replace(/"/g, '""') + '"'
}).join(',')).join('\n') + '\n'

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await fs.rename(temporary, file)
}
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')) }
export function inside(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}
export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || value.split('/').some(p => p === '..' || p === '.git') || /^[A-Za-z]:/.test(value)) throw new Error(`Expected a project-relative path: ${value}`)
  return value.replace(/\/$/, '')
}
export function localUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Ollama URL must be plain HTTP on 127.0.0.1 or [::1], with no path or credentials.')
  return url.origin
}
export async function configuration(root, file) {
  root = await fs.realpath(root)
  const config = { ...defaults, ...(file ? await readJson(path.resolve(file)) : {}) }
  if (config.version !== 1) throw new Error('Unsupported configuration version')
  for (const field of ['include', 'exclude', 'extensions']) if (!Array.isArray(config[field]) || config[field].some(s => typeof s !== 'string')) throw new Error(`${field} must be an array of strings`)
  if (!config.include.length) throw new Error('Choose at least one source file or folder in include')
  config.include.forEach(relativePath); config.exclude.forEach(relativePath)
  if (typeof config.respectGitIgnore !== 'boolean') throw new Error('respectGitIgnore must be a boolean')
  for (const [key, low, high] of [['maxFileBytes', 1, 2097152], ['maxChunks', 1, 20000], ['chunkChars', 256, 4000]]) {
    if (!Number.isInteger(config[key]) || config[key] < low || config[key] > high) throw new Error(`${key} must be an integer from ${low} to ${high}`)
  }
  for (const key of ['embeddingModel', 'chatModel']) if (typeof config[key] !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{0,150}$/i.test(config[key]) || /cloud/i.test(config[key])) throw new Error(`Invalid local ${key}`)
  config.ollamaUrl = localUrl(config.ollamaUrl)
  const cache = path.join(cacheHome, hash(root).slice(0, 20))
  return { root, config, cache, indexFile: path.join(cache, 'index.json') }
}
export async function api(config, endpoint, payload, timeout = 120000) {
  const response = await fetch(localUrl(config.ollamaUrl) + endpoint, {
    method: payload === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(timeout)
  }).catch(error => { throw new Error(`Local Ollama request failed (${config.ollamaUrl}): ${error.message}. Run the serve command first.`) })
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 600)}`)
  const result = await response.json()
  if (result.error) throw new Error(`Ollama: ${result.error}`)
  return result
}
export async function modelIdentity(config, name) {
  const models = (await api(config, '/api/tags')).models || []
  const model = models.find(m => m.name === name || m.model === name || m.name === name + ':latest')
  if (!model?.digest) throw new Error(`Model ${name} is not installed. Run the models command.`)
  return { name: model.name, digest: model.digest, size: model.size, details: model.details }
}
export function validVector(v, dimension) {
  return Array.isArray(v) && v.length > 0 && (!dimension || v.length === dimension) && v.every(Number.isFinite) && v.some(n => n !== 0)
}
export async function embed(config, input) {
  const result = await api(config, '/api/embed', { model: config.embeddingModel, input, truncate: false, keep_alive: '10m' })
  if (!Array.isArray(result.embeddings) || result.embeddings.length !== input.length || result.embeddings.some(v => !validVector(v, result.embeddings[0]?.length))) throw new Error('Embedding response has missing or invalid vectors')
  return result.embeddings
}
export async function outputDir(value) {
  const dir = path.resolve(value)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}
