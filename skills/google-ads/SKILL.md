---
name: google-ads
description: Read Google Ads performance, find problems and propose changes with the local `google-ads` CLI. Use when the user asks about campaign spend, keywords, search terms, negative keywords, age or location targeting, budget or bidding, why a campaign stopped, or wants a change prepared in the account.
---

# google-ads

The `google-ads` CLI reads the account, runs the playbook rules (`suggest`), and turns change
requests into **plans**. You never change the account yourself: a human applies plans with
`google-ads apply`. Your environment has `DENY_COMMANDS=apply`, so that command fails for you
by design. Do not try to work around it.

## Knowledge

- General playbook: `knowledge/playbook/` in the google-ads-cli repo (measurement, bidding,
  diagnosis, match types, negatives, targeting, assets, approval).
- The account's own knowledge base (its `Wiki.md`): the business, what it does not offer,
  broken tracking periods, past changes. **Read its summary first.** Account facts win over the
  general playbook.

## Workflow

1. `google-ads ping`, then `google-ads suggest --days 30` (add `--rules <account rules json>`).
2. For each finding, read the playbook page it names and the matching account page. Drop the
   findings that the account knowledge explains (e.g. a term that looks wasteful but is the core
   service).
3. Dig deeper where needed: `report`, `keywords`, `search-terms`, `ages`, `locations`, `campaigns`.
4. Explain to the user in plain words: what is wrong, the numbers, the playbook reason.
5. For each change the user wants, run the finding's `action` (or the matching write command).
   Show the plan's `summary`, `warnings` and path. Stop there; the user applies it.
6. After the user applied it, write the history entry in the account knowledge base and remind
   them of the 24–72 h re-check.

## Rules

- **Measurement first.** If `suggest` reports `measurement-suspect` or an invalid period, do not
  argue with conversion numbers at all. Say so, and work from CTR, cost and relevance.
- **No auction + no impression share → billing.** Ask the user to check Billing before you touch
  any setting.
- A proposal states **what, why (data + page), expected effect**. One plan per decision.
- If a command refuses (budget guard, worldwide targeting, every age excluded), explain why.
  Only add `--force` when the user explicitly asks for that change.
- Location IDs come from `google-ads geo-search <name> --country <CC>`; never guess them.
- New keywords are EXACT unless the account's match strategy says otherwise.
