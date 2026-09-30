/**
 * Session Bus — the MCP server that lets one Workbench session address another.
 *
 * Delivery reuses the hook bridge wholesale: the same token-protected loopback
 * server, the same `TERMINAL_SESSION_ID` / `TERMINAL_BRIDGE_FILE` pair already
 * in every session's tmux environment, and the same ELECTRON_RUN_AS_NODE
 * re-entry, so there is no dependency on a system Node install and nothing new
 * listening on the machine.
 *
 * The guardrails are the point of the design, not a layer on top of it:
 *
 *   - Access is **off by default**, per session, and revocable at runtime. The
 *     MCP server is offered to every agent, but the bridge refuses every call
 *     from a session the user has not opted in. Baking the decision into launch
 *     argv would make it un-revocable for the life of the session.
 *   - Ordinary grants opt individual targets into reading or messaging.
 *     A project manager instead has explicit authority over one Workbench
 *     project, including its off-bus sessions. It cannot cross that boundary,
 *     grant permissions, move sessions, or pass its manager role to children.
 *     A separate App Manager grant covers this app's sessions across projects;
 *     it never silently upgrades an existing project's authority.
 *   - Every call is **written to a ledger** the user can see, refused calls
 *     included. Two agents talking each other in circles is a thing that
 *     happens, and it has to be diagnosable from the UI rather than from a log
 *     file nobody opens.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { hostCapture, hostKind, toHostPath } from './host.js'
import { asAgentKind, asString, asBusCall, isObj } from './validate.js'
import { resolveMention, slugify } from '../shared/mentions.js'
import type { BridgeRoute } from './hooks.js'
import type { RelayRequest, RelayResult } from '../shared/relay.js'
import type { Experience } from './experience.js'
import { FOCUS_IMAGE_PATH_LENGTH, FOCUS_LABEL_LENGTH, FOCUS_NEXT_LENGTH, FOCUS_SUMMARY_LENGTH, FOCUS_VALUE_LENGTH,
  FOCUS_VISUAL_ITEMS } from '../shared/focusUpdate.js'
import { projectFocus } from '../shared/focusProjects.js'
import { focusStatus, focusText } from '../shared/focusJournal.js'

import type { BusAccess, BusEntry, CreateSessionOptions, ForkOptions, Session, SessionProject } from '../shared/types.js'

/** How long a caller may block in `wait_for`, whatever it asks for. */
const MAX_WAIT_SECONDS = 600

/** Ledger depth. Enough to see a loop form; small enough to persist nothing. */
const LEDGER_CAP = 200
const PROGRESS_PROJECT_LIMIT = 8
const PROGRESS_WORKER_LIMIT = 12

const RANK: Record<BusAccess, number> = { off: 0, read: 1, full: 2, manager: 3, 'app-manager': 3 }

type ManagementScope = { kind: 'app' } | { kind: 'project'; projectId: string }

/**
 * The slice of SessionManager the bus needs. Declared structurally so tests can
 * drive the bus with a double instead of a live tmux.
 */
export interface BusSessions {
  list(): Session[]
  get(sessionId: string): Session | undefined
  captureText(sessionId: string, lines?: number): Promise<string>
  sendPrompt(sessionId: string, text: string): Promise<void>
  fork(opts: ForkOptions): Promise<Session>
  create(opts: CreateSessionOptions): Promise<Session>
  rename(sessionId: string, title: string): void
  setPinned(sessionId: string, pinned: boolean): void
  setBusAccess(sessionId: string, access: BusAccess): boolean
  kill(sessionId: string): Promise<void>
  remove(sessionId: string): Promise<void>
  restart(sessionId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  on(event: 'sessions-changed', listener: () => void): unknown
  off(event: 'sessions-changed', listener: () => void): unknown
}

export interface BusToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Keep creation and editing on the same field vocabulary. Project identity,
 * working folder and execution permissions come from the manager's grant and
 * the scheduler, never from tool arguments supplied by an agent. */
const TASK_FIELDS = {
  name: { type: 'string', description: 'Task name shown in Workbench Scheduled, up to 120 characters.' },
  prompt: { type: 'string', description: 'Self-contained instructions for a new agent conversation, up to 12000 characters. It does not inherit this conversation.' },
  agent: { type: 'string', enum: ['codex', 'claude'], description: 'Defaults to the calling agent when creating a task.' },
  cadence: { type: 'string', enum: ['daily', 'weekdays', 'weekly'] },
  time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'HH:MM in the Workbench computer\'s local time zone. Use list_scheduled_tasks to check that zone.' },
  weekday: { type: 'integer', minimum: 0, maximum: 6, description: 'Required for a weekly schedule: 0 is Sunday, 6 is Saturday.' },
  enabled: { type: 'boolean', description: 'Defaults to true for new tasks. Set false to pause a schedule.' }
}

/**
 * The tool surface, in MCP's own shape.
 *
 * Embedded verbatim into the generated server script rather than fetched from
 * the app at runtime: an agent starting while Workbench is closed must still get
 * a valid `tools/list`, or the CLI treats the whole server as broken and the
 * user sees a startup error instead of a refused call.
 */
