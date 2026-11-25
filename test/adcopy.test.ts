/** Ad copy, assets and keyword checks (knowledge/playbook/ad-copy.md, keyword-planning.md). */
import { describe, expect, it } from 'vitest'
import {
  containsKeyword, duplicateAdsAcrossGroups, keywordCoverage, lintAd, lintAdGroup, lintAssets, lintKeywords, type AdText,
} from '../src/adcopy.js'
import { buildCreateCampaigns, checkSpec, type CampaignSpec } from '../src/campaign.js'
import { annotateIdeas, buildAddAd, liveAdReport } from '../src/commands/ads.js'
import { analyze, DEFAULT_RULES } from '../src/suggest.js'

const H = (...t: Array<string | [string, number]>) => t.map(x => (typeof x === 'string' ? { text: x } : { text: x[0], pin: x[1] }))
const ad = (over: Partial<AdText> = {}): AdText => ({
  finalUrl: 'https://x.hu/koltoztetes',
  headlines: H(['Költöztetés Budapesten', 1], ['Kisköltöztetés Budapesten', 1], 'Kisköltöztetés furgonnal', 'Költöztetés árak',
    'Kiszállás 10 000 Ft-tól', 'Hívjon most: 0–24', 'Akár 24 órán belül', 'Végső árak, számlával', 'Lift nélkül is', 'Irodaköltöztetés is'),
  descriptions: H('Bútor, doboz, háztartási gép – furgonnal költöztetjük.', 'Budapesten és Pest megyében, számlával.',
    'Hívjon a hét minden napján, 0–24!', 'Kiszállás 10 000 Ft, rakodás 3000 Ft/m³.'),
  ...over,
})
const codes = (issues: Array<{ code: string }>) => issues.map(i => i.code)

describe('keyword in headline (Ad Strength counts a keyword only inside one headline)', () => {
  it('matches whole words in order, case-insensitive; accents and word forms must match', () => {
    expect(containsKeyword('Költöztetés Budapesten olcsón', 'költöztetés budapesten')).toBe(true)
    expect(containsKeyword('Költöztetés Budapesten', 'költöztetés budapest')).toBe(false)
    expect(containsKeyword('Koltoztetes Budapesten', 'költöztetés')).toBe(false)
    expect(containsKeyword('Budapesten költöztetés', 'költöztetés budapesten')).toBe(false)
  })
  it('splits keywords into covered, missing, and too long for a headline', () => {
    const c = keywordCoverage(['költöztetés árak', 'kisköltöztetés', 'költöztetés budapest', 'költöztetés bútorral együtt budapest pest megye'], ad())
    expect(c.covered).toEqual(['költöztetés árak', 'kisköltöztetés'])
    expect(c.missing).toEqual(['költöztetés budapest'])
    expect(c.longMissing).toEqual(['költöztetés bútorral együtt budapest pest megye'])
  })
})

describe('lintAd', () => {
  it('a good ad (2 versions pinned to position 1, keywords in headlines, price, 10 headlines, 4 descriptions) has no issue', () => {
    expect(lintAd(ad(), ['költöztetés árak', 'kisköltöztetés'], 'AG')).toEqual([])
  })
  it('the same ad in two groups is still reported by suggest', () => {
    const res = analyze({
      windowDays: 30, windowStart: '2026-10-06', windowEnd: '2026-11-04',
      campaigns: [{ id: '10', name: 'Fuvarozás', status: 'ENABLED', biddingStrategyType: 'TARGET_SPEND', geoTargetType: 'PRESENCE', cost: 1000, clicks: 10, impressions: 100, conversions: 1, impressionShare: 0.5, rankLost: 0.1, budgetLost: 0 }],
      keywords: [], searchTerms: [], negatives: [], ages: [], existingKeywords: [],
      ads: [{ campaignId: '10', adGroupId: '20', adGroup: 'A', ad: ad() }, { campaignId: '10', adGroupId: '21', adGroup: 'B', ad: ad() }],
    }, { ...DEFAULT_RULES, trackingVerifiedOn: '2026-01-01' })
    expect(res.findings.map(f => f.rule)).toContain('duplicate-ads')
  })
  it("Google's limits are errors", () => {
    const issues = lintAd(ad({ headlines: H('x'.repeat(31), 'a', 'a'), descriptions: H('d'), path1: 'two words' }), [], 'AG')
    expect(codes(issues.filter(i => i.level === 'error'))).toEqual(['description-count', 'headline-length', 'duplicate-headline', 'path'])
  })
  it('every position pinned → the unpinned headlines never show (error)', () => {
    const issues = lintAd(ad({ headlines: H(['A', 1], ['B', 2], ['C', 3], 'D') }), [], 'AG')
    expect(codes(issues)).toContain('all-positions-pinned')
  })
  it('recommendations: few headlines, one pinned variant, pins on 2 positions, similar, same length, no number, keyword missing', () => {
    const issues = lintAd(ad({
      headlines: H(['Fuvarozás Budapesten', 1], ['Budapesten fuvarozás', 2], 'Bútorszállítás furgonnal', 'Fuvarozás Pest megyében', 'Bútorszállítás olcsón'),
      descriptions: H('Bútor, gép, építőanyag furgonnal.', 'Hívjon minden nap!'),
    }), ['bútorszállítás árak'], 'AG')
    expect(codes(issues)).toEqual([
      'few-headlines', 'few-descriptions', 'keyword-not-in-headline', 'pinned-single-variant', 'pinned-single-variant', 'too-many-pins',
      'similar-headlines', 'same-length-headlines', 'no-price-or-number',
    ])
  })
})

