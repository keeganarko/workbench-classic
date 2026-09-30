import type { JSX } from 'react'
import mark from '../../../../resources/workbench-mark.svg?url'

/** A mask follows the surrounding theme while preserving the website outline. */
export function WorkbenchMark({ size = 22 }: { size?: number }): JSX.Element {
  return <span aria-hidden="true" style={{
    display: 'inline-block', width: size, height: size, flexShrink: 0,
    backgroundColor: 'currentColor', mask: `url("${mark}") center / contain no-repeat`
  }} />
}