export const BUS_TOOLS: BusToolSpec[] = [
  {
    name: 'publish_focus_update',
    description: 'Publish a short report on your own project Focus card whenever meaningful progress changes during the current turn: a discovery, design revision, verified fix, blocker or completed milestone. Publish more than once in a long turn when there are distinct useful updates; use no timer. '
      + 'Prefer a new image specific to this exact update: a screenshot, custom diagram or generated illustration, saved as PNG, JPEG, WebP or SVG inside your session folder, up to 4 MB. Include its local path and a short image description. Do not reuse generic category artwork or only change its color. Workbench preserves a copy for this report. '
      + 'Use a factual summary and optional next step. Steps or measured values are available when there is no useful image. Do not publish for routine tool calls, poll, or start another agent turn just to report. '
      + 'Reports are agent-authored claims and never change live session status or ask the user for approval. Workbench supplies your identity, project, timestamp and report ID. '
      + 'Use plain text without HTML or URLs. Requires an enabled bus, an existing project, and Read, Full, Project Manager or App Manager access.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['update', 'milestone', 'blocked', 'decision'] },
      summary: { type: 'string', minLength: 1, maxLength: FOCUS_SUMMARY_LENGTH },
      next: { type: 'string', minLength: 1, maxLength: FOCUS_NEXT_LENGTH },
      visual: { oneOf: [
        { type: 'object', properties: {
          kind: { type: 'string', enum: ['image'] },
          path: { type: 'string', minLength: 1, maxLength: FOCUS_IMAGE_PATH_LENGTH, description: 'Local PNG, JPEG, WebP or SVG inside this session’s folder. Workbench copies it for this update.' },
          alt: { type: 'string', minLength: 1, maxLength: FOCUS_SUMMARY_LENGTH, description: 'Describe the specific result shown, including useful concrete names or measured values.' }
        }, required: ['kind', 'path', 'alt'], additionalProperties: false },
        { type: 'object', properties: {
          kind: { type: 'string', enum: ['steps'] },
          items: { type: 'array', minItems: 1, maxItems: FOCUS_VISUAL_ITEMS, items: {
            type: 'object', properties: {
              label: { type: 'string', minLength: 1, maxLength: FOCUS_LABEL_LENGTH },
              state: { type: 'string', enum: ['done', 'active', 'pending'] }
            }, required: ['label', 'state'], additionalProperties: false
          } }
        }, required: ['kind', 'items'], additionalProperties: false },
        { type: 'object', properties: {
          kind: { type: 'string', enum: ['metrics'] },
          items: { type: 'array', minItems: 1, maxItems: FOCUS_VISUAL_ITEMS, items: {
            type: 'object', properties: {
              label: { type: 'string', minLength: 1, maxLength: FOCUS_LABEL_LENGTH },
              value: { type: 'string', minLength: 1, maxLength: FOCUS_VALUE_LENGTH }
            }, required: ['label', 'value'], additionalProperties: false
          } }
        }, required: ['kind', 'items'], additionalProperties: false }
      ] }
    }, required: ['kind', 'summary'], additionalProperties: false }
  },
  {
    name: 'list_projects',
    description: 'Discover existing Workbench projects you may manage, including their real default folders. '
      + 'App Managers see every project in this app; Project Managers see only their authorized project. '
      + 'Use the returned project_id when an App Manager creates a worker. Does not create projects or grant access.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_project_progress',
    description: 'Read the same bounded project progress used by the central project overview before answering status questions. '
      + 'App Managers may read all projects or choose project_id; Project Managers may read only their authorized project. Ordinary workers cannot use this tool. '
      + 'Returns current workers, task-art subjects, dated agent reports/milestones/next steps, and provenance. Archived reports remain labeled history; moved/removed owners are excluded. '
      + 'Agent reports are claims, not verified task completion. Respect stale/newer-request warnings; current activity does not refresh old report dates. '
      + 'Follow next_project_offset/next_worker_offset for a complete roster. Reports are the newest six per project, not a full audit log. '
      + 'Workers should publish_focus_update after meaningful progress in their current turn; do not start extra turns or poll just to collect updates.',
    inputSchema: { type: 'object', properties: {
      project_id: { type: 'string', description: 'Optional existing project ID within your management grant.' },
      project_offset: { type: 'integer', minimum: 0, maximum: 100000, description: 'Next all-project page offset returned by this tool; default 0.' },
      worker_offset: { type: 'integer', minimum: 0, maximum: 100000, description: 'Active-worker page offset for one selected project; default 0.' }
    }, additionalProperties: false }
  },
  {
    name: 'list_sessions',
    description:
      'List the other Workbench sessions you may address, with what each one is currently doing. ' +
      'Status is authoritative — it comes from the agent\'s own lifecycle hooks, not from scraping ' +
      'its screen. App Managers see sessions across this app, including unfiled/off-bus sessions. '
      + 'Project Managers see only their authorized project; others see individually opted-in targets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'read_session',
    description:
      'Read the visible scrollback of another session, with ANSI escapes stripped.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'From list_sessions.' },
        lines: {
          type: 'number',
          description: 'How many lines back to read. Defaults to 200, max 4000.'
        }
      },
      required: ['session_id'],
      additionalProperties: false
    }
  },
  {
    name: 'send_prompt',
    description:
      'Type a prompt into another session and submit it. The target must be granted full bus ' +
      'access by the user, belong to your managed project, or be covered by your App Manager grant. Returns as soon as the text is submitted, not when the agent is done — ' +
      'use wait_for if you need the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        text: { type: 'string' },
        wait: { type: 'boolean', description: 'Wait for a reply, with deadlock detection. Defaults to false.' },
        timeout_seconds: { type: 'number', description: 'Reply timeout, defaults to 120, max 600.' }
      },
      required: ['session_id', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'wait_for',
    description:
      'Block until another session reaches one of the given statuses, or the timeout expires. ' +
      'Use this instead of polling read_session in a loop: Workbench tracks agent state from ' +
      'lifecycle hooks, so this resolves on the real transition rather than on a guess about ' +
      'what the screen looks like.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        status: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['idle', 'working', 'waiting', 'review', 'failed', 'exited']
          },
          description: 'Any one of these ends the wait. Defaults to ["review","idle","failed"].'
        },
        timeout_seconds: { type: 'number', description: `Defaults to 120, max ${MAX_WAIT_SECONDS}.` }
      },
      required: ['session_id'],
      additionalProperties: false
    }
  },
  {
    name: 'fork_session',
    description:
      'Branch the target conversation as a child or parallel sibling. Uses native conversation ' +
      'forking where supported, otherwise a transcript handoff. Manager children remain in the ' +
      'same project with Full access; they never inherit Manager permission.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        kind: { type: 'string', enum: ['child', 'sibling'], description: 'Defaults to "child".' },
        agent: {
          type: 'string',
          description: 'Switch agents while carrying the context across. Defaults to the target\'s.'
        },
        prompt: { type: 'string', description: 'First instruction for the new session.' }
      },
      required: ['session_id'],
      additionalProperties: false
    }
  },
  {
    name: 'create_session',
    description: 'App or Project Managers only. Create an agent in an existing authorized project and its real default folder. '
      + 'App Managers must supply project_id from list_projects. Project Managers may omit it or supply their own project ID. '
      + 'The child has Full bus access, never either Manager grant. CLI execution permissions remain at their normal default.',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string', description: 'Registered agent ID, for example codex or claude.' },
      project_id: { type: 'string', description: 'Existing project ID. Required for App Managers; Project Managers may name only their authorized project.' },
      title: { type: 'string' }, prompt: { type: 'string', description: 'Optional first instruction, sent after startup.' }
    }, required: ['agent', 'title'], additionalProperties: false }
  },
  {
    name: 'update_session',
    description: 'App or Project Managers only. Rename or pin a session within your grant. Cannot change bus grants, project membership, or CLI execution permissions.',
    inputSchema: { type: 'object', properties: {
      session_id: { type: 'string' }, title: { type: 'string' }, pinned: { type: 'boolean' }
    }, required: ['session_id'], additionalProperties: false }
  },
  ...[
    ['stop_session', 'Stop a project session, keeping its conversation available to restart.'],
    ['restart_session', 'Restart a project session in place, resuming its recorded conversation when available.'],
    ['interrupt_session', 'Send Ctrl+C to a project session to interrupt its current work.'],
    ['delete_session', 'Stop and remove a project session from Workbench. This does not delete project files or CLI transcripts.']
  ].map(([name, description]) => ({ name, description: 'App or Project Managers only, within the scope the user granted. ' + description,
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } },
      required: ['session_id'], additionalProperties: false }
  })),
  {
    name: 'list_scheduled_tasks',
    description: 'Project managers only. List scheduled tasks and recent runs in your authorized project, with the computer\'s local time zone. '
      + 'These are the tasks shown in Workbench Scheduled. They run only while Workbench is open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'create_scheduled_task',
    description: 'Project managers only. Save a recurring task in your authorized project and its default folder. '
      + 'It appears immediately in Workbench Scheduled. Each run starts a new agent with normal approval permissions and saved project instructions; '
      + 'write a self-contained prompt. Daily, weekdays and weekly schedules are supported while Workbench is open. This does not run the task immediately.',
    inputSchema: { type: 'object', properties: TASK_FIELDS,
      required: ['name', 'prompt', 'cadence', 'time'], additionalProperties: false }
  },
  {
    name: 'update_scheduled_task',
    description: 'Project managers only. Edit a task in your authorized project. Supply only changed fields; set enabled false to pause or true to resume. '
      + 'Pausing does not stop a run already launched. The next occurrence is recalculated in the computer\'s local time zone.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'Task id from list_scheduled_tasks.' }, ...TASK_FIELDS },
      required: ['task_id'], additionalProperties: false }
  },
  ...[
    ['run_scheduled_task', 'Run a saved project task now using the normal scheduler. It starts a new agent conversation and returns the run record; it does not wait for completion. An active run prevents overlap.'],
    ['delete_scheduled_task', 'Delete a task in your authorized project. An active run prevents deletion; pause the schedule instead. Run history and project files are kept.']
  ].map(([name, description]) => ({ name, description: 'Project managers only. ' + description,
    inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'Task id from list_scheduled_tasks.' } },
      required: ['task_id'], additionalProperties: false }
  }))

]

