# Knowledge base template

The CLI is the agent's hands; this is its judgement. Keep one folder per account (Markdown files
the agent reads before proposing anything). The structure I use, without the real numbers:

```
account-name/
  Wiki.md               index: business, goal, what a conversion is, links to the pages below
  rules/
    approval.md         what needs approval (everything that writes) and how a plan is presented
    budget.md           daily budget range, max change per step, when to raise or lower
    match-strategy.md   which match types are allowed and why (e.g. EXACT/PHRASE first)
    negatives.md        terms that are always negative (jobs, free, DIY, competitor brands…)
    targeting.md        service area (geo IDs), presence-only or not, excluded ages and why
  history/
    YYYY-MM-DD.md       what was changed, the plan ID, the expected effect, what happened
  data-quality.md       periods with broken conversion tracking that must not be used
```

Good entries say **why**, not only what: "65+ excluded: 0 conversions from 41 clicks in 90 days"
lets the agent revisit the decision when the data changes.
