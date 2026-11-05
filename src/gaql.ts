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

/** --days 7|14|30 → GAQL date clause (anything else → 30). */
export function dateClause(days: number): string {
  const d = [7, 14, 30].includes(days) ? days : 30
  return `segments.date DURING LAST_${d}_DAYS`
}
