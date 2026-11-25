/**
 * Ad copy and keyword planning: read the live ads, check a new campaign spec or ad before it is
 * uploaded, plan a new RSA, and get keyword ideas. The checks live in src/adcopy.ts; the lessons
 * in knowledge/playbook/ad-copy.md and knowledge/playbook/keyword-planning.md.
 */
import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { call, micros } from '../client.js'
import { CliError } from '../config.js'
import { ids } from '../gaql.js'
import type { Change } from '../builders.js'
import { duplicateAdsAcrossGroups, lintAd, lintAdGroup, lintAssets, sameMeaningKey, type Issue } from '../adcopy.js'
import { adText, checkSpec, rsa, type AdSpec, type CreateSpec } from '../campaign.js'
import { negativeBlocks, words, stripAccents } from '../negatives.js'
import { adGroupKeywords, adsState, getAdGroup, listCampaigns, negativeState } from '../state.js'
import { cidOf, out } from './read.js'
import { PLAN_NOTE, propose, withPlanOptions } from './write.js'

const readJson = <T>(file: string): T => {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch (e) { throw new CliError(`Cannot read ${file}: ${(e as Error).message}`) }
}

export function registerAds(program: Command): void {
  program.command('ads').description(`The live responsive search ads by ad group, with the deterministic checks of the playbook.

Read-only. For each enabled ad group: its ads (headlines with pins, descriptions, final URL, Ad
Strength, approval) and "issues": keywords not entirely inside one headline, pinning, too few
or similar headlines, one RSA only, the same ad in several groups. For each enabled campaign:
the assets it really shows (own, or the account's) and their issues (sitelinks without
descriptions, too few sitelinks / callouts, no structured snippet). See knowledge/playbook/ad-copy.md.

OUTPUT: { adGroups: [{ campaign, adGroupId, adGroup, keywords, ads: [{ adId, adStrength, approval,
  finalUrl, path, headlines: [{text, pin}], descriptions }], issues }], campaigns: [{ campaign,
  sitelinks, callouts, snippets, call, issues }] }`)
    .option('--customer-id <id>', 'account ID (no dashes); default GOOGLE_ADS_CUSTOMER_ID')
    .option('--campaign <id>', 'only this campaign')
    .option('--json', 'JSON output (always on, accepted for clarity)')
    .action(async (_, cmd) => {
      const cid = cidOf(cmd)
      const only = cmd.opts().campaign ? String(cmd.opts().campaign) : undefined
      const [{ ads, assets }, keywords] = await Promise.all([adsState(cid), adGroupKeywords(undefined, cid)])
      out(liveAdReport(ads.filter(a => !only || a.campaignId === only), assets.filter(a => !only || a.campaignId === only),
        keywords.filter(k => k.serving)))
    })

  program.command('check-spec').description(`Check a create-campaign spec without uploading anything: Google's limits (errors) and
the playbook's recommendations (warnings) for ads, assets, keywords and negatives.

Run it after every edit of the spec, until "errors" is empty and every warning is either fixed
or a conscious decision. create-campaign repeats the same checks and puts the warnings into the
plan. With --offline it does not even read the account (the "campaign name exists" check is skipped).

OUTPUT: { ok, errors: [..], warnings: [{ level, code, message }], coverage: [{ campaign, adGroup,
  keywords, inHeadline, missing }] }

EXAMPLES:
  google-ads check-spec --spec specs/new-campaigns.json
  google-ads check-spec --spec specs/new-campaigns.json --offline`)
    .requiredOption('--spec <file>', 'path of the JSON spec (same format as create-campaign)')
    .option('--offline', 'do not read the account')
    .option('--customer-id <id>', 'account ID (no dashes); default GOOGLE_ADS_CUSTOMER_ID')
    .option('--json', 'JSON output (always on, accepted for clarity)')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const spec = readJson<CreateSpec>(o.spec)
      const existing = o.offline ? [] : (await listCampaigns(cidOf(cmd))).filter(c => c.status !== 'REMOVED').map(c => c.name)
      out(checkSpec(spec, existing))
    })

  withPlanOptions(program.command('add-ad').description(`Plan: new responsive search ads in an existing ad group, optionally pausing old ones in the same call.${PLAN_NOTE}

The JSON is one ad of the create-campaign spec, or an array of them:
  { "finalUrl": "https://…", "path1": "…", "headlines": ["…", { "text": "…", "pin": 1 }], "descriptions": ["…"] }
The text of an RSA cannot be edited in Google Ads: to improve an ad, add the new one and pause the
old one with --pause <adId> (ad IDs: google-ads ads). Both happen in one atomic call, so the ad
group is never left without an ad. Errors (limits) refuse the plan; the playbook warnings
(keyword not in a headline, pins, too few headlines, the same headlines as another ad) go into
the plan's warnings. Google recommends 2 RSAs per ad group. See knowledge/playbook/ad-copy.md.

EXAMPLES:
  google-ads add-ad --ad-group 456 --spec specs/ad-moving-b.json
  google-ads add-ad --ad-group 456 --spec specs/ads-moving.json --pause 832376008704`))
    .requiredOption('--ad-group <id>', 'ad group ID (see: google-ads ad-groups)')
    .requiredOption('--spec <file>', 'path of the ad JSON (one ad or an array)')
    .option('--pause <adIds>', 'comma-separated IDs of ads in this ad group to pause in the same call')
    .option('--paused', 'create the new ads paused')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const raw = readJson<AdSpec | AdSpec[]>(o.spec)
      const specs = Array.isArray(raw) ? raw : [raw]
      const [ag, keywords, { ads }] = await Promise.all([getAdGroup(o.adGroup, cid), adGroupKeywords(o.adGroup, cid), adsState(cid)])
      const existing = ads.filter(a => a.adGroupId === String(o.adGroup))
      const change = buildAddAds({
        adGroupResource: ag.resourceName, adGroupName: `${ag.campaign} › ${ag.name}`, specs, keywords: keywords.filter(k => k.serving).map(k => k.text),
        existing: existing.map(a => ({ adId: a.adId, ad: a.ad })), pause: ids(o.pause, 'ad ID'), paused: Boolean(o.paused),
      })
      await propose(cmd, 'add-ad', change, { adGroup: ag.name, ads: existing.map(a => ({ adId: a.adId, adStrength: a.adStrength, headlines: a.ad.headlines.map(h => h.text) })) })
    })

  program.command('keyword-ideas').description(`Keyword ideas from Google's Keyword Planner for an area and a language: average monthly
searches, competition and the top-of-page bid range. Read-only (it changes nothing).

Each idea also says whether the account already has it as a keyword (close variants count: accents,
word order, spacing) and in which enabled campaigns a negative would block it. Choose by intent,
not by volume: see knowledge/playbook/keyword-planning.md. Needs a developer token with Basic access
or higher; a test token returns an error.

OUTPUT FIELDS: keyword, avgMonthlySearches, competition (LOW | MEDIUM | HIGH), lowTopOfPageBid,
  highTopOfPageBid (account currency), inAccount (the existing keyword, or null), blockedIn
  (campaigns whose negatives block it)

EXAMPLES:
  google-ads keyword-ideas --seed "költöztetés,bútorszállítás" --geo 1007633,20429 --language 1024
  google-ads keyword-ideas --url https://example.com/moving --geo 1007633 --language 1000`)
    .option('--seed <keywords>', 'comma-separated seed keywords')
    .option('--url <url>', 'a page to take ideas from')
    .requiredOption('--geo <ids>', 'geo target IDs, e.g. a city and its county (see: google-ads geo-search)')
    .requiredOption('--language <id>', 'language constant ID, e.g. 1024 Hungarian, 1000 English')
    .option('--top <count>', 'at most this many ideas', '100')
    .option('--customer-id <id>', 'account ID (no dashes); default GOOGLE_ADS_CUSTOMER_ID')
    .option('--json', 'JSON output (always on, accepted for clarity)')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const seeds = String(o.seed ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)
      if (!seeds.length && !o.url) throw new CliError('Give --seed and/or --url')
      const geo = ids(o.geo, 'geo ID')
      if (!geo.length) throw new CliError('--geo is empty')
      const language = ids(o.language, 'language ID')[0]
      const body: Record<string, unknown> = {
        language: `languageConstants/${language}`,
        geoTargetConstants: geo.map(g => `geoTargetConstants/${g}`),
        keywordPlanNetwork: 'GOOGLE_SEARCH',
        includeAdultKeywords: false,
        pageSize: 1000,
        ...(seeds.length && o.url ? { keywordAndUrlSeed: { url: o.url, keywords: seeds } }
          : seeds.length ? { keywordSeed: { keywords: seeds } } : { urlSeed: { url: o.url } }),
      }
      const [res, keywords, { negatives, lists }, campaigns] = await Promise.all([
        call('generateKeywordIdeas', body, cid), adGroupKeywords(undefined, cid), negativeState(cid), listCampaigns(cid),
      ])
      const ideas = (res.results ?? []).map((r: any) => ({
        keyword: String(r.text ?? ''),
        avgMonthlySearches: Number(r.keywordIdeaMetrics?.avgMonthlySearches ?? 0),
        competition: r.keywordIdeaMetrics?.competition ?? 'UNSPECIFIED',
        lowTopOfPageBid: micros(r.keywordIdeaMetrics?.lowTopOfPageBidMicros),
        highTopOfPageBid: micros(r.keywordIdeaMetrics?.highTopOfPageBidMicros),
      }))
      out(annotateIdeas(ideas, keywords.filter(k => k.serving), negatives, lists,
        campaigns.filter(c => c.status === 'ENABLED').map(c => ({ id: c.id, name: c.name })), Number(o.top) || 100))
    })
}

