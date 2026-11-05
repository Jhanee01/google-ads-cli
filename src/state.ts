/** Reads the current state a write command needs (always fresh from the API). */
import { CliError } from './config.js'
import { search, micros } from './client.js'
import { id, str, ids as idList } from './gaql.js'
import type { AgeCriterion, KeywordRow, LocationCriterion, MatchType } from './builders.js'

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

export async function adGroupKeywords(adGroupId?: string, cid?: string): Promise<Array<{ adGroupId: string; text: string; match: string; status: string }>> {
  const where = [`ad_group_criterion.type = 'KEYWORD'`, `ad_group_criterion.negative = FALSE`, `ad_group_criterion.status != 'REMOVED'`]
  if (adGroupId) where.push(`ad_group.id = ${id(adGroupId, 'ad group ID')}`)
  const rows = await search(
    `SELECT ad_group.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status
     FROM ad_group_criterion WHERE ${where.join(' AND ')}`,
    cid,
  )
  return rows.map(r => ({
    adGroupId: String(r.adGroup?.id),
    text: r.adGroupCriterion?.keyword?.text ?? '',
    match: r.adGroupCriterion?.keyword?.matchType ?? '',
    status: r.adGroupCriterion?.status ?? '',
  }))
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
