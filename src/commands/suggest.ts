import type { Command } from 'commander'
import { search, micros, round2 } from '../client.js'
import { dateClause } from '../gaql.js'
import { AGE_RANGES } from '../builders.js'
import { adGroupKeywords, listCampaigns } from '../state.js'
import { analyze, loadRules, type SuggestData } from '../suggest.js'
import { cidOf, out } from './read.js'

const AGE_LABEL = Object.fromEntries(Object.entries(AGE_RANGES).map(([k, v]) => [v, k]))
const share = (v: unknown): number | null => (v === undefined || v === null ? null : Number(v))
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function registerSuggest(program: Command): void {
  program.command('suggest').description(`Rule-based findings on live data, from the playbook in knowledge/playbook.

Read-only. Each finding has: rule, severity, campaign, title, why (the numbers), playbook (the page
that explains the rule) and, where a change makes sense, "action": the plan command to run.
The agent should read the playbook page and the account's own knowledge base, then decide which
actions to propose to the human. Running an action only creates a plan.

RULES: invalid-conversion-period, measurement-suspect, no-auction, smart-bidding-without-signal,
  rank-lost, budget-limited, presence-or-interest, broad-phrase-share, always-negative,
  wasted-search-terms, promote-to-exact, age-without-conversions
Thresholds and the always-negative words come from google-ads.rules.json (or --rules <file>);
see google-ads.rules.example.json.

EXAMPLES:
  google-ads suggest --days 30
  google-ads suggest --days 14 --rules accounts/acme/google-ads.rules.json`)
    .option('--customer-id <id>', 'account ID (no dashes); default GOOGLE_ADS_CUSTOMER_ID')
    .option('--days <n>', 'period: 7, 14 or 30', '30')
    .option('--rules <file>', 'rules JSON (default ./google-ads.rules.json if present)')
    .option('--json', 'JSON output (always on, accepted for clarity)')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const days = [7, 14, 30].includes(Number(o.days)) ? Number(o.days) : 30
      const window = dateClause(days)
      const { rules, source } = loadRules(o.rules)

      const [campaigns, metrics, keywords, terms, existingKeywords, negatives, ages] = await Promise.all([
        listCampaigns(cid),
        search(
          `SELECT campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions,
                  metrics.search_impression_share, metrics.search_rank_lost_impression_share, metrics.search_budget_lost_impression_share
           FROM campaign WHERE campaign.status = 'ENABLED' AND ${window}`,
          cid,
        ),
        search(
          `SELECT campaign.id, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                  ad_group_criterion.keyword.match_type, ad_group_criterion.status, metrics.cost_micros, metrics.clicks, metrics.conversions
           FROM keyword_view WHERE campaign.status = 'ENABLED' AND ${window}`,
          cid,
        ),
        search(
          `SELECT search_term_view.search_term, search_term_view.status, campaign.id, ad_group.id, ad_group.name,
                  metrics.cost_micros, metrics.clicks, metrics.conversions
           FROM search_term_view WHERE campaign.status = 'ENABLED' AND ${window}`,
          cid,
        ),
        adGroupKeywords(undefined, cid),
        search(
          `SELECT campaign.id, campaign_criterion.keyword.text FROM campaign_criterion
           WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE`,
          cid,
        ),
        search(
          `SELECT campaign.id, ad_group.id, ad_group.name, ad_group_criterion.age_range.type, ad_group_criterion.negative,
                  metrics.cost_micros, metrics.clicks, metrics.conversions
           FROM age_range_view WHERE campaign.status = 'ENABLED' AND ${window}`,
          cid,
        ),
      ])

      const m = new Map<string, any>()
      for (const r of metrics) m.set(String(r.campaign?.id), r.metrics ?? {})
      const end = new Date()
      end.setDate(end.getDate() - 1)
      const start = new Date()
      start.setDate(start.getDate() - days)

      const data: SuggestData = {
        windowDays: days,
        windowStart: isoDay(start),
        windowEnd: isoDay(end),
        campaigns: campaigns.filter(c => c.status === 'ENABLED').map(c => {
          const x = m.get(c.id) ?? {}
          return {
            id: c.id, name: c.name, status: c.status, biddingStrategyType: c.biddingStrategyType, geoTargetType: c.geoTargetType,
            cost: micros(x.costMicros), clicks: Number(x.clicks ?? 0), impressions: Number(x.impressions ?? 0),
            conversions: round2(x.conversions), impressionShare: share(x.searchImpressionShare),
            rankLost: share(x.searchRankLostImpressionShare), budgetLost: share(x.searchBudgetLostImpressionShare),
          }
        }),
        keywords: keywords.map(r => ({
          criterion: `${r.adGroup?.id}~${r.adGroupCriterion?.criterionId}`, text: r.adGroupCriterion?.keyword?.text ?? '',
          match: r.adGroupCriterion?.keyword?.matchType ?? '', status: r.adGroupCriterion?.status ?? '', campaignId: String(r.campaign?.id),
          adGroup: r.adGroup?.name ?? '', cost: micros(r.metrics?.costMicros), clicks: Number(r.metrics?.clicks ?? 0), conversions: round2(r.metrics?.conversions),
        })),
        searchTerms: terms.map(r => ({
          term: r.searchTermView?.searchTerm ?? '', status: r.searchTermView?.status ?? 'NONE', campaignId: String(r.campaign?.id),
          adGroupId: String(r.adGroup?.id), adGroup: r.adGroup?.name ?? '', cost: micros(r.metrics?.costMicros),
          clicks: Number(r.metrics?.clicks ?? 0), conversions: round2(r.metrics?.conversions),
        })),
        existingKeywords,
        negatives: negatives.map(r => ({ campaignId: String(r.campaign?.id), text: r.campaignCriterion?.keyword?.text ?? '' })),
        ages: ages.map(r => ({
          adGroupId: String(r.adGroup?.id), adGroup: r.adGroup?.name ?? '', campaignId: String(r.campaign?.id),
          age: AGE_LABEL[r.adGroupCriterion?.ageRange?.type] ?? String(r.adGroupCriterion?.ageRange?.type),
          excluded: Boolean(r.adGroupCriterion?.negative), cost: micros(r.metrics?.costMicros),
          clicks: Number(r.metrics?.clicks ?? 0), conversions: round2(r.metrics?.conversions),
        })),
      }
      const result = analyze(data, rules)
      out({
        window: `${data.windowStart} – ${data.windowEnd} (${days} days)`,
        rules: source,
        wasteThreshold: result.wasteThreshold,
        conversionsTrusted: Object.fromEntries(data.campaigns.map(c => [c.name, result.measurementTrusted[c.id]])),
        findings: result.findings,
        note: 'Findings are candidates, not decisions. Check the playbook page and the account knowledge base; every action only creates a plan.',
      })
    })
}