/**
 * add-ad: new RSAs (refused on a limit error) and, in the same call, old ads of the group paused.
 * The playbook warnings are computed for the ad group as it will be after the change.
 */
export function buildAddAds(input: {
  adGroupResource: string
  adGroupName: string
  specs: AdSpec[]
  keywords: string[]
  existing: Array<{ adId: string; ad: ReturnType<typeof adText> }>
  pause?: string[]
  paused?: boolean
}): Change {
  if (!input.specs.length) throw new CliError('The ad JSON is empty')
  for (const s of input.specs) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new CliError('Each ad must be an object with finalUrl, headlines and descriptions')
    if (!s.finalUrl) throw new CliError('Every ad needs a finalUrl')
  }
  const pause = [...new Set(input.pause ?? [])]
  for (const id of pause) if (!input.existing.some(e => e.adId === id)) throw new CliError(`Ad ${id} is not an enabled ad of "${input.adGroupName}" (see: google-ads ads)`)
  const news = input.specs.map(adText)
  const errors = news.flatMap((ad, i) => lintAdGroup([ad], input.keywords, `"${input.adGroupName}" › new ad ${i + 1}`)).filter(i => i.level === 'error')
  if (errors.length) throw new CliError(errors.map(e => e.message).join('; '))
  const after = [...input.existing.filter(e => !pause.includes(e.adId)).map(e => e.ad), ...(input.paused ? [] : news)]
  const warnings = [
    ...news.flatMap((ad, i) => lintAd(ad, input.keywords, `"${input.adGroupName}" › new ad ${i + 1}`)).filter(i => i.level === 'warning'),
    ...lintAdGroup(after, input.keywords, `"${input.adGroupName}" after the change`).filter(i => i.code === 'single-rsa' || i.code === 'duplicate-ads' || i.code === 'no-ad'),
  ].map(i => `[${i.code}] ${i.message}`)
  if (!after.length) throw new CliError(`After this change "${input.adGroupName}" would have no enabled ad.`)
  const [, cid, , agId] = input.adGroupResource.split('/')
  const ops = [
    ...input.specs.map(s => ({ create: { adGroup: input.adGroupResource, status: input.paused ? 'PAUSED' : 'ENABLED', ad: rsa(s) } })),
    ...pause.map(id => ({ updateMask: 'status', update: { resourceName: `customers/${cid}/adGroupAds/${agId}~${id}`, status: 'PAUSED' } })),
  ]
  const summary = news.flatMap((ad, i) => [
    `add ${input.paused ? 'a PAUSED' : 'an'} RSA to "${input.adGroupName}" (new ad ${i + 1}): ${ad.headlines.length} headlines / ${ad.descriptions.length} descriptions → ${ad.finalUrl}`,
    `  headlines: ${ad.headlines.map(h => `${h.text}${h.pin ? ` [pin ${h.pin}]` : ''}`).join(' · ')}`,
    `  descriptions: ${ad.descriptions.map(d => d.text).join(' · ')}`,
  ])
  for (const id of pause) summary.push(`pause ad ${id} in "${input.adGroupName}" (its text cannot be edited; the new ads replace it)`)
  return { summary, warnings, mutations: [{ endpoint: 'adGroupAds:mutate', operations: ops }] }
}

