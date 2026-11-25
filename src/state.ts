/** Reads the current state a write command needs (always fresh from the API). */
import { CliError } from './config.js'
import { search, micros } from './client.js'
import { id, str, ids as idList } from './gaql.js'
import type { AgeCriterion, KeywordRow, LocationCriterion, MatchType } from './builders.js'
import type { ScopedNegative } from './negatives.js'
import type { AdText, SitelinkText, Snippet } from './adcopy.js'

export interface LiveAd {
  campaignId: string
  campaign: string
  adGroupId: string
  adGroup: string
  adId: string
  status: string
  approval: string
  adStrength: string
  ad: AdText
}
export interface LiveAssets { campaignId: string; campaign: string; sitelinks: SitelinkText[]; callouts: string[]; snippets: Snippet[]; call: boolean }

const PIN_NUMBER: Record<string, number> = { HEADLINE_1: 1, HEADLINE_2: 2, HEADLINE_3: 3, DESCRIPTION_1: 1, DESCRIPTION_2: 2 }

/**
 * The enabled responsive search ads of enabled ad groups and campaigns, and the assets each
 * enabled campaign really shows: its own sitelinks / callouts / snippets, or the account-level
 * ones when it has none of that type (a lower level overrides a higher one).
 */
export async function adsState(cid?: string): Promise<{ ads: LiveAd[]; assets: LiveAssets[] }> {
  const ASSET_FIELDS = `asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2,
    asset.callout_asset.callout_text, asset.structured_snippet_asset.header, asset.structured_snippet_asset.values`
  const [adRows, campRows, accountRows, campaigns] = await Promise.all([
    search(
      `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.status,
              ad_group_ad.policy_summary.approval_status, ad_group_ad.ad_strength, ad_group_ad.ad.final_urls,
              ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
              ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2
       FROM ad_group_ad
       WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED'
         AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`, cid),
    search(
      `SELECT campaign.id, campaign.status, campaign_asset.field_type, ${ASSET_FIELDS} FROM campaign_asset
       WHERE campaign.status = 'ENABLED' AND campaign_asset.status = 'ENABLED'`, cid),
    search(`SELECT customer_asset.field_type, ${ASSET_FIELDS} FROM customer_asset WHERE customer_asset.status = 'ENABLED'`, cid),
    listCampaigns(cid),
  ])
  const ads: LiveAd[] = adRows.map(r => {
    const a = r.adGroupAd ?? {}
    const rsa = a.ad?.responsiveSearchAd ?? {}
    const pin = (p?: string) => (p && PIN_NUMBER[p] ? { pin: PIN_NUMBER[p] } : {})
    return {
      campaignId: String(r.campaign?.id), campaign: r.campaign?.name ?? '', adGroupId: String(r.adGroup?.id), adGroup: r.adGroup?.name ?? '',
      adId: String(a.ad?.id), status: a.status ?? '', approval: a.policySummary?.approvalStatus ?? '', adStrength: a.adStrength ?? '',
      ad: {
        finalUrl: (a.ad?.finalUrls ?? [])[0], path1: rsa.path1, path2: rsa.path2,
        headlines: (rsa.headlines ?? []).map((h: any) => ({ text: h.text, ...pin(h.pinnedField) })),
        descriptions: (rsa.descriptions ?? []).map((d: any) => ({ text: d.text, ...pin(d.pinnedField) })),
      },
    }
  })
  const collect = (rows: any[], field: (r: any) => string) => ({
    sitelinks: rows.filter(r => field(r) === 'SITELINK').map(r => ({
      text: r.asset?.sitelinkAsset?.linkText ?? '',
      ...(r.asset?.sitelinkAsset?.description1 ? { description1: r.asset.sitelinkAsset.description1, description2: r.asset.sitelinkAsset.description2 } : {}),
    })),
    callouts: rows.filter(r => field(r) === 'CALLOUT').map(r => r.asset?.calloutAsset?.calloutText ?? ''),
    snippets: rows.filter(r => field(r) === 'STRUCTURED_SNIPPET').map(r => ({ header: r.asset?.structuredSnippetAsset?.header ?? '', values: r.asset?.structuredSnippetAsset?.values ?? [] })),
    call: rows.some(r => field(r) === 'CALL'),
  })
  const account = collect(accountRows, r => r.customerAsset?.fieldType)
  const assets: LiveAssets[] = campaigns.filter(c => c.status === 'ENABLED').map(c => {
    const own = collect(campRows.filter(r => String(r.campaign?.id) === c.id), r => r.campaignAsset?.fieldType)
    return {
      campaignId: c.id, campaign: c.name,
      sitelinks: own.sitelinks.length ? own.sitelinks : account.sitelinks,
      callouts: own.callouts.length ? own.callouts : account.callouts,
      snippets: own.snippets.length ? own.snippets : account.snippets,
      call: own.call || account.call,
    }
  })
  return { ads, assets }
}

