/**
 * Pure functions: current state + requested change → mutate operations and a human-readable
 * summary. No network here, so every rule is unit-tested.
 */
import { CliError } from './config.js'
import { micros, toMicros } from './client.js'

export type Op = Record<string, unknown>
export interface Mutation { endpoint: string; operations: Op[] }
export interface Change { summary: string[]; warnings: string[]; mutations: Mutation[] }

const change = (): Change => ({ summary: [], warnings: [], mutations: [] })
const push = (c: Change, endpoint: string, ops: Op[]) => { if (ops.length) c.mutations.push({ endpoint, operations: ops }) }

// --- negative keywords -------------------------------------------------------

export type MatchType = 'EXACT' | 'PHRASE' | 'BROAD'

export function matchType(v: string | undefined): MatchType {
  const m = String(v ?? 'EXACT').toUpperCase()
  if (m !== 'EXACT' && m !== 'PHRASE' && m !== 'BROAD') throw new CliError(`--match must be EXACT, PHRASE or BROAD, got "${v}"`)
  return m
}

export function buildAddNegatives(input: {
  campaignResource: string
  campaignName: string
  terms: string[]
  match: MatchType
  existing: Array<{ text: string; match: string }>
}): Change {
  const c = change()
  const have = new Set(input.existing.map(e => `${e.text.toLowerCase()}|${e.match}`))
  const seen = new Set<string>()
  const ops: Op[] = []
  for (const raw of input.terms) {
    const text = raw.trim()
    if (!text) continue
    const key = `${text.toLowerCase()}|${input.match}`
    if (have.has(key)) { c.warnings.push(`"${text}" [${input.match}] is already a negative, skipped`); continue }
    if (seen.has(key)) continue
    seen.add(key)
    ops.push({ create: { campaign: input.campaignResource, negative: true, keyword: { text, matchType: input.match } } })
    c.summary.push(`add negative "${text}" [${input.match}] to campaign "${input.campaignName}"`)
  }
  push(c, 'campaignCriteria:mutate', ops)
  return c
}

// --- keywords -----------------------------------------------------------------

