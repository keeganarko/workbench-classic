import type { JSX } from 'react'
import { focusArtwork, type FocusArtKind } from '../../../shared/focusArtwork'
import '../styles/focus-task-art.css'

/** Hand-drawn SVG scenes stay cheap enough for every card. The large objects
 * communicate the work's subject; literal reports below communicate results.
 * Session-stable arrangements give two people in the same discipline their own
 * workspace without pretending to have generated an image of their exact task. */
export function FocusTaskArt({ id, title, task, summary }: {
  id: string; title: string; task?: string; summary?: string
}): JSX.Element {
  const art = focusArtwork({ id, title, task, summary })
  return <div className={`focus-art focus-art--${art.kind}`} data-art-kind={art.kind} data-art-variant={art.variant}>
    <svg viewBox="0 0 320 180" role="img" aria-label={`${art.label} — task illustration for ${title}`}>
      <ellipse className="fa-shadow" cx="160" cy="155" rx="107" ry="13" />
      <path className="fa-backdrop" d={art.variant === 0 ? 'M40 134V61L115 24L264 64V135Z' : art.variant === 1 ? 'M51 137V43L206 23L277 76V137Z' : 'M40 133L62 61L156 26L274 60V133Z'} />
      <g transform={`translate(${art.variant === 1 ? -8 : art.variant === 2 ? 9 : 0} 0)`}><Scene kind={art.kind} variant={art.variant} /></g>
      {art.variant === 0 ? <g className="fa-decoration"><path d="M263 110V146M250 119L263 130L277 112" /><path className="fa-leaf" d="M250 103L250 119L262 120Z M278 98L277 112L265 114Z" /><path className="fa-mid" d="M251 143H275L272 157H254Z" /></g>
        : art.variant === 1 ? <g className="fa-decoration"><path className="fa-paper" d="M248 122H273V148H248Z" /><path d="M255 128H267M255 135H264M255 142H260" /><path className="fa-warm" d="M272 145L283 116L287 118L277 147Z" /></g>
          : <g className="fa-decoration"><path className="fa-warm" d="M39 134H60V151H39Z" /><path d="M60 137H67V145H60M45 124V128M53 122V128" /></g>}
    </svg>
    <span className="focus-art-label">{art.label}</span>
  </div>
}

