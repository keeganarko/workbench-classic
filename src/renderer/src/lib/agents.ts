/**
 * Asking the registry about an agent, from the renderer.
 *
 * These replace the two `Record<AgentKind, string>` maps that used to live in
 * `ui.ts`. A literal map was fine while the app shipped exactly three agents;
 * with a registry the user can add to, `AGENT_LABEL[id]` becomes `undefined`
 * for a perfectly valid session, which renders as an empty chip rather than an
 * error — the worst kind of failure.
 *
 * The resolved profiles come from main (they carry `available` and `version`,
 * which need a disk), so these are store reads. Every hook here returns a
 * primitive on purpose: a selector returning a string or a boolean is compared
 * by value, so the twice-a-second state push from main re-renders nothing.
 */

import { useMemo } from 'react'

import { useStore } from '../state/store'
import { definitionOr } from '../../../shared/agents'
import type { AgentCapabilities } from '../../../shared/agents'
import type { AgentProfile } from '../../../shared/types'

/**
 * The profile for an id, or a stand-in that renders correctly and can do
 * nothing.
 *
 * A session on disk can name an agent the user has since deleted from
 * Settings. Falling back to the built-in registry first keeps `claude` looking
 * like Claude even before main's first state push has arrived; falling back to
 * the id itself keeps a deleted profile's sessions visible and legible instead
 * of blank.
 */
export function profileOf(id: string, profiles: AgentProfile[]): AgentProfile {
  const found = profiles.find((p) => p.id === id)
  if (found) return found
  const def = definitionOr(id)
  return {
    id: def.id,
    label: def.label,
    command: def.bin,
    args: def.args,
    color: def.color,
    available: false,
    version: null,
    capabilities: def.capabilities,
    builtin: def.builtin
  }
}

export function useAgentLabel(id: string): string {
  return useStore((s) => profileOf(id, s.profiles).label)
}

export function useAgentColor(id: string): string {
  return useStore((s) => profileOf(id, s.profiles).color)
}

/** Does this agent claim `cap`? False for anything unknown — the safe answer. */
export function useAgentCan(id: string, cap: keyof AgentCapabilities): boolean {
  return useStore((s) => profileOf(id, s.profiles).capabilities[cap])
}

/** Every profile this install knows about, built-ins first. */
export function useProfiles(): AgentProfile[] {
  return useStore((s) => s.profiles)
}

/**
 * Profiles worth offering in a "new session" list.
 *
 * An agent whose command is not on PATH is left out rather than shown
 * disabled: the launch would fail with a message naming the command, and a
 * dialog full of things that cannot be started is worse than a short one. It
 * comes back the moment the CLI is installed and the app is reopened.
 */
export function useLaunchableProfiles(): AgentProfile[] {
  // Memoised over the array, not computed inside the selector: a selector that
  // builds a fresh array every call hands `useSyncExternalStore` a new snapshot
  // each time and re-renders forever. `applyState` keeps `profiles` identity
  // stable across pushes so this recomputes only when they really change.
  const profiles = useProfiles()
  return useMemo(() => profiles.filter((p) => p.available), [profiles])
}
