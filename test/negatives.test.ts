/** Negative keyword matching as Google documents it (support.google.com/google-ads/answer/2453972). */
import { describe, expect, it } from 'vitest'
import {
  checkKeywordTexts, keywordConflicts, missingAccentVariants, negativeBlocks, ngrams, stripAccents, subsumes, withAccentVariants, words,
} from '../src/negatives.js'
import { buildAddNegatives, buildAttachNegativeList, buildCreateNegativeList } from '../src/builders.js'
import { lastDaysClause } from '../src/gaql.js'

const b = (text: string) => ({ text, match: 'BROAD' })
const p = (text: string) => ({ text, match: 'PHRASE' })
const e = (text: string) => ({ text, match: 'EXACT' })

describe('negativeBlocks: the examples of the Google help page', () => {
  it('BROAD: all words in any order, no plural', () => {
    expect(negativeBlocks(b('running shoes'), 'blue running shoes')).toBe(true)
    expect(negativeBlocks(b('running shoes'), 'shoes running')).toBe(true)
    expect(negativeBlocks(b('running shoes'), 'running shoe')).toBe(false)
    expect(negativeBlocks(b('running shoes'), 'blue tennis shoes')).toBe(false)
  })
  it('PHRASE: the words in this order, more words around them allowed', () => {
    expect(negativeBlocks(p('running shoes'), 'blue running shoes')).toBe(true)
    expect(negativeBlocks(p('running shoes'), 'shoes running')).toBe(false)
  })
  it('EXACT: nothing else', () => {
    expect(negativeBlocks(e('running shoes'), 'running shoes')).toBe(true)
    expect(negativeBlocks(e('running shoes'), 'blue running shoes')).toBe(false)
  })
  it('accents make two different keywords; case does not', () => {
    expect(negativeBlocks(b('állás'), 'állás budapest')).toBe(true)
    expect(negativeBlocks(b('állás'), 'allas budapest')).toBe(false)
    expect(negativeBlocks(b('ÁLLÁS'), 'Állás Budapest')).toBe(true)
  })
  it('a comma is a word break: PHRASE "5 tonnás" also blocks "1,5 tonnás"', () => {
    expect(words('furgon 1,5 tonnás')).toEqual(['furgon', '1', '5', 'tonnás'])
    expect(negativeBlocks(p('5 tonnás'), 'furgon 1,5 tonnás')).toBe(true)
    expect(negativeBlocks(e('5 tonnás'), 'furgon 1,5 tonnás')).toBe(false)
  })
  it('only the first 16 words of a search count', () => {
    const long = Array.from({ length: 16 }, (_, i) => `w${i}`).join(' ')
    expect(negativeBlocks(b('free'), `${long} free`)).toBe(false)
    expect(negativeBlocks(b('free'), `free ${long}`)).toBe(true)
  })
})

describe('subsumes', () => {
  it('a broad word covers every negative containing it; phrase and exact are narrower', () => {
    expect(subsumes(b('kontener'), b('kontener ar'))).toBe(true)
    expect(subsumes(b('kontener'), e('olcso kontener'))).toBe(true)
    expect(subsumes(p('kontener ar'), b('ar kontener'))).toBe(false)
    expect(subsumes(p('kontener ar'), e('olcso kontener ar'))).toBe(true)
    expect(subsumes(e('kontener'), e('kontener'))).toBe(true)
    expect(subsumes(e('kontener'), p('kontener'))).toBe(false)
  })
})

describe('accent variants', () => {
  it('strips Hungarian accents', () => {
    expect(stripAccents('Költöztetés űrlap ő')).toBe('koltoztetes urlap o')
  })
  it('adds the unaccented form after each accented term, without duplicates', () => {
    expect(withAccentVariants(['állás', ' munka ', 'allas', 'Bérlés'])).toEqual(['állás', 'allas', 'munka', 'Bérlés', 'berles'])
  })
  it('reports accented negatives whose twin is missing and not covered', () => {
    const negs = [b('állás'), b('konténer'), b('kontener'), b('konténer ár'), e('bérlés'), b('berles')]
    // konténer ár → kontener ar is covered by broad "kontener"; bérlés [EXACT] → berles by broad "berles"
    expect(missingAccentVariants(negs)).toEqual([{ text: 'állás', match: 'BROAD', variant: 'allas' }])
  })
})