/** Which access level the *target* of each tool must have granted. */
const TARGET_REQUIRES: Record<string, BusAccess> = {
  list_sessions: 'read',
  read_session: 'read',
  wait_for: 'read',
  send_prompt: 'full',
  fork_session: 'full'
}

export class BusError extends Error {}

export interface BusDeps {
  sessions: BusSessions
  /** Where the generated server script and MCP config files live. */
  binDir: string
  /** Our own binary, re-entered as plain Node. */
  electronExecPath: string
  /** The master switch. Read live, so turning the bus off takes effect at once. */
  enabled: () => boolean
  project?: (id: string) => SessionProject | undefined
  /** Real app project inventory, exposed only through a valid management scope. */
  projects?: () => SessionProject[]
  /** Uses the existing relay engine for agent-to-agent messages and replies. */
  relay?: (request: RelayRequest, authorize: () => void) => Promise<RelayResult>
  /** Adds saved project instructions without letting tools override the folder. */
  context?: (projectId: string, prompt: string) => string
  /** Resolved per call because the bridge is initialized before project data.
   * Reuse the UI's durable scheduler, so agents cannot create invisible jobs or
   * bypass its normal approvals, active-run checks and restart recovery. */
  scheduler?: () => Pick<Experience, 'snapshot' | 'saveTask' | 'runTask' | 'removeTask' | 'publishFocusUpdate'> | null
}

export class SessionBus extends EventEmitter {
  private deps: BusDeps
  private ledger: BusEntry[] = []
  private seq = 0
  private secret: Buffer | null = null

  readonly paths: { server: string; shim: string; claudeConfig: string }

  constructor(deps: BusDeps) {
    super()
    this.deps = deps
    this.paths = {
      server: path.join(deps.binDir, 'bus-mcp.cjs'),
      shim: path.join(deps.binDir, 'bus-mcp.sh'),
      claudeConfig: path.join(deps.binDir, 'bus-mcp.json')
    }
  }

  entries(): BusEntry[] {
    return this.ledger
  }

  /**
   * A session ID is an address, not authentication. The loopback bridge token
   * is shared by lifecycle hooks, so it cannot prove which agent is calling.
   * Give each launched session a different HMAC credential in its environment.
   * Persist only the private signing key so detached tmux agents survive app
   * restarts; credentials never enter renderer snapshots or MCP argv/config.
   * This is an application boundary, not OS isolation between same-user shells.
   */
  envFor(sessionId: string): Record<string, string> {
    if (!this.secret) {
      fs.mkdirSync(this.deps.binDir, { recursive: true })
      const file = path.join(this.deps.binDir, 'bus-secret')
      try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      this.secret = fs.readFileSync(file)
      if (this.secret.length !== 32) throw new BusError('The Session Bus signing key is invalid.')
    }
    return { TERMINAL_BUS_TOKEN: crypto.createHmac('sha256', this.secret).update(sessionId).digest('hex') }
  }

