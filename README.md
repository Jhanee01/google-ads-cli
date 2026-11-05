# google-ads-cli

An agent-friendly command line tool for the Google Ads API. An AI agent (Claude Code, or any
agent that can run shell commands) uses it to read campaign data and to **propose** changes.
Nothing changes in the account until a human approves the exact change.

I built it to run real campaigns for small service businesses with Claude Code: the agent reads
the search terms, finds wasted spend, and drafts the negative keywords, budget, bidding, age and
location changes. I check the plan and apply it.

```
 agent                          google-ads-cli                         Google Ads API
 ─────                          ──────────────                         ──────────────
 "spend is wasted on         →  search-terms --days 7          →       searchStream (read)
  'free' searches"
                             →  add-negative --terms free      →       read current state
                                                                       mutate validateOnly=true
                                writes plans/<id>.json  ←────────────  (checked, nothing changed)
 shows summary + warnings
 to the human
 human: google-ads apply     →  hash / expiry / account check  →       mutate (real)
        plans/<id>.json --yes   audit.log.jsonl ← every run
```

## Why it is built this way

- **Propose, don't act.** Every write command reads the live state, builds the operations, has the
  API check them with `validateOnly`, and writes a plan file with a summary, warnings, the "before"
  state and the exact operations. The agent never needs write access.
- **The approval is enforced in code, not in a prompt.** Give the agent `DENY_COMMANDS=apply` and it
  physically cannot apply. `apply` checks a SHA-256 hash of the operations (an edited plan is
  refused), an expiry (24 h by default; the account may have changed), the account ID, and that the
  plan was not applied before. Without `--yes` it asks in the terminal and refuses when there is none.
- **Guards for the expensive mistakes.** A budget change above `MAX_BUDGET_CHANGE_PCT` (50 %) needs
  `--force`. Removing the last targeted location (which silently means *worldwide*) needs
  `--force`. Excluding every age range is refused. Switching to Maximize conversions with fewer than
  15 conversions in 30 days gets a warning. So do shared budgets, age bid adjustments under Smart
  Bidding (they are ignored), and an uncapped Maximize clicks.
- **Output an agent can use directly.** Always JSON; money in the account currency (no micros);
  CTR in percent; every row carries the IDs the next command needs. The `--help` texts are written
  for agents: when to use the command, the output fields, examples.
- **Small and dependency-light.** Plain REST calls with `fetch` (OAuth2 refresh, GAQL `searchStream`,
  `mutate`), `commander` for the CLI. No client library, no code generation.

## Commands

| Read (JSON, never changes anything) | |
|---|---|
| `ping` | connection and account check |
| `campaigns` | IDs, status, bidding strategy, target CPA / max CPC, daily budget, location option |
| `ad-groups [--campaign]` | ad group IDs |
| `report --days 7\|14\|30` | cost, clicks, impressions, CTR, avg. CPC, conversions, cost per conversion |
| `keywords --days` | keyword performance with match type and the criterion ID |
| `search-terms --days` | what people actually searched (negative keyword candidates) |
| `negatives` | campaign-level negative keywords |
| `ages --days [--campaign]` | performance by age range, exclusions and bid adjustments |
| `locations --campaign` | targeted / excluded locations and the presence-vs-interest option |
| `geo-search <name> [--country HU]` | geo target IDs by name |

| Plan (validated, written to a file, nothing changes) | |
|---|---|
| `add-negative --campaign --terms a,b --match EXACT` | negative keywords; existing ones are skipped |
| `pause-keyword --keyword "…" \| --criterion ag~id [--resume]` | pause or re-enable keywords |
| `set-budget --campaign --daily 2500 [--force]` | daily budget, with the change guard |
| `set-bidding --campaign --strategy max-conversions [--target-cpa 7000]` | bidding goal: conversions |
| `set-bidding --campaign --strategy max-clicks [--max-cpc 400]` | bidding goal: clicks, with a CPC cap |
| `set-bidding --campaign --strategy manual-cpc` | manual CPC bids |
| `set-age --ad-group --exclude 18-24,65+ / --include / --bid-adjust 35-44:+20` | age targeting |
| `set-location --campaign --add / --exclude / --remove <geo IDs> [--presence-only]` | location targeting |

| Human | |
|---|---|
| `apply <plan.json> [--yes]` | runs a plan; appends to the audit log |
| `auth` | gets a new refresh token in the browser and saves it into `.env` (never printed) |

A plan looks like this (shortened):

```json
{
  "status": "planned",
  "plan": "C:\\work\\plans\\20261105T081500-set-location-3fa9c1.json",
  "validated": "api-validate-only",
  "summary": [
    "target Budapest,Hungary (1007633) on campaign \"Search – Services – Budapest\"",
    "exclude Pest County,Hungary (20429) on campaign \"Search – Services – Budapest\"",
    "location option of \"Search – Services – Budapest\": PRESENCE_OR_INTEREST → PRESENCE (only people who are in or regularly in the area)"
  ],
  "warnings": [],
  "expiresAt": "2026-11-06T08:15:00.000Z",
  "next": "A human reviews the summary, then runs: google-ads apply \"…\" --yes"
}
```

## Setup

```bash
git clone https://github.com/Jhanee01/google-ads-cli && cd google-ads-cli
npm install && npm run build
npm link            # makes `google-ads` available everywhere
cp .env.example .env
```

### Credentials

1. **Developer token**: Google Ads → Tools → API Center (a test account token works for test accounts).
2. **OAuth client**: Google Cloud console → APIs & Services → enable *Google Ads API* → Credentials →
   *Create OAuth client ID* → *Desktop app*. Put the ID and secret into `.env`.
3. **Refresh token**: `google-ads auth` opens the consent screen and writes `GOOGLE_ADS_REFRESH_TOKEN`
   into `.env`. If the OAuth app stays in *Testing* status, Google expires the token after 7 days;
   publish the app (an internal or unverified app is fine for your own use) to keep it.
4. `GOOGLE_ADS_CUSTOMER_ID` (no dashes), and `GOOGLE_ADS_LOGIN_CUSTOMER_ID` only if you reach the
   account through a manager account.
5. `google-ads ping`

`.env`, client secret files, plans and the audit log are git-ignored.

## Using it with an agent

`skills/google-ads/SKILL.md` is a ready Claude Code skill: copy it to `~/.claude/skills/google-ads/`.
It tells the agent the workflow (read → explain → plan → hand over) and that `apply` is not its job.
Run the agent with `DENY_COMMANDS=apply` so that this holds even if it tries.

The tool deliberately has no opinions about *what* to change. My own rules (match type strategy,
budget limits, which search terms are always negative) live in a separate knowledge base the agent
reads; `docs/knowledge-base-template.md` shows the structure without my clients' numbers.

## Development

```bash
npm test          # vitest: the change builders, and plan → apply end to end with a fake API
npm run typecheck
npm run dev -- report --days 7
```

The change logic is in `src/builders.ts` as pure functions (current state + request → operations,
summary, warnings), so every rule is unit-tested without the network. `test/cli.test.ts` runs the
real command line against a mocked `fetch` and checks the safety properties: validate-only during
planning, single use, hash, expiry, account match, `--yes`, and the deny list.

The API version is `GOOGLE_ADS_API_VERSION` (default `v26`); Google retires versions about a year
after release, so bump it when `ping` reports an unsupported version.

## License

MIT