describe('ad groups and assets', () => {
  it('one RSA per group, and the same ad in two groups, are warnings', () => {
    expect(codes(lintAdGroup([ad()], [], 'AG'))).toContain('single-rsa')
    expect(codes(lintAdGroup([ad(), ad()], [], 'AG'))).toContain('duplicate-ads')
    expect(codes(duplicateAdsAcrossGroups([{ name: 'Fuvar', ads: [ad()] }, { name: 'Bútor', ads: [ad()] }]))).toEqual(['duplicate-ads-across-groups'])
  })
  it('assets: limits are errors, recommendations are warnings', () => {
    const issues = lintAssets({
      sitelinks: [{ text: 'Árak' }, { text: 'Ajánlatkérés', description1: 'Gyors visszahívás', description2: 'x'.repeat(36) }],
      callouts: ['Számlát adunk', 'Végső árak, számlával'],
      snippets: [{ header: 'Szolgáltatások', values: ['Költöztetés'] }],
      headlines: ['Végső árak, számlával'],
    }, 'C')
    expect(codes(issues.filter(i => i.level === 'error'))).toEqual(['sitelink-description-length', 'snippet-header', 'snippet-values'])
    expect(codes(issues.filter(i => i.level === 'warning'))).toEqual(['few-sitelinks', 'sitelink-without-description', 'few-callouts', 'callout-repeats-headline'])
  })
})

describe('lintKeywords', () => {
  it('close variants in one campaign, the same keyword in two campaigns', () => {
    const issues = lintKeywords([
      { name: 'Költöztetés', adGroups: [{ name: 'A', keywords: ['kisköltöztetés', 'kis költöztetés', 'koltoztetes budapest', 'budapest költöztetés'] }] },
      { name: 'Fuvarozás', adGroups: [{ name: 'B', keywords: ['bútorszállítás'] }, { name: 'C', keywords: ['fuvarozás'] }] },
      { name: 'Bútor', adGroups: [{ name: 'D', keywords: ['Bútorszállítás'] }] },
    ])
    expect(issues.map(i => i.code)).toEqual(['close-variant-keywords', 'close-variant-keywords', 'keyword-in-two-campaigns'])
    expect(issues[0].message).toContain('"kisköltöztetés", "kis költöztetés"')
  })
})

const spec = (over: Partial<CampaignSpec> = {}): CampaignSpec => ({
  name: 'Költöztetés', dailyBudget: 2000, maxCpc: 1000, geoIds: ['1007633'], languageIds: ['1024'], callAssetId: '555',
  sitelinks: Array.from({ length: 6 }, (_, i) => ({ text: `Link ${i}`, url: `https://x.hu/${i}`, description1: 'Egy', description2: 'Kettő' })),
  callouts: ['Számlát adunk', 'Akár 24 órán belül', '0–24 elérhetőség', 'Rakodással együtt'],
  snippets: [{ header: 'Service catalog', values: ['Költöztetés', 'Fuvarozás', 'Sittszállítás'] }],
  negatives: [{ text: 'állás' }, { text: '5 tonnás', match: 'EXACT' }],
  negativeAccentVariants: true,
  adGroups: [{ name: 'Költöztetés', keywords: ['költöztetés árak', 'kisköltöztetés'], ads: [ad() as any, { ...ad(), headlines: ad().headlines.slice().reverse().map(h => ({ ...h, text: h.text + '!' })) } as any] }],
  ...over,
})