export interface CampaignState {
  resourceName: string
  id: string
  name: string
  status: string
  channel: string
  biddingStrategyType: string
  targetCpa?: number
  maxCpc?: number
  geoTargetType?: string
  budgetResource: string
  budgetMicros: string
  budgetShared: boolean
}

const CAMPAIGN_FIELDS = `campaign.resource_name, campaign.id, campaign.name, campaign.status,
  campaign.advertising_channel_type, campaign.bidding_strategy_type,
  campaign.maximize_conversions.target_cpa_micros, campaign.target_spend.cpc_bid_ceiling_micros,
  campaign.geo_target_type_setting.positive_geo_target_type,
  campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared`

export function toCampaign(r: any): CampaignState {
  const c = r.campaign ?? {}
  const b = r.campaignBudget ?? {}
  return {
    resourceName: c.resourceName,
    id: String(c.id),
    name: c.name,
    status: c.status,
    channel: c.advertisingChannelType,
    biddingStrategyType: c.biddingStrategyType,
    targetCpa: c.maximizeConversions?.targetCpaMicros ? micros(c.maximizeConversions.targetCpaMicros) : undefined,
    maxCpc: c.targetSpend?.cpcBidCeilingMicros ? micros(c.targetSpend.cpcBidCeilingMicros) : undefined,
    geoTargetType: c.geoTargetTypeSetting?.positiveGeoTargetType,
    budgetResource: b.resourceName,
    budgetMicros: String(b.amountMicros ?? '0'),
    budgetShared: Boolean(b.explicitlyShared),
  }
}

export async function listCampaigns(cid?: string): Promise<CampaignState[]> {
  const rows = await search(`SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`, cid)
  return rows.map(toCampaign)
}

export async function getCampaign(campaignId: string, cid?: string): Promise<CampaignState> {
  const rows = await search(`SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE campaign.id = ${id(campaignId, 'campaign ID')}`, cid)
  if (!rows.length) throw new CliError(`Campaign ${campaignId} not found. List them with: google-ads campaigns`)
  return toCampaign(rows[0])
}

export async function campaignConversions30d(campaignId: string, cid?: string): Promise<number> {
  const rows = await search(
    `SELECT metrics.conversions FROM campaign WHERE campaign.id = ${id(campaignId)} AND segments.date DURING LAST_30_DAYS`,
    cid,
  )
  return rows.reduce((s, r) => s + Number(r.metrics?.conversions ?? 0), 0)
}

export async function campaignNegatives(campaignId: string, cid?: string): Promise<Array<{ text: string; match: string }>> {
  const rows = await search(
    `SELECT campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion
     WHERE campaign.id = ${id(campaignId)} AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE`,
    cid,
  )
  return rows.map(r => ({ text: r.campaignCriterion?.keyword?.text ?? '', match: r.campaignCriterion?.keyword?.matchType ?? '' }))
}

export async function findKeywords(
  q: { text?: string; match?: MatchType; campaignId?: string; criterion?: string },
  cid?: string,
): Promise<KeywordRow[]> {
  const where = [`ad_group_criterion.type = 'KEYWORD'`, `ad_group_criterion.negative = FALSE`, `ad_group_criterion.status != 'REMOVED'`]
  if (q.criterion) {
    const [ag, crit] = q.criterion.split('~')
    where.push(`ad_group.id = ${id(ag, 'ad group ID')}`, `ad_group_criterion.criterion_id = ${id(crit, 'criterion ID')}`)
  } else if (q.text) {
    where.push(`ad_group_criterion.keyword.text = ${str(q.text)}`)
  } else {
    throw new CliError('Give --keyword "<text>" or --criterion <adGroupId~criterionId>')
  }
  if (q.match) where.push(`ad_group_criterion.keyword.match_type = '${q.match}'`)
  if (q.campaignId) where.push(`campaign.id = ${id(q.campaignId, 'campaign ID')}`)
  const rows = await search(
    `SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
            ad_group_criterion.status, campaign.name, ad_group.name
     FROM ad_group_criterion WHERE ${where.join(' AND ')}`,
    cid,
  )
  return rows.map(r => ({
    resourceName: r.adGroupCriterion?.resourceName,
    text: r.adGroupCriterion?.keyword?.text,
    match: r.adGroupCriterion?.keyword?.matchType,
    status: r.adGroupCriterion?.status,
    campaign: r.campaign?.name,
    adGroup: r.adGroup?.name,
  }))
}

