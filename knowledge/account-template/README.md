# Account template

Copy this folder once per account (outside the repo, or into a private repo) and fill it in.
The agent reads it together with the general [playbook](../playbook/). Account pages win
when the two disagree: they hold facts about this business.

```
<account>/
  Wiki.md                 index + the 10-line summary the agent reads first
  what-we-dont-offer.md   the source of the negative keywords
  data-quality.md         periods when tracking was broken, conversion setup facts
  rules/
    budget.md             daily budget, how far a single change may go
    match-strategy.md     allowed match types and why
    targeting.md          service area (geo IDs), presence-only, excluded ages and why
  history/
    YYYY-MM-DD.md         one entry per change package: what, plan IDs, why, expected, outcome
```

Good entries say **why**, not only what: "65+ excluded: 0 conversions from 41 clicks in 90 days"
lets the agent revisit the decision when the data changes.

Put the machine-readable part into `google-ads.rules.json` next to where you run the CLI
(see `google-ads.rules.example.json`): thresholds, `alwaysNegative` words, invalid conversion
periods. `google-ads suggest` uses it.