describe('keywordConflicts', () => {
  const kw = (text: string, over = {}) => ({ text, match: 'EXACT', status: 'ENABLED', campaignId: '10', adGroupId: '20', ...over })
  it('finds negatives of the campaign, the ad group and attached lists that block an enabled keyword', () => {
    const found = keywordConflicts(
      [kw('furgon 1,5 tonnás'), kw('fuvarozás budapest'), kw('költöztetés', { status: 'PAUSED' }), kw('bútor', { campaignId: '11' })],
      [
        { ...p('5 tonnás'), level: 'campaign', campaignId: '10' },
        { ...b('budapest'), level: 'list', listId: '7', listName: 'Common' },
        { ...b('költöztetés'), level: 'campaign', campaignId: '10' },
        { ...b('bútor'), level: 'adGroup', adGroupId: '99' },
      ],
      { 7: ['10'] },
    )
    expect(found.map(f => `${f.keyword.text} ← ${f.negative.text}`)).toEqual(['furgon 1,5 tonnás ← 5 tonnás', 'fuvarozás budapest ← budapest'])
  })
})

describe('ngrams', () => {
  it('sums every search term that contains a piece, once per term, sorted by cost', () => {
    const g = ngrams([
      { term: 'konténer ár budapest', cost: 1000, clicks: 2, impressions: 10, conversions: 0, campaignId: '10' },
      { term: 'konténer konténer rendelés', cost: 500, clicks: 1, impressions: 5, conversions: 0, campaignId: '11' },
      { term: 'sittszállítás budapest', cost: 300, clicks: 1, impressions: 4, conversions: 1, campaignId: '10' },
    ], [1])
    expect(g[0]).toMatchObject({ ngram: 'konténer', terms: 2, cost: 1500, clicks: 3, campaignIds: ['10', '11'] })
    expect(g.find(x => x.ngram === 'budapest')).toMatchObject({ terms: 2, cost: 1300, conversions: 1 })
  })
})

describe('keyword text checks', () => {
  it('refuses commas and forbidden characters before the API, with the reason', () => {
    expect(() => checkKeywordTexts(['1,5 tonnás'])).toThrow(/word break/)
    expect(() => checkKeywordTexts(['free!'])).toThrow(/"!" is not allowed/)
    expect(() => checkKeywordTexts(['a b c d e f g h i j k'])).toThrow(/more than 10 words/)
    expect(() => checkKeywordTexts(['sittszállítás & lomtalanítás'])).not.toThrow()
  })
})