export interface AdGroupKeyword {
  adGroupId: string
  adGroup: string
  campaignId: string
  text: string
  match: string
  /** the keyword's own status */
  status: string
  /** ENABLED only when the keyword, its ad group and its campaign are all enabled */
  serving: boolean
}

export async function adGroupKeywords(adGroupId?: string, cid?: string): Promise<AdGroupKeyword[]> {
  const where = [`ad_group_criterion.type = 'KEYWORD'`, `ad_group_criterion.negative = FALSE`, `ad_group_criterion.status != 'REMOVED'`]
  if (adGroupId) where.push(`ad_group.id = ${id(adGroupId, 'ad group ID')}`)
  const rows = await search(
    `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.status, ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type, ad_group_criterion.status
     FROM ad_group_criterion WHERE ${where.join(' AND ')}`,
    cid,
  )
  return rows.map(r => ({
    adGroupId: String(r.adGroup?.id),
    adGroup: r.adGroup?.name ?? '',
    campaignId: String(r.campaign?.id),
    text: r.adGroupCriterion?.keyword?.text ?? '',
    match: r.adGroupCriterion?.keyword?.matchType ?? '',
    status: r.adGroupCriterion?.status ?? '',
    serving: r.adGroupCriterion?.status === 'ENABLED' && r.adGroup?.status === 'ENABLED' && r.campaign?.status === 'ENABLED',
  }))
}

export interface NegativeList { id: string; resourceName: string; name: string; memberCount: number; campaignIds: string[] }

/**
 * Every negative keyword of the account by level (campaign, ad group, shared list) and the
 * shared negative keyword lists with the campaigns they are attached to.
 */
export async function negativeState(cid?: string): Promise<{ negatives: ScopedNegative[]; lists: NegativeList[] }> {
  const [camp, ag, sets, members, links] = await Promise.all([
    search(
      `SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion
       WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign.status != 'REMOVED'`, cid),
    search(
      `SELECT campaign.id, ad_group.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion
       WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = TRUE AND ad_group_criterion.status != 'REMOVED'
         AND ad_group.status != 'REMOVED'`, cid),
    search(
      `SELECT shared_set.id, shared_set.resource_name, shared_set.name, shared_set.member_count FROM shared_set
       WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`, cid),
    search(
      `SELECT shared_set.id, shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion
       WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED' AND shared_criterion.type = 'KEYWORD'`, cid),
    search(
      `SELECT campaign.id, shared_set.id FROM campaign_shared_set
       WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND campaign_shared_set.status = 'ENABLED' AND campaign.status != 'REMOVED'`, cid),
  ])
  const lists: NegativeList[] = sets.map(r => ({
    id: String(r.sharedSet?.id), resourceName: r.sharedSet?.resourceName ?? '', name: r.sharedSet?.name ?? '',
    memberCount: Number(r.sharedSet?.memberCount ?? 0),
    campaignIds: links.filter(l => String(l.sharedSet?.id) === String(r.sharedSet?.id)).map(l => String(l.campaign?.id)),
  }))
  const listName = new Map(lists.map(l => [l.id, l.name]))
  const negatives: ScopedNegative[] = [
    ...camp.map(r => ({ level: 'campaign' as const, campaignId: String(r.campaign?.id),
      text: r.campaignCriterion?.keyword?.text ?? '', match: r.campaignCriterion?.keyword?.matchType ?? '' })),
    ...ag.map(r => ({ level: 'adGroup' as const, campaignId: String(r.campaign?.id), adGroupId: String(r.adGroup?.id),
      text: r.adGroupCriterion?.keyword?.text ?? '', match: r.adGroupCriterion?.keyword?.matchType ?? '' })),
    ...members.filter(r => listName.has(String(r.sharedSet?.id))).map(r => ({ level: 'list' as const, listId: String(r.sharedSet?.id),
      listName: listName.get(String(r.sharedSet?.id)), text: r.sharedCriterion?.keyword?.text ?? '', match: r.sharedCriterion?.keyword?.matchType ?? '' })),
  ]
  return { negatives, lists }
}

export async function getNegativeList(listId: string, cid?: string): Promise<{ list: NegativeList; members: Array<{ text: string; match: string }> }> {
  const { negatives, lists } = await negativeState(cid)
  const list = lists.find(l => l.id === id(listId, 'list ID'))
  if (!list) throw new CliError(`Negative keyword list ${listId} not found (see: google-ads negative-lists)`)
  return { list, members: negatives.filter(n => n.level === 'list' && n.listId === list.id).map(n => ({ text: n.text, match: n.match })) }
}