export function buildAddKeywords(input: {
  adGroupResource: string
  adGroupName: string
  terms: string[]
  match: MatchType
  existing: Array<{ text: string; match: string; status: string }>
}): Change {
  const c = change()
  const have = new Map(input.existing.map(e => [`${e.text.toLowerCase()}|${e.match}`, e]))
  const seen = new Set<string>()
  const ops: Op[] = []
  for (const raw of input.terms) {
    const text = raw.trim().replace(/\s+/g, ' ')
    if (!text) continue
    if (text.split(' ').length > 10 || text.length > 80) throw new CliError(`Keyword too long (max 10 words, 80 characters): "${text}"`)
    const key = `${text.toLowerCase()}|${input.match}`
    const cur = have.get(key)
    if (cur) {
      c.warnings.push(`"${text}" [${input.match}] already exists (${cur.status})${cur.status === 'PAUSED' ? ': use pause-keyword --resume' : ''}, skipped`)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    ops.push({ create: { adGroup: input.adGroupResource, status: 'ENABLED', keyword: { text, matchType: input.match } } })
    c.summary.push(`add keyword "${text}" [${input.match}] to ad group "${input.adGroupName}"`)
  }
  if (input.match !== 'EXACT') c.warnings.push(`${input.match} keywords can spend fast on a small budget (knowledge/playbook/match-types.md).`)
  push(c, 'adGroupCriteria:mutate', ops)
  return c
}

// --- keyword status -----------------------------------------------------------

export interface KeywordRow { resourceName: string; text: string; match: string; status: string; campaign: string; adGroup: string }

export function buildKeywordStatus(rows: KeywordRow[], status: 'PAUSED' | 'ENABLED'): Change {
  const c = change()
  if (!rows.length) throw new CliError('No matching keyword found (check --keyword, --match and --campaign).')
  const ops: Op[] = []
  for (const r of rows) {
    if (r.status === status) { c.warnings.push(`"${r.text}" [${r.match}] in "${r.adGroup}" is already ${status}, skipped`); continue }
    ops.push({ updateMask: 'status', update: { resourceName: r.resourceName, status } })
    c.summary.push(`${status === 'PAUSED' ? 'pause' : 'resume'} keyword "${r.text}" [${r.match}] in "${r.campaign}" › "${r.adGroup}"`)
  }
  push(c, 'adGroupCriteria:mutate', ops)
  return c
}

// --- budget -------------------------------------------------------------------

export function buildBudget(input: {
  budgetResource: string
  campaignName: string
  currentMicros: string | number
  newAmount: number
  explicitlyShared: boolean
  maxChangePct: number
  force: boolean
}): Change {
  const c = change()
  if (!(input.newAmount > 0)) throw new CliError('--daily must be a positive amount')
  const current = micros(input.currentMicros)
  if (current === input.newAmount) throw new CliError(`The daily budget is already ${current}.`)
  const pct = current > 0 ? ((input.newAmount - current) / current) * 100 : Infinity
  if (Math.abs(pct) > input.maxChangePct && !input.force) {
    throw new CliError(
      `A ${pct === Infinity ? 'new' : `${Math.round(pct)}%`} change is above the ${input.maxChangePct}% guard ` +
        `(${current} → ${input.newAmount}). Re-run with --force if this is intended.`,
    )
  }
  if (input.explicitlyShared) c.warnings.push('This is a SHARED budget: the change affects every campaign that uses it.')
  if (Math.abs(pct) > input.maxChangePct) c.warnings.push(`Forced change of ${Math.round(pct)}% (guard: ${input.maxChangePct}%).`)
  push(c, 'campaignBudgets:mutate', [
    { updateMask: 'amount_micros', update: { resourceName: input.budgetResource, amountMicros: toMicros(input.newAmount) } },
  ])
  c.summary.push(`daily budget of "${input.campaignName}": ${current} → ${input.newAmount} (${pct > 0 ? '+' : ''}${Math.round(pct)}%)`)
  return c
}

// --- bidding --------------------------------------------------------------------

export type Strategy = 'max-conversions' | 'max-clicks' | 'manual-cpc'

export function strategy(v: string | undefined): Strategy {
  const s = String(v ?? '').toLowerCase()
  if (s === 'max-conversions' || s === 'max-clicks' || s === 'manual-cpc') return s
  throw new CliError(`--strategy must be max-conversions, max-clicks or manual-cpc, got "${v}"`)
}

export function buildBidding(input: {
  campaignResource: string
  campaignName: string
  currentType: string
  strategy: Strategy
  targetCpa?: number
  maxCpc?: number
  conversionsLast30d: number
}): Change {
  const c = change()
  const s = input.strategy
  if (input.targetCpa !== undefined && s !== 'max-conversions') throw new CliError('--target-cpa only goes with --strategy max-conversions')
  if (input.maxCpc !== undefined && s !== 'max-clicks') throw new CliError('--max-cpc only goes with --strategy max-clicks')
  for (const [name, v] of [['--target-cpa', input.targetCpa], ['--max-cpc', input.maxCpc]] as const) {
    if (v !== undefined && !(v > 0)) throw new CliError(`${name} must be a positive amount`)
  }

  let op: Op
  let label: string
  if (s === 'max-conversions') {
    // The subfield path in the mask switches the strategy even when the target is left unset.
    op = {
      updateMask: 'maximize_conversions.target_cpa_micros',
      update: {
        resourceName: input.campaignResource,
        maximizeConversions: input.targetCpa ? { targetCpaMicros: toMicros(input.targetCpa) } : {},
      },
    }
    label = input.targetCpa ? `Maximize conversions, target CPA ${input.targetCpa}` : 'Maximize conversions'
    if (input.conversionsLast30d < 15) {
      c.warnings.push(
        `Only ${input.conversionsLast30d} conversions in the last 30 days: Smart Bidding learns slowly below ~15/month. ` +
          'Check that conversion tracking is right before switching.',
      )
    }
  } else if (s === 'max-clicks') {
    // "Maximize clicks" is called TargetSpend in the API.
    op = {
      updateMask: 'target_spend.cpc_bid_ceiling_micros',
      update: {
        resourceName: input.campaignResource,
        targetSpend: input.maxCpc ? { cpcBidCeilingMicros: toMicros(input.maxCpc) } : {},
      },
    }
    label = input.maxCpc ? `Maximize clicks, max CPC ${input.maxCpc}` : 'Maximize clicks (no CPC cap)'
    if (!input.maxCpc) c.warnings.push('No --max-cpc cap: single clicks can get expensive.')
  } else {
    op = {
      updateMask: 'manual_cpc.enhanced_cpc_enabled',
      update: { resourceName: input.campaignResource, manualCpc: { enhancedCpcEnabled: false } },
    }
    label = 'Manual CPC (set the bids on the keywords / ad groups)'
  }
  push(c, 'campaigns:mutate', [op])
  c.summary.push(`bidding of "${input.campaignName}": ${input.currentType} → ${label}`)
  return c
}

// --- age ------------------------------------------------------------------------

export const AGE_RANGES: Record<string, string> = {
  '18-24': 'AGE_RANGE_18_24',
  '25-34': 'AGE_RANGE_25_34',
  '35-44': 'AGE_RANGE_35_44',
  '45-54': 'AGE_RANGE_45_54',
  '55-64': 'AGE_RANGE_55_64',
  '65+': 'AGE_RANGE_65_UP',
  unknown: 'AGE_RANGE_UNDETERMINED',
}
const AGE_LABEL = Object.fromEntries(Object.entries(AGE_RANGES).map(([k, v]) => [v, k]))

export function ageRange(v: string): string {
  const s = v.trim()
  const hit = AGE_RANGES[s.toLowerCase()] ?? (Object.values(AGE_RANGES).includes(s.toUpperCase()) ? s.toUpperCase() : undefined)
  if (!hit) throw new CliError(`Unknown age range "${v}". Use: ${Object.keys(AGE_RANGES).join(', ')}`)
  return hit
}

export const ageList = (v: string | undefined): string[] => (v ?? '').split(',').filter(s => s.trim()).map(ageRange)

/** "25-34:+20,65+:-50" → { AGE_RANGE_25_34: 1.2, AGE_RANGE_65_UP: 0.5 } */
export function bidAdjustments(v: string | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of (v ?? '').split(',').filter(s => s.trim())) {
    const i = part.lastIndexOf(':')
    if (i < 0) throw new CliError(`--bid-adjust entries look like 25-34:+20, got "${part}"`)
    const pct = Number(part.slice(i + 1).replace('%', ''))
    if (!Number.isFinite(pct) || pct < -90 || pct > 900) throw new CliError(`Bid adjustment must be between -90 and +900 %, got "${part}"`)
    out[ageRange(part.slice(0, i))] = Math.round((1 + pct / 100) * 100) / 100
  }
  return out
}