describe('negative plans', () => {
  const CAMP = 'customers/1/campaigns/10'
  it('add-negative --with-accent-variants adds the twin and skips what an existing negative covers', () => {
    const c = buildAddNegatives({
      campaignResource: CAMP, campaignName: 'Fuvarozás', match: 'BROAD', accentVariants: true,
      terms: ['állás', 'konténer bérlés'], existing: [b('kontener'), b('konténer')],
    })
    expect(c.mutations[0].operations.map((o: any) => o.create.keyword.text)).toEqual(['állás', 'allas'])
    expect(c.warnings.join(' ')).toMatch(/"konténer bérlés" \[BROAD\] is already covered by "konténer"/)
    expect(c.warnings.join(' ')).toMatch(/"kontener berles" \[BROAD\] is already covered by "kontener"/)
  })
  it('add-negative --list writes shared criteria', () => {
    const c = buildAddNegatives({ sharedSetResource: 'customers/1/sharedSets/7', campaignName: 'Common', match: 'BROAD', terms: ['ingyen'], existing: [] })
    expect(c.mutations).toEqual([{ endpoint: 'sharedCriteria:mutate', operations: [{ create: { sharedSet: 'customers/1/sharedSets/7', keyword: { text: 'ingyen', matchType: 'BROAD' } } }] }])
    expect(c.summary[0]).toContain('negative list "Common"')
  })
  it('create-negative-list: list, keywords and attachments in one atomic call', () => {
    const c = buildCreateNegativeList({
      customerId: '1', name: 'Common', terms: ['állás', 'munka'], match: 'BROAD', accentVariants: true, existingNames: ['Other'],
      attach: [{ resourceName: CAMP, name: 'Fuvarozás' }],
    })
    const ops = c.mutations[0].operations as any[]
    expect(c.mutations[0].endpoint).toBe('googleAds:mutate')
    expect(ops[0]).toEqual({ sharedSetOperation: { create: { resourceName: 'customers/1/sharedSets/-1', name: 'Common', type: 'NEGATIVE_KEYWORDS' } } })
    expect(ops.slice(1, 4).map(o => o.sharedCriterionOperation.create.keyword.text)).toEqual(['állás', 'allas', 'munka'])
    expect(ops[4]).toEqual({ campaignSharedSetOperation: { create: { campaign: CAMP, sharedSet: 'customers/1/sharedSets/-1' } } })
    expect(() => buildCreateNegativeList({ customerId: '1', name: 'other', terms: ['x'], match: 'BROAD', existingNames: ['Other'], attach: [] }))
      .toThrow(/already exists/)
    expect(buildCreateNegativeList({ customerId: '1', name: 'New', terms: ['x'], match: 'BROAD', existingNames: [], attach: [] }).warnings[0])
      .toMatch(/blocks nothing/)
  })
  it('attach-negative-list attaches, detaches and skips what is already so', () => {
    const list = { id: '7', resourceName: 'customers/1/sharedSets/7', name: 'Common' }
    const camps = [{ id: '10', resourceName: CAMP, name: 'A' }, { id: '11', resourceName: 'customers/1/campaigns/11', name: 'B' }]
    const on = buildAttachNegativeList({ customerId: '1', list, campaigns: camps, attached: ['10'] })
    expect(on.mutations[0]).toEqual({ endpoint: 'campaignSharedSets:mutate', operations: [{ create: { campaign: 'customers/1/campaigns/11', sharedSet: list.resourceName } }] })
    expect(on.warnings[0]).toMatch(/already attached to campaign "A"/)
    const off = buildAttachNegativeList({ customerId: '1', list, campaigns: camps, attached: ['10'], detach: true })
    expect(off.mutations[0].operations).toEqual([{ remove: 'customers/1/campaignSharedSets/10~7' }])
  })
})

describe('lastDaysClause', () => {
  it('ends yesterday and spans N days', () => {
    expect(lastDaysClause(60, new Date(2026, 10, 25))).toBe("segments.date BETWEEN '2026-09-26' AND '2026-11-24'")
    expect(() => lastDaysClause(0)).toThrow()
  })
})

describe('remove-negative', () => {
  it('removes the matching campaign negatives, every match type unless --match, and refuses unknown terms', async () => {
    const { buildRemoveNegatives } = await import('../src/builders.js')
    const existing = [
      { resourceName: 'customers/1/campaignCriteria/9~11', text: 'raklap', match: 'BROAD' },
      { resourceName: 'customers/1/campaignCriteria/9~12', text: 'raklap', match: 'EXACT' },
      { resourceName: 'customers/1/campaignCriteria/9~13', text: 'kamion', match: 'BROAD' },
    ]
    const all = buildRemoveNegatives({ campaignName: 'C', terms: ['Raklap'], existing })
    expect(all.mutations[0]).toEqual({ endpoint: 'campaignCriteria:mutate', operations: [
      { remove: 'customers/1/campaignCriteria/9~11' }, { remove: 'customers/1/campaignCriteria/9~12' },
    ] })
    const broad = buildRemoveNegatives({ campaignName: 'C', terms: ['raklap'], match: 'BROAD', existing })
    expect(broad.mutations[0].operations).toEqual([{ remove: 'customers/1/campaignCriteria/9~11' }])
    expect(() => buildRemoveNegatives({ campaignName: 'C', terms: ['raklapp'], existing })).toThrow(/not a negative/)
  })
})
