/**
 * Inline SVG icons drawn on the 16x16 grid Codicons use, so they sit at the
 * same optical weight as the rest of the Cursor/VS Code chrome.
 */

import type { JSX } from 'react'

export type IconName =
  | 'shelf'
  | 'sessions'
  | 'waiting'
  | 'running'
  | 'done'
  | 'failed'
  | 'settings'
  | 'permissions'
  | 'pin'
  | 'pinned'
  | 'plus'
  | 'close'
  | 'chevron'
  | 'split-h'
  | 'split-v'
  | 'search'
  | 'broadcast'
  | 'terminal'
  | 'fork'
  | 'stop'
  | 'refresh'
  | 'external'
  | 'sidebar'
  | 'zoom'
  | 'minimize'
  | 'preview'
  | 'document'
  | 'image'
  | 'eye'
  | 'folder'
  | 'git'
  | 'check'
  | 'minus'
  | 'diff'
  | 'globe'
  | 'share'
  | 'person'
  | 'pencil'
  | 'download'

const PATHS: Record<IconName, JSX.Element> = {
  pencil: (
    <>
      <path d="M11.2 2.3l2.5 2.5L5.4 13.1 2 14l.9-3.4z" />
      <path d="M10 3.5l2.5 2.5" />
    </>
  ),
  download: (
    <>
      <path d="M8 2v8" />
      <path d="M4.8 7l3.2 3.2L11.2 7" />
      <path d="M2.5 12.8v.7h11v-.7" />
    </>
  ),
  sessions: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 5.5h13" />
    </>
  ),
  waiting: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8v3.6M8 11.1v.1" />
    </>
  ),
  running: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8l2.4 1.6" />
    </>
  ),
  done: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.4 8.2l1.8 1.8 3.4-3.6" />
    </>
  ),
  // An X in a circle, deliberately unlike `waiting`'s exclamation: a crash and
  // a question must not read as the same thing at a glance.
  failed: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6 6l4 4M10 6l-4 4" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8L3.5 3.5" />
    </>
  ),
  permissions: (
    <>
      <path d="M8 1.5l5.3 2v4.1c0 3-2.1 5.3-5.3 6.9-3.2-1.6-5.3-3.9-5.3-6.9V3.5z" />
      <path d="M5.5 7.8l1.7 1.7 3.3-3.4" />
    </>
  ),
  pin: <path d="M9.6 1.8l4.6 4.6-1.6 1.1-.7 3.4-4.2-4.2-4.2 4.2 4.2-4.2L3.5 2.5l3.4-.7z" />,
  pinned: (
    <path
      d="M9.6 1.8l4.6 4.6-1.6 1.1-.7 3.4-4.2-4.2-4.2 4.2 4.2-4.2L3.5 2.5l3.4-.7z"
      fill="currentColor"
    />
  ),
  plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  chevron: <path d="M5 6.2L8 9.4l3-3.2" />,
  'split-h': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M8 2.5v11" />
    </>
  ),
  'split-v': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 8h13" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.3" />
      <path d="M10.2 10.2L14 14" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="8" cy="8" r="1.6" />
      <path d="M4.8 4.8a4.5 4.5 0 000 6.4M11.2 4.8a4.5 4.5 0 010 6.4M2.6 2.6a7.6 7.6 0 000 10.8M13.4 2.6a7.6 7.6 0 010 10.8" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.6 6l2 2-2 2M8.4 10.4h3" />
    </>
  ),
  fork: (
    <>
      <circle cx="4.5" cy="3.6" r="1.7" />
      <circle cx="11.5" cy="3.6" r="1.7" />
      <circle cx="8" cy="12.4" r="1.7" />
      <path d="M4.5 5.3v1.3a2 2 0 002 2h3a2 2 0 002-2V5.3M8 8.6v2.1" />
    </>
  ),
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  refresh: (
    <>
      <path d="M13 8a5 5 0 11-1.6-3.7" />
      <path d="M13.2 2v3h-3" />
    </>
  ),
  external: (
    <>
      <path d="M9.5 2.5H13.5V6.5" />
      <path d="M13.5 2.5L8 8" />
      <path d="M12 9.4v3.1a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3.1" />
    </>
  ),
  sidebar: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
    </>
  ),
  zoom: <path d="M6.2 2.5H2.5v3.7M9.8 2.5h3.7v3.7M9.8 13.5h3.7V9.8M6.2 13.5H2.5V9.8" />,
  minimize: <path d="M4 12h8" />,
  // The dock itself: a panel pinned to the right edge.
  //
  // The right strip is *filled*, not ruled. Drawn as an outline it was a
  // rounded rectangle with a faint line in it, which at 16px is a maximize
  // button — a user looking straight at this control reported not being able
  // to find it. Solid ink on one side is the only thing that reads as "a panel
  // lives over there" at this size.
  preview: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M9.8 2.5v11" />
      <path d="M9.8 2.5h3.2a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 01-1.5 1.5H9.8z" fill="currentColor" />
    </>
  ),
  document: (
    <>
      <path d="M9 1.8H4.5a1 1 0 00-1 1v10.4a1 1 0 001 1h7a1 1 0 001-1V5.3z" />
      <path d="M9 1.8v3.5h3.5" />
      <path d="M5.8 8.2h4.4M5.8 10.4h4.4" />
    </>
  ),
  image: (
    <>
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.5" />
      <circle cx="5.6" cy="6.4" r="1.1" />
      <path d="M2.4 11.4l3.3-3 2.6 2.3 2.2-1.9 3.1 2.7" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S3.9 3.8 8 3.8 14.5 8 14.5 8 12.1 12.2 8 12.2 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  folder: (
    <path d="M1.8 12.4V4.2a1 1 0 011-1h3.1l1.4 1.7h5.9a1 1 0 011 1v6.5a1 1 0 01-1 1H2.8a1 1 0 01-1-1z" />
  ),
  // A branch: trunk on the left, one line splitting away to a node on the right.
  /*
    A bookmark over a stack: a saved place in something that has layers behind
    it, which is what a checkpoint is. Deliberately not a folder — the shelf is
    not a place files live, it is a set of moments you can return to.
  */
  shelf: (
    <>
      <path d="M2.5 3.2h11" />
      <path d="M2.5 6.4h11" />
      <path d="M5 9.2h6.2a1 1 0 0 1 1 1v4.3l-4.1-2.3-4.1 2.3v-4.3a1 1 0 0 1 1-1Z" />
    </>
  ),
  git: (
    <>
      <circle cx="4.5" cy="3.6" r="1.7" />
      <circle cx="4.5" cy="12.4" r="1.7" />
      <circle cx="11.5" cy="6.6" r="1.7" />
      <path d="M4.5 5.3v5.4M4.5 8.6h3.6a3 3 0 003-2.6" />
    </>
  ),
  check: <path d="M3.2 8.4l3 3 6.6-6.8" />,
  minus: <path d="M3.5 8h9" />,
  diff: (
    <>
      <path d="M2.6 4.6h10.8M2.6 11.4h10.8" />
      <path d="M5.2 2.8v3.6M10.8 9.6v3.6" />
    </>
  ),
  // A globe: something being served, as opposed to something being read.
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2.2 8h11.6" />
      <path d="M8 2a9 9 0 010 12A9 9 0 018 2z" />
    </>
  ),
  share: (
    <>
      <circle cx="12.2" cy="3.8" r="2.1" />
      <circle cx="3.8" cy="8" r="2.1" />
      <circle cx="12.2" cy="12.2" r="2.1" />
      <path d="M5.7 7l4.6-2.3M5.7 9l4.6 2.3" />
    </>
  ),
  person: (
    <>
      <circle cx="8" cy="5.4" r="2.6" />
      <path d="M2.9 13.4a5.1 5.1 0 0110.2 0" />
    </>
  )
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.25
}: {
  name: IconName
  size?: number
  strokeWidth?: number
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
