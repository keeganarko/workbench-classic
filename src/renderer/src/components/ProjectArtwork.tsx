import type { CSSProperties, JSX } from 'react'
import { PROJECT_COLORS, type ProjectAppearance, type ProjectStroke } from '../../../shared/projectAppearance'
import { PROJECT_SYMBOLS, projectIdentity } from '../../../shared/projectIdentity'

/** Both shell themes use a readable shade of the same saved accent. */
export function projectDesignStyle(appearance?: ProjectAppearance): CSSProperties {
  const color = PROJECT_COLORS.find((item) => item.id === appearance?.color) ?? PROJECT_COLORS[0]
  return { '--project-color-dark': color.dark, '--project-color-light': color.light } as CSSProperties
}

export function SketchLines({ strokes }: { strokes: ProjectStroke[] }): JSX.Element {
  return <>{strokes.map((stroke, i) => stroke.length === 1
    ? <circle key={i} cx={stroke[0][0]} cy={stroke[0][1]} r="1.75" fill="currentColor" stroke="none" />
    : <polyline key={i} points={stroke.map((point) => point.join(',')).join(' ')} />)}</>
}

/**
 * Small flat illustrations share a square coordinate system with the drawing
 * pad. Cards, header art, and sidebar marks all render the same saved design;
 * no thumbnail can become stale after a color change or a project rename.
 */
export function ProjectArt({ name, appearance, className = '' }: { name?: string; appearance?: ProjectAppearance; className?: string }): JSX.Element | null {
  if (!appearance || appearance.artwork === 'none' || (appearance.artwork === 'sketch' && !appearance.strokes.length)) {
    if (name === undefined) return null
    const identity = projectIdentity(name)
    return <svg className={`project-art project-name-art ${className}`} viewBox="0 0 24 24" width="24" height="24"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {identity.symbol ? <path d={PROJECT_SYMBOLS[identity.symbol]} /> : <>
        <rect x="2" y="2" width="20" height="20" rx={[4, 8, 2, 10][identity.frame]} opacity=".4" />
        <text x="12" y="12.5" dominantBaseline="middle" textAnchor="middle" fill="currentColor" stroke="none"
          fontFamily="system-ui, sans-serif" fontSize="9" fontWeight="650">{identity.initials}</text>
      </>}
    </svg>
  }
  return <svg className={`project-art ${className}`} viewBox="0 0 160 160" width="160" height="160"
    fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {appearance.artwork === 'sprout' && <>
      <path d="M80 136V76M80 101C48 101 27 80 30 48C59 47 80 67 80 101Z" />
      <path d="M80 81C80 46 102 25 131 29C130 60 110 81 80 81Z" fill="currentColor" fillOpacity=".17" />
      <path d="M80 103L48 70M80 79L111 48M58 137H102" />
      <circle cx="34" cy="126" r="5" fill="currentColor" stroke="none" />
    </>}
    {appearance.artwork === 'waves' && <>
      <circle cx="117" cy="44" r="17" fill="currentColor" stroke="none" />
      <path d="M19 83C40 59 56 105 80 83S120 60 141 83M19 105C40 81 56 127 80 105S120 82 141 105M19 127C40 103 56 149 80 127S120 104 141 127" />
      <path d="M20 47H55M29 35H45" opacity=".35" />
    </>}
    {appearance.artwork === 'sun' && <>
      <path d="M43 105A37 37 0 0 1 117 105" fill="currentColor" fillOpacity=".2" />
      <path d="M20 106H140M35 121H125M57 136H103M80 29V44M28 51L39 63M132 51L121 63M12 84L28 88M148 84L132 88" />
      <circle cx="80" cy="91" r="8" fill="currentColor" stroke="none" />
    </>}
    {appearance.artwork === 'orbit' && <>
      <circle cx="80" cy="80" r="26" fill="currentColor" fillOpacity=".17" />
      <ellipse cx="80" cy="80" rx="66" ry="28" transform="rotate(-34 80 80)" />
      <circle cx="127" cy="41" r="8" fill="currentColor" stroke="none" />
      <path d="M31 28V42M24 35H38M126 120V132M120 126H132" />
    </>}
    {appearance.artwork === 'sketch' && <SketchLines strokes={appearance.strokes} />}
  </svg>
}

export function ProjectMark({ name, appearance }: { name: string; appearance?: ProjectAppearance }): JSX.Element {
  return <span className="px-projectmark project-design" style={projectDesignStyle(appearance)} aria-hidden="true">
    <ProjectArt name={name} appearance={appearance} />
  </span>
}