  authenticate(callerId: string, credential: string): void {
    const expected = this.envFor(callerId).TERMINAL_BUS_TOKEN
    if (!/^[a-f0-9]{64}$/.test(credential) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(credential))) {
      this.record(callerId, 'authenticate', null, false, 'Invalid session credential; restart the session to connect.', Date.now())
      throw new BusError('Invalid session credential. Restart this session from Workbench to connect to the bus.')
    }
  }

  /** All agent transports use the same live grants and credential checks. */
  mount(hooks: { route(path: string, handler: BridgeRoute): void }): void {
    hooks.route('/bus/call', async (body) => {
      const { callerId, credential, tool, args } = asBusCall(body)
      this.authenticate(callerId, credential)
      return this.call(callerId, tool, args)
    })
    // The shell CLI and MCP must share one permission boundary. Leaving the
    // older /sessions and /relay routes unrestricted would let an agent bypass
    // a revoked bus grant simply by running `workbench send` instead of MCP.
    const agentRequest = (body: unknown): { callerId: string; args: Record<string, unknown> } => {
      if (!isObj(body)) throw new Error('Invalid agent request')
      const request = asBusCall({ callerId: body.termSessionId, credential: body.credential, tool: 'list_sessions' })
      this.authenticate(request.callerId, request.credential)
      return { callerId: request.callerId, args: body }
    }
    hooks.route('/sessions', async (body) => {
      const { callerId } = agentRequest(body)
      const roster = await this.call(callerId, 'list_sessions', {}) as { sessions: { session_id: string; title: string; agent: string; status: string }[] }
      return { sessions: roster.sessions.map((s) => ({ ...s, id: s.session_id,
        mention: roster.sessions.filter((t) => slugify(t.title) === slugify(s.title)).length > 1 ? s.session_id : slugify(s.title) || s.session_id, self: false })) }
    })
    hooks.route('/relay', async (body) => {
      const { callerId, args } = agentRequest(body)
      const roster = await this.call(callerId, 'list_sessions', {}) as { sessions: { session_id: string; title: string; agent: string; alive: boolean }[] }
      const targets = roster.sessions.map((s) => ({ ...s, id: s.session_id }))
      const to = typeof args.to === 'string' ? args.to.replace(/^@/, '') : ''
      const target = resolveMention(to, targets)
      if (!target.target) throw new Error(`Session address is ${target.reason}; use a reachable session's ID.`)
      return this.call(callerId, 'send_prompt', { session_id: target.target.id,
        text: args.message, wait: args.wait === true,
        ...(typeof args.timeoutMs === 'number' ? { timeout_seconds: args.timeoutMs / 1000 } : {}) })
    })
  }

  // ── generated delivery ────────────────────────────────────────────────────

  /**
   * Writes the MCP server, its shim, and the Claude-side config that points at
   * it. Same shape as the hook shim: Claude runs a command string, Codex execs
   * an argv array, and neither can set environment inline, so a shell script
   * carries the ELECTRON_RUN_AS_NODE re-entry for both.
   */
  writeScripts(): void {
    fs.mkdirSync(this.deps.binDir, { recursive: true })
    fs.writeFileSync(this.paths.server, this.serverScript(), { mode: 0o755 })

    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

    // Identical reasoning to the hook shims in `hooks.ts`, and deliberately the
    // same shape: on a WSL host the shim lives in the distro while the Electron
    // binary is a Windows process, so the binary is named `/mnt/c/…`, the server
    // script keeps the `\\wsl.localhost\…` spelling Windows will open it by, and
    // WSLENV carries the three variables across interop. The stdio the MCP
    // protocol rides on crosses with it.
    const wsl = hostKind() === 'wsl'
    const wslenv = 'WSLENV=ELECTRON_RUN_AS_NODE/w:TERMINAL_SESSION_ID/w:TERMINAL_BRIDGE_FILE/wp:TERMINAL_BUS_TOKEN/w'
    const exe = wsl ? toHostPath(this.deps.electronExecPath) : this.deps.electronExecPath
    fs.writeFileSync(
      this.paths.shim,
      [
        '#!/bin/sh',
        '# Generated by Workbench.',
        `exec env ${wsl ? `${wslenv} ` : ''}ELECTRON_RUN_AS_NODE=1 ${q(exe)} ${q(this.paths.server)}`,
        ''
      ].join('\n'),
      { mode: 0o755 }
    )

    // Both configs name the shim the way the *agent* will run it, because the
    // agent is on the host. Node ignores `mode` on win32, so the execute bit is
    // set from the side that owns the inode or the first tool call fails.
    const shimOnHost = toHostPath(this.paths.shim)
    if (wsl) hostCapture(['chmod', '755', shimOnHost])

    fs.writeFileSync(
      this.paths.claudeConfig,
      JSON.stringify({ mcpServers: { workbench: { command: shimOnHost, args: [] } } }, null, 2),
      'utf8'
    )
  }

  /** Codex takes its MCP servers as `-c` overrides rather than a config file. */
  codexConfigArgs(): string[] {
    return [
      '-c',
      `mcp_servers.workbench.command=${JSON.stringify(toHostPath(this.paths.shim))}`,
      '-c',
      'mcp_servers.workbench.args=[]',
      // Codex filters the environment of stdio servers. Without this allowlist
      // the tools load and look healthy, but their first real call has neither
      // a session identity nor a bridge path and reports that the app is down.
      '-c',
      'mcp_servers.workbench.env_vars=["TERMINAL_SESSION_ID","TERMINAL_BRIDGE_FILE","TERMINAL_BUS_TOKEN"]',
      '-c',
      `mcp_servers.workbench.tool_timeout_sec=${MAX_WAIT_SECONDS + 120}`
    ]
  }

  private serverScript(): string {
    // Function replacements, not string ones: a `$&` inside a tool description
    // would otherwise be read as a substitution pattern.
    return MCP_SERVER_SCRIPT.replace('__BUS_TOOLS__', () => JSON.stringify(BUS_TOOLS)).replace(
      '__MAX_WAIT__',
      () => String(MAX_WAIT_SECONDS)
    )
  }

  // ── guardrails ────────────────────────────────────────────────────────────

  private accessOf(s: Session | undefined): BusAccess {
    if (s?.bus === 'app-manager' && s.busProjectId !== null) return 'off'
    if (s?.bus === 'manager' && (!s.busProjectId || s.busProjectId !== s.sessionProjectId
      || !this.deps.project?.(s.busProjectId))) return 'off'
    return s?.bus ?? 'off'
  }

  private allows(s: Session | undefined, need: BusAccess): boolean {
    return RANK[this.accessOf(s)] >= RANK[need]
  }

  private caller(callerId: string): Session {
    if (!this.deps.enabled()) throw new BusError('The Session Bus is switched off in Workbench settings.')
    const caller = this.deps.sessions.get(callerId)
    if (!caller) throw new BusError('Calling session is not known to Workbench')
    if (!caller.alive) throw new BusError('Calling session is no longer running')
    if (!this.allows(caller, 'read')) throw new BusError('This session has no bus access. The user grants it per session in Workbench.')
    return caller
  }

  private manager(callerId: string): SessionProject {
    const caller = this.caller(callerId)
    if (this.accessOf(caller) !== 'manager') throw new BusError('This tool requires a project Manager grant from the user in Session Bus.')
    return this.deps.project!(caller.busProjectId!)!
  }

  /** Session management is the only app-wide slice. The existing scheduler
   * still uses manager() above, so this grant cannot widen scheduled work. */
  private sessionManager(callerId: string): ManagementScope {
    const caller = this.caller(callerId)
    if (this.accessOf(caller) === 'app-manager') return { kind: 'app' }
    return { kind: 'project', projectId: this.manager(callerId).id }
  }

  private recheckManagement(callerId: string, granted: ManagementScope): void {
    const current = this.sessionManager(callerId)
    if (current.kind !== granted.kind || (current.kind === 'project' && granted.kind === 'project'
      && current.projectId !== granted.projectId)) {
      throw new BusError('The management grant changed while this operation was running.')
    }
  }

  private reachable(caller: Session, target: Session, need: BusAccess): boolean {
    // A manager's grant never becomes a route into another project, even when
    // a target there has individually opted into Full access.
    const access = this.accessOf(caller)
    if (access === 'app-manager') return true
    return access === 'manager' ? target.sessionProjectId === caller.busProjectId : this.allows(target, need)
  }

  private target(callerId: string, tool: string, sessionId: unknown): Session {
    if (typeof sessionId !== 'string' || !sessionId) throw new BusError('session_id is required')
    const caller = this.caller(callerId)
    if (sessionId === callerId && !['manager', 'app-manager'].includes(this.accessOf(caller))) throw new BusError('A session cannot address itself')
    const s = this.deps.sessions.get(sessionId)
    const need = TARGET_REQUIRES[tool] ?? 'full'
    if (!s || !this.reachable(caller, s, need)) {
      throw new BusError(`No session ${sessionId} is reachable at ${need} access. The user grants this per session or within your managed project.`)
    }
    return s
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  /**
   * Runs one tool call on behalf of `callerId`, and records it either way.
   */
  async call(callerId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const started = Date.now()
    const targetId = typeof args.session_id === 'string' ? args.session_id : null
    try {
      const value = await this.run(callerId, tool, args)
      this.record(callerId, tool, targetId, true, this.describe(tool, args, value), started)
      return value
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.record(callerId, tool, targetId, false, message, started)
      throw err
    }
  }

  private async run(
    callerId: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    this.caller(callerId)
    const spec = BUS_TOOLS.find((item) => item.name === tool)
    if (!spec) throw new BusError(`Unknown tool: ${tool}`)
    const properties = spec.inputSchema.properties as Record<string, unknown>
    if (Object.keys(args).some((key) => !Object.hasOwn(properties, key))) throw new BusError('Unsupported tool argument')

    switch (tool) {
      case 'publish_focus_update':
        return this.publishFocusUpdate(callerId, args)
      case 'list_sessions':
        return this.listSessions(callerId)
      case 'list_projects':
        return this.listProjects(callerId)
      case 'get_project_progress':
        return this.projectProgress(callerId, args)
      case 'read_session':
        return this.readSession(callerId, args)
      case 'send_prompt':
        return this.sendPrompt(callerId, args)
      case 'wait_for':
        return this.waitFor(callerId, args)
      case 'fork_session':
        return this.forkSession(callerId, args)
      case 'create_session':
        return this.createSession(callerId, args)
      case 'update_session':
      case 'stop_session':
      case 'restart_session':
      case 'interrupt_session':
      case 'delete_session':
        return this.manageSession(callerId, tool, args)
      case 'list_scheduled_tasks':
      case 'create_scheduled_task':
      case 'update_scheduled_task':
      case 'run_scheduled_task':
      case 'delete_scheduled_task':
        return this.scheduledTask(callerId, tool, args)
      default:
        throw new BusError(`Unknown tool: ${tool}`)
    }
  }

  private publishFocusUpdate(callerId: string, args: Record<string, unknown>): unknown {
    const caller = this.caller(callerId)
    if (!caller.sessionProjectId || !this.deps.project?.(caller.sessionProjectId)) {
      throw new BusError('Focus reports require an existing Workbench project')
    }
    const experience = this.deps.scheduler?.()
    if (!experience) throw new BusError('Workbench project data is not ready. Try again after the app finishes starting.')
    return { update: experience.publishFocusUpdate(caller.id, args) }
  }

  private listSessions(callerId: string): unknown {
    const caller = this.caller(callerId)
    return {
      caller_session_id: callerId,
      managed_project_id: this.accessOf(caller) === 'manager' ? caller.busProjectId : null,
      management_scope: this.accessOf(caller) === 'app-manager' ? 'app' : this.accessOf(caller) === 'manager' ? 'project' : null,
      sessions: this.deps.sessions
        .list()
        .filter((s) => s.id !== callerId && this.reachable(caller, s, 'read'))
        .map((s) => ({
          session_id: s.id,
          title: s.title,
          last_task: s.lastTask ?? null,
          agent: s.agent,
          status: s.status,
          status_reason: s.statusReason,
          alive: s.alive,
          cwd: s.cwd,
          parent_session_id: s.parentId,
          root_session_id: s.rootId,
          // What this caller is permitted to do with it, so the agent does not
          // have to discover the boundary by being refused.
          project_id: s.sessionProjectId ?? null,
          can_manage: ['manager', 'app-manager'].includes(this.accessOf(caller)),
          can_message: this.reachable(caller, s, 'full')
        }))
    }
  }

  private listProjects(callerId: string): unknown {
    const scope = this.sessionManager(callerId)
    if (scope.kind === 'app' && !this.deps.projects) throw new BusError('Workbench project data is not ready.')
    const projects = scope.kind === 'app' ? this.deps.projects!() : [this.manager(callerId)]
    return { management_scope: scope.kind, projects: projects.map((project) => {
      let available = false
      try { available = !!project.defaultCwd && fs.statSync(project.defaultCwd).isDirectory() } catch { /* unavailable is explicit */ }
      return { project_id: project.id, name: project.name, default_cwd: project.defaultCwd, can_create: available }
    }) }
  }

  private projectProgress(callerId: string, args: Record<string, unknown>): unknown {
    const scope = this.sessionManager(callerId)
    const requested = args.project_id === undefined ? undefined : asString(args.project_id, 'project_id', 200)
    if (requested !== undefined && !requested.trim()) throw new BusError('project_id must not be empty')
    if (scope.kind === 'project' && requested !== undefined && requested !== scope.projectId) {
      throw new BusError('No project with that ID is available within your Manager grant.')
    }
    const selected = requested ?? (scope.kind === 'project' ? scope.projectId : undefined)
    const offset = (value: unknown, name: string): number => {
      if (value === undefined) return 0
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100000) {
        throw new BusError(`${name} must be an integer from 0 to 100000`)
      }
      return value
    }
    const projectOffset = offset(args.project_offset, 'project_offset')
    const workerOffset = offset(args.worker_offset, 'worker_offset')
    if (selected && projectOffset !== 0) throw new BusError('project_offset applies only to an all-project overview')
    if (!selected && workerOffset !== 0) throw new BusError('Select project_id to page through its workers')
    const experience = this.deps.scheduler?.()
    if (!experience) throw new BusError('Workbench project data is not ready.')
    const state = experience.snapshot()
    this.recheckManagement(callerId, scope)
    let projects: SessionProject[]
    if (selected) {
      const project = this.deps.project?.(selected)
      if (!project) throw new BusError('No project with that ID is available within your Manager grant.')
      projects = [project]
    } else {
      if (!this.deps.projects) throw new BusError('Workbench project data is not ready.')
      projects = this.deps.projects()
    }
    const sessions = this.deps.sessions.list(), byId = new Map(sessions.map(s => [s.id, s]))
    const archived = new Set(state.archivedIds), now = Date.now()
    const timestamp = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value)
      && value > 0 && value <= 8640000000000000 ? value : null
    const page = projects.slice(projectOffset, projectOffset + PROGRESS_PROJECT_LIMIT)
    return { management_scope: scope.kind, as_of: now,
      data_status: state.error ? 'unavailable' : 'available',
      warnings: state.error ? ['Saved project data is unavailable; reports may be missing.'] : [],
      total_projects: projects.length, project_offset: projectOffset,
      next_project_offset: projectOffset + page.length < projects.length ? projectOffset + page.length : null,
      report_history_limit: 6,
      projects: page.map(project => {
        // This is the overview's pure aggregator, not a second source of task
        // truth. Reports keep their recorded owner and original timestamp;
        // the queried-at time never turns an old claim into a fresh milestone.
        const progress = projectFocus(project.id, sessions, state.focusUpdates, state.archivedIds)
        const workers = progress.workers.slice(workerOffset, workerOffset + PROGRESS_WORKER_LIMIT)
        const reports = progress.reports.map(report => {
          const owner = byId.get(report.sessionId)!
          const promptAt = timestamp(owner.lastPromptAt)
          const reasons: string[] = []
          if (promptAt !== null && report.at < promptAt) reasons.push('newer_request')
          if (now - report.at > 86400000) reasons.push('older_than_24_hours')
          if (report.at > now) reasons.push('future_timestamp')
          return { id: report.id, session_id: report.sessionId, project_id: report.projectId,
            source: 'agent_report', reported_at: report.at, kind: report.kind, summary: report.summary,
            next: report.next ?? null, visual: report.visual ?? null,
            archived_history: archived.has(report.sessionId), stale: reasons.length > 0, stale_reasons: reasons }
        })
        const counts: Record<string, number> = {}
        for (const worker of progress.workers) { const status = focusStatus(worker); counts[status] = (counts[status] ?? 0) + 1 }
        return { project_id: project.id, name: focusText(project.name, 120),
          current_worker_id: progress.current?.id ?? null,
          current_intent: focusText(progress.current?.lastTask) || null,
          intent_source: 'session_task_summary',
          last_known_task: focusText(progress.lastKnown?.lastTask) || null,
          last_known_task_at: timestamp(progress.lastKnown?.lastPromptAt),
          task_art: null,
          latest_visual: progress.latest?.visual ?? null,
          needs_attention: progress.needsAttention, worker_count: progress.workers.length, status_counts: counts,
          worker_offset: workerOffset, next_worker_offset: workerOffset + workers.length < progress.workers.length
            ? workerOffset + workers.length : null,
          workers: workers.map(worker => ({ session_id: worker.id, project_id: worker.sessionProjectId,
            role: focusText(worker.title, 120), agent: worker.agent, task: focusText(worker.lastTask) || null,
            status: focusStatus(worker), alive: worker.alive, source: 'observed_session_snapshot',
            status_source: worker.statusSource ?? 'system', status_at: timestamp(worker.lastStatusChangeAt),
            last_prompt_at: timestamp(worker.lastPromptAt) })),
          reports, milestone_ids: reports.filter(report => report.kind === 'milestone').map(report => report.id),
          latest_report_id: progress.latest?.id ?? null }
      }) }
  }

  private async readSession(callerId: string, args: Record<string, unknown>): Promise<unknown> {
    const s = this.target(callerId, 'read_session', args.session_id)
    const asked = typeof args.lines === 'number' && args.lines > 0 ? Math.floor(args.lines) : 200
    const text = await this.deps.sessions.captureText(s.id, Math.min(asked, 4000))
    this.target(callerId, 'read_session', s.id)
    return { session_id: s.id, status: s.status, text }
  }

  private async sendPrompt(callerId: string, args: Record<string, unknown>): Promise<unknown> {
    const s = this.target(callerId, 'send_prompt', args.session_id)
    const text = asString(args.text, 'text', 100_000)
    if (!text.trim()) throw new BusError('text is required')
    if (args.wait !== undefined && typeof args.wait !== 'boolean') throw new BusError('wait must be a boolean')
    if (this.deps.relay) {
      const result = await this.deps.relay({ fromSessionId: callerId, toSessionId: s.id,
        message: text, wait: args.wait === true, timeoutMs: this.timeoutMs(args.timeout_seconds) }, () => { this.target(callerId, 'send_prompt', s.id) })
      this.target(callerId, 'send_prompt', s.id)
      if (!result.ok) throw new BusError(result.error ?? `Relay ${result.phase}`)
      return { ...result, session_id: s.id, submitted: true }
    }
    await this.deps.sessions.sendPrompt(s.id, text)
    this.target(callerId, 'send_prompt', s.id)
    return { session_id: s.id, submitted: true }
  }

  private timeoutMs(value: unknown): number {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      throw new BusError('timeout_seconds must be a positive finite number')
    }
    return Math.min((value as number | undefined) ?? 120, MAX_WAIT_SECONDS) * 1000
  }

  /**
   * Blocks until the target reaches one of the given statuses.
   *
   * Driven by the manager's change event rather than a timer, so it resolves on
   * the transition itself — which is the whole reason this tool exists instead
   * of the caller looping on read_session.
   */
  private async waitFor(callerId: string, args: Record<string, unknown>): Promise<unknown> {
    const s = this.target(callerId, 'wait_for', args.session_id)
    const statuses = ['idle', 'working', 'waiting', 'review', 'failed', 'exited']
    if (args.status !== undefined && (!Array.isArray(args.status) || !args.status.length
      || args.status.some((value) => !statuses.includes(value)))) throw new BusError('status must contain valid session statuses')
    const wanted = new Set((args.status as string[] | undefined) ?? ['review', 'idle', 'failed'])
    const timeoutMs = this.timeoutMs(args.timeout_seconds)
    const current = (): Session => this.target(callerId, 'wait_for', s.id)
    const result = (now: Session, timedOut: boolean): unknown => ({
      session_id: s.id, status: now.status, timed_out: timedOut, alive: now.alive
    })
    const now = current()
    if (wanted.has(now.status) || !now.alive) return result(now, false)
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        clearInterval(permissions)
        this.deps.sessions.off('sessions-changed', onChange)
      }
      const check = (timedOut = false): void => {
        try {
          const hit = current()
          if (timedOut || wanted.has(hit.status) || !hit.alive) { cleanup(); resolve(result(hit, timedOut)) }
        } catch (error) { cleanup(); reject(error) }
      }
      const onChange = (): void => check()
      const timer = setTimeout(() => check(true), timeoutMs)
      // Status transitions still resolve synchronously. This guard covers the
      // master preference, which is not itself a sessions-changed event, and
      // stops an old wait from disclosing data after its grant was revoked.
      const permissions = setInterval(onChange, 100)
      this.deps.sessions.on('sessions-changed', onChange)
      check()
    })
  }

  private async forkSession(callerId: string, args: Record<string, unknown>): Promise<unknown> {
    const s = this.target(callerId, 'fork_session', args.session_id)
    if (args.kind !== undefined && args.kind !== 'child' && args.kind !== 'sibling') throw new BusError('kind must be child or sibling')
    const kind = args.kind === 'sibling' ? 'sibling' : 'child'
    const agent = args.agent === undefined ? undefined : asAgentKind(args.agent)
    const callerAccess = this.accessOf(this.caller(callerId))
    const scope = ['manager', 'app-manager'].includes(callerAccess) ? this.sessionManager(callerId) : null
    const projectId = s.sessionProjectId ?? null
    const created = await this.deps.sessions.fork({
      sourceId: s.id,
      kind,
      targetAgent: agent,
      initialPrompt: args.prompt === undefined ? undefined : asString(args.prompt, 'prompt', 100_000)
    })
    const currentSource = this.target(callerId, 'fork_session', s.id)
    if (scope) {
      this.recheckManagement(callerId, scope)
      if ((currentSource.sessionProjectId ?? null) !== projectId || (created.sessionProjectId ?? null) !== projectId
        || (projectId !== null && !this.deps.project?.(projectId))) {
        throw new BusError('The project grant changed during launch; the new session has no bus access.')
      }
      this.deps.sessions.setBusAccess(created.id, 'full')
    }
    return {
      session_id: created.id,
      title: created.title,
      agent: created.agent,
      project_id: created.sessionProjectId ?? null,
      forked_from: s.id,
      kind
    }
  }

  private async createSession(callerId: string, args: Record<string, unknown>): Promise<unknown> {
    const scope = this.sessionManager(callerId)
    const projectId = args.project_id === undefined
      ? scope.kind === 'project' ? scope.projectId : null
      : asString(args.project_id, 'project_id', 200)
    if (!projectId) throw new BusError('project_id is required for App Manager worker creation. Use list_projects.')
    if (scope.kind === 'project' && projectId !== scope.projectId) throw new BusError('No project with that ID is available within your Manager grant.')
    const project = this.deps.project?.(projectId)
    if (!project) throw new BusError('No project with that ID is available within your Manager grant.')
    const cwd = project.defaultCwd
    const agent = asAgentKind(args.agent)
    const title = asString(args.title, 'title', 200).trim()
    if (!title) throw new BusError('title is required')
    const prompt = args.prompt === undefined ? undefined : asString(args.prompt, 'prompt', 100_000)
    // Falling back to home is useful for an interactive launcher but dangerous
    // for an unattended manager: the authorized project's folder must exist.
    try {
      if (!cwd || !fs.statSync(cwd).isDirectory()) throw new Error('Unavailable')
    } catch { throw new BusError('Project folder is unavailable') }
    const created = await this.deps.sessions.create({ agent, title, cwd,
      sessionProjectId: project.id, parentId: callerId, forkKind: 'child', permissionMode: 'default',
      initialPrompt: agent !== 'shell' && prompt && this.deps.context ? this.deps.context(project.id, prompt) : prompt })
    // Only the user can make a manager. A worker is individually reachable so
    // it can answer its manager without another manual grant for every child.
    this.recheckManagement(callerId, scope)
    const currentProject = this.deps.project?.(project.id)
    if (!currentProject || currentProject.defaultCwd !== cwd || created.sessionProjectId !== project.id || created.cwd !== cwd) {
      throw new BusError('The project grant changed during launch; the new session has no bus access.')
    }
    this.deps.sessions.setBusAccess(created.id, 'full')
    return { session_id: created.id, title: created.title, agent: created.agent, project_id: project.id, cwd: created.cwd }
  }

  private async manageSession(callerId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const scope = this.sessionManager(callerId)
    const s = this.target(callerId, tool, args.session_id)
    switch (tool) {
      case 'update_session': {
        const title = args.title === undefined ? undefined : asString(args.title, 'title', 200).trim()
        if (title === '') throw new BusError('title must not be empty')
        if (args.pinned !== undefined && typeof args.pinned !== 'boolean') throw new BusError('pinned must be a boolean')
        if (title === undefined && args.pinned === undefined) throw new BusError('Provide title or pinned')
        if (title !== undefined) this.deps.sessions.rename(s.id, title)
        if (typeof args.pinned === 'boolean') this.deps.sessions.setPinned(s.id, args.pinned)
        break
      }
      case 'stop_session': await this.deps.sessions.kill(s.id); break
      case 'restart_session': await this.deps.sessions.restart(s.id); break
      case 'interrupt_session': await this.deps.sessions.interrupt(s.id); break
      case 'delete_session': await this.deps.sessions.remove(s.id); break
    }
    this.recheckManagement(callerId, scope)
    if (tool !== 'delete_session') this.target(callerId, tool, s.id)
    return { session_id: s.id, updated: true, action: tool }
  }

  /** A task ID conveys no authority. Check its project before reading its
   * prompt or changing it, using the same non-disclosing refusal for missing
   * and out-of-project tasks. A saved schedule remains visible in Scheduled
   * after its creator leaves; revoking bus access only blocks further calls. */
  private async scheduledTask(callerId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const project = this.manager(callerId)
    const scheduler = this.deps.scheduler?.()
    if (!scheduler) throw new BusError('Workbench scheduling is not ready. Try again after the app finishes starting.')
    const state = scheduler.snapshot()
    const clock = { time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, requires_workbench_open: true }
    if (tool === 'list_scheduled_tasks') {
      if (state.error) throw new BusError(state.error)
      return { project_id: project.id, ...clock, local_time: new Date().toString(),
        tasks: state.tasks.filter((t) => t.projectId === project.id), runs: state.runs.filter((r) => r.projectId === project.id) }
    }

    if (tool === 'create_scheduled_task') {
      if (args.cadence === 'weekly' && args.weekday === undefined) throw new BusError('weekday is required for a weekly schedule (0 Sunday through 6 Saturday).')
      const task = scheduler.saveTask({ agent: this.caller(callerId).agent, weekday: 1, enabled: true,
        ...args, projectId: project.id })
      return { task, ...clock }
    }

    const id = asString(args.task_id, 'task_id', 200)
    const task = state.tasks.find((t) => t.id === id && t.projectId === project.id)
    if (!task) throw new BusError(state.error ?? 'No scheduled task with that ID is available in your managed project.')
    if (tool === 'update_scheduled_task') {
      const { task_id: _, ...patch } = args
      if (!Object.keys(patch).length) throw new BusError('Provide at least one task field to change, such as enabled.')
      if (patch.cadence === 'weekly' && task.cadence !== 'weekly' && patch.weekday === undefined) {
        throw new BusError('weekday is required when changing to a weekly schedule (0 Sunday through 6 Saturday).')
      }
      return { task: scheduler.saveTask({ ...task, ...patch }), ...clock }
    }
    if (tool === 'delete_scheduled_task') {
      scheduler.removeTask(id)
      return { task_id: id, deleted: true }
    }
    const run = await scheduler.runTask(id)
    // A launch is asynchronous. Do not return its new session details after
    // the caller has lost this project's grant while tmux was starting it.
    if (this.manager(callerId).id !== project.id) throw new BusError('The project grant changed while the scheduled task was launching.')
    return { run, ...clock }
  }

  // ── ledger ────────────────────────────────────────────────────────────────

  private describe(tool: string, args: Record<string, unknown>, value: unknown): string {
    const v = value as Record<string, unknown> | null
    switch (tool) {
      case 'publish_focus_update':
        return trim(String(args.summary ?? ''), 120)
      case 'list_sessions':
        return `${(v?.sessions as unknown[] | undefined)?.length ?? 0} reachable`
      case 'list_projects':
        return `${(v?.projects as unknown[] | undefined)?.length ?? 0} managed projects`
      case 'get_project_progress':
        return `${(v?.projects as unknown[] | undefined)?.length ?? 0} project progress summaries`
      case 'read_session':
        return `${String((v?.text as string) ?? '').length} chars`
      case 'send_prompt':
        return trim(String(args.text ?? ''), 120)
      case 'wait_for':
        return v?.timed_out ? `timed out at ${String(v?.status)}` : `reached ${String(v?.status)}`
      case 'fork_session':
      case 'create_session':
        return `created ${String(v?.session_id)}`
      case 'list_scheduled_tasks':
        return `${(v?.tasks as unknown[] | undefined)?.length ?? 0} scheduled tasks`
      case 'create_scheduled_task':
      case 'update_scheduled_task':
        return trim(String((v?.task as { name?: string } | undefined)?.name ?? 'scheduled task'), 120)
      case 'run_scheduled_task':
        return `run ${String((v?.run as { status?: string } | undefined)?.status ?? 'not started')}`
      case 'delete_scheduled_task':
        return `deleted task ${String(args.task_id)}`
      default:
        return tool === 'update_session' ? trim(String(args.title ?? 'pin updated'), 120) : tool.replace('_session', '')
    }
  }

  private record(
    callerId: string,
    tool: string,
    targetId: string | null,
    ok: boolean,
    detail: string,
    startedAt: number
  ): void {
    this.ledger.push({
      id: `bus_${++this.seq}`,
      at: startedAt,
      ms: Date.now() - startedAt,
      callerId,
      tool,
      targetId,
      ok,
      detail
    })
    if (this.ledger.length > LEDGER_CAP) this.ledger.splice(0, this.ledger.length - LEDGER_CAP)
    this.emit('bus-changed')
  }
}

