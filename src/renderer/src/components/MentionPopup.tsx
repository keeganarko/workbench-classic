import type { JSX } from 'react'
import { profileOf, useProfiles } from '../lib/agents'
import { slugify, type MentionTarget } from '../../../shared/mentions'

/**
 * The `@` autocomplete list.
 *
 * Shows dead sessions greyed rather than hiding them: "@reviewer is exited" is
 * a useful thing to learn, and an empty popup for a name you know you gave a
 * session reads as a bug in the matcher.
 */
export function MentionPopup(props: {
  items: MentionTarget[]
  active: number
  onPick: (t: MentionTarget) => void
  onHover: (i: number) => void
}): JSX.Element | null {
  // Read once for the whole list rather than a hook per row: the colour now
  // comes from the agent registry, which the user can add to, so a literal map
  // would render a custom agent's dot as the fallback grey.
  const profiles = useProfiles()
  if (props.items.length === 0) return null
  return (
    <div className="mention" role="listbox" aria-label="Sessions">
      {props.items.map((t, i) => (
        <button
          key={t.id}
          role="option"
          aria-selected={i === props.active}
          className={`mention__row${i === props.active ? ' mention__row--on' : ''}${
            t.alive ? '' : ' mention__row--dead'
          }`}
          // Pointer-down rather than click: the textarea must not lose focus
          // before the pick lands, or the caret jumps and the insert goes in
          // at the wrong offset.
          onMouseDown={(e) => {
            e.preventDefault()
            props.onPick(t)
          }}
          onMouseEnter={() => props.onHover(i)}
        >
          <span
            className="mention__dot"
            style={{ color: profileOf(t.agent, profiles).color }}
          >
            ●
          </span>
          <span className="mention__name">@{slugify(t.title) || t.id.slice(0, 8)}</span>
          <span className="mention__title">{t.lastTask || t.title}</span>
          {!t.alive && <span className="mention__flag">exited</span>}
        </button>
      ))}
      <div className="mention__hint">↑↓ choose · ⏎ or ⇥ insert · esc dismiss</div>
    </div>
  )
}
