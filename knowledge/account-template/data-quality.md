# Data quality

Playbook: [measurement](../playbook/measurement.md). Keep `invalidConversionPeriods` in
`google-ads.rules.json` in sync with the table below.

## Conversion actions

| Action | Type | Primary? | Counting | Fires from | Verified "Recording conversions" on |
|---|---|---|---|---|---|
| <name> | <CLICK_TO_CALL / WEBPAGE / GA4 import> | yes | one per click | <GTM trigger> | <date or "not yet"> |

## Periods with invalid conversion data

| From | To | What was broken |
|---|---|---|
| <YYYY-MM-DD> | <YYYY-MM-DD> | <e.g. call tag never sent; container had no Google tag> |

## Account quirks

- <e.g. goal-based conversion management: primary/secondary only in the UI>
- <e.g. country without forwarding numbers: calls from ads are not measurable>
