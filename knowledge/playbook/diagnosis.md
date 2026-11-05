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

## Other checks

- Did a change happen just before the drop? (Budget cut, bidding switch, paused keywords.) Read
  the account's `history/`.
- New-customer promotional credits only apply within the first weeks of a new account; an old
  account is not eligible, and opening a new account for the credit is not worth it.
