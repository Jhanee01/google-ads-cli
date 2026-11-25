import { CliError } from './config.js'

/** A numeric resource ID (campaign, ad group, geo target...). Guards GAQL against injection. */
export function id(value: unknown, what = 'ID'): string {
  const s = String(value ?? '').trim()
  if (!/^\d+$/.test(s)) throw new CliError(`${what} must be numeric, got "${s}"`)
  return s
}

export function ids(list: string | undefined, what = 'ID'): string[] {
  return (list ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => id(s, what))
}

/** A GAQL string literal. */
export function str(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * The last N finished days (ending yesterday) as an explicit range; GAQL has no LAST_60_DAYS.
 * Local calendar days: close enough to the account time zone for windows this long.
 */
export function lastDaysClause(days: number, today = new Date()): string {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new CliError(`--days must be 1–365, got ${days}`)
  const day = (offset: number) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return `segments.date BETWEEN '${day(days)}' AND '${day(1)}'`
}

/** --days 1|7|14|30 → GAQL date clause (1 = yesterday, a full finished day; anything else → 30). */
export function dateClause(days: number): string {
  if (days === 1) return 'segments.date DURING YESTERDAY'
  const d = [7, 14, 30].includes(days) ? days : 30
  return `segments.date DURING LAST_${d}_DAYS`
}
