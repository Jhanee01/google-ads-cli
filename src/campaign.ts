/**
 * create-campaign: a JSON spec → one atomic googleAds:mutate call that creates budgets, Search
 * campaigns (PAUSED), locations, language, negatives, ad groups, exact keywords, RSAs and assets.
 * Pure: no network here. New resources reference each other through temporary (negative) IDs.
 */
import { CliError } from './config.js'
import { toMicros } from './client.js'
import { matchType, type Change, type MatchType, type Op } from './builders.js'
import { duplicateAdsAcrossGroups, keywordCoverage, lintAdGroup, lintAssets, lintKeywords, type AdText, type Issue, type Snippet } from './adcopy.js'
import { checkKeywordTexts, missingAccentVariants, negativeBlocks, withAccentVariants } from './negatives.js'

export interface PinnedText { text: string; pin?: 1 | 2 | 3 }
export interface AdSpec {
  finalUrl: string
  path1?: string
  path2?: string
  headlines: Array<string | PinnedText>
  descriptions: Array<string | { text: string; pin?: 1 | 2 }>
}
export interface AdGroupSpec {
  name: string
  keywords: string[]
  match?: string
  /** one RSA (older specs) … */
  ad?: AdSpec
  /** … or several: Google recommends 2 per ad group */
  ads?: AdSpec[]
}
export interface SitelinkSpec { text: string; url: string; description1?: string; description2?: string }
export interface CampaignSpec {
  name: string
  dailyBudget: number
  maxCpc: number
  geoIds: string[]
  languageIds: string[]
  callAssetId?: string
  sitelinks?: SitelinkSpec[]
  callouts?: string[]
  /** structured snippets, e.g. { "header": "Service catalog", "values": ["Moving", "Transport", "Waste removal"] } */
  snippets?: Snippet[]
  negatives?: Array<{ text: string; match?: string }>
  /** add the unaccented twin of every accented negative (Google treats them as two keywords) */
  negativeAccentVariants?: boolean
  adGroups: AdGroupSpec[]
}

/** The ads of an ad group, whichever way the spec lists them. */
export const adsOf = (ag: AdGroupSpec): AdSpec[] => [...(ag.ad ? [ag.ad] : []), ...(ag.ads ?? [])]

/** Spec ad → the shape the checks use. */
export function adText(a: AdSpec): AdText {
  return {
    finalUrl: a.finalUrl, path1: a.path1, path2: a.path2,
    headlines: (a.headlines ?? []).map(h => (typeof h === 'string' ? { text: h } : { text: h.text, pin: h.pin })),
    descriptions: (a.descriptions ?? []).map(d => (typeof d === 'string' ? { text: d } : { text: d.text, pin: d.pin })),
  }
}

/** The campaign's negatives as they will be created (with accent twins when asked). */
export function specNegatives(c: CampaignSpec): Array<{ text: string; match: MatchType }> {
  const out: Array<{ text: string; match: MatchType }> = []
  for (const n of c.negatives ?? []) {
    const match = matchType(n.match ?? 'BROAD')
    const texts = c.negativeAccentVariants ? withAccentVariants([n.text]) : [n.text.trim()]
    for (const text of texts) out.push({ text, match })
  }
  return out
}
export interface CreateSpec { campaigns: CampaignSpec[] }

const len = (s: string) => [...s].length
const PIN: Record<number, string> = { 1: 'HEADLINE_1', 2: 'HEADLINE_2', 3: 'HEADLINE_3' }

function check(ok: boolean, msg: string) { if (!ok) throw new CliError(msg) }
function digitsOnly(v: string, what: string) { check(/^\d+$/.test(String(v)), `${what} must be numeric, got "${v}"`); return String(v) }
function url(v: string, what: string) {
  check(/^https:\/\/[^\s]+$/.test(v ?? ''), `${what} must be an https:// URL, got "${v}"`)
  return v
}

