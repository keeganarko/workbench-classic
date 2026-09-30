import { useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../state/store'
import { guestColor, guestInitials, MAX_GUESTS } from '../../../shared/share'
import { Icon } from './Icon'

const api = window.term

/**
 * The host's side of a share: the link, how far it reaches, and who has it.
 *
 * The typing controls are here and nowhere else. Granting write access to a
 * terminal running coding agents is the one genuinely dangerous thing this
 * feature can do, so it is a deliberate click in a dialog the host opened —
 * never a default, never inferable from the guest's side, and always revocable
 * from the same row that granted it.
 */
export function ShareDialog({ sessionId }: { sessionId: string }): JSX.Element {
  const shares = useStore((s) => s.shares)
  const tunnel = useStore((s) => s.tunnel)
  const sessions = useStore((s) => s.sessions)
  const [busy, setBusy] = useState(false)

  const share = shares.find((s) => s.sessionId === sessionId)
  const session = sessions.find((s) => s.id === sessionId)
  const close = (): void => useStore.getState().setOverlay({ kind: 'none' })
  const toast = useStore.getState().setToast

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.shareStart(sessionId)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start sharing.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    await api.shareStop(sessionId).catch(() => undefined)
    close()
  }

  /**
   * Whether the link in the field is one that will work on someone else's
   * device.
   *
   * This matters more than it looks. The server binds loopback, so until the
   * tunnel lands the URL is `http://127.0.0.1:<port>/…` — which on any other
   * machine resolves to *that* machine and fails with nothing useful on screen.
   * A phone is the worst case: the host copies, sends, and the guest sees a
   * blank error page that says nothing about why.
   */
  const publicReady = share?.reach === 'tunnel'
  const tunnelComing = tunnel.status === 'off' || tunnel.status === 'starting'
  /**
   * The tunnel published a link but it never answered our test request. It may
   * be fine and merely slow, so the link is not withheld — but the host is told
   * before they send it, not after their friend hits an error page.
   */
  const unverified = tunnel.status === 'up' && Boolean(tunnel.warning)

  const copy = (): void => {
    if (!share?.url) return
    void api.writeClipboard(share.url)
    toast(
      unverified
        ? 'Copied — but this link has not answered a test request yet.'
        : publicReady
          ? 'Link copied. Anyone with it can watch this session.'
          : 'Copied — but this link only opens on this machine.',
      publicReady && !unverified ? 'success' : 'info'
    )
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal" style={{ width: 520 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">Share “{session?.title ?? 'session'}”</div>

        <div className="modal__body">
          {!share ? (
            <>
              <p className="share__lede">
                Hand this session to up to {MAX_GUESTS} people over a link. They watch in a
                browser — no install, no account, nothing to set up on their side.
              </p>
              <p className="share__note">
                Everyone joins as a watcher. Typing is off until you turn it on per person.
              </p>
            </>
          ) : (
            <>
              <div className="field">
                <span className="field__label">Link</span>
                <div className="share__link">
                  <input
                    readOnly
                    value={
                      publicReady
                        ? (share.url ?? '')
                        : tunnelComing
                          ? 'Publishing a link that works anywhere…'
                          : (share.url ?? '')
                    }
                    onFocus={(e) => e.target.select()}
                  />
                  {/*
                    Withheld for the second the tunnel takes, rather than handing
                    over a loopback URL that cannot work on another device. If
                    the tunnel is genuinely unavailable there is nothing better
                    to offer, so the local link comes back — labelled honestly.
                  */}
                  <button
                    className="btn"
                    onClick={copy}
                    disabled={!share.url || tunnelComing}
                  >
                    {unverified
                      ? 'Copy anyway'
                      : publicReady
                        ? 'Copy'
                        : tunnelComing
                          ? 'Preparing…'
                          : 'Copy local link'}
                  </button>
                </div>
              </div>

              <Reach reach={share.reach} tunnel={tunnel} />

              <div className="field">
                <span className="field__label">
                  People — {share.guests.length} of {MAX_GUESTS}
                </span>
                {share.guests.length === 0 ? (
                  <div className="share__empty">
                    Nobody has joined yet. They will be asked for a name when they open the link.
                  </div>
                ) : (
                  <ul className="share__guests">
                    {share.guests.map((g) => (
                      <li key={g.id}>
                        <span className="presence__mark" style={{ background: guestColor(g.id) }}>
                          {guestInitials(g.name)}
                        </span>
                        <span className="share__name">{g.name}</span>
                        <span className="share__role">{g.canType ? 'can type' : 'watching'}</span>
                        <button
                          className="btn btn--ghost btn--sm"
                          title={
                            g.canType
                              ? 'Revoke typing — they go back to watching'
                              : 'Let this person type into the session. They get the same reach as you.'
                          }
                          onClick={() => void api.shareSetCanType(sessionId, g.id, !g.canType)}
                        >
                          {g.canType ? 'Revoke' : 'Let them type'}
                        </button>
                        <button
                          className="btn btn--ghost btn--sm"
                          title="Remove this person from the share"
                          onClick={() => void api.shareKick(sessionId, g.id)}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={close}>
            Close
          </button>
          {share ? (
            <button className="btn btn--danger" onClick={() => void stop()}>
              Stop sharing
            </button>
          ) : (
            <button className="btn btn--primary" disabled={busy} onClick={() => void start()}>
              {busy ? 'Starting…' : 'Create link'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * How far the link goes, said plainly.
 *
 * A host who hands out a LAN-only URL to someone in another city gets a dead
 * link and no explanation, so the failure that produces that — `cloudflared`
 * missing — is spelled out here with the command that fixes it rather than
 * hidden behind a generic "local only" label.
 */
function Reach({
  reach,
  tunnel
}: {
  reach: 'local' | 'pending' | 'tunnel'
  tunnel: { status: string; reason?: string; warning?: string }
}): JSX.Element {
  if (reach === 'tunnel') {
    // A working tunnel this machine cannot see is still a working tunnel. Say
    // both halves, or the host tests their own link, gets nothing, and stops
    // sharing something that was fine for the person on the other end.
    if (tunnel.warning) {
      return (
        <div className="share__reach share__reach--warn">
          <Icon name="globe" size={13} />
          {tunnel.warning}
        </div>
      )
    }
    return (
      <div className="share__reach share__reach--ok">
        <Icon name="globe" size={13} />
        Works anywhere. Anyone with this link can watch.
      </div>
    )
  }
  if (reach === 'pending' || tunnel.status === 'starting') {
    return (
      <div className="share__reach">
        <Icon name="globe" size={13} />
        Opening a public link… the address above only opens on this machine meanwhile.
      </div>
    )
  }
  return (
    <div className="share__reach share__reach--warn">
      <Icon name="globe" size={13} />
      {tunnel.reason ?? 'This link works on your network only.'}
    </div>
  )
}
