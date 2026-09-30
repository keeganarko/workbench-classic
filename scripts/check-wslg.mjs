import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

function commandVersion(command, args = ['--version']) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim().split('\n')[0]
  } catch {
    return null
  }
}

const tmuxVersion = commandVersion('tmux', ['-V'])
const claudeVersion = commandVersion('claude')
const codexVersion = commandVersion('codex')
const nodeMajor = Number(process.versions.node.split('.')[0])

let kernel = ''
try {
  kernel = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8')
} catch {
  // The platform check below will report the useful error.
}

const checks = [
  ['Linux runtime', process.platform === 'linux', process.platform],
  ['WSL 2', /wsl2/i.test(kernel), kernel.trim() || 'not detected'],
  ['Node.js 20+', nodeMajor >= 20, process.version],
  [
    'WSLg display',
    Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY),
    process.env.WAYLAND_DISPLAY || process.env.DISPLAY || 'not detected'
  ],
  ['tmux', Boolean(tmuxVersion), tmuxVersion || 'not found'],
  [
    'Claude or Codex',
    Boolean(claudeVersion || codexVersion),
    [claudeVersion, codexVersion].filter(Boolean).join(' / ') || 'neither found'
  ]
]

for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`)
}

if (checks.some(([, ok]) => !ok)) {
  console.error('\nWorkbench is not ready for WSLg. Resolve the failed checks above, then rerun npm run doctor:wslg.')
  process.exitCode = 1
} else {
  console.log('\nWorkbench is ready to run with npm run dev.')
}