export function validateSpec(spec: CreateSpec, existingCampaignNames: string[]): void {
  check(Array.isArray(spec?.campaigns) && spec.campaigns.length > 0, 'The spec needs a non-empty "campaigns" array.')
  const taken = new Set(existingCampaignNames.map(n => n.toLowerCase()))
  const names = new Set<string>()
  for (const c of spec.campaigns) {
    const where = `campaign "${c.name}"`
    check(Boolean(c.name?.trim()), 'Every campaign needs a name.')
    check(!taken.has(c.name.toLowerCase()), `A campaign called "${c.name}" already exists in the account.`)
    check(!names.has(c.name.toLowerCase()), `Campaign "${c.name}" appears twice in the spec.`)
    names.add(c.name.toLowerCase())
    check(c.dailyBudget > 0, `${where}: dailyBudget must be positive`)
    check(c.maxCpc > 0, `${where}: maxCpc must be positive (Maximize clicks without a cap is not allowed here)`)
    check(c.geoIds?.length > 0, `${where}: geoIds is empty, which would target the whole world`)
    c.geoIds.forEach(g => digitsOnly(g, `${where}: geo ID`))
    check(c.languageIds?.length > 0, `${where}: languageIds is empty`)
    c.languageIds.forEach(l => digitsOnly(l, `${where}: language ID`))
    if (c.callAssetId) digitsOnly(c.callAssetId, `${where}: callAssetId`)
    for (const s of c.sitelinks ?? []) {
      check(len(s.text) >= 1 && len(s.text) <= 25, `${where}: sitelink text "${s.text}" must be 1–25 characters`)
      url(s.url, `${where}: sitelink "${s.text}" url`)
      for (const d of [s.description1, s.description2]) if (d !== undefined) check(len(d) <= 35, `${where}: sitelink description "${d}" is over 35 characters`)
      check((s.description1 === undefined) === (s.description2 === undefined), `${where}: sitelink "${s.text}" needs both descriptions or neither`)
    }
    for (const t of c.callouts ?? []) check(len(t) >= 1 && len(t) <= 25, `${where}: callout "${t}" must be 1–25 characters`)
    const assetErrors = lintAssets({ sitelinks: [], callouts: [], snippets: c.snippets ?? [], headlines: [] }, where).filter(i => i.level === 'error')
    check(!assetErrors.length, assetErrors.map(e => e.message).join('; '))
    for (const n of c.negatives ?? []) { matchType(n.match ?? 'BROAD'); check(Boolean(n.text?.trim()), `${where}: empty negative`) }
    checkKeywordTexts((c.negatives ?? []).map(n => n.text.trim()), 'negative keyword')
    check(c.adGroups?.length > 0, `${where}: needs at least one ad group`)
    for (const ag of c.adGroups) {
      const w = `${where} › ad group "${ag.name}"`
      check(Boolean(ag.name?.trim()), `${where}: an ad group has no name`)
      check(ag.keywords?.length > 0, `${w}: no keywords`)
      checkKeywordTexts(ag.keywords.map(k => k.trim().replace(/\s+/g, ' ')), 'keyword')
      matchType(ag.match ?? 'EXACT')
      const ads = adsOf(ag)
      check(ads.length > 0, `${w}: needs an "ad" (or "ads")`)
      for (const a of ads) url(a?.finalUrl, `${w}: finalUrl`)
      const adErrors = lintAdGroup(ads.map(adText), ag.keywords, w).filter(i => i.level === 'error')
      check(!adErrors.length, adErrors.map(e => e.message).join('; '))
    }
  }
}

/** Negatives that would block one of the campaign's own keywords, matched as Google matches them (src/negatives.ts). */
export function negativeConflicts(c: CampaignSpec): string[] {
  const out: string[] = []
  const kws = c.adGroups.flatMap(ag => ag.keywords.map(k => k.trim().replace(/\s+/g, ' ')))
  for (const n of specNegatives(c)) {
    for (const k of kws) if (negativeBlocks(n, k)) out.push(`negative "${n.text}" [${n.match}] blocks keyword "${k}" in campaign "${c.name}"`)
  }
  return out
}

export interface SpecCheck {
  ok: boolean
  errors: string[]
  warnings: Issue[]
  /** per ad group: which keywords are inside a headline of at least one of its ads */
  coverage: Array<{ campaign: string; adGroup: string; keywords: number; inHeadline: number; missing: string[] }>
}

