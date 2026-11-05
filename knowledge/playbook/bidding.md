# Bidding

> Rule for the agent: **no conversion-based bidding without a proven conversion signal**
> (roughly 15+ real conversions in 30 days and tracking verified, see [measurement](measurement.md)).

## What happened

The campaign ran on *Maximize conversions* while tracking recorded nothing. After a budget cut
the impressions fell from ~160 a day to 0 within six days. The budget was not the cause: the
*lost impression share (budget)* was 0 %, the *lost impression share (rank)* was ~90 %. With no
conversions to learn from, Smart Bidding had pushed the bids to the floor and the ads lost
almost every auction.

Switching to *Maximize clicks* with a CPC cap brought serving back the same day; the campaign
became "limited by budget", which is the healthy state for a small budget.

## Rules

1. **Without a signal: Maximize clicks with a CPC cap.** The cap stops single expensive clicks;
   set it generously (several times the average CPC) so it does not choke serving.
   `google-ads set-bidding --campaign <id> --strategy max-clicks --max-cpc <amount>`
2. **Move to Maximize conversions only after** 2–4 weeks of verified conversions. Start without a
   target CPA, add one when the actual CPA is stable.
3. **Diagnose before you change bids**: rank loss vs. budget loss (see [diagnosis](diagnosis.md)).
   Rank loss on Smart Bidding with few conversions = starvation, not competition.
4. **Smart Bidding ignores bid adjustments** (age, location, schedule; only a −100 % device
   adjustment applies). Exclusions still work.
5. **Bidding changes restart learning.** One change at a time, then wait 1–2 weeks unless serving
   collapsed.