function Scene({ kind, variant }: { kind: FocusArtKind; variant: number }): JSX.Element {
  switch (kind) {
    case 'finance': return <>
      <path className="fa-paper" d="M85 53L191 43L206 143L96 151Z" /><path className="fa-line" d="M105 71L172 65M108 81L150 77M112 134L186 127" />
      <path className="fa-mid" d="M118 122V104L132 102V120Z M141 119V92L155 90V117Z" /><path className="fa-accent" d="M164 116V79L178 77V114Z" />
      <path className="fa-warm" d="M205 121L226 109L247 121V145L226 157L205 145Z" /><path className="fa-line" d="M205 129L226 141L247 129M205 137L226 149L247 137M226 121V132" />
    </>
    case 'design': return <>
      <path className="fa-mid" d="M73 56L198 45L215 132L87 146Z" /><path className="fa-paper" d="M84 65L189 56L201 121L98 133Z" />
      <path className="fa-accent" d="M93 73L119 71L122 120L102 123Z" /><path className="fa-warm" d="M129 70L181 66L184 86L132 90Z" />
      <path className="fa-mid" d="M135 99L153 97L156 116L138 118Z M163 96L186 94L190 112L166 115Z" />
      <path className="fa-warm" d="M213 69L225 64L246 139L237 157L227 144Z" /><path className="fa-line" d="M213 69L227 144L246 139M237 157L241 149" />
    </>
    case 'research': return <>
      <path className="fa-paper" d="M66 105L130 91L160 104L216 90L233 139L173 154L144 142L82 155Z" /><path className="fa-line" d="M130 91L144 142M160 104L173 154M87 117L121 109M91 128L126 120M185 122L212 115" />
      <path className="fa-mid" d="M179 82L220 118L212 127L171 91Z" /><circle className="fa-accent" cx="160" cy="65" r="35" /><circle className="fa-paper" cx="160" cy="65" r="25" />
      <path className="fa-line" d="M145 69L155 56L163 73L175 60" />
    </>
    case 'writing': return <>
      <path className="fa-mid" d="M95 55L185 47L203 148L106 156Z" /><path className="fa-paper" d="M82 41L174 34L192 135L98 143Z" />
      <path className="fa-line" d="M104 61L153 57M108 74L164 69M110 86L157 82M114 99L170 94M117 112L146 110" />
      <path className="fa-accent" d="M202 53L236 65L184 140L169 149L171 130Z" /><path className="fa-line" d="M216 59L171 130L184 140M169 149L180 143" />
    </>
    case 'security': return <>
      <path className="fa-mid" d="M159 29L223 54L214 108L159 152L104 108L95 54Z" /><path className="fa-accent" d="M159 29V152L214 108L223 54Z" />
      <path className="fa-paper" d="M133 80H184V118H133Z" /><path className="fa-line" d="M143 80V67C143 44 175 44 175 67V80M159 93V105" />
      <path className="fa-warm" d="M235 118L253 128L253 147L235 157L217 147V128Z" /><path className="fa-line" d="M235 131V142" />
    </>
    case 'shipping': return <>
      <path className="fa-mid" d="M88 106L136 83L180 107V145L133 165L88 145Z" /><path className="fa-line" d="M88 106L133 128L180 107M133 128V165M110 96L155 118" />
      <path className="fa-paper fa-lift" d="M189 37L218 56L230 94L202 117L176 93L177 60Z" /><path className="fa-accent" d="M189 37L218 56L177 60Z M177 79L156 111L179 103Z M225 79L248 110L227 102Z" />
      <circle className="fa-mid" cx="201" cy="77" r="12" /><path className="fa-warm" d="M188 112L202 144L215 112Z" />
    </>
    case 'knowledge': return <>
      <path className="fa-paper" d="M76 113L139 104L161 113L215 100L239 139L178 152L151 142L93 153Z" /><path className="fa-line" d="M139 104L151 142M161 113L178 152" />
      <path className="fa-line" d="M162 114V66M162 66L111 48M162 66L208 41M162 66L226 83M162 66L116 85" />
      <path className="fa-accent" d="M162 42L182 54V78L162 90L142 78V54Z" /><path className="fa-warm" d="M208 24L224 33V51L208 60L192 51V33Z" />
      <path className="fa-mid" d="M111 34L124 41V55L111 63L98 55V41Z M226 69L239 76V90L226 98L213 90V76Z" /><circle className="fa-warm" cx="116" cy="85" r="8" />
    </>
    case 'planning': return <>
      <path className="fa-paper" d="M74 50L225 40L238 128L90 142Z" /><path className="fa-line" d="M105 129L97 69L135 66L144 105L185 101L178 59L210 56" />
      <path className="fa-mid" d="M88 59L111 57L115 81L92 83Z M132 93L156 91L160 115L136 117Z" /><path className="fa-accent" d="M169 48L193 46L197 71L173 73Z" />
      <path className="fa-warm" d="M221 106V150L206 158L201 129Z" />
    </>
    case 'coding': return <>
      <path className="fa-mid" d="M69 47L205 43L216 127L80 134Z" /><path className="fa-paper" d="M81 58L194 55L202 115L89 122Z" />
      <path className="fa-line" d="M116 77L103 88L119 98M166 75L183 85L170 96M150 72L140 103" /><path className="fa-accent" d="M80 134L216 127L240 145L107 157Z" />
      <path className="fa-warm" d="M221 78L243 65L265 78V103L243 116L221 103Z" /><path className="fa-line" d="M221 78L243 91L265 78M243 91V116" />
    </>
    default: return <>
      <path className="fa-mid" d={variant === 1 ? 'M83 95L211 74L245 125L109 151Z' : 'M73 118L203 92L245 129L110 156Z'} />
      <path className="fa-paper" d="M108 79L178 66L198 124L126 140Z" /><path className="fa-line" d="M126 92L164 84M131 104L174 96M136 116L166 110" />
      <path className="fa-accent" d="M191 65L230 49L235 59L198 76Z" /><path className="fa-warm" d="M215 86L237 81L243 116L221 121Z" />
    </>
  }
}
