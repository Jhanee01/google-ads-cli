/** Each scenario is one of the lessons in knowledge/playbook. */
import { describe, expect, it } from 'vitest'
import { analyze, containsWord, cpcCap, DEFAULT_RULES, type CampaignData, type SuggestData } from '../src/suggest.js'
import { buildAddKeywords } from '../src/builders.js'

const camp = (over: Partial<CampaignData> = {}): CampaignData => ({
  id: '10', name: 'Search', status: 'ENABLED', biddingStrategyType: 'TARGET_SPEND', geoTargetType: 'PRESENCE',
  cost: 20000, clicks: 100, impressions: 900, conversions: 20, impressionShare: 0.4, rankLost: 0.2, budgetLost: 0.1, ...over,
})
const data = (over: Partial<SuggestData> = {}): SuggestData => ({
  windowDays: 30, windowStart: '2026-10-06', windowEnd: '2026-11-04',
  campaigns: [camp()], keywords: [], searchTerms: [], existingKeywords: [], negatives: [], ages: [], ...over,
})
const rules = (over = {}) => ({ ...DEFAULT_RULES, trackingVerifiedOn: '2026-01-01', ...over })
const rulesOf = (d: SuggestData, r = rules()) => analyze(d, r).findings.map(f => f.rule)

describe('measurement first', () => {
  it('by default conversions are not trusted, even when there are some', () => {
    const res = analyze(data({
      campaigns: [camp({ conversions: 5 })],
      searchTerms: [{ term: 'service city', status: 'NONE', campaignId: '10', adGroupId: '20', adGroup: 'A', cost: 5000, clicks: 20, conversions: 0 }],
    }), { ...DEFAULT_RULES })
    expect(res.findings[0].rule).toBe('tracking-unverified')
    expect(res.measurementTrusted['10']).toBe(false)
    expect(res.findings.map(f => f.rule)).not.toContain('wasted-search-terms')
  })
  it('a window that starts before the verification date is not trusted', () => {
    const res = analyze(data(), rules({ trackingVerifiedOn: '2026-10-20' }))
    expect(res.findings[0]).toMatchObject({ rule: 'tracking-unverified', title: expect.stringContaining('2026-10-20') })
    expect(analyze(data(), rules({ trackingVerifiedOn: '2026-10-01' })).measurementTrusted['10']).toBe(true)
  })
  it('many clicks and zero conversions → tracking suspect, conversion rules skipped', () => {
    const res = analyze(data({
      campaigns: [camp({ conversions: 0 })],
      searchTerms: [{ term: 'service city', status: 'NONE', campaignId: '10', adGroupId: '20', adGroup: 'A', cost: 5000, clicks: 20, conversions: 0 }],
    }), rules())
    expect(res.findings[0]).toMatchObject({ rule: 'measurement-suspect', severity: 'high' })
    expect(res.measurementTrusted['10']).toBe(false)
    expect(res.findings.map(f => f.rule)).not.toContain('wasted-search-terms')
  })
  it('a window overlapping an invalid period distrusts every campaign', () => {
    const res = analyze(data(), rules({ invalidConversionPeriods: [{ from: '2026-10-20', to: '2026-10-25', reason: 'tag broken' }] }))
    expect(res.findings[0].rule).toBe('invalid-conversion-period')
    expect(res.findings[0].why).toContain('tag broken')
    expect(res.measurementTrusted['10']).toBe(false)
  })
})

describe('bidding and serving', () => {
  it('Smart Bidding without signal and high rank loss → max-clicks with a CPC cap', () => {
    const [f] = analyze(data({ campaigns: [camp({ biddingStrategyType: 'MAXIMIZE_CONVERSIONS', conversions: 2, clicks: 30, cost: 6000, rankLost: 0.9 })] }), rules()).findings
    expect(f).toMatchObject({ rule: 'smart-bidding-without-signal', severity: 'high', action: 'google-ads set-bidding --campaign 10 --strategy max-clicks --max-cpc 800' })
  })
  it('no impressions and no impression share data → billing, nothing else for that campaign', () => {
    const r = rulesOf(data({ campaigns: [camp({ impressions: 0, clicks: 0, cost: 0, conversions: 0, impressionShare: null, rankLost: null, budgetLost: null, geoTargetType: 'PRESENCE_OR_INTEREST' })] }))
    expect(r).toEqual(['no-auction'])
  })
  it('budget loss is reported, never turned into a budget action', () => {
    const f = analyze(data({ campaigns: [camp({ budgetLost: 0.35 })] }), rules()).findings.find(x => x.rule === 'budget-limited')!
    expect(f.action).toBeUndefined()
  })
  it('presence or interest on a local business → presence-only', () => {
    const f = analyze(data({ campaigns: [camp({ geoTargetType: 'PRESENCE_OR_INTEREST' })] }), rules()).findings[0]
    expect(f.action).toBe('google-ads set-location --campaign 10 --presence-only')
    expect(rulesOf(data({ campaigns: [camp({ geoTargetType: 'PRESENCE_OR_INTEREST' })] }), rules({ localBusiness: false }))).toEqual([])
  })
  it('cpcCap rounds 4x the average CPC', () => {
    expect(cpcCap(206)).toBe(850)
    expect(cpcCap(0)).toBeUndefined()
  })
})

