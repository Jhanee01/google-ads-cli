import { Command } from 'commander'
import { config, CliError } from './config.js'
import { registerRead } from './commands/read.js'
import { registerWrite } from './commands/write.js'
import { registerAuth } from './commands/auth.js'

/** Exact command names, or a prefix ending in "*" (e.g. "set-*"). */
export function isDenied(command: string, deny: string[]): string | undefined {
  const name = command.toLowerCase()
  return deny.find(d => (d.endsWith('*') ? name.startsWith(d.slice(0, -1)) : name === d))
}

export function buildProgram(): Command {
  const program = new Command()
    .name('google-ads')
    .description(`Agent-friendly CLI for the Google Ads API.

READ commands return JSON and never change anything.
WRITE commands (add-negative, pause-keyword, set-budget, set-bidding, set-age, set-location) only
write a PLAN: the change is validated by the API (validateOnly) and saved to a file. Nothing changes
until a human runs "google-ads apply <plan> --yes". Every apply is appended to an audit log.

FOR AI AGENTS:
  Output is always JSON. Start with "google-ads ping".
  Money is in the account currency (micros already converted); ctr 17.02 means 17.02 %.
  Get IDs from "campaigns" and "ad-groups" first; every write command takes IDs.
  After a write command, show the human its "summary" and "warnings" and the plan path. Do not apply.
  Your environment should have DENY_COMMANDS=apply, so apply is refused for you anyway.

QUICK REFERENCE:
  ping            "does it work?"
  campaigns       IDs, bidding, budget, location option
  ad-groups       ad group IDs
  report          campaign spend, clicks, conversions, cost per conversion
  keywords        keyword performance with match type
  search-terms    what people searched (negative candidates)
  negatives       current negative keywords
  ages            performance by age range
  locations       targeted / excluded locations of a campaign
  geo-search      find geo target IDs by name
  add-negative    PLAN  add negative keywords
  pause-keyword   PLAN  pause / resume keywords
  set-budget      PLAN  daily budget (guarded)
  set-bidding     PLAN  max-conversions (target CPA) | max-clicks (max CPC) | manual-cpc
  set-age         PLAN  exclude / include age ranges, age bid adjustments
  set-location    PLAN  add / exclude / remove locations, presence vs interest
  apply           HUMAN applies a plan
  auth            HUMAN gets a new refresh token into .env`)
    .option('--deny <commands>', 'extra comma-separated denied commands (added to DENY_COMMANDS)', '')
    .showHelpAfterError()
    .hook('preAction', (root, action) => {
      const extra = String(root.opts().deny ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      const denied = isDenied(action.name(), [...config.deny, ...extra])
      if (denied) throw new CliError(`Command "${action.name()}" is blocked by the deny list ("${denied}").`)
    })
  registerRead(program)
  registerWrite(program)
  registerAuth(program)
  return program
}