/** One new RSA, no pause: kept for callers of the first version. */
export function buildAddAd(input: { adGroupResource: string; adGroupName: string; spec: AdSpec; keywords: string[]; existing: Array<ReturnType<typeof adText>>; paused?: boolean }): Change {
  return buildAddAds({ ...input, specs: [input.spec], existing: input.existing.map((ad, i) => ({ adId: `existing-${i}`, ad })) })
}

/** The ads command's output: per ad group and per campaign, with the checks. */
export function liveAdReport(
  ads: Array<{ campaignId: string; campaign: string; adGroupId: string; adGroup: string; adId: string; approval: string; adStrength: string; ad: ReturnType<typeof adText> }>,
  assets: Array<{ campaignId: string; campaign: string; sitelinks: any[]; callouts: string[]; snippets: any[]; call: boolean }>,
  keywords: Array<{ adGroupId: string; text: string }>,
): { adGroups: unknown[]; campaigns: unknown[] } {
  const groups = new Map<string, typeof ads>()
  ads.forEach(a => groups.set(a.adGroupId, [...(groups.get(a.adGroupId) ?? []), a]))
  const adGroups = [...groups.entries()].map(([agId, list]) => {
    const kws = keywords.filter(k => k.adGroupId === agId).map(k => k.text)
    return {
      campaign: list[0].campaign, adGroupId: agId, adGroup: list[0].adGroup, keywords: kws.length,
      ads: list.map(a => ({ adId: a.adId, adStrength: a.adStrength, approval: a.approval, finalUrl: a.ad.finalUrl,
        path: [a.ad.path1, a.ad.path2].filter(Boolean).join('/'), headlines: a.ad.headlines, descriptions: a.ad.descriptions.map(d => d.text) })),
      issues: lintAdGroup(list.map(a => a.ad), kws, `"${list[0].adGroup}"`).filter(i => i.level === 'warning'),
    }
  })
  const campaigns = assets.map(c => {
    const own = ads.filter(a => a.campaignId === c.campaignId)
    const byGroup = new Map<string, typeof ads>()
    own.forEach(a => byGroup.set(a.adGroup, [...(byGroup.get(a.adGroup) ?? []), a]))
    const issues: Issue[] = [
      ...lintAssets({ sitelinks: c.sitelinks, callouts: c.callouts, snippets: c.snippets, headlines: own.flatMap(a => a.ad.headlines.map(h => h.text)) }, `"${c.campaign}"`)
        .filter(i => i.level === 'warning'),
      ...duplicateAdsAcrossGroups([...byGroup].map(([name, l]) => ({ name, ads: l.map(a => a.ad) }))),
      ...(c.call ? [] : [{ level: 'warning' as const, code: 'no-call-asset', message: `"${c.campaign}": no call asset` }]),
    ]
    return { campaign: c.campaign, campaignId: c.campaignId, sitelinks: c.sitelinks, callouts: c.callouts, snippets: c.snippets, call: c.call, issues }
  })
  return { adGroups, campaigns }
}