describe('check-spec / create-campaign', () => {
  it('a complete spec passes with coverage, and create-campaign builds 2 RSAs, snippets and accent twins', () => {
    const r = checkSpec({ campaigns: [spec()] })
    expect(r.errors).toEqual([])
    expect(r.coverage).toEqual([{ campaign: 'Költöztetés', adGroup: 'Költöztetés', keywords: 2, inHeadline: 2, missing: [] }])
    const o = buildCreateCampaigns('1', { campaigns: [spec()] }, []).mutations[0].operations as any[]
    expect(o.filter(x => x.adGroupAdOperation)).toHaveLength(2)
    expect(o.find(x => x.assetOperation?.create.structuredSnippetAsset).assetOperation.create.structuredSnippetAsset)
      .toEqual({ header: 'Service catalog', values: ['Költöztetés', 'Fuvarozás', 'Sittszállítás'] })
    expect(o.filter(x => x.campaignAssetOperation?.create.fieldType === 'STRUCTURED_SNIPPET')).toHaveLength(1)
    const negs = o.filter(x => x.campaignCriterionOperation?.create.negative).map(x => x.campaignCriterionOperation.create.keyword.text)
    expect(negs).toEqual(['állás', 'allas', '5 tonnás', '5 tonnas'])
  })
  it('collects every error and the recommendations', () => {
    const bad = spec({
      negatives: [{ text: '5 tonnás', match: 'PHRASE' }, { text: 'bérlés' }], negativeAccentVariants: false, snippets: [], callAssetId: undefined,
      adGroups: [{ name: 'A', keywords: ['furgon 1,5 tonnás'], ad: { finalUrl: 'https://x.hu', headlines: ['a', 'b', 'c'], descriptions: ['d', 'e'] } }],
    })
    const r = checkSpec({ campaigns: [bad] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/word break/)
    expect(codes(r.warnings)).toEqual(expect.arrayContaining(['single-rsa', 'few-headlines', 'keyword-not-in-headline', 'no-structured-snippet', 'no-call-asset', 'negative-missing-accent-variant']))
  })
  it('the negative conflict check follows Google: a phrase "5 tonnás" blocks "furgon 1,5 tonnás" only via the comma', () => {
    const r = checkSpec({ campaigns: [spec({ negatives: [{ text: '5 tonnás', match: 'PHRASE' }], adGroups: [{ name: 'A', keywords: ['furgon 1 5 tonnás'], ads: [ad() as any, ad() as any] }] })] })
    expect(r.errors).toEqual(['negative "5 tonnás" [PHRASE] blocks keyword "furgon 1 5 tonnás" in campaign "Költöztetés"'])
  })
})

describe('add-ad', () => {
  const base = { adGroupResource: 'customers/1/adGroups/20', adGroupName: 'Költöztetés › A', keywords: ['költöztetés árak'] }
  it('plans the RSA with pins and puts the recommendations into the warnings', () => {
    const c = buildAddAd({ ...base, existing: [], spec: { finalUrl: 'https://x.hu', headlines: [{ text: 'Költöztetés árak', pin: 1 }, 'B', 'C'], descriptions: ['D', 'E'] } })
    const op = (c.mutations[0].operations[0] as any).create
    expect(c.mutations[0].endpoint).toBe('adGroupAds:mutate')
    expect(op.ad.responsiveSearchAd.headlines[0]).toEqual({ text: 'Költöztetés árak', pinnedField: 'HEADLINE_1' })
    expect(op.status).toBe('ENABLED')
    expect(c.warnings.join(' ')).toMatch(/\[single-rsa\]/)
    expect(c.warnings.join(' ')).toMatch(/\[pinned-single-variant\]/)
  })
  it('refuses a limit error and warns about a copy of an existing ad', () => {
    expect(() => buildAddAd({ ...base, existing: [], spec: { finalUrl: 'https://x.hu', headlines: ['x'.repeat(31), 'b', 'c'], descriptions: ['d', 'e'] } })).toThrow(/max 30/)
    const c = buildAddAd({ ...base, existing: [ad()], spec: ad() as any })
    expect(c.warnings.join(' ')).toMatch(/\[duplicate-ads\]/)
    expect(c.warnings.join(' ')).not.toMatch(/single-rsa/)
  })
})

describe('live ads: the ads report and suggest', () => {
  const live = [
    { campaignId: '10', campaign: 'Fuvarozás', adGroupId: '20', adGroup: 'Fuvarozás', adId: '1', approval: 'APPROVED', adStrength: 'POOR', ad: ad() },
    { campaignId: '10', campaign: 'Fuvarozás', adGroupId: '21', adGroup: 'Bútorszállítás', adId: '2', approval: 'APPROVED', adStrength: 'POOR', ad: ad() },
  ]
  const assets = [{ campaignId: '10', campaign: 'Fuvarozás', sitelinks: [{ text: 'Árak' }, { text: 'Ajánlat' }], callouts: ['Számlát adunk'], snippets: [], call: true }]
  it('ads: issues per ad group and per campaign', () => {
    const r = liveAdReport(live, assets, [{ adGroupId: '21', text: 'bútorszállítás árak' }]) as any
    // two different headlines pinned to position 1 is what Google recommends: no pinning warning
    expect(codes(r.adGroups[1].issues)).toEqual(['keyword-not-in-headline', 'single-rsa'])
    expect(codes(r.campaigns[0].issues)).toEqual(['few-sitelinks', 'sitelink-without-description', 'few-callouts', 'no-structured-snippet', 'duplicate-ads-across-groups'])
  })
  it('suggest: ad-keyword-coverage, single-rsa, ad-pinning, duplicate-ads, ad-assets', () => {
    const res = analyze({
      windowDays: 30, windowStart: '2026-10-06', windowEnd: '2026-11-04',
      campaigns: [{ id: '10', name: 'Fuvarozás', status: 'ENABLED', biddingStrategyType: 'TARGET_SPEND', geoTargetType: 'PRESENCE', cost: 1000, clicks: 10, impressions: 100, conversions: 1, impressionShare: 0.5, rankLost: 0.1, budgetLost: 0 }],
      keywords: [], searchTerms: [], negatives: [], ages: [],
      existingKeywords: [{ adGroupId: '21', campaignId: '10', text: 'bútorszállítás árak', match: 'EXACT', serving: true }],
      ads: [live[0], { ...live[1], ad: ad({ headlines: H(['Bútorszállítás furgonnal', 1], 'B', 'C') }) }], adAssets: assets,
    }, { ...DEFAULT_RULES, trackingVerifiedOn: '2026-01-01' })
    const rules = res.findings.map(f => f.rule)
    expect(rules).toEqual(expect.arrayContaining(['ad-keyword-coverage', 'single-rsa', 'ad-pinning', 'ad-assets']))
    expect(res.findings.find(f => f.rule === 'ad-pinning')!.campaign).toBe('Fuvarozás')
    expect(res.findings.find(f => f.rule === 'ad-keyword-coverage')!.why).toContain('"bútorszállítás árak"')
  })
})

describe('keyword-ideas', () => {
  it('sorts by volume and flags existing close variants and negatives that block an idea', () => {
    const r = annotateIdeas(
      [
        { keyword: 'koltoztetes budapest', avgMonthlySearches: 880, competition: 'HIGH', lowTopOfPageBid: 300, highTopOfPageBid: 900 },
        { keyword: 'költöztetés állás', avgMonthlySearches: 90, competition: 'LOW', lowTopOfPageBid: 50, highTopOfPageBid: 100 },
        { keyword: 'zongoraszállítás', avgMonthlySearches: 1300, competition: 'MEDIUM', lowTopOfPageBid: 200, highTopOfPageBid: 600 },
      ],
      [{ text: 'költöztetés budapest', campaignId: '10' }],
      [{ level: 'campaign', campaignId: '10', text: 'állás', match: 'BROAD' }, { level: 'list', listId: '7', text: 'zongoraszállítás', match: 'BROAD' }],
      [{ id: '7', campaignIds: ['11'] }],
      [{ id: '10', name: 'Költöztetés' }, { id: '11', name: 'Fuvarozás' }],
      10,
    ) as any[]
    expect(r.map(i => i.keyword)).toEqual(['zongoraszállítás', 'koltoztetes budapest', 'költöztetés állás'])
    expect(r[0].blockedIn).toEqual(['Fuvarozás'])
    expect(r[1].inAccount).toBe('költöztetés budapest')
    expect(r[2].blockedIn).toEqual(['Költöztetés'])
  })
})
