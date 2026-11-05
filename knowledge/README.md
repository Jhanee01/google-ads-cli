# Knowledge base

The CLI is the agent's hands; this folder is its judgement. Two layers:

- **`playbook/`**: general lessons that hold for any small Search account. They come from running
  a real local-service account (small daily budget, phone calls as the main conversion) for most
  of a year, and every rule says what went wrong when it was ignored.
- **`account-template/`**: copy it once per account and fill it in (the business, the service
  area, what it does NOT offer, what counts as a conversion, the periods with broken tracking).
  That copy stays private; the agent reads both.

`google-ads suggest` runs the measurable part of the playbook as fixed rules on live data and
names the playbook page behind every finding. The agent then weighs the findings against the
account's own pages before it proposes a plan.

## Playbook

| Page | The lesson in one line |
|---|---|
| [measurement](playbook/measurement.md) | Prove that conversions are recorded before you optimise for them. A tag that "fired" in preview proved nothing. |
| [bidding](playbook/bidding.md) | Smart Bidding without a conversion signal starves the campaign; use Maximize clicks with a CPC cap until the signal exists. |
| [diagnosis](playbook/diagnosis.md) | "No impressions": rank loss, budget loss, or no auction at all (billing). The impression share columns tell which. |
| [match-types](playbook/match-types.md) | On a small budget, broad and phrase eat the money. Exact first; promote proven search terms to exact. |
| [negatives](playbook/negatives.md) | Build the negative list from "what we don't offer" before launch, by category. |
| [targeting](playbook/targeting.md) | Presence-only for local services; age, gender and schedule only with valid conversion data. |
| [assets-and-mobile](playbook/assets-and-mobile.md) | When calls are the goal and traffic is mobile, assets and call-focused ads are the cheapest rank gain. |
| [approval](playbook/approval.md) | Every write is a plan with what, why and expected effect; re-check 24–72 h later and log it. |
