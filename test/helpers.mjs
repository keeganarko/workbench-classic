/** Shared fixtures: temp directories, a fake tmux, and canned persisted state. */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const roots = []

/** A throwaway directory removed when the test file exits. */
export function tempDir(prefix = 'term-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of roots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the OS will get it */
    }
  }
})

/**
 * A tmux double.
 *
 * Records every call so tests can assert on the argv a relaunch actually used,
 * and lets individual methods be made to fail — which is the only way to
 * exercise partial fan-out failure without killing a real pane mid-test.
 */
export function fakeTmux(options = {}) {
  const live = new Set(options.live ?? [])
  const calls = []
  const record = (name, args) => calls.push({ name, args })

  return {
    calls,
    live,
    binary: '/usr/bin/tmux',
    /** Set to a function returning an Error to make submitPrompt fail for a name. */
    submitPromptFailure: options.submitPromptFailure ?? (() => null),
    paneInfoFor: options.paneInfoFor ?? (() => null),
    captureTailText: options.captureTailText ?? '',

    writeConfig(scrollback) {
      record('writeConfig', [scrollback])
    },
    async ensureServer() {
      record('ensureServer', [])
    },
    async listSessionNames() {
      record('listSessionNames', [])
      return [...live]
    },
    async hasSession(name) {
      record('hasSession', [name])
      return live.has(name)
    },
    async createSession(opts) {
      record('createSession', [opts])
      live.add(opts.name)
    },
    async killSession(name) {
      record('killSession', [name])
      live.delete(name)
    },
    async startPipePane(name, logPath) {
      record('startPipePane', [name, logPath])
    },
    async stopPipePane(name) {
      record('stopPipePane', [name])
    },
    async paneInfo(name) {
      record('paneInfo', [name])
      return this.paneInfoFor(name)
    },
    async allPaneInfo() {
      record('allPaneInfo', [])
      const map = new Map()
      for (const name of live) {
        const info = this.paneInfoFor(name)
        if (info) map.set(name, info)
      }
      return map
    },
    async capturePane(name) {
      record('capturePane', [name])
      return this.captureTailText
    },
    async captureTail(name) {
      record('captureTail', [name])
      return this.captureTailText
    },
    async sendText(name, text) {
      record('sendText', [name, text])
    },
    async sendKeys(name, keys) {
      record('sendKeys', [name, keys])
    },
    async submitPrompt(name, text) {
      record('submitPrompt', [name, text])
      const err = this.submitPromptFailure(name)
      if (err) throw err
    },
    async resize(name, cols, rows) {
      record('resize', [name, cols, rows])
    },
    async respawn(name, command, cwd) {
      record('respawn', [name, command, cwd])
    },
    attachCommandFor(name) {
      return `tmux -L terminal attach -t ${name}`
    }
  }
}

/** One persisted session, current-schema, with only the interesting bits set. */
export function persistedSession(patch = {}) {
  const now = Date.now()
  const id = patch.id ?? 'aaa'
  return {
    id,
    title: `session ${id}`,
    agent: 'claude',
    cwd: '/tmp',
    status: 'idle',
    tmuxName: `term_${id}`,
    createdAt: now,
    lastActivityAt: now,
    lastStatusChangeAt: now,
    lastEventAt: null,
    lastSeenAt: null,
    statusSource: 'system',
    statusReason: null,
    parentId: null,
    rootId: id,
    forkKind: 'root',
    depth: 0,
    agentSessionId: null,
    lastMessage: null,
    alive: true,
    exitCode: null,
    pinned: false,
    color: '#d97757',
    badge: null,
    ...patch
  }
}

/** One persisted launch descriptor at the current version. */
export function persistedDescriptor(patch = {}) {
  const sessionId = patch.sessionId ?? 'aaa'
  return {
    version: 1,
    sessionId,
    profileId: 'claude',
    command: '/usr/local/bin/claude',
    baseArgs: ['--settings', '/tmp/claude-settings.json'],
    launchArgs: ['--session-id', 'uuid-1'],
    extraArgs: [],
    env: {},
    cwd: '/tmp',
    workspaceId: null,
    agentSessionId: null,
    origin: 'new',
    model: null,
    effort: null,
    permissionMode: 'default',
    transcriptPath: null,
    lifecycleLogPath: null,
    cliVersion: null,
    createdAt: Date.now(),
    ...patch
  }
}

/**
 * Writes a Claude transcript so `findClaudeTranscript(sessionId, home)` resolves.
 * The project directory name is cosmetic — the lookup scans every project dir.
 */
export function seedClaudeTranscript(home, sessionId, { cwd = '/tmp' } = {}) {
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ type: 'summary', sessionId }) + '\n', 'utf8')
  return file
}

/**
 * Writes a Codex rollout so `findCodexRolloutBySessionId(sessionId, home)`
 * resolves. The id is carried in the header, since a non-UUID id (like the
 * fixtures') is not recoverable from the filename.
 */
export function seedCodexRollout(home, sessionId, { cwd = '/tmp', at = Date.now() } = {}) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '03')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-09-03T00-00-00-${sessionId}.jsonl`)
  const header = { payload: { session_id: sessionId, cwd, timestamp: new Date(at).toISOString() } }
  fs.writeFileSync(file, JSON.stringify(header) + '\n', 'utf8')
  return file
}

/** Writes a full state document into `dir` the way the app would have. */
export function writeState(dir, { sessions = [], descriptors = [], prefs = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'workbench.json'),
    JSON.stringify({ version: 2, prefs, sessions, descriptors, tabs: [], activeTabId: null }),
    'utf8'
  )
}

/** Lets pending promise callbacks (an awaited tmux round-trip) run. */
export async function flush(times = 3) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r))
}
