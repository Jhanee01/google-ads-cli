import type { Command } from 'commander'
import { createInterface } from 'node:readline/promises'
import { getNegativeList, negativeState } from '../state.js'
import { config, CliError } from '../config.js'
import { mutate, resolveCustomerId, micros } from '../client.js'
import { ids } from '../gaql.js'
import {
  ageList, bidAdjustments, buildAddKeywords, buildAddNegatives, buildRemoveNegatives, buildAge, buildBidding, buildBudget, buildKeywordStatus, buildLocation,
  matchType, strategy, type Change, type GeoType,
} from '../builders.js'
import { audit, checkPlan, createPlan, loadPlan, markApplied, savePlan } from '../plan.js'
import {
  adGroupAges, adGroupKeywords, campaignConversions30d, campaignLocations, campaignNegatives, findKeywords, geoByIds, getAdGroup, getCampaign,
  listCampaigns,
} from '../state.js'
import { cidOf, out } from './read.js'
import { readFileSync } from 'node:fs'
import { buildCampaignAssets, buildCampaignStatus, buildCreateCampaigns, parseSitelink, type CreateSpec, type SitelinkSpec } from '../campaign.js'
import type { Snippet } from '../adcopy.js'
import { search } from '../client.js'

const SMART_BIDDING = new Set(['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS'])

export const PLAN_NOTE = `
SAFETY: this command does NOT change the account. It reads the current state, builds the change,
has the Google Ads API validate it (validateOnly), and writes a plan file. A human applies it with:
  google-ads apply <plan-file> --yes`

export function withPlanOptions(cmd: Command): Command {
  return cmd
    .option('--customer-id <id>', 'account ID (no dashes); default GOOGLE_ADS_CUSTOMER_ID')
    .option('--offline', 'skip the API validation of the plan (not recommended)')
    .option('--json', 'JSON output (always on, accepted for clarity)')
}

export async function propose(cmd: Command, command: string, change: Change, before: unknown): Promise<void> {
  const customerId = resolveCustomerId(cidOf(cmd))
  if (!change.mutations.length) throw new CliError(`Nothing to change.${change.warnings.length ? ' ' + change.warnings.join('; ') : ''}`)
  const offline = Boolean(cmd.opts().offline)
  if (!offline) {
    for (const m of change.mutations) await mutate(m.endpoint, m.operations, customerId, { validateOnly: true })
  }
  const plan = createPlan({ command, customerId, change, before, validated: offline ? 'skipped' : 'api-validate-only' })
  const file = savePlan(plan)
  out({
    status: 'planned',
    plan: file,
    validated: plan.validated,
    summary: plan.summary,
    warnings: plan.warnings,
    expiresAt: plan.expiresAt,
    next: `A human reviews the summary, then runs: google-ads apply "${file}" --yes`,
  })
}

