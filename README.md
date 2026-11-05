# google-ads-cli

[![CI](https://github.com/Jhanee01/google-ads-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Jhanee01/google-ads-cli/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node >=20](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](package.json)

An agent-friendly command line tool for the Google Ads API. An AI agent (Claude Code, or any
agent that can run shell commands) uses it to read campaign data and to **propose** changes.
Nothing changes in the account until a human approves the exact change.

I built it to run real campaigns for small service businesses with Claude Code: the agent reads
the search terms, finds wasted spend, and drafts the negative keywords, budget, bidding, age and
location changes. I check the plan and apply it.

Three layers, each doing what it is good at:

| Layer | Does | Lives in |
|---|---|---|
| **Rules** | finds the measurable problems on live data, every time, the same way | `google-ads suggest` (`src/suggest.ts`) |
| **Judgement** | weighs the findings against what the business is and what went wrong before | the agent + [`knowledge/`](knowledge/) |
| **Approval** | decides; nothing changes without it | a human running `google-ads apply` |

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
| `suggest --days [--rules file]` | rule-based findings from the playbook, each with its reason and the plan command |

| Plan (validated, written to a file, nothing changes) | |
|---|---|
| `add-negative --campaign --terms a,b --match EXACT` | negative keywords; existing ones are skipped |
| `add-keyword --ad-group --terms a,b --match EXACT` | keywords (e.g. promoted search terms); existing ones are skipped |
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

## `suggest`: the playbook as rules

`google-ads suggest --days 30` reads the account (campaigns with impression share, keywords,
search terms, negatives, age ranges) and runs the rules from [`knowledge/playbook`](knowledge/playbook/).
Every rule comes from something that actually went wrong on a live account:

| Rule | Fires when | Suggests |
|---|---|---|
| `tracking-unverified` / `invalid-conversion-period` / `measurement-suspect` | no verification date (the default), the window overlaps a period marked broken, or many clicks with zero conversions | verify tracking; conversion-based rules are switched off |
| `no-auction` | zero impressions **and** no impression share data | check billing in the UI (invisible in the API) |
| `smart-bidding-without-signal` | Smart Bidding with < 15 conversions (high if rank loss is high) | `set-bidding --strategy max-clicks --max-cpc …` |
| `rank-lost` / `budget-limited` | lost impression share above the thresholds | assets and relevance / report only, never a budget raise |
| `presence-or-interest` | local business on "presence or interest" | `set-location --presence-only` |
| `broad-phrase-share` | broad + phrase take most of the keyword spend | `pause-keyword` for the biggest wasteful ones |
| `always-negative` | search terms contain words the account never wants | one BROAD `add-negative` |
| `wasted-search-terms` | terms above the waste threshold, zero conversions, trusted tracking | review, `add-negative` EXACT for the irrelevant ones |
| `promote-to-exact` | converting terms (or clicked ones, if tracking is unverified) that are no exact keyword yet | `add-keyword --match EXACT` |
| `age-without-conversions` | an age range spent without converting while the ad group converts | `set-age --exclude` |

```json
{
  "rule": "smart-bidding-without-signal",
  "severity": "high",
  "campaign": "Search – Services – Budapest",
  "title": "MAXIMIZE_CONVERSIONS with only 0 conversions: Smart Bidding has no signal",
  "why": "Fewer than 15 conversions in 30 days, 90% of impressions lost to rank. Without a signal it lowers bids until the campaign stops serving.",
  "playbook": "knowledge/playbook/bidding.md",
  "action": "google-ads set-bidding --campaign 123 --strategy max-clicks --max-cpc 850"
}
```

Findings are candidates. An action only creates a plan, and the agent is told to read the
playbook page and the account's own pages before proposing it. Conversions are **not trusted until the account's
`trackingVerifiedOn` date is set**: broken tracking can report a few conversions for months and
look fine. Thresholds, the always-negative words and the invalid conversion periods are per account in `google-ads.rules.json`
(see [`google-ads.rules.example.json`](google-ads.rules.example.json)).

## Using it with an agent

- `skills/google-ads/SKILL.md` is a ready Claude Code skill: copy it to `~/.claude/skills/google-ads/`.
  Workflow: `ping` → `suggest` → read the playbook and the account pages → explain → plan → hand over.
- Run the agent with `DENY_COMMANDS=apply` so that `apply` stays the human's job even if it tries.
- [`knowledge/playbook`](knowledge/playbook/) holds the general lessons (measurement, bidding,
  diagnosis, match types, negatives, targeting, assets, approval).
  [`knowledge/account-template`](knowledge/account-template/) is the per-account part you fill in
  and keep private: the business, what it does not offer, broken tracking periods, history.

## Development

```bash
npm test          # vitest: builders, suggest rules, and plan → apply end to end with a fake API
npm run typecheck
npm run dev -- report --days 7
```

The change logic is in `src/builders.ts` and the suggest rules in `src/suggest.ts`, both as pure
functions (data in, operations or findings out), so every rule is unit-tested without the network;
`test/suggest.test.ts` has one scenario per playbook lesson. `test/cli.test.ts` runs the
real command line against a mocked `fetch` and checks the safety properties: validate-only during
planning, single use, hash, expiry, account match, `--yes`, and the deny list.

The API version is `GOOGLE_ADS_API_VERSION` (default `v26`); Google retires versions about a year
after release, so bump it when `ping` reports an unsupported version.

## License

MIT