describe('match types', () => {
  it('broad/phrase above the share → pause the biggest wasteful ones', () => {
    const kw = (text: string, match: string, cost: number, criterion: string) =>
      ({ criterion, text, match, status: 'ENABLED', campaignId: '10', adGroup: 'A', cost, clicks: 10, conversions: 0 })
    const f = analyze(data({ keywords: [kw('a b', 'BROAD', 12000, '20~1'), kw('c d', 'PHRASE', 6000, '20~2'), kw('[e]', 'EXACT', 2000, '20~3')] }), rules()).findings
      .find(x => x.rule === 'broad-phrase-share')!
    expect(f.title).toContain('90%')
    expect(f.action).toBe('google-ads pause-keyword --criterion 20~1 && google-ads pause-keyword --criterion 20~2')
  })
})

describe('search terms', () => {
  const term = (t: string, over = {}) => ({ term: t, status: 'NONE', campaignId: '10', adGroupId: '20', adGroup: 'A', cost: 800, clicks: 4, conversions: 0, ...over })
  it('always-negative words match whole words, without accents, and become one BROAD negative', () => {
    expect(containsWord('Konténer bérlés árak', 'kontener')).toBe(true)
    expect(containsWord('konténeres', 'konténer')).toBe(false)
    const f = analyze(data({ searchTerms: [term('konténer árak'), term('sitt kontener bérlés'), term('service city')] }), rules({ alwaysNegative: ['konténer'] }))
      .findings.find(x => x.rule === 'always-negative')!
    expect(f.action).toBe('google-ads add-negative --campaign 10 --terms "konténer" --match BROAD')
    expect(f.why).toContain('1600')
  })
  it('terms already covered by a negative or excluded are ignored', () => {
    const d = data({ searchTerms: [term('free pickup'), term('jobs here', { status: 'EXCLUDED' })], negatives: [{ campaignId: '10', text: 'free' }] })
    expect(rulesOf(d, rules({ alwaysNegative: ['free', 'jobs'] }))).not.toContain('always-negative')
  })
  it('costly terms without conversions are review candidates (EXACT negatives), only with trusted tracking', () => {
    const f = analyze(data({ searchTerms: [term('drop off waste', { cost: 1500 }), term('cheap', { cost: 50 })] }), rules({ wasteThreshold: 1000 }))
      .findings.find(x => x.rule === 'wasted-search-terms')!
    expect(f.action).toBe('google-ads add-negative --campaign 10 --terms "drop off waste" --match EXACT')
  })
  it('converting terms that are not exact keywords yet → add-keyword EXACT; existing exact ones are skipped', () => {
    const d = data({
      searchTerms: [term('service price city', { conversions: 2 }), term('service city', { conversions: 1 })],
      existingKeywords: [{ adGroupId: '20', text: 'Service City', match: 'EXACT' }],
    })
    const f = analyze(d, rules()).findings.find(x => x.rule === 'promote-to-exact')!
    expect(f.action).toBe('google-ads add-keyword --ad-group 20 --terms "service price city" --match EXACT')
  })
  it('with untrusted tracking, promotion is by clicks and says so', () => {
    const d = data({ campaigns: [camp({ conversions: 0 })], searchTerms: [term('service city', { clicks: 5 })] })
    expect(analyze(d, rules()).findings.find(x => x.rule === 'promote-to-exact')!.title).toMatch(/tracking unverified/)
  })
})

describe('age', () => {
  const age = (a: string, cost: number, conversions: number) =>
    ({ adGroupId: '20', adGroup: 'A', campaignId: '10', age: a, excluded: false, cost, clicks: 10, conversions })
  it('excludes a spending range with zero conversions only when the ad group converts', () => {
    const d = data({ ages: [age('25-34', 5000, 4), age('65+', 3000, 0), age('unknown', 3000, 0)] })
    const f = analyze(d, rules({ wasteThreshold: 1000 })).findings.find(x => x.rule === 'age-without-conversions')!
    expect(f.action).toBe('google-ads set-age --ad-group 20 --exclude 65+')
    expect(rulesOf(data({ ages: [age('25-34', 5000, 1), age('65+', 3000, 0)] }), rules({ wasteThreshold: 1000 }))).not.toContain('age-without-conversions')
  })
})

describe('add-keyword', () => {
  it('creates enabled EXACT keywords and skips existing ones', () => {
    const c = buildAddKeywords({
      adGroupResource: 'customers/1/adGroups/20', adGroupName: 'C › A', match: 'EXACT',
      terms: ['service city', 'service  price', 'Service City'],
      existing: [{ text: 'service city', match: 'EXACT', status: 'PAUSED' }],
    })
    expect(c.mutations[0].operations).toEqual([
      { create: { adGroup: 'customers/1/adGroups/20', status: 'ENABLED', keyword: { text: 'service price', matchType: 'EXACT' } } },
    ])
    expect(c.warnings[0]).toMatch(/--resume/)
  })
})