export function registerWrite(program: Command): void {
  withPlanOptions(program.command('add-negative').description(`Plan: add negative keywords to a campaign, or to a shared negative keyword list (--list).${PLAN_NOTE}

Negatives do not match close variants: add plurals and synonyms yourself. Google treats an
accented and an unaccented negative as two different keywords ("állás" ≠ "allas"):
--with-accent-variants adds the unaccented form of every accented term.
Terms already present, or already covered by a broader existing negative (also from a list
attached to the campaign), are skipped. Commas and ! @ % ^ ( ) = { } ; ~ < > ? \\ | are refused.
See knowledge/playbook/negatives.md.

EXAMPLES:
  google-ads add-negative --campaign 123 --terms "free,jobs,diy" --match EXACT
  google-ads add-negative --campaign 123 --terms "állás,bérlés" --match BROAD --with-accent-variants
  google-ads add-negative --list 987 --terms "ingyen" --match BROAD --with-accent-variants`))
    .option('--campaign <id>', 'campaign ID (see: google-ads campaigns)')
    .option('--list <id>', 'shared negative keyword list ID instead of a campaign (see: google-ads negative-lists)')
    .requiredOption('--terms <list>', 'comma-separated terms')
    .option('--match <type>', 'EXACT | PHRASE | BROAD', 'EXACT')
    .option('--with-accent-variants', 'also add the unaccented form of every accented term')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      if (Boolean(o.campaign) === Boolean(o.list)) throw new CliError('Give exactly one of --campaign or --list')
      const terms = String(o.terms).split(',')
      const accentVariants = Boolean(o.withAccentVariants)
      if (o.list) {
        const { list, members } = await getNegativeList(o.list, cid)
        const change = buildAddNegatives({
          sharedSetResource: list.resourceName, campaignName: list.name, terms, match: matchType(o.match), existing: members, accentVariants,
        })
        await propose(cmd, 'add-negative', change, { list: list.name, negatives: members.length })
        return
      }
      const camp = await getCampaign(o.campaign, cid)
      const { negatives, lists } = await negativeState(cid)
      const attached = new Set(lists.filter(l => l.campaignIds.includes(camp.id)).map(l => l.id))
      const existing = negatives.filter(n => (n.level === 'campaign' && n.campaignId === camp.id) || (n.level === 'list' && attached.has(n.listId ?? '')))
      const change = buildAddNegatives({
        campaignResource: camp.resourceName, campaignName: camp.name, terms, match: matchType(o.match), existing, accentVariants,
      })
      await propose(cmd, 'add-negative', change, { campaign: camp.name, negatives: existing.length })
    })

  withPlanOptions(program.command('remove-negative').description(`Plan: remove negative keywords from a campaign.${PLAN_NOTE}

Use it when a negative blocks searches for something the business does offer (check the search
terms first). The text matches case-insensitively; --match limits it to one match type, otherwise
every match type of that text is removed. A term that is not a negative of the campaign is refused.

EXAMPLES:
  google-ads remove-negative --campaign 123 --terms "raklap"
  google-ads remove-negative --campaign 123 --terms "raklap,raklapos" --match BROAD`))
    .requiredOption('--campaign <id>', 'campaign ID (see: google-ads campaigns)')
    .requiredOption('--terms <list>', 'comma-separated terms')
    .option('--match <type>', 'EXACT | PHRASE | BROAD (default: every match type)')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const camp = await getCampaign(o.campaign, cid)
      const rows = await search(
        `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
         FROM campaign_criterion WHERE campaign.id = ${camp.id} AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE`, cid)
      const existing = rows.map(r => ({ resourceName: r.campaignCriterion.resourceName, text: r.campaignCriterion.keyword.text, match: r.campaignCriterion.keyword.matchType }))
      const change = buildRemoveNegatives({
        campaignName: camp.name, terms: String(o.terms).split(','), match: o.match ? matchType(o.match) : undefined, existing,
      })
      await propose(cmd, 'remove-negative', change, { campaign: camp.name, negatives: existing.length })
    })

  withPlanOptions(program.command('add-keyword').description(`Plan: add keywords to an ad group (EXACT by default).${PLAN_NOTE}

Typical use: promote search terms that converted (see "google-ads suggest", rule promote-to-exact).
Existing keywords with the same text and match type are skipped.

EXAMPLES:
  google-ads add-keyword --ad-group 456 --terms "service price city,service city" --match EXACT`))
    .requiredOption('--ad-group <id>', 'ad group ID (see: google-ads ad-groups)')
    .requiredOption('--terms <list>', 'comma-separated keywords')
    .option('--match <type>', 'EXACT | PHRASE | BROAD', 'EXACT')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const ag = await getAdGroup(o.adGroup, cid)
      const existing = await adGroupKeywords(o.adGroup, cid)
      const change = buildAddKeywords({
        adGroupResource: ag.resourceName, adGroupName: `${ag.campaign} › ${ag.name}`, terms: String(o.terms).split(','), match: matchType(o.match), existing,
      })
      await propose(cmd, 'add-keyword', change, { adGroup: ag.name, keywords: existing.length })
    })

  withPlanOptions(program.command('pause-keyword').description(`Plan: pause (or with --resume, re-enable) keywords.${PLAN_NOTE}

Find the keyword by text (optionally narrowed by --match / --campaign) or by --criterion from "google-ads keywords".

EXAMPLES:
  google-ads pause-keyword --keyword "cheap moving" --match BROAD
  google-ads pause-keyword --criterion 1234567~89012 --resume`))
    .option('--keyword <text>', 'exact keyword text')
    .option('--criterion <adGroupId~criterionId>', 'the "criterion" field of the keywords command')
    .option('--match <type>', 'EXACT | PHRASE | BROAD')
    .option('--campaign <id>', 'only in this campaign')
    .option('--resume', 'enable instead of pause')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const rows = await findKeywords(
        { text: o.keyword, criterion: o.criterion, match: o.match ? matchType(o.match) : undefined, campaignId: o.campaign },
        cidOf(cmd),
      )
      const change = buildKeywordStatus(rows, o.resume ? 'ENABLED' : 'PAUSED')
      await propose(cmd, o.resume ? 'resume-keyword' : 'pause-keyword', change, rows.map(r => ({ keyword: r.text, match: r.match, status: r.status, adGroup: r.adGroup })))
    })

  withPlanOptions(program.command('set-budget').description(`Plan: change a campaign's daily budget (account currency).${PLAN_NOTE}

GUARD: a change bigger than MAX_BUDGET_CHANGE_PCT (default 50 %) needs --force. Shared budgets get a warning.

EXAMPLES:
  google-ads set-budget --campaign 123 --daily 2500`))
    .requiredOption('--campaign <id>', 'campaign ID')
    .requiredOption('--daily <amount>', 'new daily budget, e.g. 2500')
    .option('--force', 'allow a change above the guard')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const camp = await getCampaign(o.campaign, cidOf(cmd))
      const change = buildBudget({
        budgetResource: camp.budgetResource, campaignName: camp.name, currentMicros: camp.budgetMicros, newAmount: Number(o.daily),
        explicitlyShared: camp.budgetShared, maxChangePct: config.maxBudgetChangePct, force: Boolean(o.force),
      })
      await propose(cmd, 'set-budget', change, { campaign: camp.name, dailyBudget: micros(camp.budgetMicros), shared: camp.budgetShared })
    })

  withPlanOptions(program.command('set-bidding').description(`Plan: change the bidding goal of a campaign.${PLAN_NOTE}

STRATEGIES:
  max-conversions  Smart Bidding for conversions; optional --target-cpa (cost per conversion)
  max-clicks       as many clicks as the budget allows; optional --max-cpc cap
  manual-cpc       you set the CPC bids yourself
Warns when the campaign had fewer than 15 conversions in 30 days (too little data for max-conversions).

EXAMPLES:
  google-ads set-bidding --campaign 123 --strategy max-conversions --target-cpa 7000
  google-ads set-bidding --campaign 123 --strategy max-clicks --max-cpc 400`))
    .requiredOption('--campaign <id>', 'campaign ID')
    .requiredOption('--strategy <name>', 'max-conversions | max-clicks | manual-cpc')
    .option('--target-cpa <amount>', 'target cost per conversion (max-conversions)')
    .option('--max-cpc <amount>', 'CPC cap (max-clicks)')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const camp = await getCampaign(o.campaign, cid)
      const s = strategy(o.strategy)
      const change = buildBidding({
        campaignResource: camp.resourceName, campaignName: camp.name, currentType: camp.biddingStrategyType, strategy: s,
        targetCpa: o.targetCpa !== undefined ? Number(o.targetCpa) : undefined,
        maxCpc: o.maxCpc !== undefined ? Number(o.maxCpc) : undefined,
        conversionsLast30d: s === 'max-conversions' ? await campaignConversions30d(camp.id, cid) : 0,
      })
      await propose(cmd, 'set-bidding', change, { campaign: camp.name, bidding: camp.biddingStrategyType, targetCpa: camp.targetCpa, maxCpc: camp.maxCpc })
    })

  withPlanOptions(program.command('set-age').description(`Plan: age targeting of an ad group.${PLAN_NOTE}

AGE RANGES: 18-24, 25-34, 35-44, 45-54, 55-64, 65+, unknown
  --exclude      stop showing ads to these ages
  --include      undo an exclusion
  --bid-adjust   bid more or less for an age, in percent: "25-34:+20,65+:-30"
Refuses to exclude every known age range. Check "google-ads ages" first.

EXAMPLES:
  google-ads set-age --ad-group 456 --exclude 18-24,65+
  google-ads set-age --ad-group 456 --bid-adjust 35-44:+20`))
    .requiredOption('--ad-group <id>', 'ad group ID (see: google-ads ad-groups)')
    .option('--exclude <ages>', 'comma-separated age ranges')
    .option('--include <ages>', 'comma-separated age ranges')
    .option('--bid-adjust <list>', 'age:percent pairs')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const exclude = ageList(o.exclude)
      const include = ageList(o.include)
      const adjust = bidAdjustments(o.bidAdjust)
      if (!exclude.length && !include.length && !Object.keys(adjust).length) throw new CliError('Give --exclude, --include or --bid-adjust')
      const ag = await getAdGroup(o.adGroup, cid)
      const existing = await adGroupAges(o.adGroup, cid)
      const change = buildAge({ adGroupResource: ag.resourceName, adGroupName: `${ag.campaign} › ${ag.name}`, existing, exclude, include, adjust })
      if (SMART_BIDDING.has(ag.bidding) && Object.keys(adjust).length) {
        change.warnings.push(`The campaign uses ${ag.bidding}: Smart Bidding ignores age bid adjustments (exclusions still apply).`)
      }
      await propose(cmd, 'set-age', change, existing.map(e => ({ type: e.type, negative: e.negative, bidModifier: e.bidModifier })))
    })

  withPlanOptions(program.command('set-location').description(`Plan: location targeting of a campaign.${PLAN_NOTE}

Geo IDs come from "google-ads geo-search <name>" (Hungary = 2348).
  --add        target these locations
  --exclude    exclude these locations
  --remove     drop a targeting or exclusion
  --presence-only        only people who are in (or regularly in) the area  ← usually what local businesses want
  --presence-or-interest also people who only search about the area
Refuses to leave the campaign with no targeted location (= worldwide) unless --force.

EXAMPLES:
  google-ads set-location --campaign 123 --add 1007633 --presence-only
  google-ads set-location --campaign 123 --exclude 20429`))
    .requiredOption('--campaign <id>', 'campaign ID')
    .option('--add <ids>', 'comma-separated geo target IDs')
    .option('--exclude <ids>', 'comma-separated geo target IDs')
    .option('--remove <ids>', 'comma-separated geo target IDs')
    .option('--presence-only', 'location option PRESENCE')
    .option('--presence-or-interest', 'location option PRESENCE_OR_INTEREST')
    .option('--force', 'allow leaving no targeted location')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      if (o.presenceOnly && o.presenceOrInterest) throw new CliError('Choose one of --presence-only / --presence-or-interest')
      const geoType: GeoType | undefined = o.presenceOnly ? 'presence' : o.presenceOrInterest ? 'presence-or-interest' : undefined
      const add = ids(o.add, 'geo target ID')
      const exclude = ids(o.exclude, 'geo target ID')
      const remove = ids(o.remove, 'geo target ID')
      if (!add.length && !exclude.length && !remove.length && !geoType) throw new CliError('Give --add, --exclude, --remove or a location option')
      const camp = await getCampaign(o.campaign, cid)
      const { locations, proximityCount } = await campaignLocations(camp.id, cid)
      const geo = await geoByIds([...new Set([...add, ...exclude, ...locations.map(l => l.geoId)])], cid)
      const names = Object.fromEntries(Object.values(geo).map(g => [g.id, g.canonicalName ?? g.name]))
      const change = buildLocation({
        campaignResource: camp.resourceName, campaignName: camp.name, existing: locations, proximityCount, add, exclude, remove,
        geoType, currentGeoType: camp.geoTargetType, names, force: Boolean(o.force),
      })
      await propose(cmd, 'set-location', change, {
        campaign: camp.name, locationOption: camp.geoTargetType,
        locations: locations.map(l => ({ id: l.geoId, name: names[l.geoId], excluded: l.negative })),
      })
    })

  withPlanOptions(program.command('create-campaign').description(`Plan: create new Search campaigns from a JSON spec file.${PLAN_NOTE}

Everything goes into ONE atomic googleAds:mutate call: budget (not shared), campaign (PAUSED,
Google Search only, Maximize clicks with a required CPC cap, location option PRESENCE, text asset
automation off, not EU political), locations, languages, campaign negatives, ad groups, keywords
(EXACT by default), one RSA per ad group, call asset link, sitelinks and callouts.
Refuses: an existing campaign name, no locations, no CPC cap, over-long ad texts, or a negative
that would block the campaign's own keyword.

SPEC (JSON): { "campaigns": [ { "name", "dailyBudget", "maxCpc", "geoIds": [], "languageIds": [],
  "callAssetId"?, "sitelinks"?: [{ "text", "url", "description1"?, "description2"? }], "callouts"?: [],
  "negatives"?: [{ "text", "match"?: "BROAD" }],
  "adGroups": [{ "name", "keywords": [], "match"?: "EXACT",
    "ad": { "finalUrl", "path1"?, "path2"?, "headlines": ["text" | { "text", "pin": 1|2|3 }], "descriptions": [] } }] } ] }

EXAMPLES:
  google-ads create-campaign --spec specs/new-campaigns.json`))
    .requiredOption('--spec <file>', 'path of the JSON spec')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const customerId = resolveCustomerId(cid)
      let spec: CreateSpec
      try { spec = JSON.parse(readFileSync(o.spec, 'utf8')) } catch (e) { throw new CliError(`Cannot read the spec ${o.spec}: ${(e as Error).message}`) }
      const existing = await listCampaigns(cid)
      const change = buildCreateCampaigns(customerId, spec, existing.filter(c => c.status !== 'REMOVED').map(c => c.name))
      await propose(cmd, 'create-campaign', change, { spec: o.spec, existingCampaigns: existing.map(c => ({ name: c.name, status: c.status })) })
    })

  withPlanOptions(program.command('set-campaign-status').description(`Plan: start, pause or remove whole campaigns.${PLAN_NOTE}

--remove is PERMANENT (a removed campaign cannot be enabled again; its statistics stay).
A running campaign is only removed with --force: pause it first.

EXAMPLES:
  google-ads set-campaign-status --campaign 123,456 --enable
  google-ads set-campaign-status --campaign 123 --pause
  google-ads set-campaign-status --campaign 123 --remove`))
    .requiredOption('--campaign <ids>', 'comma-separated campaign IDs')
    .option('--enable', 'start the campaigns (ENABLED)')
    .option('--pause', 'pause the campaigns (PAUSED)')
    .option('--remove', 'remove the campaigns permanently (REMOVED)')
    .option('--force', 'allow removing a running campaign')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      if ([o.enable, o.pause, o.remove].filter(Boolean).length !== 1) throw new CliError('Give exactly one of --enable / --pause / --remove')
      const cid = cidOf(cmd)
      const camps = []
      for (const cId of ids(o.campaign, 'campaign ID')) camps.push(await getCampaign(cId, cid))
      const status = o.enable ? 'ENABLED' : o.pause ? 'PAUSED' : 'REMOVED'
      const change = buildCampaignStatus(
        camps.map(c => ({ resourceName: c.resourceName, name: c.name, status: c.status, dailyBudget: micros(c.budgetMicros) })),
        status, Boolean(o.force),
      )
      const command = { ENABLED: 'enable-campaign', PAUSED: 'pause-campaign', REMOVED: 'remove-campaign' }[status]
      await propose(cmd, command, change, camps.map(c => ({ campaign: c.name, status: c.status })))
    })

  withPlanOptions(program.command('set-campaign-assets').description(`Plan: link / unlink assets (sitelinks, callouts, call, image...) of a campaign.${PLAN_NOTE}

--link     existing asset IDs (e.g. the sitelinks and callouts of another campaign); the field
           type comes from the asset itself. Already linked ones are skipped.
--unlink   asset IDs linked to this campaign (the asset itself stays in the account).
--sitelink "Text=https://…"  create a new sitelink and link it (repeatable).
--spec     JSON file with new assets to create and link:
           { "sitelinks": [{ "text", "url", "description1", "description2" }],
             "callouts": ["…"], "snippets": [{ "header": "Service catalog", "values": ["…"] }] }
           Checked like create-campaign assets (lengths, both description lines, snippet header).
All in one atomic call: e.g. --unlink the old assets and --spec the new ones.

EXAMPLES:
  google-ads set-campaign-assets --campaign 123 --link 111,222 --unlink 333
  google-ads set-campaign-assets --campaign 123 --sitelink "Get a quote=https://example.com/#contact"
  google-ads set-campaign-assets --campaign 123 --unlink 111,222 --spec specs/assets.json`))
    .requiredOption('--campaign <id>', 'campaign ID')
    .option('--link <ids>', 'comma-separated asset IDs to link')
    .option('--unlink <ids>', 'comma-separated asset IDs to unlink')
    .option('--sitelink <text=url>', 'new sitelink (repeatable)', (v: string, all: string[]) => [...all, v], [] as string[])
    .option('--spec <file>', 'JSON file with new sitelinks (with descriptions), callouts and structured snippets')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const linkIds = ids(o.link, 'asset ID')
      const unlink = ids(o.unlink, 'asset ID')
      let spec: { sitelinks?: SitelinkSpec[]; callouts?: string[]; snippets?: Snippet[] } = {}
      if (o.spec) {
        try { spec = JSON.parse(readFileSync(o.spec, 'utf-8')) } catch (e) { throw new CliError(`Cannot read --spec ${o.spec}: ${(e as Error).message}`) }
      }
      const sitelinks = [...(o.sitelink as string[]).map(parseSitelink), ...(spec.sitelinks ?? [])]
      const callouts = spec.callouts ?? []
      const snippets = spec.snippets ?? []
      if (!linkIds.length && !unlink.length && !sitelinks.length && !callouts.length && !snippets.length) throw new CliError('Give --link, --unlink, --sitelink or --spec')
      const camp = await getCampaign(o.campaign, cid)
      const linkedRows = await search(
        `SELECT campaign.id, campaign_asset.resource_name, campaign_asset.field_type, asset.id FROM campaign_asset
         WHERE campaign.id = ${camp.id} AND campaign_asset.status != 'REMOVED'`, cid)
      const linked = linkedRows.map(r => ({ resourceName: r.campaignAsset.resourceName, assetId: String(r.asset.id), fieldType: r.campaignAsset.fieldType }))
      const assetRows = linkIds.length ? await search(
        `SELECT asset.id, asset.type, asset.name, asset.sitelink_asset.link_text, asset.callout_asset.callout_text, asset.call_asset.phone_number
         FROM asset WHERE asset.id IN (${linkIds.join(',')})`, cid) : []
      const byId = new Map(assetRows.map(r => [String(r.asset.id), r.asset]))
      const link = linkIds.map(id => {
        const a = byId.get(id)
        if (!a) throw new CliError(`Asset ${id} not found in the account.`)
        return { assetId: id, type: a.type, label: a.sitelinkAsset?.linkText ?? a.calloutAsset?.calloutText ?? a.callAsset?.phoneNumber ?? a.name ?? '' }
      })
      const change = buildCampaignAssets({
        customerId: resolveCustomerId(cid), campaignResource: camp.resourceName, campaignName: camp.name, linked, link, unlink, sitelinks, callouts, snippets,
      })
      await propose(cmd, 'set-campaign-assets', change, { campaign: camp.name, linked })
    })

  program.command('apply').description(`Apply a plan created by a write command. THIS CHANGES THE ACCOUNT.

Checks before running: the plan is unchanged (hash), not expired (PLAN_TTL_HOURS, default 24),
not applied before, and for the right account. Every run is appended to the audit log (AUDIT_LOG).
Without --yes it asks for confirmation in a terminal and refuses otherwise.

AGENTS: do not run this yourself. Show the plan summary to the human and let them apply it.
Set DENY_COMMANDS=apply in the agent's environment to enforce that.`)
    .argument('<plan-file>', 'path of the plan JSON')
    .option('--yes', 'confirm without a prompt')
    .option('--customer-id <id>', 'refuse unless the plan is for this account')
    .action(async (file: string, o: { yes?: boolean; customerId?: string }) => {
      const plan = loadPlan(file)
      checkPlan(plan, { customerId: o.customerId ? resolveCustomerId(o.customerId) : undefined })
      if (!o.yes) {
        if (!process.stdin.isTTY) throw new CliError('Refusing to apply without --yes (no terminal to confirm in).')
        console.error(`Plan ${plan.id} on account ${plan.customerId}:`)
        plan.summary.forEach(s => console.error(`  • ${s}`))
        plan.warnings.forEach(w => console.error(`  ⚠ ${w}`))
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        const answer = (await rl.question('Apply these changes? [y/N] ')).trim().toLowerCase()
        rl.close()
        if (answer !== 'y' && answer !== 'yes') {
          audit({ event: 'declined', planId: plan.id, hash: plan.hash })
          throw new CliError('Not applied.')
        }
      }
      const results: unknown[] = []
      for (const [i, m] of plan.mutations.entries()) {
        try {
          results.push(await mutate(m.endpoint, m.operations, plan.customerId))
        } catch (err) {
          audit({ event: 'failed', planId: plan.id, hash: plan.hash, customerId: plan.customerId, failedStep: i, done: results, error: (err as Error).message })
          const note = i > 0 ? ` Steps 1–${i} of ${plan.mutations.length} were applied; check the account before retrying.` : ' Nothing was changed.'
          throw new CliError(`Apply failed at step ${i + 1}: ${(err as Error).message}.${note}`)
        }
      }
      markApplied(file, plan, results)
      audit({ event: 'applied', planId: plan.id, hash: plan.hash, customerId: plan.customerId, command: plan.command, summary: plan.summary, results })
      out({ status: 'applied', plan: plan.id, summary: plan.summary, results })
    })
}
