/** Saved commands and their app-owned runtime state live outside agent sessions. */
export type ServiceShell = 'powershell' | 'bash'
export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'exited' | 'failed'

export interface ServiceInput {
  id?: string
  name: string
  projectId: string
  cwd: string
  command: string
  shell: ServiceShell
  autoStart: boolean
}

export interface ServiceDefinition extends ServiceInput {
  id: string
  createdAt: number
}

export interface ServiceRecord extends ServiceDefinition {
  status: ServiceStatus
  pid: number | null
  startedAt: number | null
  exitCode: number | null
  error: string | null
  log: string
}

export interface ServicesState {
  services: ServiceRecord[]
  error: string | null
}

export const MAX_SERVICE_LOG_CHARS = 64_000
export const MAX_SERVICES = 100

export function validateServiceInput(raw: unknown): ServiceInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid service')
  const value = raw as Record<string, unknown>
  const text = (key: string, max: number): string => {
    const field = value[key]
    if (typeof field !== 'string' || !field.trim() || field.length > max || field.includes('\0')) {
      throw new Error(`Invalid service ${key}`)
    }
    return field.trim()
  }
  if (value.id !== undefined && (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value.id))) {
    throw new Error('Invalid service id')
  }
  if (value.shell !== 'bash' && value.shell !== 'powershell') throw new Error('Choose Bash or PowerShell')
  if (typeof value.autoStart !== 'boolean') throw new Error('Invalid service startup setting')
  return {
    ...(value.id === undefined ? {} : { id: value.id as string }),
    name: text('name', 120), projectId: text('projectId', 120), cwd: text('cwd', 4096),
    command: text('command', 32_000), shell: value.shell, autoStart: value.autoStart
  }
}
