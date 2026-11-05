import type { Command } from 'commander'
import { search, micros, round2 } from '../client.js'
import { dateClause, id } from '../gaql.js'
import { AGE_RANGES } from '../builders.js'
import { campaignLocations, geoByIds, geoSearch, getCampaign, listCampaigns } from '../state.js'

export const out = (data: unknown) => console.log(JSON.stringify(data, null, 2))
export const cidOf = (cmd: Command): string | undefined => cmd.opts().customerId
const days = (cmd: Command) => dateClause(Number(cmd.opts().days))
const pct = (v: unknown) => Math.round(Number(v ?? 0) * 100 * 100) / 100
const AGE_LABEL = Object.fromEntries(Object.entries(AGE_RANGES).map(([k, v]) => [v, k]))

function withAccount(cmd: Command, period = false): Command {
  cmd.option('--customer-id <id>', 'account ID (no dashes); default GOOGLE_ADS_CUSTOMER_ID')
  if (period) cmd.option('--days <n>', 'period: 7, 14 or 30', '30')
  return cmd.option('--json', 'JSON output (always on, accepted for clarity)')
}

export function registerRead(program: Command): void {
  withAccount(program.command('ping').description(`Connection and credentials check. Run this first.

OUTPUT: { status, customerId, descriptiveName, currency, timeZone }`))
    .action(async (_, cmd) => {
      const rows = await search(
        'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1',
        cidOf(cmd),
      )
      const c = rows[0]?.customer ?? {}
      out({ status: 'ok', customerId: String(c.id), descriptiveName: c.descriptiveName, currency: c.currencyCode, timeZone: c.timeZone })
    })

  withAccount(program.command('campaigns').description(`Campaign settings: the IDs every write command needs.

OUTPUT FIELDS: id, name, status, channel, bidding (strategy type), targetCpa, maxCpc,
  dailyBudget (account currency), sharedBudget, locationOption (PRESENCE | PRESENCE_OR_INTEREST)`))
    .action(async (_, cmd) => {
      out((await listCampaigns(cidOf(cmd))).map(c => ({
        id: c.id, name: c.name, status: c.status, channel: c.channel, bidding: c.biddingStrategyType,
        targetCpa: c.targetCpa, maxCpc: c.maxCpc, dailyBudget: micros(c.budgetMicros), sharedBudget: c.budgetShared,
        locationOption: c.geoTargetType,
      })))
    })

  withAccount(program.command('ad-groups').description(`Ad groups with their IDs (needed by set-age).

OUTPUT FIELDS: id, name, status, campaignId, campaign`))
    .option('--campaign <id>', 'only this campaign')
    .action(async (_, cmd) => {
      const where = [`ad_group.status != 'REMOVED'`, `campaign.status != 'REMOVED'`]
      if (cmd.opts().campaign) where.push(`campaign.id = ${id(cmd.opts().campaign, 'campaign ID')}`)
      const rows = await search(
        `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name FROM ad_group
         WHERE ${where.join(' AND ')} ORDER BY campaign.name, ad_group.name`,
        cidOf(cmd),
      )
      out(rows.map(r => ({ id: String(r.adGroup?.id), name: r.adGroup?.name, status: r.adGroup?.status, campaignId: String(r.campaign?.id), campaign: r.campaign?.name })))
    })

  withAccount(program.command('report').description(`Campaign performance. "How much did we spend / how does it perform?"

OUTPUT FIELDS: campaignId, campaign, status, cost, clicks, impressions, ctr (%), avgCpc, conversions, costPerConversion
  Money is in the account currency (micros already converted). ctr 17.02 means 17.02 %.`), true)
    .action(async (_, cmd) => {
      const rows = await search(
        `SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.clicks, metrics.impressions,
                metrics.ctr, metrics.average_cpc, metrics.conversions
         FROM campaign WHERE ${days(cmd)} ORDER BY metrics.cost_micros DESC`,
        cidOf(cmd),
      )
      out(rows.map(r => {
        const cost = micros(r.metrics?.costMicros)
        const conv = round2(r.metrics?.conversions)
        return {
          campaignId: String(r.campaign?.id), campaign: r.campaign?.name, status: r.campaign?.status, cost,
          clicks: Number(r.metrics?.clicks ?? 0), impressions: Number(r.metrics?.impressions ?? 0), ctr: pct(r.metrics?.ctr),
          avgCpc: micros(r.metrics?.averageCpc), conversions: conv, costPerConversion: conv ? round2(cost / conv) : null,
        }
      }))
    })

  withAccount(program.command('keywords').description(`Keyword performance with match type. "Which keyword brought the leads?"

OUTPUT FIELDS: criterion (adGroupId~criterionId, for pause-keyword), keyword, match, status, campaign, adGroup,
  cost, clicks, ctr (%), avgCpc, conversions`), true)
    .action(async (_, cmd) => {
      const rows = await search(
        `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
                ad_group_criterion.status, campaign.name, ad_group.name,
                metrics.cost_micros, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions
         FROM keyword_view WHERE ${days(cmd)} ORDER BY metrics.cost_micros DESC`,
        cidOf(cmd),
      )
      out(rows.map(r => ({
        criterion: `${r.adGroup?.id}~${r.adGroupCriterion?.criterionId}`,
        keyword: r.adGroupCriterion?.keyword?.text, match: r.adGroupCriterion?.keyword?.matchType, status: r.adGroupCriterion?.status,
        campaign: r.campaign?.name, adGroup: r.adGroup?.name, cost: micros(r.metrics?.costMicros),
        clicks: Number(r.metrics?.clicks ?? 0), ctr: pct(r.metrics?.ctr), avgCpc: micros(r.metrics?.averageCpc),
        conversions: round2(r.metrics?.conversions),
      })))
    })

  withAccount(program.command('search-terms').description(`What people actually searched. Source of new negative keywords.

OUTPUT FIELDS: searchTerm, campaignId, campaign, cost, clicks, conversions`), true)
    .action(async (_, cmd) => {
      const rows = await search(
        `SELECT search_term_view.search_term, campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions
         FROM search_term_view WHERE ${days(cmd)} ORDER BY metrics.cost_micros DESC`,
        cidOf(cmd),
      )
      out(rows.map(r => ({
        searchTerm: r.searchTermView?.searchTerm, campaignId: String(r.campaign?.id), campaign: r.campaign?.name,
        cost: micros(r.metrics?.costMicros), clicks: Number(r.metrics?.clicks ?? 0), conversions: round2(r.metrics?.conversions),
      })))
    })

  withAccount(program.command('negatives').description(`Campaign-level negative keywords.

OUTPUT FIELDS: campaignId, campaign, negative, match`))
    .action(async (_, cmd) => {
      const rows = await search(
        `SELECT campaign.id, campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
         FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE`,
        cidOf(cmd),
      )
      out(rows.map(r => ({
        campaignId: String(r.campaign?.id), campaign: r.campaign?.name,
        negative: r.campaignCriterion?.keyword?.text, match: r.campaignCriterion?.keyword?.matchType,
      })))
    })

  withAccount(program.command('ages').description(`Performance by age range per ad group. Decide what set-age should exclude.

OUTPUT FIELDS: adGroupId, adGroup, campaign, age (18-24 … 65+, unknown), excluded, bidAdjustPct,
  cost, clicks, conversions, costPerConversion`), true)
    .option('--campaign <id>', 'only this campaign')
    .action(async (_, cmd) => {
      const where = [days(cmd)]
      if (cmd.opts().campaign) where.push(`campaign.id = ${id(cmd.opts().campaign, 'campaign ID')}`)
      const rows = await search(
        `SELECT ad_group.id, ad_group.name, campaign.name, ad_group_criterion.age_range.type, ad_group_criterion.negative,
                ad_group_criterion.bid_modifier, metrics.cost_micros, metrics.clicks, metrics.conversions
         FROM age_range_view WHERE ${where.join(' AND ')}`,
        cidOf(cmd),
      )
      out(rows.map(r => {
        const cost = micros(r.metrics?.costMicros)
        const conv = round2(r.metrics?.conversions)
        const mod = r.adGroupCriterion?.bidModifier
        return {
          adGroupId: String(r.adGroup?.id), adGroup: r.adGroup?.name, campaign: r.campaign?.name,
          age: AGE_LABEL[r.adGroupCriterion?.ageRange?.type] ?? r.adGroupCriterion?.ageRange?.type,
          excluded: Boolean(r.adGroupCriterion?.negative), bidAdjustPct: mod ? Math.round((mod - 1) * 100) : 0,
          cost, clicks: Number(r.metrics?.clicks ?? 0), conversions: conv, costPerConversion: conv ? round2(cost / conv) : null,
        }
      }))
    })

  withAccount(program.command('locations').description(`Location targeting of a campaign.

OUTPUT: { campaign, locationOption, targeted: [{id, name, type}], excluded: [...], radiusTargets }
  locationOption PRESENCE = only people in the area; PRESENCE_OR_INTEREST = also people interested in it.`))
    .requiredOption('--campaign <id>', 'campaign ID')
    .action(async (_, cmd) => {
      const cid = cidOf(cmd)
      const camp = await getCampaign(cmd.opts().campaign, cid)
      const { locations, proximityCount } = await campaignLocations(camp.id, cid)
      const geo = await geoByIds(locations.map(l => l.geoId), cid)
      const show = (neg: boolean) => locations.filter(l => l.negative === neg)
        .map(l => ({ id: l.geoId, name: geo[l.geoId]?.canonicalName ?? geo[l.geoId]?.name, type: geo[l.geoId]?.type }))
      out({ campaign: camp.name, locationOption: camp.geoTargetType, targeted: show(false), excluded: show(true), radiusTargets: proximityCount })
    })

  withAccount(program.command('geo-search').description(`Find geo target IDs by name (for set-location).

OUTPUT FIELDS: id, name, canonicalName, type (Country, City, County...), country

EXAMPLES:
  google-ads geo-search Budapest --country HU
  google-ads geo-search "Pest" --country HU`))
    .argument('<name>', 'location name or part of it')
    .option('--country <code>', '2-letter country code')
    .action(async (name, _, cmd) => {
      out((await geoSearch(name, cmd.opts().country, cidOf(cmd))).map(({ status: _s, ...g }) => g))
    })
}
