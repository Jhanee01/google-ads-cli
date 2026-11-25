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
  diagnosis, keyword planning, match types, negatives, ad copy, targeting, assets, approval).
- The account's own knowledge base (its `Wiki.md`): the business, what it does not offer,
  broken tracking periods, past changes. **Read its summary first.** Account facts win over the
  general playbook.

## Workflow

1. `google-ads ping`, then `google-ads suggest --days 30` (add `--rules <account rules json>`).
2. For each finding, read the playbook page it names and the matching account page. Drop the
   findings that the account knowledge explains (e.g. a term that looks wasteful but is the core
   service).
3. Dig deeper where needed: `report`, `keywords`, `search-terms`, `ngrams`, `negatives`,
   `negative-lists`, `ages`, `locations`, `campaigns`.
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
- **Negatives:** follow `knowledge/playbook/negatives.md`. The CLI does the mechanical part
  (Google's matching, accent twins, conflicts with own keywords, redundancy, invalid characters);
  you decide whether a word is really never wanted. Words wrong for every campaign go into a
  shared list (`create-negative-list --attach`); use `--with-accent-variants` for accented terms;
  mine `ngrams --days 60` for single words that spoil many searches.
- **New campaigns**, in this order:
  1. Keywords per service: `knowledge/playbook/keyword-planning.md`; numbers from `keyword-ideas`.
  2. Negatives before launch, by category: `knowledge/playbook/negatives.md`.
  3. Ad copy: `knowledge/playbook/ad-copy.md`. Read the landing pages first; every price or
     promise in the text must be on the page. Write 2 RSAs per ad group with the main keywords
     word for word in headlines, 6+ sitelinks with descriptions, callouts, a snippet.
  4. Write the JSON spec (README), then run `check-spec --spec <file>` and fix it until
     `errors` is empty. Fix each warning, or tell the human why you keep it.
  5. `create-campaign --spec <file>`. Campaigns are created PAUSED; starting them is a separate
     decision and a separate plan (`set-campaign-status --campaign <ids> --enable`).
- **Existing ads:** `ads` shows the copy with its issues; a better or second ad is an `add-ad` plan.
- `report --days 1` gives yesterday, a full finished day.
