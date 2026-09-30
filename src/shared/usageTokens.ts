/** Local token accounting is separate from the providers' subscription quotas.
 * Cache reads are part of input, and reasoning is already part of output; adding
 * either again would inflate the total. These are counts, never billing estimates.
 */
export interface TokenCounts {
  input: number
  output: number
  cachedInput: number
  cacheWriteInput: number
}

export interface ProviderTokens {
  last7Days: TokenCounts | null
  sessions: Record<string, TokenCounts>
  observedAt: number | null
  partial: boolean
}

export interface UsageTokens {
  claude: ProviderTokens
  codex: ProviderTokens
  since: number
}

export function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 }
}

export function addTokens(to: TokenCounts, from: TokenCounts): void {
  to.input += from.input
  to.output += from.output
  to.cachedInput += from.cachedInput
  to.cacheWriteInput += from.cacheWriteInput
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
