---
name: google-ads
description: Read Google Ads performance and propose changes with the local `google-ads` CLI. Use when the user asks about campaign spend, keywords, search terms, negative keywords, age or location targeting, budget or bidding, or wants a change prepared in the account.
---

# google-ads

The `google-ads` CLI reads the account and turns change requests into **plans**. You never change
the account yourself: a human applies plans with `google-ads apply`. Your environment has
`DENY_COMMANDS=apply`, so that command fails for you by design. Do not try to work around it.

## Workflow

1. `google-ads ping` to check the connection, then `google-ads campaigns` (and `ad-groups`) for IDs.
2. Read what the question needs: `report`, `keywords`, `search-terms`, `negatives`, `ages`,
   `locations`. Use `--days 7|14|30`. Output is JSON; money is in the account currency.
3. Explain what you see in plain words: what is wasting money, what works, with the numbers.
4. If the user agrees a change is needed, create the plan with the matching command
   (`add-negative`, `pause-keyword`, `set-budget`, `set-bidding`, `set-age`, `set-location`).
5. Show the user the plan's `summary` and `warnings` and the plan path. Stop there. The user runs
   `google-ads apply "<plan>" --yes` after reading it.

## Rules

- Read the knowledge base before proposing (match type strategy, budget rules, negative list).
- One plan per decision, so each can be approved or rejected on its own.
- If a command refuses (budget guard, worldwide targeting, every age excluded), explain why to the
  user. Only add `--force` when the user explicitly asks for that change.
- Location IDs come from `google-ads geo-search <name> --country <CC>`; never guess them.
- Conversion numbers are only as good as the tracking. Say so when they look suspicious.
