# Diagnosis: the campaign stopped spending

Read the impression share columns before touching any setting
(`google-ads suggest` does this for every enabled campaign):

| Search impression share | Lost (rank) | Lost (budget) | Most likely cause | First step |
|---|---|---|---|---|
| present, low | **high** | low | bids too low; on Smart Bidding with few conversions: starvation | [bidding](bidding.md): Maximize clicks with a cap |
| present | low | **high** | the budget runs out | fine on a small budget; flag it, do not raise it yourself |
| present | high | high | both; also check Quality Score / ad relevance | ad text that mirrors the exact keyword; landing page match |
| **no data at all** | – | – | the campaign does not enter auctions | **check Billing in the UI first** |

## The silent one: billing

Twice the campaign stopped completely for weeks while every entity in the API stayed `ENABLED`,
`SERVING` and `ELIGIBLE`. The cause was an unpaid invoice. A payment hold is **not visible in the
API**. The tell: zero impressions **and** no impression share data at all, not even rank or
budget loss. Ask the human to look at *Billing* in the Google Ads UI before changing anything.

## Anomalies: notice it the next morning, not weeks later

`google-ads suggest` always reads the last 30 days day by day (whatever `--days` is) and reports:

| Rule | Fires when | First step |
|---|---|---|
| `anomaly-serving-stopped` | zero impressions yesterday after ≥ 10 a day the week before | billing, then the change history, then disapproved ads |
| `anomaly-cost-spike` | yesterday's cost ≥ `costSpikeFactor` (2) × the 28-day daily average, and above the waste threshold | read that day's search terms; Google may legally spend up to 2x the daily budget on one day |
| `anomaly-weekly` | the last 7 days against the average week of the 3 before: a metric fell ≥ `anomalyDropPct` (50 %) or rose ≥ `anomalyRisePct` (100 %) | find the cause before changing anything |

The weekly check compares whole weeks, so weekday patterns cancel out; a small account has too
few clicks for a day-by-day comparison. It stays silent below `anomalyMinWeeklyClicks` (20) clicks
a week in the baseline, because there the swings are noise. Conversions are compared only when
tracking is trusted (see [measurement](measurement.md)). A rise in clicks or impressions is
reported as `low`; a drop, or a rise in cost or CPC, as `medium`.

An anomaly is a question, not a verdict: a holiday, a season, a change you made yourself, or a
new campaign explains most of them. Check `history/` before proposing a fix.

## Other checks

- Did a change happen just before the drop? (Budget cut, bidding switch, paused keywords.) Read
  the account's `history/`.
- New-customer promotional credits only apply within the first weeks of a new account; an old
  account is not eligible, and opening a new account for the credit is not worth it.