export interface AgeCriterion { resourceName: string; type: string; negative: boolean; bidModifier?: number }

export function buildAge(input: {
  adGroupResource: string
  adGroupName: string
  existing: AgeCriterion[]
  exclude: string[]
  include: string[]
  adjust: Record<string, number>
}): Change {
  const c = change()
  const both = input.exclude.filter(t => input.include.includes(t) || t in input.adjust)
  if (both.length) throw new CliError(`${both.map(t => AGE_LABEL[t]).join(', ')} cannot be excluded and targeted at the same time`)
  const byType = new Map(input.existing.map(e => [e.type, e]))
  const removes: Op[] = []
  const creates: Op[] = []
  const updates: Op[] = []

  for (const t of input.exclude) {
    const cur = byType.get(t)
    if (cur?.negative) { c.warnings.push(`${AGE_LABEL[t]} is already excluded`); continue }
    if (cur) removes.push({ remove: cur.resourceName })
    creates.push({ create: { adGroup: input.adGroupResource, negative: true, ageRange: { type: t } } })
    c.summary.push(`exclude age ${AGE_LABEL[t]} in ad group "${input.adGroupName}"`)
  }
  for (const t of input.include) {
    const cur = byType.get(t)
    if (!cur?.negative) { if (!(t in input.adjust)) c.warnings.push(`${AGE_LABEL[t]} is not excluded, nothing to include`); continue }
    removes.push({ remove: cur.resourceName })
    c.summary.push(`target age ${AGE_LABEL[t]} again in ad group "${input.adGroupName}"`)
  }
  for (const [t, mod] of Object.entries(input.adjust)) {
    const cur = byType.get(t)
    const pct = `${mod >= 1 ? '+' : ''}${Math.round((mod - 1) * 100)}%`
    if (cur && !cur.negative) {
      updates.push({ updateMask: 'bid_modifier', update: { resourceName: cur.resourceName, bidModifier: mod } })
    } else {
      if (cur?.negative && !input.include.includes(t)) removes.push({ remove: cur.resourceName })
      creates.push({ create: { adGroup: input.adGroupResource, ageRange: { type: t }, bidModifier: mod } })
    }
    c.summary.push(`bid adjustment ${pct} for age ${AGE_LABEL[t]} in ad group "${input.adGroupName}"`)
  }

  const excludedAfter = new Set(input.existing.filter(e => e.negative).map(e => e.type))
  input.exclude.forEach(t => excludedAfter.add(t))
  input.include.forEach(t => excludedAfter.delete(t))
  Object.keys(input.adjust).forEach(t => excludedAfter.delete(t))
  const realRanges = Object.values(AGE_RANGES).filter(t => t !== 'AGE_RANGE_UNDETERMINED')
  if (realRanges.every(t => excludedAfter.has(t))) {
    throw new CliError('This would exclude every age range: the ad group could only reach people of unknown age.')
  }
  if (input.exclude.includes('AGE_RANGE_UNDETERMINED')) {
    c.warnings.push('Excluding "unknown" age usually removes a large share of the traffic.')
  }
  // Removes first, so an existing criterion can be re-created as negative in the same call.
  push(c, 'adGroupCriteria:mutate', [...removes, ...creates, ...updates])
  return c
}

