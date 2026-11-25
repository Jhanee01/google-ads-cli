/** Each scenario is one of the lessons in knowledge/playbook. */
import { describe, expect, it } from 'vitest'
import { analyze, containsWord, cpcCap, DEFAULT_RULES, type CampaignData, type DailyData, type Rules, type SuggestData } from '../src/suggest.js'
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
const rulesOf = (d: SuggestData, r: Rules = rules()) => analyze(d, r).findings.map(f => f.rule)

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
    expect(containsWord('Container rentál prices', 'rental')).toBe(true)
    expect(containsWord('containers', 'container')).toBe(false)
    const f = analyze(data({ searchTerms: [term('container prices'), term('waste Contáiner rental'), term('service city')] }), rules({ alwaysNegative: ['container'] }))
      .findings.find(x => x.rule === 'always-negative')!
    expect(f.action).toBe('google-ads add-negative --campaign 10 --terms "container" --match BROAD --with-accent-variants')
    expect(f.why).toContain('1600')
  })
  it('terms already covered by a negative or excluded are ignored', () => {
    const d = data({ searchTerms: [term('free pickup'), term('jobs here', { status: 'EXCLUDED' })], negatives: [{ campaignId: '10', text: 'free' }] })
    expect(rulesOf(d, rules({ alwaysNegative: ['free', 'jobs'] }))).not.toContain('always-negative')
  })
  it('an accented negative does not cover the unaccented search (as in Google)', () => {
    const d = data({ searchTerms: [term('kontener ar')], negatives: [{ campaignId: '10', text: 'konténer', match: 'BROAD' }] })
    expect(rulesOf(d, rules({ alwaysNegative: ['konténer'] }))).toContain('always-negative')
  })
  it('a shared list attached to the campaign covers the term; a list of another campaign does not', () => {
    const neg = { text: 'free', match: 'BROAD', level: 'list' as const, listId: '7', listName: 'Common' }
    const on = data({ searchTerms: [term('free pickup')], negatives: [neg], negativeLists: [{ id: '7', name: 'Common', campaignIds: ['10'] }] })
    const off = data({ searchTerms: [term('free pickup')], negatives: [neg], negativeLists: [{ id: '7', name: 'Common', campaignIds: ['99'] }] })
    expect(rulesOf(on, rules({ alwaysNegative: ['free'] }))).not.toContain('always-negative')
    expect(rulesOf(off, rules({ alwaysNegative: ['free'] }))).toContain('always-negative')
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

describe('negatives', () => {
  it('accented negatives without their unaccented twin → one add-negative per match type', () => {
    const f = analyze(data({ negatives: [
      { campaignId: '10', text: 'állás', match: 'BROAD' },
      { campaignId: '10', text: 'bérlés', match: 'BROAD' },
      { campaignId: '10', text: 'berles', match: 'BROAD' },
      { campaignId: '10', text: 'sofőr állás', match: 'PHRASE' },
      { campaignId: '10', text: 'konténer', match: 'EXACT' },
    ] }), rules()).findings.find(x => x.rule === 'negative-missing-accent-variant')!
    expect(f.title).toMatch(/^2 accented negative/)
    expect(f.action).toBe('google-ads add-negative --campaign 10 --terms "allas" --match BROAD && google-ads add-negative --campaign 10 --terms "kontener" --match EXACT')
  })
  it('a twin in an attached shared list counts; lists are checked once, not per campaign', () => {
    const d = data({
      negatives: [
        { campaignId: '10', text: 'állás', match: 'BROAD' },
        { text: 'allas', match: 'BROAD', level: 'list', listId: '7', listName: 'Common' },
        { text: 'munkás', match: 'BROAD', level: 'list', listId: '7', listName: 'Common' },
      ],
      negativeLists: [{ id: '7', name: 'Common', campaignIds: ['10'] }],
    })
    const found = analyze(d, rules()).findings.filter(x => x.rule === 'negative-missing-accent-variant')
    expect(found).toHaveLength(1)
    expect(found[0].action).toBe('google-ads add-negative --list 7 --terms "munkas" --match BROAD')
  })
  it('a negative that blocks an enabled keyword of the same campaign → high', () => {
    const f = analyze(data({
      existingKeywords: [
        { adGroupId: '20', adGroup: 'Fuvar', campaignId: '10', text: 'furgon 1,5 tonnás', match: 'EXACT', serving: true },
        { adGroupId: '20', adGroup: 'Fuvar', campaignId: '10', text: 'tonnás fuvar', match: 'EXACT', serving: false },
      ],
      negatives: [{ campaignId: '10', text: '5 tonnás', match: 'PHRASE' }],
    }), rules()).findings.find(x => x.rule === 'negative-blocks-keyword')!
    expect(f).toMatchObject({ severity: 'high', title: expect.stringMatching(/^1 enabled keyword/) })
    expect(f.why).toContain('"furgon 1,5 tonnás" [EXACT] in "Fuvar" ← negative "5 tonnás" [PHRASE] (campaign)')
  })
})

describe('Quality Score', () => {
  const kw = (text: string, cost: number, qualityScore: number | null, over = {}) =>
    ({ criterion: `20~${text.length}`, text, match: 'EXACT', status: 'ENABLED', campaignId: '10', adGroup: 'A', cost, clicks: 10, conversions: 0,
      qualityScore, expectedCtr: 'AVERAGE', adRelevance: 'AVERAGE', landingPage: 'AVERAGE', ...over })
  it('most of the spend on low-QS keywords → names the weakest component by spend', () => {
    const f = analyze(data({ keywords: [
      kw('service city', 6000, 3, { landingPage: 'BELOW_AVERAGE' }),
      kw('service price', 2000, 4, { expectedCtr: 'BELOW_AVERAGE' }),
      kw('service', 2000, 8),
    ] }), rules({ wasteThreshold: 1000 })).findings.find(x => x.rule === 'low-quality-score-spend')!
    expect(f).toMatchObject({ severity: 'high', title: expect.stringContaining('80%') })
    expect(f.why).toContain('spend-weighted Quality Score 4.2')
    expect(f.why).toContain('"service city" QS 3 6000 (below average: landing page experience)')
    expect(f.why).toContain('Weakest component by spend: landing page experience')
    expect(f.action).toBeUndefined()
  })
  it('a small low-QS share, or keywords without a score, do not fire', () => {
    const r = rules({ wasteThreshold: 1000 })
    expect(rulesOf(data({ keywords: [kw('a', 2000, 3), kw('b', 8000, 7)] }), r)).not.toContain('low-quality-score-spend')
    expect(rulesOf(data({ keywords: [kw('a', 9000, null), kw('b', 1000, 7)] }), r)).not.toContain('low-quality-score-spend')
  })
  it('does not depend on conversion tracking', () => {
    expect(rulesOf(data({ keywords: [kw('a', 9000, 2)] }), { ...DEFAULT_RULES, wasteThreshold: 1000 })).toContain('low-quality-score-spend')
  })
})

describe('anomalies', () => {
  // windowEnd 2026-11-04 = yesterday (offset 0)
  const dayOf = (offset: number) => {
    const d = new Date('2026-11-04T00:00:00Z')
    d.setUTCDate(d.getUTCDate() - offset)
    return d.toISOString().slice(0, 10)
  }
  /** 30 days of identical days, then overrides per offset */
  const series = (base: Partial<DailyData>, over: Record<number, Partial<DailyData>> = {}): DailyData[] =>
    Array.from({ length: 30 }, (_, i) => ({ campaignId: '10', date: dayOf(i), cost: 1000, clicks: 5, impressions: 50, conversions: 0.5, ...base, ...over[i] }))
  const anomalies = (daily: DailyData[], r: Rules = rules({ wasteThreshold: 1000 })) =>
    analyze(data({ daily }), r).findings.filter(f => f.rule.startsWith('anomaly'))

  it('a steady account has no anomaly', () => {
    expect(anomalies(series({}))).toEqual([])
  })
  it('zero impressions yesterday after normal days → serving stopped', () => {
    const f = anomalies(series({}, { 0: { impressions: 0, clicks: 0, cost: 0, conversions: 0 } }))
    expect(f.map(x => x.rule)).toContain('anomaly-serving-stopped')
    expect(f[0]).toMatchObject({ severity: 'high', title: expect.stringContaining('2026-11-04') })
  })
  it('missing rows count as zero (the API leaves out empty days)', () => {
    const f = anomalies(series({}).filter(r => r.date !== dayOf(0)))
    expect(f.map(x => x.rule)).toContain('anomaly-serving-stopped')
  })
  it('yesterday at 2x the daily average → cost spike', () => {
    const f = anomalies(series({}, { 0: { cost: 2500, clicks: 6 } })).find(x => x.rule === 'anomaly-cost-spike')!
    expect(f.title).toContain('2.5x')
    expect(f.why).toContain('1000 a day')
  })
  it('a spike below the waste threshold is ignored', () => {
    expect(anomalies(series({ cost: 100 }, { 0: { cost: 300 } }), rules({ wasteThreshold: 1000 })).map(x => x.rule)).not.toContain('anomaly-cost-spike')
  })
  it('last week clicks halved and CPC doubled → weekly anomaly, medium', () => {
    const lastWeek = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, { clicks: 2, cost: 800, impressions: 50 }]))
    const f = anomalies(series({}, lastWeek)).find(x => x.rule === 'anomaly-weekly')!
    expect(f.severity).toBe('medium')
    expect(f.title).toContain('clicks -60%')
    expect(f.title).toContain('avg. CPC +100%')
    expect(f.why).toContain('2026-10-29 – 2026-11-04')
  })
  it('a quiet baseline is noise: no weekly anomaly below the minimum weekly clicks', () => {
    const lastWeek = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, { clicks: 0 }]))
    expect(anomalies(series({ clicks: 2 }, lastWeek)).map(x => x.rule)).not.toContain('anomaly-weekly')
  })
  it('conversions are compared only with trusted tracking', () => {
    const lastWeek = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, { conversions: 0 }]))
    expect(anomalies(series({}, lastWeek))[0].title).toContain('conversions -100%')
    expect(anomalies(series({}, lastWeek), { ...DEFAULT_RULES, wasteThreshold: 1000 })).toEqual([])
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
