/**
 * `google-ads suggest`: the measurable part of the playbook (knowledge/playbook) as fixed rules.
 * Pure: data + rules → findings. Every finding names the playbook page behind it and, where a
 * change makes sense, the exact plan command to run. It never writes anything itself.
 */
import { existsSync, readFileSync } from 'node:fs'
import { CliError } from './config.js'

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
export interface KeywordData { criterion: string; text: string; match: string; status: string; campaignId: string; adGroup: string; cost: number; clicks: number; conversions: number }
export interface TermData { term: string; status: string; campaignId: string; adGroupId: string; adGroup: string; cost: number; clicks: number; conversions: number }
export interface AgeData { adGroupId: string; adGroup: string; campaignId: string; age: string; excluded: boolean; cost: number; clicks: number; conversions: number }

export interface SuggestData {
  windowDays: number
  windowStart: string
  windowEnd: string
  campaigns: CampaignData[]
  keywords: KeywordData[]
  searchTerms: TermData[]
  existingKeywords: Array<{ adGroupId: string; text: string; match: string }>
  negatives: Array<{ campaignId: string; text: string }>
  ages: AgeData[]
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

  // --- search terms -------------------------------------------------------------------------
  const negByCampaign = new Map<string, string[]>()
  data.negatives.forEach(n => negByCampaign.set(n.campaignId, [...(negByCampaign.get(n.campaignId) ?? []), n.text]))
  const covered = (t: TermData) => (negByCampaign.get(t.campaignId) ?? []).some(n => containsWord(t.term, n))
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
      why: `${money(hit.cost)} spent on e.g. ${hit.examples.map(e => `"${e}"`).join(', ')}. One broad negative word blocks the variants.`,
      playbook: 'knowledge/playbook/negatives.md',
      action: `google-ads add-negative --campaign ${cid} --terms ${q([...hit.words].join(','))} --match BROAD`,
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
