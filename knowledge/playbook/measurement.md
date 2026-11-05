# Measurement first

> Rule for the agent: **if conversion tracking is not proven, do not use conversion numbers for
> any decision.** Optimise on CTR, cost and search term relevance instead, and say so.

## What happened

- The tracking was wrong for **most of the year** and was fixed in several rounds while the
  campaigns kept running. Broken tracking did not look broken: in the first months it still
  reported a handful of conversions, so nothing seemed off. Every "cost per conversion" and
  "exact match converts 4x better" conclusion built on them had to be withdrawn.
- That is why `suggest` trusts no conversion by default: only from the `trackingVerifiedOn` date
  in the account's rules, i.e. after someone saw a real click arrive as *Recording conversions*.
- After a fix, the tag manager preview showed the conversion tag firing three times on a test
  click. In live traffic the next ~90 clicks recorded **zero** conversions. The tag was stuck
  ("still running") because the container had no Google tag for the Ads account: a *Conversion
  Linker* is not a Google tag, and the only Google tag in the container was for GA4.
- Several conversion actions measured the same phone call, all set as primary. They happened to be
  silent; had they fired together, every call would have counted two or three times.

## Rules

1. **A tag firing is not a conversion being sent.** Verify on three levels: the preview fires the
   tag → the browser sends the conversion request (network tab) → Google Ads shows the action as
   *Recording conversions* after real clicks. Only the last one counts.
2. **Keep a list of invalid periods** in the account's `data-quality.md` (and in
   `google-ads.rules.json`, `invalidConversionPeriods`, so `suggest` ignores those conversions).
3. **Suspicious pattern:** dozens of clicks with zero conversions on a business that does get
   enquiries means broken tracking far more often than a bad campaign. Ask the owner whether
   leads came in.
4. **One primary action per real-world event.** Duplicates go secondary, not deleted (removal is
   permanent; history is lost).
5. **Lead forms count once per click** (`ONE_PER_CLICK`). Many-per-click counts a page refresh on
   the thank-you page as a second lead.
6. **Accounts with goal-based conversion management** do not let the API change
   `primary_for_goal`, `include_in_conversions_metric` or the counting type of imported actions
   (`IMMUTABLE_FIELD`). Send the human to *Goals → Conversions* in the UI instead of retrying.

## Phone calls in countries without Google forwarding numbers

Hungary is one: *calls from ads* (`AD_CALL`) and *calls to a number on the website*
(`WEBSITE_CALL`) cannot be measured there at all; they stay at zero however many people call.
What works:

- a **click-to-call conversion on the website**, fired by the tag manager on clicks of
  `a[href^="tel:"]`;
- the trigger must be **All elements** with the CSS selector `a[href^="tel:"], a[href^="tel:"] *`:
  page-builder buttons (Elementor and similar) wrap the link, and a *Just links* trigger never
  sees the click;
- the container needs a **Google tag for the Ads account** (AW-…), loaded on initialisation.

A phone-call asset still helps people call; it just will not be counted.
