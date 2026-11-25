import { describe, expect, it } from 'vitest'
import { buildCreateCampaigns, negativeConflicts, type CampaignSpec } from '../src/campaign.js'

const camp = (over: Partial<CampaignSpec> = {}): CampaignSpec => ({
  name: 'Moving',
  dailyBudget: 2000,
  maxCpc: 1000,
  geoIds: ['1007633'],
  languageIds: ['1024'],
  callAssetId: '555',
  sitelinks: [{ text: 'Quote', url: 'https://x.hu/#k' }, { text: 'Prices', url: 'https://x.hu/p' }],
  callouts: ['24/7'],
  negatives: [{ text: 'jobs' }, { text: 'free', match: 'EXACT' }],
  adGroups: [{
    name: 'AG', keywords: ['moving budapest', 'moving  budapest', 'cheap moving'],
    ad: { finalUrl: 'https://x.hu/m', path1: 'moving', headlines: [{ text: 'Moving Budapest', pin: 1 }, 'Two', 'Three'], descriptions: ['D1', 'D2'] },
  }],
  ...over,
})

const ops = (c: ReturnType<typeof buildCreateCampaigns>) => c.mutations[0].operations as any[]

describe('create-campaign', () => {
  it('builds one atomic googleAds:mutate with a PAUSED, search-only, capped campaign', () => {
    const c = buildCreateCampaigns('1', { campaigns: [camp()] }, [])
    expect(c.mutations).toHaveLength(1)
    expect(c.mutations[0].endpoint).toBe('googleAds:mutate')
    const o = ops(c)
    const campaign = o.find(x => x.campaignOperation).campaignOperation.create
    expect(campaign).toMatchObject({
      status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: 'customers/1/campaignBudgets/-1',
      targetSpend: { cpcBidCeilingMicros: '1000000000' },
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false },
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },
    })
    const budget = o[0].campaignBudgetOperation.create
    expect(budget).toMatchObject({ amountMicros: '2000000000', explicitlyShared: false })
    // duplicate keyword (extra whitespace) skipped, EXACT by default
    const kws = o.filter(x => x.adGroupCriterionOperation).map(x => x.adGroupCriterionOperation.create.keyword)
    expect(kws).toEqual([{ text: 'moving budapest', matchType: 'EXACT' }, { text: 'cheap moving', matchType: 'EXACT' }])
    const rsa = o.find(x => x.adGroupAdOperation).adGroupAdOperation.create.ad.responsiveSearchAd
    expect(rsa.headlines[0]).toEqual({ text: 'Moving Budapest', pinnedField: 'HEADLINE_1' })
    const negs = o.filter(x => x.campaignCriterionOperation?.create.negative).map(x => x.campaignCriterionOperation.create.keyword)
    expect(negs).toEqual([{ text: 'jobs', matchType: 'BROAD' }, { text: 'free', matchType: 'EXACT' }])
    // assets are created before they are linked
    const firstLink = o.findIndex(x => x.campaignAssetOperation)
    const lastAsset = o.map(x => Boolean(x.assetOperation)).lastIndexOf(true)
    expect(lastAsset).toBeLessThan(firstLink)
  })

  it('shares identical assets between campaigns and keeps temp IDs unique', () => {
    const c = buildCreateCampaigns('1', { campaigns: [camp(), camp({ name: 'Transport' })] }, [])
    const o = ops(c)
    expect(o.filter(x => x.assetOperation)).toHaveLength(3)
    expect(o.filter(x => x.campaignAssetOperation)).toHaveLength(8)
    const temps = o.map(x => Object.values(x)[0] as any).map(v => v.create?.resourceName).filter(Boolean)
    expect(new Set(temps).size).toBe(temps.length)
  })

  it('refuses unsafe or invalid specs', () => {
    expect(() => buildCreateCampaigns('1', { campaigns: [camp()] }, ['moving'])).toThrow(/already exists/)
    expect(() => buildCreateCampaigns('1', { campaigns: [camp({ geoIds: [] })] }, [])).toThrow(/whole world/)
    expect(() => buildCreateCampaigns('1', { campaigns: [camp({ maxCpc: 0 })] }, [])).toThrow(/maxCpc/)
    const long = camp()
    long.adGroups[0].ad!.headlines = ['x'.repeat(31), 'a', 'b']
    expect(() => buildCreateCampaigns('1', { campaigns: [long] }, [])).toThrow(/max 30/)
    expect(() => buildCreateCampaigns('1', { campaigns: [camp({ callouts: ['x'.repeat(26)] })] }, [])).toThrow(/1–25/)
    // Hungarian accents count as one character
    const hu = camp()
    hu.adGroups[0].ad!.headlines = ['Árvíztűrő tükörfúrógép óbb', 'a', 'b']
    expect(() => buildCreateCampaigns('1', { campaigns: [hu] }, [])).not.toThrow()
  })

  it('finds negatives that block own keywords', () => {
    expect(negativeConflicts(camp({ negatives: [{ text: 'cheap' }] }))).toHaveLength(1)
    expect(negativeConflicts(camp({ negatives: [{ text: 'moving cheap', match: 'PHRASE' }] }))).toHaveLength(0)
    expect(negativeConflicts(camp({ negatives: [{ text: 'cheap moving', match: 'EXACT' }] }))).toHaveLength(1)
    expect(() => buildCreateCampaigns('1', { campaigns: [camp({ negatives: [{ text: 'budapest' }] })] }, [])).toThrow(/Conflicting/)
  })
})