/**
 * Everything create-campaign checks, without the API: the hard limits (errors: nothing would be
 * uploaded) and the playbook recommendations (warnings) for the ads, assets, keywords and negatives.
 */
export function checkSpec(spec: CreateSpec, existingCampaignNames: string[] = []): SpecCheck {
  const out: SpecCheck = { ok: true, errors: [], warnings: [], coverage: [] }
  try {
    validateSpec(spec, existingCampaignNames)
  } catch (e) {
    out.errors.push(...(e as Error).message.split('; '))
  }
  if (!Array.isArray(spec?.campaigns)) return { ...out, ok: false }
  for (const c of spec.campaigns) {
    if (!Array.isArray(c.adGroups) || c.adGroups.some(ag => !Array.isArray(ag.keywords))) continue
    try { out.errors.push(...negativeConflicts(c)) } catch (e) { out.errors.push((e as Error).message) }
    const where = `campaign "${c.name}"`
    const groups = c.adGroups.map(ag => ({ name: ag.name, ads: adsOf(ag).map(adText), keywords: ag.keywords }))
    for (const g of groups) {
      out.warnings.push(...lintAdGroup(g.ads, g.keywords, `${where} › ad group "${g.name}"`).filter(i => i.level === 'warning'))
      const covered = new Set(g.ads.flatMap(a => keywordCoverage(g.keywords, a).covered.map(k => k.toLowerCase())))
      const all = [...new Set(g.keywords.map(k => k.trim().replace(/\s+/g, ' ')).filter(k => [...k].length <= 30))]
      out.coverage.push({ campaign: c.name, adGroup: g.name, keywords: all.length, inHeadline: all.filter(k => covered.has(k.toLowerCase())).length,
        missing: all.filter(k => !covered.has(k.toLowerCase())) })
    }
    out.warnings.push(...duplicateAdsAcrossGroups(groups).map(i => ({ ...i, message: `${where}: ${i.message}` })))
    out.warnings.push(...lintAssets({
      sitelinks: c.sitelinks ?? [], callouts: c.callouts ?? [], snippets: c.snippets ?? [],
      headlines: groups.flatMap(g => g.ads.flatMap(a => a.headlines.map(h => h.text))),
    }, where).filter(i => i.level === 'warning'))
    if (!c.callAssetId) out.warnings.push({ level: 'warning', code: 'no-call-asset', message: `${where}: no call asset (callAssetId): when calls are the goal, the phone number is the main conversion path` })
    try {
      const missing = missingAccentVariants(specNegatives(c))
      if (missing.length) {
        out.warnings.push({ level: 'warning', code: 'negative-missing-accent-variant', message: `${where}: ${missing.length} accented negative(s) without their unaccented twin ` +
          `(${missing.slice(0, 10).map(m => `"${m.text}" → "${m.variant}"`).join(', ')}${missing.length > 10 ? '…' : ''}): set "negativeAccentVariants": true` })
      }
    } catch { /* an invalid match type is already an error */ }
  }
  out.warnings.push(...lintKeywords(spec.campaigns.filter(c => Array.isArray(c.adGroups)).map(c => ({
    name: c.name, adGroups: c.adGroups.map(ag => ({ name: ag.name, keywords: ag.keywords ?? [] })),
  }))))
  out.errors = [...new Set(out.errors)]
  out.ok = out.errors.length === 0
  return out
}

