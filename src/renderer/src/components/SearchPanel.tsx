import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { activeSessionId } from '../lib/actions'
import { preview } from '../lib/preview'
import { shortPath } from '../lib/ui'
import { Icon } from './Icon'
import { PanelEmpty } from './PanelEmpty'
import type { SearchHit, SearchResult } from '../../../shared/types'

const api = window.term

/** Long enough that a keystroke is not a sweep, short enough to feel live. */
const DEBOUNCE_MS = 250

/**
 * Find text in the folder the focused agent is working in.
 *
 * Scoped to that session on purpose — "search what this agent is editing" is a
 * question with an answer, where "search everything" is a second app. Results
 * open in the preview pane rather than an editor, because this is a place to
 * read what happened, and the pane already renders every kind of file the
 * search can turn up.
 *
 * The query is **literal text, not a pattern.** A regular expression typed into
 * a sidebar would run inside the process that also drives every terminal in the
 * window, and one accidental backtrack would freeze all of them. Substring
 * matching cannot do that, and it is what the box gets used for anyway.
 */
export function SearchPanel(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const openDoc = useStore((s) => s.preview.doc?.path ?? null)

  const sessionId = activeSessionId()
  const session = sessions.find((s) => s.id === sessionId) ?? null

  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  // What the newest request asked for. Anything else landing is a stale answer.
  const want = useRef('')

  useEffect(() => {
    input.current?.focus()
  }, [])

  useEffect(() => {
    const text = query.trim()
    const key = `${sessionId} ${caseSensitive} ${text}`
    want.current = key
    if (!sessionId || !text) {
      setResult(null)
      setBusy(false)
      setError(null)
      return
    }
    setBusy(true)
    const timer = setTimeout(() => {
      void api
        .filesSearch(sessionId, text, caseSensitive)
        .then((res) => {
          if (want.current !== key) return
          setResult(res)
          setError(null)
        })
        .catch((err: Error) => {
          if (want.current !== key) return
          setResult(null)
          setError(err.message)
        })
        .finally(() => {
          if (want.current === key) setBusy(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, caseSensitive, sessionId])

  if (!session) {
    return (
      <PanelEmpty title="No session focused" note="Focus a pane to search the folder it runs in." />
    )
  }

  const groups = groupByFile(result?.hits ?? [])
  const text = query.trim()

  return (
    <div className="search">
      <div className="search__head">
        <Icon name="search" size={13} />
        <input
          ref={input}
          className="search__input"
          value={query}
          spellCheck={false}
          placeholder={`Find in ${shortPath(session.cwd)}`}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Escape clears the box before it reaches the app, where it would
            // otherwise close an overlay that is not the thing you meant.
            if (e.key === 'Escape' && query) {
              e.stopPropagation()
              setQuery('')
            }
          }}
        />
        <button
          className={`chip${caseSensitive ? ' chip--on' : ''}`}
          title="Match capitalisation exactly"
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
      </div>

      {error ? (
        <div className="search__note search__note--bad">{error}</div>
      ) : !text ? (
        <div className="search__note">
          Literal text, not a pattern. Build output and dependencies are skipped.
        </div>
      ) : busy ? (
        <div className="search__note">Searching…</div>
      ) : !result || result.hits.length === 0 ? (
        <div className="search__note">
          No matches in {result?.scanned ?? 0} file{result?.scanned === 1 ? '' : 's'}.
        </div>
      ) : (
        <>
          <div className="search__note">
            {result.hits.length} match{result.hits.length === 1 ? '' : 'es'} in {groups.length} file
            {groups.length === 1 ? '' : 's'}
            {result.truncated && ' — stopped early, narrow the search'}
          </div>
          <div className="search__scroll">
            {groups.map((group) => (
              <div className="search__file" key={group.rel}>
                <div className="search__file-head" title={group.rel}>
                  <span className="search__file-name">{basename(group.rel)}</span>
                  <span className="search__file-dir">{dirname(group.rel)}</span>
                  <span className="search__file-count">{group.hits.length}</span>
                </div>
                {group.hits.map((hit) => (
                  <button
                    key={`${hit.line}:${hit.offset}`}
                    className={`search__hit${hit.path === openDoc ? ' search__hit--open' : ''}`}
                    title={`${group.rel}:${hit.line}`}
                    onClick={() => void preview.open(hit.path, { owner: sessionId })}
                  >
                    <span className="search__line">{hit.line}</span>
                    <span className="search__text">
                      {hit.text.slice(0, hit.offset)}
                      <mark className="search__mark">
                        {hit.text.slice(hit.offset, hit.offset + text.length)}
                      </mark>
                      {hit.text.slice(hit.offset + text.length)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Hits arrive sorted by path then line, so one pass groups them.
 *
 * Grouping rather than a flat list because the useful shape of an answer is
 * "three files, and here is where in each" — a flat list of forty lines from
 * one file buries the other two.
 */
function groupByFile(hits: SearchHit[]): { rel: string; hits: SearchHit[] }[] {
  const out: { rel: string; hits: SearchHit[] }[] = []
  for (const hit of hits) {
    const last = out[out.length - 1]
    if (last && last.rel === hit.rel) last.hits.push(hit)
    else out.push({ rel: hit.rel, hits: [hit] })
  }
  return out
}

function basename(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? rel : rel.slice(cut + 1)
}

function dirname(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? '' : rel.slice(0, cut)
}
