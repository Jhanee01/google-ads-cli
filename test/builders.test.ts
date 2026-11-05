import { describe, expect, it } from 'vitest'
import {
  ageList, bidAdjustments, buildAddNegatives, buildAge, buildBidding, buildBudget, buildKeywordStatus, buildLocation, matchType,
} from '../src/builders.js'

const CAMP = 'customers/1/campaigns/10'
const AG = 'customers/1/adGroups/20'

describe('add-negative', () => {
  it('creates EXACT negatives and skips existing and duplicate ones', () => {
    const c = buildAddNegatives({
      campaignResource: CAMP, campaignName: 'Search', match: 'EXACT',
      terms: ['free', ' jobs ', 'FREE', 'diy', ''], existing: [{ text: 'diy', match: 'EXACT' }],
    })
    expect(c.mutations).toEqual([{
      endpoint: 'campaignCriteria:mutate',
      operations: [
        { create: { campaign: CAMP, negative: true, keyword: { text: 'free', matchType: 'EXACT' } } },
        { create: { campaign: CAMP, negative: true, keyword: { text: 'jobs', matchType: 'EXACT' } } },
      ],
    }])
    expect(c.warnings[0]).toMatch(/diy/)
  })
  it('validates the match type', () => {
    expect(matchType('phrase')).toBe('PHRASE')
    expect(() => matchType('fuzzy')).toThrow(/EXACT, PHRASE or BROAD/)
  })
})

describe('pause-keyword', () => {
  const row = { resourceName: 'customers/1/adGroupCriteria/20~30', text: 'cheap', match: 'BROAD', status: 'ENABLED', campaign: 'C', adGroup: 'A' }
  it('pauses with an update mask on status', () => {
    const c = buildKeywordStatus([row], 'PAUSED')
    expect(c.mutations[0].operations).toEqual([{ updateMask: 'status', update: { resourceName: row.resourceName, status: 'PAUSED' } }])
  })
  it('skips keywords already in the wanted status and fails when nothing matches', () => {
    expect(buildKeywordStatus([row], 'ENABLED').mutations).toEqual([])
    expect(() => buildKeywordStatus([], 'PAUSED')).toThrow(/No matching keyword/)
  })
})

describe('set-budget', () => {
  const base = { budgetResource: 'customers/1/campaignBudgets/5', campaignName: 'C', currentMicros: '2000000000', explicitlyShared: false, maxChangePct: 50, force: false }
  it('converts the amount to micros', () => {
    const c = buildBudget({ ...base, newAmount: 2500 })
    expect(c.mutations[0]).toEqual({
      endpoint: 'campaignBudgets:mutate',
      operations: [{ updateMask: 'amount_micros', update: { resourceName: base.budgetResource, amountMicros: '2500000000' } }],
    })
    expect(c.summary[0]).toContain('2000 → 2500 (+25%)')
  })
  it('refuses a change above the guard unless forced', () => {
    expect(() => buildBudget({ ...base, newAmount: 5000 })).toThrow(/150% change is above the 50% guard/)
    expect(buildBudget({ ...base, newAmount: 5000, force: true }).warnings.join()).toMatch(/Forced/)
  })
  it('warns about shared budgets and rejects no-op or invalid amounts', () => {
    expect(buildBudget({ ...base, newAmount: 2100, explicitlyShared: true }).warnings[0]).toMatch(/SHARED/)
    expect(() => buildBudget({ ...base, newAmount: 2000 })).toThrow(/already/)
    expect(() => buildBudget({ ...base, newAmount: -1 })).toThrow(/positive/)
  })
})

describe('set-bidding', () => {
  const base = { campaignResource: CAMP, campaignName: 'C', currentType: 'TARGET_SPEND', conversionsLast30d: 40 }
  it('max-conversions with a target CPA', () => {
    const c = buildBidding({ ...base, strategy: 'max-conversions', targetCpa: 7000 })
    expect(c.mutations[0].operations[0]).toEqual({
      updateMask: 'maximize_conversions.target_cpa_micros',
      update: { resourceName: CAMP, maximizeConversions: { targetCpaMicros: '7000000000' } },
    })
    expect(c.warnings).toEqual([])
  })
  it('max-conversions without a target still switches via the subfield mask, and warns on little data', () => {
    const c = buildBidding({ ...base, strategy: 'max-conversions', conversionsLast30d: 3 })
    expect(c.mutations[0].operations[0]).toMatchObject({ updateMask: 'maximize_conversions.target_cpa_micros', update: { maximizeConversions: {} } })
    expect(c.warnings[0]).toMatch(/Only 3 conversions/)
  })
  it('max-clicks is TargetSpend with an optional CPC cap', () => {
    const c = buildBidding({ ...base, strategy: 'max-clicks', maxCpc: 400 })
    expect(c.mutations[0].operations[0]).toEqual({
      updateMask: 'target_spend.cpc_bid_ceiling_micros',
      update: { resourceName: CAMP, targetSpend: { cpcBidCeilingMicros: '400000000' } },
    })
    expect(buildBidding({ ...base, strategy: 'max-clicks' }).warnings[0]).toMatch(/No --max-cpc/)
  })
  it('manual-cpc and option mismatches', () => {
    expect(buildBidding({ ...base, strategy: 'manual-cpc' }).mutations[0].operations[0]).toMatchObject({ update: { manualCpc: { enhancedCpcEnabled: false } } })
    expect(() => buildBidding({ ...base, strategy: 'max-clicks', targetCpa: 5 })).toThrow(/--target-cpa only/)
    expect(() => buildBidding({ ...base, strategy: 'max-conversions', maxCpc: 5 })).toThrow(/--max-cpc only/)
  })
})

