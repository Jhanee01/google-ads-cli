import { config, validateConfig, digits, CliError } from './config.js'

export type GadsRow = Record<string, any>

let cached: { value: string; expiresAt: number } | null = null

/** For tests. */
export function resetTokenCache(): void { cached = null }

async function getAccessToken(): Promise<string> {
  validateConfig()
  if (cached && Date.now() < cached.expiresAt) return cached.value
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    if (text.includes('invalid_grant')) {
      throw new CliError(
        'The refresh token has expired or was revoked (invalid_grant). Create a new one (see README, "Credentials"). ' +
          'OAuth apps left in "Testing" publishing status issue refresh tokens that expire after 7 days.',
      )
    }
    throw new CliError(`OAuth token refresh failed (${res.status}): ${text}`)
  }
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cached = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 }
  return data.access_token
}

export function resolveCustomerId(customerId?: string): string {
  const cid = digits(customerId ?? config.customerId)
  if (!cid) throw new CliError('A customer ID is required: pass --customer-id <id> or set GOOGLE_ADS_CUSTOMER_ID.')
  return cid
}

function headers(token: string, cid: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'developer-token': config.developerToken,
    'Content-Type': 'application/json',
  }
  // Only when the account is reached through a manager account.
  if (config.loginCustomerId && config.loginCustomerId !== cid) h['login-customer-id'] = config.loginCustomerId
  return h
}

/** Turns a Google Ads error response into one readable line (error codes, messages, field paths). */
export function apiErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body)
    const root = Array.isArray(parsed) ? parsed[0] : parsed
    const err = root?.error
    const details = err?.details?.flatMap((d: any) => d?.errors ?? []) ?? []
    if (details.length) {
      return details
        .map((e: any) => {
          const code = e.errorCode ? Object.values(e.errorCode)[0] : ''
          const field = e.location?.fieldPathElements?.map((p: any) => p.fieldName).join('.')
          return `${code}: ${e.message}${field ? ` (${field})` : ''}`
        })
        .join('; ')
    }
    if (err?.message) return `${status}: ${err.message}`
  } catch {
    /* not JSON */
  }
  return `${status}: ${body.slice(0, 500)}`
}

/** Runs a GAQL query on the searchStream endpoint and returns all result rows. */
export async function search(query: string, customerId?: string): Promise<GadsRow[]> {
  const cid = resolveCustomerId(customerId)
  const token = await getAccessToken()
  const url = `https://googleads.googleapis.com/${config.apiVersion}/customers/${cid}/googleAds:searchStream`
  const res = await fetch(url, { method: 'POST', headers: headers(token, cid), body: JSON.stringify({ query }) })
  if (!res.ok) throw new CliError(`Query failed → ${apiErrorMessage(res.status, await res.text())}`)
  const batches = (await res.json()) as Array<{ results?: GadsRow[] }>
  return batches.flatMap(b => b.results ?? [])
}

/**
 * A mutate call, e.g. endpoint "campaignCriteria:mutate". The operations of one call succeed or
 * fail together. With validateOnly the API checks everything and changes nothing.
 */
export async function mutate(
  endpoint: string,
  operations: unknown[],
  customerId?: string,
  opts: { validateOnly?: boolean } = {},
): Promise<any> {
  const cid = resolveCustomerId(customerId)
  const token = await getAccessToken()
  const url = `https://googleads.googleapis.com/${config.apiVersion}/customers/${cid}/${endpoint}`
  const body: Record<string, unknown> = { operations }
  if (opts.validateOnly) body.validateOnly = true
  const res = await fetch(url, { method: 'POST', headers: headers(token, cid), body: JSON.stringify(body) })
  if (!res.ok) throw new CliError(`${endpoint} → ${apiErrorMessage(res.status, await res.text())}`)
  return res.json()
}

/** micros (string or number) → account currency units, 2 decimals. */
export function micros(v: unknown): number {
  return Math.round((Number(v ?? 0) / 1_000_000) * 100) / 100
}

/** Account currency units → micros, as the string the REST API expects for int64. */
export function toMicros(amount: number): string {
  return String(Math.round(amount * 1_000_000))
}

export const round2 = (v: unknown): number => Math.round(Number(v ?? 0) * 100) / 100