/** keyword-ideas: sorted by volume, with "already a keyword" and "blocked by a negative" flags. */
export function annotateIdeas(
  ideas: Array<{ keyword: string; avgMonthlySearches: number; competition: string; lowTopOfPageBid: number; highTopOfPageBid: number }>,
  keywords: Array<{ text: string; campaignId: string }>,
  negatives: Array<{ level: string; campaignId?: string; listId?: string; text: string; match: string }>,
  lists: Array<{ id: string; campaignIds: string[] }>,
  campaigns: Array<{ id: string; name: string }>,
  top: number,
): unknown[] {
  const compact = (s: string) => words(stripAccents(s)).join('')
  const existing = keywords.map(k => ({ text: k.text, key: sameMeaningKey(k.text), compact: compact(k.text) }))
  const applies = (n: { level: string; campaignId?: string; listId?: string }, campaignId: string) =>
    n.level === 'campaign' ? n.campaignId === campaignId : n.level === 'list' ? (lists.find(l => l.id === n.listId)?.campaignIds ?? []).includes(campaignId) : false
  return [...ideas]
    .sort((a, b) => b.avgMonthlySearches - a.avgMonthlySearches || a.keyword.localeCompare(b.keyword))
    .slice(0, top)
    .map(i => {
      const hit = existing.find(k => k.key === sameMeaningKey(i.keyword) || k.compact === compact(i.keyword))
      return {
        ...i,
        inAccount: hit ? hit.text : null,
        blockedIn: campaigns.filter(c => negatives.some(n => applies(n, c.id) && negativeBlocks(n, i.keyword))).map(c => c.name),
      }
    })
}
