/// <reference types="vite/client" />

import type { WorkbenchApi } from '../../preload/index'

declare global {
  interface Window {
    term: WorkbenchApi
  }
}

export {}
