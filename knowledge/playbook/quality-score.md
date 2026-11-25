# Quality Score: where the price per click comes from

Quality Score (1–10, per keyword) is Google's estimate of how relevant the ad and the landing page
are to the search. It is not a bid, but it changes what a click costs: the same position costs
more on a 3 than on a 7. On a small budget a low score is money paid for nothing.

`google-ads keywords` shows the current score and its three components;
`google-ads suggest` reports `low-quality-score-spend` when too much of a campaign's keyword spend
goes to keywords with a score of `lowQualityScore` (default 4) or lower.

## Read the component, not the number

| Component (API field) | BELOW_AVERAGE means | Fix |
|---|---|---|
| Expected CTR (`expectedCtr`) | people see the ad and do not click it | headlines that repeat the exact keyword and give a reason to click: price, area, speed, "call now" |
| Ad relevance (`adRelevance`) | the ad is not about this keyword | put the keyword in its own ad group with an ad written for it; do not serve one generic ad to every keyword |
| Landing page experience (`landingPage`) | the page does not deliver what the search asked for | a page about that exact service, fast on mobile, the phone number on top, no detour |

Fix the component that carries the most spend first (`suggest` names it).

## Cautions

- **No score is not a low score.** Keywords with too few impressions have none (`null`); they are
  left out of the calculation.
- **The score is current, the spend is from the window.** After a fix the score moves within days
  to a couple of weeks; judge it again after that, not the next morning.
- **Do not pause a keyword only because of its score.** A converting keyword with a score of 3 is
  still a converting keyword. Fix the ad or the page; pause only what is also irrelevant.
- Ad text and landing page changes are not in this CLI; propose them as a checklist for the UI
  or the website (see [assets-and-mobile](assets-and-mobile.md)).
