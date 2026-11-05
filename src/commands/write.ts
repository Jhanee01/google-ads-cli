import type { Command } from 'commander'
import { createInterface } from 'node:readline/promises'
import { config, CliError } from '../config.js'
import { mutate, resolveCustomerId, micros } from '../client.js'
import { ids } from '../gaql.js'
import {
  ageList, bidAdjustments, buildAddKeywords, buildAddNegatives, buildAge, buildBidding, buildBudget, buildKeywordStatus, buildLocation,
  matchType, strategy, type Change, type GeoType,
} from '../builders.js'
import { audit, checkPlan, createPlan, loadPlan, markApplied, savePlan } from '../plan.js'
import {
  adGroupAges, adGroupKeywords, campaignConversions30d, campaignLocations, campaignNegatives, findKeywords, geoByIds, getAdGroup, getCampaign,
} from '../state.js'
import { cidOf, out } from './read.js'

const SMART_BIDDING = new Set(['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS'])

const PLAN_NOTE = `
SAFETY: this command does NOT change the account. It reads the current state, builds the change,
has the Google Ads API validate it (validateOnly), and writes a plan file. A human applies it with:
  google-ads apply <plan-file> --yes`

function withPlanOptions(cmd: Command): Command {
  return cmd
    .option('--customer-id <id>', 'account ID (no dashes); default GOOGLE_ADS_CUSTOMER_ID')
    .option('--offline', 'skip the API validation of the plan (not recommended)')
    .option('--json', 'JSON output (always on, accepted for clarity)')
}

async function propose(cmd: Command, command: string, change: Change, before: unknown): Promise<void> {
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
  withPlanOptions(program.command('add-negative').description(`Plan: add negative keywords to a campaign.${PLAN_NOTE}

EXAMPLES:
  google-ads add-negative --campaign 123 --terms "free,jobs,diy" --match EXACT`))
    .requiredOption('--campaign <id>', 'campaign ID (see: google-ads campaigns)')
    .requiredOption('--terms <list>', 'comma-separated terms')
    .option('--match <type>', 'EXACT | PHRASE | BROAD', 'EXACT')
    .action(async (_, cmd) => {
      const o = cmd.opts()
      const cid = cidOf(cmd)
      const camp = await getCampaign(o.campaign, cid)
      const existing = await campaignNegatives(camp.id, cid)
      const change = buildAddNegatives({
        campaignResource: camp.resourceName, campaignName: camp.name, terms: String(o.terms).split(','), match: matchType(o.match), existing,
      })
      await propose(cmd, 'add-negative', change, { campaign: camp.name, negatives: existing.length })
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
