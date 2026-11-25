/**
 * `google-ads suggest`: the measurable part of the playbook (knowledge/playbook) as fixed rules.
 * Pure: data + rules → findings. Every finding names the playbook page behind it and, where a
 * change makes sense, the exact plan command to run. It never writes anything itself.
 */
import { existsSync, readFileSync } from 'node:fs'
import { CliError } from './config.js'
import { keywordConflicts, missingAccentVariants, negativeBlocks, subsumes, type MissingVariant, type ScopedNegative } from './negatives.js'

/** negative-missing-accent-variant: one finding per campaign or list, one plan command per match type. */
function accentFinding(missing: MissingVariant[], target: string, campaign: string | undefined, where: string): Finding {
  const byMatch = new Map<string, string[]>()
  missing.forEach(m => byMatch.set(m.match, [...(byMatch.get(m.match) ?? []), m.variant]))
  const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`
  return {
    rule: 'negative-missing-accent-variant',
    severity: 'medium',
    campaign,
    title: `${missing.length} accented negative(s) ${where} have no unaccented twin`,
    why: `Google treats an accented and an unaccented negative as two different keywords, and many people search without accents. ` +
      `Missing: ${missing.slice(0, 15).map(m => `"${m.text}" → "${m.variant}"`).join(', ')}${missing.length > 15 ? `, and ${missing.length - 15} more` : ''}.`,
    playbook: 'knowledge/playbook/negatives.md',
    action: [...byMatch].map(([match, terms]) => `google-ads add-negative ${target} --terms ${quote(terms.join(','))} --match ${match}`).join(' && '),
  }
}

export interface Rules {
  /** Date (YYYY-MM-DD) from which conversions were verified end to end. null = never: no conversion is trusted. */
  trackingVerifiedOn: string | null
  localBusiness: boolean
  wasteThreshold: number | null
  minClicksForMeasurementCheck: number
  smartBiddingMinConversions: number
  broadPhraseMaxShare: number
  rankLostHigh: number
  budgetLostHigh: number
  promoteMinClicks: number
  /** Quality Score at or below this counts as low (1–10 scale). */
  lowQualityScore: number
  /** Share of the keyword spend (on keywords that have a Quality Score) allowed on low-QS keywords. */
  lowQualityScoreMaxShare: number
  /** Weekly anomaly: a drop of at least this share (0.5 = −50 %) is reported. */
  anomalyDropPct: number
  /** Weekly anomaly: a rise of at least this share (1 = +100 %) is reported. */
  anomalyRisePct: number
  /** Weekly anomaly: minimum clicks per week in the baseline; below it the numbers are noise. */
  anomalyMinWeeklyClicks: number
  /** Yesterday's cost at least this many times the average daily cost of the previous 28 days. */
  costSpikeFactor: number
  alwaysNegative: string[]
  invalidConversionPeriods: Array<{ from: string; to: string; reason?: string }>
}

export const DEFAULT_RULES: Rules = {
  trackingVerifiedOn: null,
  localBusiness: true,
  wasteThreshold: null,
  minClicksForMeasurementCheck: 40,
  smartBiddingMinConversions: 15,
  broadPhraseMaxShare: 0.6,
  rankLostHigh: 0.5,
  budgetLostHigh: 0.2,
  promoteMinClicks: 3,
  lowQualityScore: 4,
  lowQualityScoreMaxShare: 0.3,
  anomalyDropPct: 0.5,
  anomalyRisePct: 1,
  anomalyMinWeeklyClicks: 20,
  costSpikeFactor: 2,
  alwaysNegative: [],
  invalidConversionPeriods: [],
}

export function loadRules(file?: string): { rules: Rules; source: string } {
  const path = file ?? (existsSync('google-ads.rules.json') ? 'google-ads.rules.json' : undefined)
  if (!path) return { rules: DEFAULT_RULES, source: 'defaults' }
  if (!existsSync(path)) throw new CliError(`Rules file not found: ${path}`)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new CliError(`Rules file is not valid JSON: ${path}`)
  }
  const rules = { ...DEFAULT_RULES }
  for (const key of Object.keys(DEFAULT_RULES) as Array<keyof Rules>) {
    if (raw[key] === undefined) continue
    const want = Array.isArray(DEFAULT_RULES[key]) ? 'array'
      : key === 'wasteThreshold' ? 'number|null' : key === 'trackingVerifiedOn' ? 'string|null' : typeof DEFAULT_RULES[key]
    const got = Array.isArray(raw[key]) ? 'array' : raw[key] === null ? 'null' : typeof raw[key]
    if (!want.split('|').includes(got)) throw new CliError(`Rules: "${key}" must be ${want}, got ${got}`)
    ;(rules as any)[key] = raw[key]
  }
  if (rules.trackingVerifiedOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(rules.trackingVerifiedOn)) {
    throw new CliError('Rules: "trackingVerifiedOn" must be a date like 2026-09-01, or null')
  }
  return { rules, source: path }
}

export interface CampaignData {
  id: string
  name: string
  status: string
  biddingStrategyType: string
  geoTargetType?: string
  cost: number
  clicks: number
  impressions: number
  conversions: number
  impressionShare: number | null
  rankLost: number | null
  budgetLost: number | null
}
export interface KeywordData {
  criterion: string; text: string; match: string; status: string; campaignId: string; adGroup: string
  cost: number; clicks: number; conversions: number
  /** Current Quality Score (1–10); null when Google has too little data. */
  qualityScore?: number | null
  /** BELOW_AVERAGE | AVERAGE | ABOVE_AVERAGE, or null */
  expectedCtr?: string | null
  adRelevance?: string | null
  landingPage?: string | null
}
/** One campaign, one day (account time zone). Days without any metrics may be missing: they count as zero. */
export interface DailyData { campaignId: string; date: string; cost: number; clicks: number; impressions: number; conversions: number }
export interface TermData { term: string; status: string; campaignId: string; adGroupId: string; adGroup: string; cost: number; clicks: number; conversions: number }
export interface AgeData { adGroupId: string; adGroup: string; campaignId: string; age: string; excluded: boolean; cost: number; clicks: number; conversions: number }

export interface SuggestData {
  windowDays: number
  windowStart: string
  windowEnd: string
  campaigns: CampaignData[]
  keywords: KeywordData[]
  searchTerms: TermData[]
  /** campaignId / adGroup / serving: needed by negative-blocks-keyword (serving = keyword, ad group and campaign enabled) */
  existingKeywords: Array<{ adGroupId: string; text: string; match: string; campaignId?: string; adGroup?: string; serving?: boolean }>
  /** every negative: level defaults to campaign, match to BROAD */
  negatives: Array<{ campaignId?: string; text: string; match?: string; level?: 'campaign' | 'adGroup' | 'list'; adGroupId?: string; listId?: string; listName?: string }>
  /** shared negative keyword lists and the campaigns they are attached to */
  negativeLists?: Array<{ id: string; name: string; campaignIds: string[] }>
  ages: AgeData[]
  /** Daily campaign metrics of the last 30 days (ending windowEnd = yesterday), for the anomaly rules. */
  daily?: DailyData[]
}

export type Severity = 'high' | 'medium' | 'low'
export interface Finding {
  rule: string
  severity: Severity
  campaign?: string
  title: string
  why: string
  playbook: string
  action?: string
}

const SMART = new Set(['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS'])
const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
const pct = (v: number) => `${Math.round(v * 100)}%`
const money = (v: number) => String(Math.round(v))

/** lowercase, no accents, words separated by single spaces, padded for whole-word matching */
export function norm(s: string): string {
  const plain = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return ` ${plain} `
}
export const containsWord = (text: string, word: string): boolean => norm(text).includes(norm(word))

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`

/** A CPC cap that will not choke serving: 4x the average CPC, rounded to a readable number. */
export function cpcCap(avgCpc: number): number | undefined {
  if (!(avgCpc > 0)) return undefined
  const raw = avgCpc * 4
  const step = raw >= 1000 ? 100 : raw >= 100 ? 50 : raw >= 10 ? 5 : 0.5
  return Math.ceil(raw / step) * step
}

export function analyze(data: SuggestData, rules: Rules): { measurementTrusted: Record<string, boolean>; wasteThreshold: number; findings: Finding[] } {
  const findings: Finding[] = []
  const add = (f: Finding) => findings.push(f)
  const byId = new Map(data.campaigns.map(c => [c.id, c]))

  const totalCost = data.campaigns.reduce((s, c) => s + c.cost, 0)
  const totalClicks = data.campaigns.reduce((s, c) => s + c.clicks, 0)
  const accountCpc = totalClicks ? totalCost / totalClicks : 0
  const waste = rules.wasteThreshold ?? Math.max(Math.round(accountCpc * 3), 1)

  // --- measurement: may conversions be used at all? ------------------------------------
  // Default is NO. Broken tracking does not always show zero: it can report a few conversions
  // for months. Conversions count only after someone verified them end to end (trackingVerifiedOn).
  const playbookM = 'knowledge/playbook/measurement.md'
  const skipped = 'Conversion-based rules are skipped; judge by CTR, cost and relevance.'
  let accountTrusted = true
  if (rules.trackingVerifiedOn === null) {
    accountTrusted = false
    add({
      rule: 'tracking-unverified',
      severity: 'high',
      title: 'Conversion tracking has not been verified: conversion numbers are not used',
      why: 'No "trackingVerifiedOn" date in the rules. Verify that a real click reaches "Recording conversions" in Google Ads, ' +
        `then set the date. ${skipped}`,
      playbook: playbookM,
    })
  } else if (rules.trackingVerifiedOn > data.windowStart) {
    accountTrusted = false
    add({
      rule: 'tracking-unverified',
      severity: 'high',
      title: `The window starts before tracking was verified (${rules.trackingVerifiedOn})`,
      why: `Window: ${data.windowStart} – ${data.windowEnd}. Use a shorter --days, or accept that conversions before the verification date may be wrong. ${skipped}`,
      playbook: playbookM,
    })
  }
  const invalid = rules.invalidConversionPeriods.filter(p => p.from <= data.windowEnd && p.to >= data.windowStart)
  if (invalid.length) {
    accountTrusted = false
    add({
      rule: 'invalid-conversion-period',
      severity: 'high',
      title: 'Conversion data in this window is marked invalid',
      why: invalid.map(p => `${p.from} – ${p.to}${p.reason ? `: ${p.reason}` : ''}`).join('; ') +
        `. Window: ${data.windowStart} – ${data.windowEnd}. ${skipped}`,
      playbook: playbookM,
    })
  }
  const trusted: Record<string, boolean> = {}
  for (const c of data.campaigns) {
    const suspect = c.clicks >= rules.minClicksForMeasurementCheck && c.conversions === 0
    trusted[c.id] = accountTrusted && !suspect
    if (suspect) {
      add({
        rule: 'measurement-suspect',
        severity: 'high',
        campaign: c.name,
        title: 'Clicks but zero conversions: check tracking before optimising',
        why: `${c.clicks} clicks and 0 conversions in ${data.windowDays} days. Ask the owner whether leads came in; ` +
          'verify the conversion request leaves the browser and the action shows "Recording conversions".' +
          (accountTrusted ? ' It was verified before, so it may have broken since.' : ''),
        playbook: playbookM,
      })
    }
  }

  // --- serving and bidding ---------------------------------------------------------------
  for (const c of data.campaigns) {
    if (c.impressions === 0 && c.impressionShare === null) {
      add({
        rule: 'no-auction',
        severity: 'high',
        campaign: c.name,
        title: 'No impressions and no impression share data: the campaign is not entering auctions',
        why: 'Typical cause: a billing / payment hold, which the API does not show. Check Billing in the Google Ads UI before changing settings.',
        playbook: 'knowledge/playbook/diagnosis.md',
      })
      continue
    }
    const smart = SMART.has(c.biddingStrategyType)
    if (smart && c.conversions < rules.smartBiddingMinConversions) {
      const cap = cpcCap(c.clicks ? c.cost / c.clicks : accountCpc)
      const rank = c.rankLost !== null ? `, ${pct(c.rankLost)} of impressions lost to rank` : ''
      add({
        rule: 'smart-bidding-without-signal',
        severity: c.rankLost !== null && c.rankLost >= rules.rankLostHigh ? 'high' : 'medium',
        campaign: c.name,
        title: `${c.biddingStrategyType} with only ${c.conversions} conversions: Smart Bidding has no signal`,
        why: `Fewer than ${rules.smartBiddingMinConversions} conversions in ${data.windowDays} days${rank}. Without a signal it lowers bids until the campaign stops serving.`,
        playbook: 'knowledge/playbook/bidding.md',
        action: `google-ads set-bidding --campaign ${c.id} --strategy max-clicks${cap ? ` --max-cpc ${cap}` : ''}`,
      })
    } else if (c.rankLost !== null && c.rankLost >= rules.rankLostHigh) {
      add({
        rule: 'rank-lost',
        severity: 'medium',
        campaign: c.name,
        title: `${pct(c.rankLost)} of impressions lost to ad rank`,
        why: 'Cheapest gains first: attach sitelinks and callouts, ad text that mirrors the exact keywords, landing page match; then the CPC cap.',
        playbook: 'knowledge/playbook/assets-and-mobile.md',
      })
    }
    if (c.budgetLost !== null && c.budgetLost >= rules.budgetLostHigh) {
      add({
        rule: 'budget-limited',
        severity: 'low',
        campaign: c.name,
        title: `${pct(c.budgetLost)} of impressions lost to budget`,
        why: 'Healthy on a small budget once waste is cut. Report it; raise the budget only on the owner\'s decision, with converting data.',
        playbook: 'knowledge/playbook/diagnosis.md',
      })
    }
    if (rules.localBusiness && c.geoTargetType === 'PRESENCE_OR_INTEREST') {
      add({
        rule: 'presence-or-interest',
        severity: 'medium',
        campaign: c.name,
        title: 'Ads also reach people outside the area who only search about it',
        why: 'Location option is "presence or interest". A local service wants people who are in the area.',
        playbook: 'knowledge/playbook/targeting.md',
        action: `google-ads set-location --campaign ${c.id} --presence-only`,
      })
    }
  }

  // --- match types -------------------------------------------------------------------------
  for (const c of data.campaigns) {
    const kws = data.keywords.filter(k => k.campaignId === c.id)
    const kwCost = kws.reduce((s, k) => s + k.cost, 0)
    const loose = kws.filter(k => k.match === 'BROAD' || k.match === 'PHRASE')
    const looseCost = loose.reduce((s, k) => s + k.cost, 0)
    if (!kwCost || looseCost / kwCost < rules.broadPhraseMaxShare) continue
    const wasteful = loose
      .filter(k => k.status === 'ENABLED' && k.cost >= waste && (k.conversions === 0 || !trusted[c.id]))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 5)
    add({
      rule: 'broad-phrase-share',
      severity: 'high',
      campaign: c.name,
      title: `Broad and phrase keywords took ${pct(looseCost / kwCost)} of the keyword spend`,
      why: `${money(looseCost)} of ${money(kwCost)}.` +
        (wasteful.length ? ` Biggest: ${wasteful.map(k => `"${k.text}" ${k.match} ${money(k.cost)}`).join(', ')}.` : '') +
        ' Pause them and add their relevant search terms as exact keywords (see promote-to-exact).',
      playbook: 'knowledge/playbook/match-types.md',
      action: wasteful.length ? wasteful.map(k => `google-ads pause-keyword --criterion ${k.criterion}`).join(' && ') : undefined,
    })
  }

  // --- negatives ------------------------------------------------------------------------------
  // Matching follows Google's rules exactly (src/negatives.ts): no close variants, accents count.
  const listCampaigns = new Map((data.negativeLists ?? []).map(l => [l.id, l.campaignIds]))
  const scoped: ScopedNegative[] = data.negatives.map(n => ({ ...n, level: n.level ?? 'campaign', match: n.match ?? 'BROAD' }))
  const appliesTo = (n: ScopedNegative, campaignId: string, adGroupId?: string) =>
    n.level === 'campaign' ? n.campaignId === campaignId
      : n.level === 'adGroup' ? adGroupId !== undefined && n.adGroupId === adGroupId
        : (listCampaigns.get(n.listId ?? '') ?? []).includes(campaignId)
  const enabledIds = new Set(data.campaigns.map(c => c.id))

  for (const c of data.campaigns) {
    const own = scoped.filter(n => n.level === 'campaign' && n.campaignId === c.id)
    const fromLists = scoped.filter(n => n.level === 'list' && appliesTo(n, c.id))
    const missing = missingAccentVariants(own).filter(m => !fromLists.some(l => subsumes(l, { text: m.variant, match: m.match })))
    if (!missing.length) continue
    add(accentFinding(missing, `--campaign ${c.id}`, c.name, `in campaign "${c.name}"`))
  }
  for (const l of data.negativeLists ?? []) {
    if (!l.campaignIds.some(id => enabledIds.has(id))) continue
    const missing = missingAccentVariants(scoped.filter(n => n.level === 'list' && n.listId === l.id))
    if (missing.length) add(accentFinding(missing, `--list ${l.id}`, undefined, `in the negative keyword list "${l.name}"`))
  }

  const conflicts = keywordConflicts(
    data.existingKeywords
      .filter(k => k.campaignId && enabledIds.has(k.campaignId))
      .map(k => ({ text: k.text, match: k.match, status: k.serving === false ? 'PAUSED' : 'ENABLED', campaignId: k.campaignId!, adGroupId: k.adGroupId, adGroup: k.adGroup })),
    scoped,
    Object.fromEntries(listCampaigns),
  )
  const conflictsByCampaign = new Map<string, typeof conflicts>()
  conflicts.forEach(x => conflictsByCampaign.set(x.keyword.campaignId, [...(conflictsByCampaign.get(x.keyword.campaignId) ?? []), x]))
  for (const [cid, list] of conflictsByCampaign) {
    const where = (n: ScopedNegative) => n.level === 'list' ? `list "${n.listName}"` : n.level === 'adGroup' ? 'ad group' : 'campaign'
    add({
      rule: 'negative-blocks-keyword',
      severity: 'high',
      campaign: byId.get(cid)?.name,
      title: `${list.length} enabled keyword(s) blocked by a negative of their own campaign`,
      why: list.slice(0, 10).map(x => `"${x.keyword.text}" [${x.keyword.match}]${x.keyword.adGroup ? ` in "${x.keyword.adGroup}"` : ''} ← negative "${x.negative.text}" [${x.negative.match}] (${where(x.negative)})`).join('; ') +
        '. The keyword cannot show for its own search. Narrow the negative (EXACT, or a longer phrase) or remove it in the UI; if the keyword is unwanted, pause it.',
      playbook: 'knowledge/playbook/negatives.md',
    })
  }

  // --- search terms -------------------------------------------------------------------------
  const covered = (t: TermData) => scoped.some(n => appliesTo(n, t.campaignId, t.adGroupId) && negativeBlocks(n, t.term))
  const open = data.searchTerms.filter(t => !t.status.includes('EXCLUDED') && !covered(t))

  const alwaysHits = new Map<string, { words: Set<string>; cost: number; examples: string[] }>()
  for (const t of open) {
    const words = rules.alwaysNegative.filter(w => containsWord(t.term, w))
    if (!words.length) continue
    const hit = alwaysHits.get(t.campaignId) ?? { words: new Set(), cost: 0, examples: [] }
    words.forEach(w => hit.words.add(w))
    hit.cost += t.cost
    if (hit.examples.length < 5) hit.examples.push(t.term)
    alwaysHits.set(t.campaignId, hit)
  }
  for (const [cid, hit] of alwaysHits) {
    add({
      rule: 'always-negative',
      severity: 'high',
      campaign: byId.get(cid)?.name,
      title: `Search terms with always-negative words are still getting through`,
      why: `${money(hit.cost)} spent on e.g. ${hit.examples.map(e => `"${e}"`).join(', ')}. One broad negative word blocks the searches ` +
        'that contain it; plural and suffixed forms need their own negative, and so does the unaccented form (added by --with-accent-variants).',
      playbook: 'knowledge/playbook/negatives.md',
      action: `google-ads add-negative --campaign ${cid} --terms ${q([...hit.words].join(','))} --match BROAD --with-accent-variants`,
    })
  }

  const alwaysTerm = (t: TermData) => rules.alwaysNegative.some(w => containsWord(t.term, w))
  const wasteByCampaign = new Map<string, TermData[]>()
  for (const t of open) {
    if (alwaysTerm(t) || !trusted[t.campaignId] || t.conversions > 0 || t.cost < waste) continue
    wasteByCampaign.set(t.campaignId, [...(wasteByCampaign.get(t.campaignId) ?? []), t])
  }
  for (const [cid, terms] of wasteByCampaign) {
    const top = terms.sort((a, b) => b.cost - a.cost).slice(0, 10)
    add({
      rule: 'wasted-search-terms',
      severity: 'medium',
      campaign: byId.get(cid)?.name,
      title: `${terms.length} search term(s) spent at least ${money(waste)} without a conversion`,
      why: `${top.map(t => `"${t.term}" ${money(t.cost)}`).join(', ')}. Make negatives of the IRRELEVANT ones only; relevant terms just need time or a better ad.`,
      playbook: 'knowledge/playbook/negatives.md',
      action: `google-ads add-negative --campaign ${cid} --terms ${q(top.map(t => t.term).join(','))} --match EXACT`,
    })
  }

  const exactByAdGroup = new Set(data.existingKeywords.filter(k => k.match === 'EXACT').map(k => `${k.adGroupId}|${norm(k.text)}`))
  const promote = new Map<string, { adGroup: string; campaignId: string; terms: TermData[] }>()
  for (const t of data.searchTerms) {
    if (t.status.includes('EXCLUDED') || alwaysTerm(t) || exactByAdGroup.has(`${t.adGroupId}|${norm(t.term)}`)) continue
    const good = trusted[t.campaignId] ? t.conversions > 0 : t.clicks >= rules.promoteMinClicks
    if (!good) continue
    const p = promote.get(t.adGroupId) ?? { adGroup: t.adGroup, campaignId: t.campaignId, terms: [] }
    p.terms.push(t)
    promote.set(t.adGroupId, p)
  }
  for (const [agId, p] of promote) {
    const top = p.terms.sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks).slice(0, 10)
    const basis = trusted[p.campaignId] ? 'converted' : `got ${rules.promoteMinClicks}+ clicks (tracking unverified: keep only the relevant ones)`
    add({
      rule: 'promote-to-exact',
      severity: 'medium',
      campaign: byId.get(p.campaignId)?.name,
      title: `${p.terms.length} search term(s) in "${p.adGroup}" ${basis} and are not exact keywords yet`,
      why: top.map(t => `"${t.term}" ${t.clicks} clicks, ${t.conversions} conv.`).join(', ') + '.',
      playbook: 'knowledge/playbook/match-types.md',
      action: `google-ads add-keyword --ad-group ${agId} --terms ${q(top.map(t => t.term).join(','))} --match EXACT`,
    })
  }

  // --- Quality Score ----------------------------------------------------------------------------
  const COMPONENT = {
    expectedCtr: { label: 'expected CTR', fix: 'headlines that repeat the exact keyword and give a reason to click (price, area, speed)' },
    adRelevance: { label: 'ad relevance', fix: 'the keyword in its own ad group, with an ad written for it' },
    landingPage: { label: 'landing page experience', fix: 'a landing page about that exact service, fast on mobile, with the phone number on top' },
  } as const
  type Component = keyof typeof COMPONENT
  const weak = (k: KeywordData): Component[] =>
    (Object.keys(COMPONENT) as Component[]).filter(c => k[c] === 'BELOW_AVERAGE')
  for (const c of data.campaigns) {
    const scored = data.keywords.filter(k => k.campaignId === c.id && typeof k.qualityScore === 'number' && k.cost > 0)
    const scoredCost = scored.reduce((s, k) => s + k.cost, 0)
    if (!scoredCost) continue
    const low = scored.filter(k => k.qualityScore! <= rules.lowQualityScore)
    const lowCost = low.reduce((s, k) => s + k.cost, 0)
    if (lowCost / scoredCost < rules.lowQualityScoreMaxShare || lowCost < waste) continue
    const avg = scored.reduce((s, k) => s + k.qualityScore! * k.cost, 0) / scoredCost
    const byComponent = new Map<Component, number>()
    low.forEach(k => weak(k).forEach(w => byComponent.set(w, (byComponent.get(w) ?? 0) + k.cost)))
    const worst = [...byComponent.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const top = [...low].sort((a, b) => b.cost - a.cost).slice(0, 5)
    const describe = (k: KeywordData) => {
      const w = weak(k)
      return `"${k.text}" QS ${k.qualityScore} ${money(k.cost)}${w.length ? ` (below average: ${w.map(x => COMPONENT[x].label).join(', ')})` : ''}`
    }
    add({
      rule: 'low-quality-score-spend',
      severity: lowCost / scoredCost >= 0.6 ? 'high' : 'medium',
      campaign: c.name,
      title: `${pct(lowCost / scoredCost)} of the keyword spend went to keywords with Quality Score ${rules.lowQualityScore} or lower`,
      why: `${money(lowCost)} of ${money(scoredCost)}; spend-weighted Quality Score ${avg.toFixed(1)}. Biggest: ${top.map(describe).join(', ')}. ` +
        (worst
          ? `Weakest component by spend: ${COMPONENT[worst].label}. Fix: ${COMPONENT[worst].fix}.`
          : 'No component is below average; check that the ad text and the landing page match these keywords.') +
        ' A low Quality Score means a higher price per click for the same position.',
      playbook: 'knowledge/playbook/quality-score.md',
    })
  }

  // --- anomalies (daily data of the last 30 days) ----------------------------------------------
  if (data.daily?.length) {
    /** offset 0 = yesterday (windowEnd), 1 = the day before... */
    const day = (offset: number) => {
      const d = new Date(`${data.windowEnd}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() - offset)
      return d.toISOString().slice(0, 10)
    }
    const total = (cid: string, from: number, to: number) => {
      const dates = new Set(Array.from({ length: to - from + 1 }, (_, i) => day(from + i)))
      const s = { cost: 0, clicks: 0, impressions: 0, conversions: 0 }
      for (const r of data.daily!) {
        if (r.campaignId !== cid || !dates.has(r.date)) continue
        s.cost += r.cost; s.clicks += r.clicks; s.impressions += r.impressions; s.conversions += r.conversions
      }
      return s
    }
    const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`

    for (const c of data.campaigns) {
      const yesterday = total(c.id, 0, 0)
      const weekBefore = total(c.id, 1, 7)
      if (yesterday.impressions === 0 && weekBefore.impressions / 7 >= 10) {
        add({
          rule: 'anomaly-serving-stopped',
          severity: 'high',
          campaign: c.name,
          title: `No impressions yesterday (${day(0)}), after ${Math.round(weekBefore.impressions / 7)} a day the week before`,
          why: 'The campaign stopped serving from one day to the next. Check, in this order: billing (invisible in the API), ' +
            'a change just before (budget, bidding, paused keywords, ad schedule), disapproved ads.',
          playbook: 'knowledge/playbook/diagnosis.md',
        })
      }

      const prev28 = total(c.id, 1, 28)
      const avgDaily = prev28.cost / 28
      if (avgDaily > 0 && yesterday.cost >= avgDaily * rules.costSpikeFactor && yesterday.cost >= waste) {
        const cpc = (x: { cost: number; clicks: number }) => (x.clicks ? money(x.cost / x.clicks) : '–')
        add({
          rule: 'anomaly-cost-spike',
          severity: 'high',
          campaign: c.name,
          title: `Yesterday's cost (${money(yesterday.cost)}) is ${(yesterday.cost / avgDaily).toFixed(1)}x the daily average`,
          why: `Average of the 28 days before: ${money(avgDaily)} a day. Yesterday ${yesterday.clicks} clicks at avg. CPC ${cpc(yesterday)} ` +
            `(28-day avg. CPC ${cpc(prev28)}). Google may spend up to 2x the daily budget on a single day; ` +
            'read that day\'s search terms before acting.',
          playbook: 'knowledge/playbook/diagnosis.md',
        })
      }

      // Whole weeks, so weekday patterns cancel out: last 7 days vs the average week of the 3 before.
      const last = total(c.id, 0, 6)
      const b = total(c.id, 7, 27)
      const base = { cost: b.cost / 3, clicks: b.clicks / 3, impressions: b.impressions / 3, conversions: b.conversions / 3 }
      if (base.clicks < rules.anomalyMinWeeklyClicks) continue
      const ratio = (n: number, d: number) => (d ? n / d : 0)
      const metrics: Array<{ name: string; now: number; was: number; badWhen: 'drop' | 'rise'; fmt: (v: number) => string }> = [
        { name: 'clicks', now: last.clicks, was: base.clicks, badWhen: 'drop', fmt: v => String(Math.round(v)) },
        { name: 'impressions', now: last.impressions, was: base.impressions, badWhen: 'drop', fmt: v => String(Math.round(v)) },
        { name: 'cost', now: last.cost, was: base.cost, badWhen: 'rise', fmt: money },
        { name: 'avg. CPC', now: ratio(last.cost, last.clicks), was: ratio(base.cost, base.clicks), badWhen: 'rise', fmt: money },
        { name: 'CTR', now: ratio(last.clicks, last.impressions), was: ratio(base.clicks, base.impressions), badWhen: 'drop', fmt: v => `${(v * 100).toFixed(1)}%` },
      ]
      if (trusted[c.id] && base.conversions >= 3) {
        metrics.push({ name: 'conversions', now: last.conversions, was: base.conversions, badWhen: 'drop', fmt: v => v.toFixed(1) })
      }
      const moved = metrics
        .filter(m => m.was > 0)
        .map(m => ({ ...m, change: m.now / m.was - 1 }))
        .filter(m => m.change <= -rules.anomalyDropPct || m.change >= rules.anomalyRisePct)
      if (!moved.length) continue
      const bad = moved.some(m => (m.badWhen === 'drop' ? m.change < 0 : m.change > 0))
      add({
        rule: 'anomaly-weekly',
        severity: bad ? 'medium' : 'low',
        campaign: c.name,
        title: `Last 7 days vs the 3 weeks before: ${moved.map(m => `${m.name} ${signed(m.change)}`).join(', ')}`,
        why: `${day(6)} – ${day(0)} against the average week of ${day(27)} – ${day(7)}: ` +
          moved.map(m => `${m.name} ${m.fmt(m.now)} vs ${m.fmt(m.was)}`).join('; ') + '. ' +
          'Find the cause before changing anything: a change in the account (history/), a holiday or season, ' +
          'competitors (rank-lost share), or broken tracking (for conversions).',
        playbook: 'knowledge/playbook/diagnosis.md',
      })
    }
  }

  // --- age (only with trusted conversions) -----------------------------------------------------
  const agesByGroup = new Map<string, AgeData[]>()
  data.ages.forEach(a => agesByGroup.set(a.adGroupId, [...(agesByGroup.get(a.adGroupId) ?? []), a]))
  for (const [agId, rows] of agesByGroup) {
    if (!trusted[rows[0].campaignId]) continue
    const conv = rows.reduce((s, r) => s + r.conversions, 0)
    if (conv < 3) continue
    const bad = rows.filter(r => !r.excluded && r.age !== 'unknown' && r.conversions === 0 && r.cost >= waste * 2)
    if (!bad.length) continue
    add({
      rule: 'age-without-conversions',
      severity: 'low',
      campaign: byId.get(rows[0].campaignId)?.name,
      title: `Age range(s) ${bad.map(b => b.age).join(', ')} spent without converting in "${rows[0].adGroup}"`,
      why: `${bad.map(b => `${b.age}: ${money(b.cost)}, ${b.clicks} clicks, 0 conv.`).join('; ')} while the ad group had ${conv} conversions. Check a longer window before excluding.`,
      playbook: 'knowledge/playbook/targeting.md',
      action: `google-ads set-age --ad-group ${agId} --exclude ${bad.map(b => b.age).join(',')}`,
    })
  }

  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
  return { measurementTrusted: trusted, wasteThreshold: waste, findings }
}