export async function getAdGroup(adGroupId: string, cid?: string): Promise<{ resourceName: string; name: string; campaign: string; channel: string; bidding: string }> {
  const rows = await search(
    `SELECT ad_group.resource_name, ad_group.name, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type
     FROM ad_group WHERE ad_group.id = ${id(adGroupId, 'ad group ID')}`,
    cid,
  )
  if (!rows.length) throw new CliError(`Ad group ${adGroupId} not found. List them with: google-ads ad-groups`)
  const r = rows[0]
  return { resourceName: r.adGroup.resourceName, name: r.adGroup.name, campaign: r.campaign?.name, channel: r.campaign?.advertisingChannelType, bidding: r.campaign?.biddingStrategyType }
}

export async function adGroupAges(adGroupId: string, cid?: string): Promise<AgeCriterion[]> {
  const rows = await search(
    `SELECT ad_group_criterion.resource_name, ad_group_criterion.age_range.type, ad_group_criterion.negative,
            ad_group_criterion.bid_modifier
     FROM ad_group_criterion WHERE ad_group.id = ${id(adGroupId)} AND ad_group_criterion.type = 'AGE_RANGE'
       AND ad_group_criterion.status != 'REMOVED'`,
    cid,
  )
  return rows.map(r => ({
    resourceName: r.adGroupCriterion?.resourceName,
    type: r.adGroupCriterion?.ageRange?.type,
    negative: Boolean(r.adGroupCriterion?.negative),
    bidModifier: r.adGroupCriterion?.bidModifier,
  }))
}

export async function campaignLocations(campaignId: string, cid?: string): Promise<{ locations: LocationCriterion[]; proximityCount: number }> {
  const rows = await search(
    `SELECT campaign_criterion.resource_name, campaign_criterion.type, campaign_criterion.location.geo_target_constant,
            campaign_criterion.negative
     FROM campaign_criterion WHERE campaign.id = ${id(campaignId)} AND campaign_criterion.type IN ('LOCATION', 'PROXIMITY')`,
    cid,
  )
  const locations = rows
    .filter(r => r.campaignCriterion?.type === 'LOCATION')
    .map(r => ({
      resourceName: r.campaignCriterion.resourceName,
      geoId: String(r.campaignCriterion.location?.geoTargetConstant ?? '').split('/').pop() ?? '',
      negative: Boolean(r.campaignCriterion.negative),
    }))
  const proximityCount = rows.filter(r => r.campaignCriterion?.type === 'PROXIMITY' && !r.campaignCriterion?.negative).length
  return { locations, proximityCount }
}

export interface GeoTarget { id: string; name: string; canonicalName: string; type: string; country: string; status: string }

const toGeo = (r: any): GeoTarget => ({
  id: String(r.geoTargetConstant?.id),
  name: r.geoTargetConstant?.name,
  canonicalName: r.geoTargetConstant?.canonicalName,
  type: r.geoTargetConstant?.targetType,
  country: r.geoTargetConstant?.countryCode,
  status: r.geoTargetConstant?.status,
})

const GEO_FIELDS = `geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name,
  geo_target_constant.target_type, geo_target_constant.country_code, geo_target_constant.status`

export async function geoByIds(geoIds: string[], cid?: string): Promise<Record<string, GeoTarget>> {
  if (!geoIds.length) return {}
  const list = idList(geoIds.join(','), 'geo target ID')
  const rows = await search(`SELECT ${GEO_FIELDS} FROM geo_target_constant WHERE geo_target_constant.id IN (${list.join(', ')})`, cid)
  return Object.fromEntries(rows.map(toGeo).map(g => [g.id, g]))
}

export async function geoSearch(name: string, country?: string, cid?: string): Promise<GeoTarget[]> {
  const where = [`geo_target_constant.name LIKE ${str(`%${name}%`)}`, `geo_target_constant.status = 'ENABLED'`]
  if (country) {
    if (!/^[A-Za-z]{2}$/.test(country)) throw new CliError('--country is a 2-letter code, e.g. HU')
    where.push(`geo_target_constant.country_code = '${country.toUpperCase()}'`)
  }
  const rows = await search(`SELECT ${GEO_FIELDS} FROM geo_target_constant WHERE ${where.join(' AND ')} LIMIT 25`, cid)
  return rows.map(toGeo)
}
