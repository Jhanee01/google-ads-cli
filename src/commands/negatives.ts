/**
 * Negative keyword planning: read the shared lists, mine the search terms for n-grams, and plan
 * shared lists. The deterministic parts live in src/negatives.ts; the lessons in
 * knowledge/playbook/negatives.md.
 */
import type { Command } from 'commander'
import { search, micros, round2, resolveCustomerId } from '../client.js'
import { CliError } from '../config.js'
import { id, ids, lastDaysClause } from '../gaql.js'
import { buildAttachNegativeList, buildCreateNegativeList, matchType } from '../builders.js'
import { getCampaign, getNegativeList, listCampaigns, negativeState } from '../state.js'
import { ngrams, subsumes, type ScopedNegative } from '../negatives.js'
import { cidOf, out } from './read.js'
import { PLAN_NOTE, propose, withPlanOptions } from './write.js'

export function registerNegatives(program: Command): void {
  program.command('negative-lists').description(`Shared negative keyword lists: their keywords and the campaigns they are attached to.

A list blocks nothing until it is attached to a campaign.

OUTPUT FIELDS: id (for add-negative --list / attach-negative-list), name, memberCount, campaigns [{id, name}],
  negatives [{text, match}]`)
    .option('--customer-id <id>', 'account ID (no dashes); default GOOGLE_ADS_CUSTOMER_ID')
    .option('--json', 'JSON output (always on, accepted for clarity)')
    .action(async (_, cmd) => {
      const cid = cidOf(cmd)
      const [{ negatives, lists }, campaigns] = await Promise.all([negativeState(cid), listCampaigns(cid)])
      const name = new Map(campaigns.map(c => [c.id, c.name]))
      out(lists.map(l => ({
        id: l.id, name: l.name, memberCount: l.memberCount,
        campaigns: l.campaignIds.map(c => ({ id: c, name: name.get(c) ?? c })),
        negatives: negatives.filter(n => n.level === 'list' && n.listId === l.id).map(n => ({ text: n.text, match: n.match })),
      })))
    })

  program.command('ngrams').description(`Search terms broken into 1-, 2- and 3-word pieces with summed cost, clicks and conversions.

Use it to find ONE word that makes many search terms irrelevant: sort is by cost; look at pieces
with conversions 0 (only when tracking is trusted) or that clearly do not fit the business.
Needs 30–60 days of data on a small account (default 60). A piece counts once per search term.

OUTPUT FIELDS: ngram, n (words), terms (search terms containing it), cost, clicks, impressions,
  conversions, examples (up to 3 search terms), campaigns, coveredBy (an existing negative that
  already blocks it as a BROAD negative in every campaign it appeared in, else null)

EXAMPLES:
  google-ads ngrams --days 60
  google-ads ngrams --campaign 123 --n 1 --top 30`)
    .option('--customer-id <id>', 'account ID (no dashes); default GOOGLE_ADS_CUSTOMER_ID')
    .option('--days <n>', 'period in finished days (1–365)', '60')
    .option('--campaign <id>', 'only this campaign')
    .option('--n <sizes>', 'piece sizes, e.g. 1 or 1,2', '1,2,3')
    .option('--top <count>', 'at most this many rows', '50')
    .option('--show-covered', 'also list pieces an existing negative already blocks')
    .option('--json', 'JSON output (always on, accepted for clarity)')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const sizes = String(o.n).split(',').map(Number)
      if (!sizes.length || sizes.some(n => ![1, 2, 3].includes(n))) throw new CliError('--n takes 1, 2 and/or 3, e.g. --n 1,2')
      const where = [lastDaysClause(Number(o.days))]
      if (o.campaign) where.push(`campaign.id = ${id(o.campaign, 'campaign ID')}`)
      const [rows, { negatives, lists }, campaigns] = await Promise.all([
        search(
          `SELECT search_term_view.search_term, campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
           FROM search_term_view WHERE ${where.join(' AND ')}`, cid),
        negativeState(cid),
        listCampaigns(cid),
      ])
      const name = new Map(campaigns.map(c => [c.id, c.name]))
      const grams = ngrams(rows.map(r => ({
        term: r.searchTermView?.searchTerm ?? '', campaignId: String(r.campaign?.id), cost: micros(r.metrics?.costMicros),
        clicks: Number(r.metrics?.clicks ?? 0), impressions: Number(r.metrics?.impressions ?? 0), conversions: round2(r.metrics?.conversions),
      })), sizes)
      const coverIn = (cid: string, text: string): ScopedNegative | undefined => negatives.find(n =>
        (n.level === 'campaign' ? n.campaignId === cid : n.level === 'list' ? lists.find(l => l.id === n.listId)?.campaignIds.includes(cid) : false) &&
        subsumes(n, { text, match: 'BROAD' }))
      const result = grams.map(g => {
        const covers = g.campaignIds.map(c => coverIn(c, g.ngram))
        const cover = covers.length && covers.every(Boolean) ? covers[0]! : null
        return {
          ngram: g.ngram, n: g.n, terms: g.terms, cost: g.cost, clicks: g.clicks, impressions: g.impressions, conversions: g.conversions,
          examples: g.examples, campaigns: g.campaignIds.map(c => name.get(c) ?? c),
          coveredBy: cover ? `${cover.text} [${cover.match}]${cover.level === 'list' ? ` (list "${cover.listName}")` : ''}` : null,
        }
      })
      out(result.filter(r => o.showCovered || !r.coveredBy).slice(0, Number(o.top) || 50))
    })

  withPlanOptions(program.command('create-negative-list').description(`Plan: a new shared negative keyword list, optionally attached to campaigns, in one atomic call.${PLAN_NOTE}

Use a shared list for negatives that are true for every campaign (jobs, free, rental, what the
business never offers); one place to edit, so campaigns do not drift apart.
--with-accent-variants adds the unaccented form of every accented term: Google treats
"állás" and "allas" as two different negatives.

EXAMPLES:
  google-ads create-negative-list --name "Common" --terms "állás,munka,ingyen" --match BROAD --with-accent-variants --attach 123,456`))
    .requiredOption('--name <name>', 'list name')
    .requiredOption('--terms <list>', 'comma-separated terms')
    .option('--match <type>', 'EXACT | PHRASE | BROAD', 'BROAD')
    .option('--with-accent-variants', 'also add the unaccented form of every accented term')
    .option('--attach <campaignIds>', 'comma-separated campaign IDs to attach the list to')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const [{ lists }, attach] = await Promise.all([
        negativeState(cid),
        Promise.all(ids(o.attach, 'campaign ID').map(c => getCampaign(c, cid))),
      ])
      const change = buildCreateNegativeList({
        customerId: resolveCustomerId(cid), name: String(o.name), terms: String(o.terms).split(','), match: matchType(o.match),
        accentVariants: Boolean(o.withAccentVariants), existingNames: lists.map(l => l.name),
        attach: attach.map(c => ({ resourceName: c.resourceName, name: c.name })),
      })
      await propose(cmd, 'create-negative-list', change, { lists: lists.map(l => l.name) })
    })

  withPlanOptions(program.command('attach-negative-list').description(`Plan: attach a shared negative keyword list to campaigns (or --detach it).${PLAN_NOTE}

EXAMPLES:
  google-ads attach-negative-list --list 987 --campaign 123,456
  google-ads attach-negative-list --list 987 --campaign 123 --detach`))
    .requiredOption('--list <id>', 'list ID (see: google-ads negative-lists)')
    .requiredOption('--campaign <ids>', 'comma-separated campaign IDs')
    .option('--detach', 'detach instead of attach')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const [{ list }, campaigns] = await Promise.all([
        getNegativeList(o.list, cid),
        Promise.all(ids(o.campaign, 'campaign ID').map(c => getCampaign(c, cid))),
      ])
      if (!campaigns.length) throw new CliError('--campaign is empty')
      const change = buildAttachNegativeList({
        customerId: resolveCustomerId(cid), list, campaigns: campaigns.map(c => ({ id: c.id, resourceName: c.resourceName, name: c.name })),
        attached: list.campaignIds, detach: Boolean(o.detach),
      })
      await propose(cmd, o.detach ? 'detach-negative-list' : 'attach-negative-list', change, { list: list.name, attachedTo: list.campaignIds })
    })
}
