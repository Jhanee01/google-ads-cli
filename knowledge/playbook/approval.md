# Approval and follow-up

On a small budget one wrong change hurts a lot, so:

- **Without approval:** every read command, `suggest`, analysis, explaining, drafting proposals.
- **With approval:** everything that writes. The CLI enforces it: write commands create plans,
  only a human runs `apply` (`DENY_COMMANDS=apply` for the agent).

## A proposal always says

**What, why (data + the playbook or account page), expected effect.** For example:

> Add "container rental" as a negative: it took 3 clicks without a lead in the search term report,
> and we don't offer containers (`what-we-dont-offer`). Expected: ~600 a week less waste.

One plan per decision, so each can be approved or rejected on its own. Related changes that only
make sense together (pause broad + add exact + add negatives) can be one approved package of
several plans.

## After applying

1. Write a `history/YYYY-MM-DD.md` entry: what changed, the plan IDs, why, the expected effect.
2. **Re-check after 24–72 hours:** are impressions and clicks back, did calls or leads come, is
   the wasted intent gone from the search terms, did rank loss fall?
3. Write the outcome into the same entry. A lesson that holds across accounts goes into the
   playbook.