// --- location ---------------------------------------------------------------------

export interface LocationCriterion { resourceName: string; geoId: string; negative: boolean }
export type GeoType = 'presence' | 'presence-or-interest'

export function buildLocation(input: {
  campaignResource: string
  campaignName: string
  existing: LocationCriterion[]
  proximityCount: number
  add: string[]
  exclude: string[]
  remove: string[]
  geoType?: GeoType
  currentGeoType?: string
  names: Record<string, string>
  force: boolean
}): Change {
  const c = change()
  const name = (geoId: string) => input.names[geoId] ?? `geo ${geoId}`
  const clash = input.add.filter(g => input.exclude.includes(g) || input.remove.includes(g))
    .concat(input.exclude.filter(g => input.remove.includes(g)))
  if (clash.length) throw new CliError(`Location(s) ${[...new Set(clash)].join(', ')} appear in more than one of --add / --exclude / --remove`)
  for (const g of [...input.add, ...input.exclude]) {
    if (!input.names[g]) throw new CliError(`Unknown geo target ${g}. Look it up with: google-ads geo-search <name>`)
  }

  const byGeo = new Map(input.existing.map(e => [e.geoId, e]))
  const removes: Op[] = []
  const creates: Op[] = []
  const target = (g: string, negative: boolean, verb: string) => {
    const cur = byGeo.get(g)
    if (cur && cur.negative === negative) { c.warnings.push(`${name(g)} is already ${negative ? 'excluded' : 'targeted'}`); return }
    if (cur) removes.push({ remove: cur.resourceName })
    creates.push({ create: { campaign: input.campaignResource, ...(negative ? { negative: true } : {}), location: { geoTargetConstant: `geoTargetConstants/${g}` } } })
    c.summary.push(`${verb} ${name(g)} (${g}) on campaign "${input.campaignName}"`)
  }
  input.add.forEach(g => target(g, false, 'target'))
  input.exclude.forEach(g => target(g, true, 'exclude'))
  for (const g of input.remove) {
    const cur = byGeo.get(g)
    if (!cur) throw new CliError(`Location ${g} is not set on this campaign, nothing to remove`)
    removes.push({ remove: cur.resourceName })
    c.summary.push(`remove ${cur.negative ? 'exclusion' : 'targeting'} of ${name(g)} (${g}) from campaign "${input.campaignName}"`)
  }

  const positiveAfter = new Set(input.existing.filter(e => !e.negative).map(e => e.geoId))
  input.add.forEach(g => positiveAfter.add(g))
  input.exclude.forEach(g => positiveAfter.delete(g))
  input.remove.forEach(g => positiveAfter.delete(g))
  if (positiveAfter.size === 0 && input.proximityCount === 0) {
    if (!input.force) {
      throw new CliError('No targeted location would remain, which means the campaign targets ALL countries. Re-run with --force if this is intended.')
    }
    c.warnings.push('No targeted location remains: the campaign will target ALL countries.')
  }
  push(c, 'campaignCriteria:mutate', [...removes, ...creates])

  if (input.geoType) {
    const wanted = input.geoType === 'presence' ? 'PRESENCE' : 'PRESENCE_OR_INTEREST'
    if (wanted === input.currentGeoType) {
      c.warnings.push(`Location option is already ${wanted}`)
    } else {
      push(c, 'campaigns:mutate', [{
        updateMask: 'geo_target_type_setting.positive_geo_target_type',
        update: { resourceName: input.campaignResource, geoTargetTypeSetting: { positiveGeoTargetType: wanted } },
      }])
      c.summary.push(`location option of "${input.campaignName}": ${input.currentGeoType ?? '?'} → ${wanted}` +
        (wanted === 'PRESENCE' ? ' (only people who are in or regularly in the area)' : ' (also people interested in the area)'))
    }
  }
  if (!c.mutations.length) throw new CliError('Nothing to change.')
  return c
}