/** Start (ENABLED) or pause (PAUSED) whole campaigns. */
export function buildCampaignStatus(
  campaigns: Array<{ resourceName: string; name: string; status: string; dailyBudget: number }>,
  status: 'ENABLED' | 'PAUSED' | 'REMOVED',
  force = false,
): Change {
  const c: Change = { summary: [], warnings: [], mutations: [] }
  const ops: Op[] = []
  for (const camp of campaigns) {
    if (camp.status === 'REMOVED') throw new CliError(`Campaign "${camp.name}" is removed and cannot be changed.`)
    if (status === 'REMOVED') {
      if (camp.status === 'ENABLED' && !force) {
        throw new CliError(`Campaign "${camp.name}" is running. Pause it first, or re-run with --force to remove it anyway.`)
      }
      ops.push({ remove: camp.resourceName })
      c.summary.push(`REMOVE campaign "${camp.name}" (was ${camp.status})`)
      continue
    }
    if (camp.status === status) { c.warnings.push(`"${camp.name}" is already ${status}, skipped`); continue }
    ops.push({ updateMask: 'status', update: { resourceName: camp.resourceName, status } })
    c.summary.push(`${status === 'ENABLED' ? 'start' : 'pause'} campaign "${camp.name}" (daily budget ${camp.dailyBudget})`)
  }
  if (ops.length) c.mutations.push({ endpoint: 'campaigns:mutate', operations: ops })
  if (status === 'ENABLED' && ops.length) c.warnings.push('Started campaigns begin to spend as soon as their ads are approved.')
  if (status === 'REMOVED' && ops.length) {
    c.warnings.push('Removing is permanent: a removed campaign cannot be enabled again. Its past statistics stay in the reports.')
  }
  return c
}

const LINKABLE = new Set(['SITELINK', 'CALLOUT', 'CALL', 'STRUCTURED_SNIPPET', 'PRICE', 'PROMOTION', 'AD_IMAGE', 'BUSINESS_NAME', 'BUSINESS_LOGO', 'LEAD_FORM'])

/** Link existing assets to a campaign, unlink linked ones, and create + link new sitelinks. One atomic call. */
export function buildCampaignAssets(input: {
  customerId: string
  campaignResource: string
  campaignName: string
  linked: Array<{ resourceName: string; assetId: string; fieldType: string }>
  link: Array<{ assetId: string; type: string; label: string }>
  unlink: string[]
  sitelinks: SitelinkSpec[]
}): Change {
  const c: Change = { summary: [], warnings: [], mutations: [] }
  const ops: Op[] = []
  const base = `customers/${input.customerId}`
  const isLinked = (id: string, field: string) => input.linked.some(l => l.assetId === id && l.fieldType === field)
  for (const id of input.unlink) {
    const hits = input.linked.filter(l => l.assetId === id)
    if (!hits.length) throw new CliError(`Asset ${id} is not linked to campaign "${input.campaignName}".`)
    for (const h of hits) {
      ops.push({ campaignAssetOperation: { remove: h.resourceName } })
      c.summary.push(`unlink ${h.fieldType} asset ${id} from campaign "${input.campaignName}"`)
    }
  }
  for (const a of input.link) {
    if (!LINKABLE.has(a.type)) throw new CliError(`Asset ${a.assetId} is a ${a.type} asset, which cannot be linked to a campaign here.`)
    if (isLinked(a.assetId, a.type)) { c.warnings.push(`${a.type} asset ${a.assetId} (${a.label}) is already linked, skipped`); continue }
    ops.push({ campaignAssetOperation: { create: { campaign: input.campaignResource, asset: `${base}/assets/${a.assetId}`, fieldType: a.type } } })
    c.summary.push(`link ${a.type} asset ${a.assetId} (${a.label}) to campaign "${input.campaignName}"`)
  }
  let next = -1
  for (const s of input.sitelinks) {
    check(len(s.text) >= 1 && len(s.text) <= 25, `sitelink text "${s.text}" must be 1–25 characters`)
    url(s.url, `sitelink "${s.text}" url`)
    const rn = `${base}/assets/${next--}`
    ops.push({ assetOperation: { create: { resourceName: rn, finalUrls: [s.url], sitelinkAsset: { linkText: s.text } } } })
    ops.push({ campaignAssetOperation: { create: { campaign: input.campaignResource, asset: rn, fieldType: 'SITELINK' } } })
    c.summary.push(`create sitelink "${s.text}" → ${s.url} and link it to campaign "${input.campaignName}"`)
  }
  // Removes first, so an unlink + link of the same asset in one call works.
  ops.sort((a, b) => Number(Boolean((b as any).campaignAssetOperation?.remove)) - Number(Boolean((a as any).campaignAssetOperation?.remove)))
  if (ops.length) c.mutations.push({ endpoint: 'googleAds:mutate', operations: ops })
  return c
}