describe('set-campaign-status', () => {
  it('enables paused campaigns and skips ones already in that state', async () => {
    const { buildCampaignStatus } = await import('../src/campaign.js')
    const c = buildCampaignStatus([
      { resourceName: 'customers/1/campaigns/1', name: 'A', status: 'PAUSED', dailyBudget: 2000 },
      { resourceName: 'customers/1/campaigns/2', name: 'B', status: 'ENABLED', dailyBudget: 2000 },
    ], 'ENABLED')
    expect(c.mutations).toEqual([{ endpoint: 'campaigns:mutate', operations: [{ updateMask: 'status', update: { resourceName: 'customers/1/campaigns/1', status: 'ENABLED' } }] }])
    expect(c.warnings[0]).toMatch(/already ENABLED/)
    expect(() => buildCampaignStatus([{ resourceName: 'x', name: 'R', status: 'REMOVED', dailyBudget: 1 }], 'ENABLED')).toThrow(/removed/)
  })
})

describe('set-campaign-status --remove', () => {
  it('removes paused campaigns and guards running ones', async () => {
    const { buildCampaignStatus } = await import('../src/campaign.js')
    const c = buildCampaignStatus([{ resourceName: 'customers/1/campaigns/1', name: 'Old', status: 'PAUSED', dailyBudget: 10 }], 'REMOVED')
    expect(c.mutations).toEqual([{ endpoint: 'campaigns:mutate', operations: [{ remove: 'customers/1/campaigns/1' }] }])
    expect(c.warnings.join(' ')).toMatch(/permanent/)
    const running = [{ resourceName: 'customers/1/campaigns/2', name: 'Live', status: 'ENABLED', dailyBudget: 10 }]
    expect(() => buildCampaignStatus(running, 'REMOVED')).toThrow(/Pause it first/)
    expect(buildCampaignStatus(running, 'REMOVED', true).mutations[0].operations).toEqual([{ remove: 'customers/1/campaigns/2' }])
  })
})

describe('set-campaign-assets', () => {
  it('unlinks first, links new assets, skips linked ones and creates sitelinks', async () => {
    const { buildCampaignAssets, parseSitelink } = await import('../src/campaign.js')
    const c = buildCampaignAssets({
      customerId: '1', campaignResource: 'customers/1/campaigns/9', campaignName: 'C',
      linked: [{ resourceName: 'customers/1/campaignAssets/9~5~AD_IMAGE', assetId: '5', fieldType: 'AD_IMAGE' }, { resourceName: 'r', assetId: '7', fieldType: 'CALL' }],
      link: [{ assetId: '6', type: 'CALLOUT', label: '24/7' }, { assetId: '7', type: 'CALL', label: 'phone' }],
      unlink: ['5'],
      sitelinks: [parseSitelink('Quote=https://x.hu/#k')],
    })
    const ops = c.mutations[0].operations as any[]
    expect(ops[0]).toEqual({ campaignAssetOperation: { remove: 'customers/1/campaignAssets/9~5~AD_IMAGE' } })
    expect(ops[1].campaignAssetOperation.create).toEqual({ campaign: 'customers/1/campaigns/9', asset: 'customers/1/assets/6', fieldType: 'CALLOUT' })
    expect(ops[2].assetOperation.create.sitelinkAsset).toEqual({ linkText: 'Quote' })
    expect(ops[3].campaignAssetOperation.create.asset).toBe('customers/1/assets/-1')
    expect(c.warnings[0]).toMatch(/already linked/)
    expect(() => buildCampaignAssets({ customerId: '1', campaignResource: 'x', campaignName: 'C', linked: [], link: [], unlink: ['5'], sitelinks: [] })).toThrow(/not linked/)
    expect(() => parseSitelink('no url')).toThrow(/looks like/)
  })
})