function trim(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

/**
 * The generated MCP server.
 *
 * Plain CommonJS over Node built-ins only — it is executed by re-entering our
 * own Electron binary with ELECTRON_RUN_AS_NODE, where nothing from
 * node_modules is resolvable. That rules out the MCP SDK, so the protocol is
 * hand-rolled: JSON-RPC 2.0, one message per line, on stdio.
 *
 * The tool list is baked in rather than fetched. An agent may well start while
 * Workbench is closed, and a server that cannot answer `tools/list` is reported
 * to the user as broken; a server that lists its tools and then refuses the call
 * tells them the truth, which is that the app is not running.
 */
const MCP_SERVER_SCRIPT = `#!/usr/bin/env node
// Generated by Workbench. Bridges MCP tool calls to the running app.
const fs = require('fs')
const http = require('http')

const TOOLS = __BUS_TOOLS__
const MAX_WAIT = __MAX_WAIT__
const PROTOCOL = '2025-06-18'

const callerId = process.env.TERMINAL_SESSION_ID || ''
const bridgeFile = process.env.TERMINAL_BRIDGE_FILE || ''
const credential = process.env.TERMINAL_BUS_TOKEN || ''

// stdout is the transport. Anything else written there corrupts the stream.
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n')
}
function reply(id, result) {
  if (id === undefined || id === null) return
  send({ jsonrpc: '2.0', id: id, result: result })
}
function fail(id, code, message) {
  if (id === undefined || id === null) return
  send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } })
}
function textResult(text, isError) {
  const r = { content: [{ type: 'text', text: text }] }
  if (isError) r.isError = true
  return r
}

// Resolved per call, never cached: the app can restart with a new port and
// token while this MCP server and its agent keep running.
function bridge() {
  try {
    const b = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'))
    if (!b || typeof b.port !== 'number' || typeof b.token !== 'string') return null
    if (!b.port || !b.token) return null
    return b
  } catch (e) { return null }
}

function callBus(tool, args, callback) {
  let finished = false
  function cb(error, value) { if (finished) return; finished = true; callback(error, value) }
  const b = bridge()
  if (!callerId || !bridgeFile) {
    cb(new Error('Session Bus launch is missing its session environment. Restart this terminal from Workbench.'))
    return
  }
  if (!b) {
    cb(new Error('Workbench is not running, so the Session Bus is unavailable.'))
    return
  }
  const body = Buffer.from(JSON.stringify({ callerId: callerId, credential: credential, tool: tool, args: args || {} }))
  // wait_for blocks on purpose; the socket has to outlast whatever it was
  // asked to wait for, plus room for the round trip.
  const waitFor = tool === 'wait_for' || (tool === 'send_prompt' && args && args.wait) ? Number(args && args.timeout_seconds) || 120 : 0
  const timeout = (Math.max(0, Math.min(waitFor, MAX_WAIT)) + 120) * 1000

  const req = http.request(
    {
      host: '127.0.0.1',
      port: b.port,
      path: '/bus/call',
      method: 'POST',
      timeout: timeout,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'x-terminal-token': b.token
      }
    },
    function (res) {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', function (c) { buf += c })
      res.on('end', function () {
        let parsed = null
        try { parsed = JSON.parse(buf) } catch (e) { parsed = null }
        if (!parsed) { cb(new Error('Workbench returned an unreadable response.')); return }
        if (parsed.ok) cb(null, parsed.value)
        else cb(new Error(parsed.error || 'The Session Bus refused this call.'))
      })
    }
  )
  req.on('error', function () { cb(new Error('Could not reach Workbench.')) })
  req.on('timeout', function () { req.destroy(); cb(new Error('The Session Bus call timed out.')) })
  req.write(body)
  req.end()
}

function handle(msg) {
  const id = msg.id
  const method = msg.method

  if (method === 'initialize') {
    const asked = msg.params && msg.params.protocolVersion
    reply(id, {
      protocolVersion: typeof asked === 'string' ? asked : PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'workbench-session-bus', version: '1.0.0' },
      instructions: 'Managers should inspect get_project_progress before answering project status questions; it reads the same attributed reports as the project overview. Respect stale/history labels and follow pagination for complete coverage. Use publish_focus_update whenever meaningful progress changes in your current turn, including distinct discoveries, design revisions, verified fixes and completed milestones. Long turns can have several useful updates; do not wait until the end or use a fixed timer. Prefer an image created for the exact update, saved in the session folder, with concrete names, results or measurements; do not select generic category art. Keep the summary factual. Do not report routine tool calls, poll, or start extra agent turns just to report. Report only your own work; Workbench provides your identity and project. A report never changes live status or requests user approval. If access is refused, continue the user task without retrying repeatedly.'
    })
    return
  }
  if (method === 'ping') { reply(id, {}); return }
  if (method === 'tools/list') { reply(id, { tools: TOOLS }); return }
  if (method === 'tools/call') {
    const params = msg.params || {}
    callBus(params.name, params.arguments, function (err, value) {
      // A refused or failed tool comes back as an error *result*, not a
      // protocol error: the agent is meant to read it and adapt.
      if (err) reply(id, textResult(err.message, true))
      else reply(id, textResult(JSON.stringify(value, null, 2), false))
    })
    return
  }
  // Notifications carry no id and want no answer.
  if (id === undefined || id === null) return
  fail(id, -32601, 'Method not found: ' + String(method))
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (chunk) {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let msg = null
    try { msg = JSON.parse(line) } catch (e) { msg = null }
    if (!msg) { fail(null, -32700, 'Parse error'); continue }
    try { handle(msg) } catch (e) { fail(msg.id, -32603, String((e && e.message) || e)) }
  }
})
process.stdin.on('end', function () { process.exit(0) })
process.stdin.on('error', function () { process.exit(0) })
`