/** "Text=https://…" → sitelink. */
export function parseSitelink(v: string): SitelinkSpec {
  const i = v.indexOf('=')
  if (i < 1) throw new CliError(`--sitelink looks like "Prices=https://example.com/prices", got "${v}"`)
  return { text: v.slice(0, i).trim(), url: v.slice(i + 1).trim() }
}

/** A spec ad → the API's ad body. */
export function rsa(a: AdSpec): Record<string, unknown> {
  const t = adText(a)
  return {
    finalUrls: [a.finalUrl],
    responsiveSearchAd: {
      headlines: t.headlines.map(h => ({ text: h.text, ...(h.pin ? { pinnedField: PIN[h.pin] } : {}) })),
      descriptions: t.descriptions.map(d => ({ text: d.text, ...(d.pin ? { pinnedField: `DESCRIPTION_${d.pin}` } : {}) })),
      ...(a.path1 ? { path1: a.path1 } : {}),
      ...(a.path2 ? { path2: a.path2 } : {}),
    },
  }
}

export function buildCreateCampaigns(customerId: string, spec: CreateSpec, existingCampaignNames: string[]): Change {
  validateSpec(spec, existingCampaignNames)
  const conflicts = spec.campaigns.flatMap(negativeConflicts)
  if (conflicts.length) throw new CliError(`Conflicting negatives: ${conflicts.join('; ')}`)
  const checked = checkSpec(spec, existingCampaignNames)

  const base = `customers/${customerId}`
  let next = -1
  const temp = (type: string) => `${base}/${type}/${next--}`
  const ops: Op[] = []
  const summary: string[] = []
  const warnings: string[] = []

  // Assets with identical content are created once and linked to every campaign that uses them.
  const assetOps: Op[] = []
  const assetByKey = new Map<string, string>()
  const asset = (key: string, body: Record<string, unknown>) => {
    const hit = assetByKey.get(key)
    if (hit) return hit
    const rn = temp('assets')
    assetByKey.set(key, rn)
    assetOps.push({ assetOperation: { create: { resourceName: rn, ...body } } })
    return rn
  }
  const linkOps: Op[] = []

  for (const c of spec.campaigns) {
    const budget = temp('campaignBudgets')
    const camp = temp('campaigns')
    ops.push({ campaignBudgetOperation: { create: {
      resourceName: budget, name: `${c.name} – keret`, amountMicros: toMicros(c.dailyBudget), deliveryMethod: 'STANDARD', explicitlyShared: false,
    } } })
    ops.push({ campaignOperation: { create: {
      resourceName: camp,
      name: c.name,
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      campaignBudget: budget,
      targetSpend: { cpcBidCeilingMicros: toMicros(c.maxCpc) },
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      assetAutomationSettings: [{ assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' }],
    } } })
    summary.push(`create campaign "${c.name}" (PAUSED, Search only, no partners / Display): daily budget ${c.dailyBudget}, Maximize clicks with max CPC ${c.maxCpc}, location option PRESENCE`)

    for (const g of c.geoIds) ops.push({ campaignCriterionOperation: { create: { campaign: camp, location: { geoTargetConstant: `geoTargetConstants/${g}` } } } })
    for (const l of c.languageIds) ops.push({ campaignCriterionOperation: { create: { campaign: camp, language: { languageConstant: `languageConstants/${l}` } } } })
    summary.push(`  locations ${c.geoIds.join(', ')}; languages ${c.languageIds.join(', ')}`)

    const negSeen = new Set<string>()
    for (const n of specNegatives(c)) {
      const m: MatchType = n.match
      const text = n.text
      const key = `${text.toLowerCase()}|${m}`
      if (negSeen.has(key)) { warnings.push(`duplicate negative "${text}" [${m}] in "${c.name}" skipped`); continue }
      negSeen.add(key)
      ops.push({ campaignCriterionOperation: { create: { campaign: camp, negative: true, keyword: { text, matchType: m } } } })
    }
    if (negSeen.size) summary.push(`  ${negSeen.size} campaign-level negative keywords`)

    for (const ag of c.adGroups) {
      const agRn = temp('adGroups')
      const m = matchType(ag.match ?? 'EXACT')
      ops.push({ adGroupOperation: { create: { resourceName: agRn, campaign: camp, name: ag.name, status: 'ENABLED', type: 'SEARCH_STANDARD' } } })
      const kwSeen = new Set<string>()
      for (const k of ag.keywords) {
        const text = k.trim().replace(/\s+/g, ' ')
        if (kwSeen.has(text.toLowerCase())) { warnings.push(`duplicate keyword "${text}" in "${ag.name}" skipped`); continue }
        kwSeen.add(text.toLowerCase())
        ops.push({ adGroupCriterionOperation: { create: { adGroup: agRn, status: 'ENABLED', keyword: { text, matchType: m } } } })
      }
      if (m !== 'EXACT') warnings.push(`"${ag.name}" uses ${m} keywords: they can spend fast on a small budget.`)
      const ads = adsOf(ag)
      for (const a of ads) {
        ops.push({ adGroupAdOperation: { create: { adGroup: agRn, status: 'ENABLED', ad: rsa(a) } } })
        const pins = adText(a).headlines.filter(h => h.pin).map(h => `"${h.text}" → ${h.pin}.`)
        summary.push(`  ad group "${ag.name}": RSA ${a.headlines.length} headlines / ${a.descriptions.length} descriptions → ${a.finalUrl}${pins.length ? `; pinned ${pins.join(', ')}` : ''}`)
      }
      summary.push(`  ad group "${ag.name}": ${kwSeen.size} ${m} keywords, ${ads.length} RSA`)
    }

    if (c.callAssetId) {
      linkOps.push({ campaignAssetOperation: { create: { campaign: camp, asset: `${base}/assets/${c.callAssetId}`, fieldType: 'CALL' } } })
      summary.push(`  link existing call asset ${c.callAssetId}`)
    }
    for (const s of c.sitelinks ?? []) {
      const body = { finalUrls: [s.url], sitelinkAsset: { linkText: s.text, ...(s.description1 ? { description1: s.description1, description2: s.description2 } : {}) } }
      const rn = asset(`sitelink|${JSON.stringify(body)}`, body)
      linkOps.push({ campaignAssetOperation: { create: { campaign: camp, asset: rn, fieldType: 'SITELINK' } } })
    }
    for (const t of c.callouts ?? []) {
      const rn = asset(`callout|${t}`, { calloutAsset: { calloutText: t } })
      linkOps.push({ campaignAssetOperation: { create: { campaign: camp, asset: rn, fieldType: 'CALLOUT' } } })
    }
    for (const sn of c.snippets ?? []) {
      const rn = asset(`snippet|${sn.header}|${sn.values.join('|')}`, { structuredSnippetAsset: { header: sn.header, values: sn.values } })
      linkOps.push({ campaignAssetOperation: { create: { campaign: camp, asset: rn, fieldType: 'STRUCTURED_SNIPPET' } } })
    }
    if (c.sitelinks?.length) summary.push(`  sitelinks: ${c.sitelinks.map(s => `${s.text} → ${s.url}`).join(' · ')}`)
    if (c.callouts?.length) summary.push(`  callouts: ${c.callouts.join(' · ')}`)
    if (c.snippets?.length) summary.push(`  structured snippets: ${c.snippets.map(sn => `${sn.header}: ${sn.values.join(', ')}`).join(' · ')}`)
    if ((c.sitelinks?.length ?? 0) > 0 && (c.sitelinks?.length ?? 0) < 2) warnings.push(`"${c.name}": sitelinks show only with at least 2.`)
  }

  if (assetOps.length) summary.push(`create ${assetOps.length} new sitelink / callout / snippet assets (shared where identical)`)
  warnings.push(...checked.warnings.map(w => `[${w.code}] ${w.message}`))
  warnings.push('The campaigns are created PAUSED. Starting them is a separate decision.')
  return { summary, warnings, mutations: [{ endpoint: 'googleAds:mutate', operations: [...ops, ...assetOps, ...linkOps] }] }
}