describe('set-age', () => {
  const base = { adGroupResource: AG, adGroupName: 'C › A', existing: [], exclude: [], include: [], adjust: {} }
  it('parses ranges and bid adjustments', () => {
    expect(ageList('18-24, 65+,unknown')).toEqual(['AGE_RANGE_18_24', 'AGE_RANGE_65_UP', 'AGE_RANGE_UNDETERMINED'])
    expect(() => ageList('20-30')).toThrow(/Unknown age range/)
    expect(bidAdjustments('25-34:+20,65+:-30%')).toEqual({ AGE_RANGE_25_34: 1.2, AGE_RANGE_65_UP: 0.7 })
    expect(() => bidAdjustments('25-34:-95')).toThrow(/between -90 and \+900/)
  })
  it('excludes: new negatives, and an existing positive criterion is removed first', () => {
    const c = buildAge({
      ...base,
      existing: [{ resourceName: `${AG.replace('adGroups', 'adGroupCriteria')}~503001`, type: 'AGE_RANGE_18_24', negative: false }],
      exclude: ['AGE_RANGE_18_24', 'AGE_RANGE_65_UP'],
    })
    expect(c.mutations[0].operations).toEqual([
      { remove: 'customers/1/adGroupCriteria/20~503001' },
      { create: { adGroup: AG, negative: true, ageRange: { type: 'AGE_RANGE_18_24' } } },
      { create: { adGroup: AG, negative: true, ageRange: { type: 'AGE_RANGE_65_UP' } } },
    ])
  })
  it('include removes the exclusion; bid-adjust updates or creates', () => {
    const c = buildAge({
      ...base,
      existing: [
        { resourceName: 'r1', type: 'AGE_RANGE_65_UP', negative: true },
        { resourceName: 'r2', type: 'AGE_RANGE_35_44', negative: false, bidModifier: 1 },
      ],
      include: ['AGE_RANGE_65_UP'],
      adjust: { AGE_RANGE_35_44: 1.2, AGE_RANGE_25_34: 0.8 },
    })
    expect(c.mutations[0].operations).toEqual([
      { remove: 'r1' },
      { create: { adGroup: AG, ageRange: { type: 'AGE_RANGE_25_34' }, bidModifier: 0.8 } },
      { updateMask: 'bid_modifier', update: { resourceName: 'r2', bidModifier: 1.2 } },
    ])
  })
  it('refuses to exclude every age range and contradictory requests', () => {
    expect(() => buildAge({ ...base, exclude: ageList('18-24,25-34,35-44,45-54,55-64,65+') })).toThrow(/every age range/)
    expect(() => buildAge({ ...base, exclude: ['AGE_RANGE_18_24'], include: ['AGE_RANGE_18_24'] })).toThrow(/same time/)
  })
})

describe('set-location', () => {
  const names = { '2348': 'Hungary', '1007633': 'Budapest,Hungary', '20429': 'Pest County,Hungary' }
  const base = {
    campaignResource: CAMP, campaignName: 'C', proximityCount: 0, add: [], exclude: [], remove: [], names, force: false,
    existing: [{ resourceName: 'customers/1/campaignCriteria/10~2348', geoId: '2348', negative: false }],
    currentGeoType: 'PRESENCE_OR_INTEREST',
  }
  it('adds, excludes and switches to presence-only', () => {
    const c = buildLocation({ ...base, add: ['1007633'], exclude: ['20429'], geoType: 'presence' })
    expect(c.mutations).toEqual([
      {
        endpoint: 'campaignCriteria:mutate',
        operations: [
          { create: { campaign: CAMP, location: { geoTargetConstant: 'geoTargetConstants/1007633' } } },
          { create: { campaign: CAMP, negative: true, location: { geoTargetConstant: 'geoTargetConstants/20429' } } },
        ],
      },
      {
        endpoint: 'campaigns:mutate',
        operations: [{
          updateMask: 'geo_target_type_setting.positive_geo_target_type',
          update: { resourceName: CAMP, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' } },
        }],
      },
    ])
  })
  it('refuses to leave no targeted location (worldwide) unless forced', () => {
    expect(() => buildLocation({ ...base, remove: ['2348'] })).toThrow(/ALL countries/)
    const forced = buildLocation({ ...base, remove: ['2348'], force: true })
    expect(forced.mutations[0].operations).toEqual([{ remove: 'customers/1/campaignCriteria/10~2348' }])
    expect(buildLocation({ ...base, remove: ['2348'], proximityCount: 1 }).warnings).toEqual([])
  })
  it('rejects unknown IDs, clashes, and no-ops', () => {
    expect(() => buildLocation({ ...base, add: ['999'] })).toThrow(/Unknown geo target 999/)
    expect(() => buildLocation({ ...base, add: ['1007633'], exclude: ['1007633'] })).toThrow(/more than one/)
    expect(() => buildLocation({ ...base, add: ['2348'] })).toThrow(/Nothing to change/)
    expect(() => buildLocation({ ...base, remove: ['20429'] })).toThrow(/not set/)
  })
})
