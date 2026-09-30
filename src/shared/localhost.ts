/**
 * Local servers: spotting one in agent output, and deciding it is safe to load.
 *
 * An agent that runs `npm run dev` prints a URL and then waits. That URL is the
 * one piece of an agent's output that is worth acting on automatically — it is
 * the difference between "it says it started the server" and looking at the
 * page. So the pane learns to read it.
 *
 * Two functions with deliberately different strictness, and the difference is
 * the security boundary:
 *
 *   - `findServerUrl` reads **untrusted text**. An agent's terminal output is
 *     input, not instruction, so it is generous about shapes but narrow about
 *     hosts, and it hands back a URL nobody has agreed to load yet.
 *   - `isLoopbackUrl` is the gate the preview frame actually consults, and it
 *     accepts only a host that cannot be anywhere but this machine.
 *
 * Keep this file free of runtime imports — both processes use it.
 */

/** `127.0.0.0/8`, the whole loopback block, not just `127.0.0.1`. */
const V4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/**
 * A URL the preview frame may load.
 *
 * Only loopback: `localhost`, the `*.localhost` names some frameworks hand
 * out, and anything in `127.0.0.0/8`. Everything else — including a LAN
 * address a dev server also prints, and including `0.0.0.0` — goes to the OS
 * browser instead, where it is the browser's problem and not this window's.
 *
 * `[::1]` is deliberately **not** on the list, even though it is loopback. The
 * renderer's `frame-src` has to name the same set this function does, and a
 * bracketed IPv6 host-source is the one CSP form whose parsing this app cannot
 * test from here — a directive that fails to parse takes the whole preview
 * pane down with it. `findServerUrl` rewrites `::1` to `localhost` instead,
 * which reaches the same server and keeps the two gates identical.
 *
 * Credentials in the URL are refused outright. `http://localhost@evil.test`
 * has hostname `evil.test` and would fail anyway, but the reverse shape is the
 * kind of thing that should never be one parser change away from passing.
 */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return V4_LOOPBACK.test(host)
}

/**
 * `http://localhost:5173` → `:5173`, for a chip that has no room for more.
 *
 * The port is the part that identifies a dev server to the person running six
 * of them; the host is `localhost` every time and says nothing.
 */
export function serverLabel(raw: string): string {
  try {
    const url = new URL(raw)
    return url.port ? `:${url.port}` : url.hostname
  } catch {
    return raw
  }
}

/**
 * Hosts that mean "here" but are not written that way.
 *
 * `0.0.0.0` means "every interface", which includes this one. Frameworks that
 * bind it print it verbatim, and the address is useless as written — nothing
 * connects *to* `0.0.0.0`. Rewriting it to `localhost` is what the person
 * reading the line does in their head anyway. `[::1]` is rewritten for a
 * different reason — see `isLoopbackUrl` — and reaches the same server.
 */
const ANY_HOST = /^(https?:\/\/)(?:0\.0\.0\.0|\[::1\])(?=[:/]|$)/i

/** Trailing punctuation that belongs to the sentence, not to the URL. */
const TRAILING = /[.,;:!?)\]}'"`]+$/

const SERVER_RE =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s"'`<>)\]]*)?/gi

/**
 * The local server URL in a chunk of terminal output, or null.
 *
 * The **last** match wins: output is read newest-last, and a session that has
 * restarted its server twice is advertising the third port, not the first.
 *
 * A LAN address printed next to it (Vite's "Network:" line) is not matched at
 * all, which is the intended outcome — it is the same server, and the loopback
 * name is the one that keeps working when the laptop changes networks.
 */
export function findServerUrl(text: string): string | null {
  const matches = text.match(SERVER_RE)
  if (!matches) return null
  for (let i = matches.length - 1; i >= 0; i--) {
    const cleaned = matches[i].replace(TRAILING, '').replace(ANY_HOST, '$1localhost')
    if (isLoopbackUrl(cleaned)) return cleaned
  }
  return null
}
