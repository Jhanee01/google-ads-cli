# Ad copy: responsive search ads and assets

> Rule for the agent: **you write the text, the CLI checks it.** Write from the business's own
> facts (the website, the account knowledge base): every price, area, time and promise in the ad
> must be on the landing page. Then run `google-ads check-spec` (new campaigns) or the `add-ad`
> plan (existing ad groups) and fix what it reports. Never invent a claim to fill a headline.

Sources: Google Ads Help (*About responsive search ads*, *Best practices for creating effective
responsive search ads*, *About Ad Strength*, *About sitelink assets*, *About callout assets*,
*About structured snippet assets*) and practitioner sources for local services.

## What happened

The first moving and transport ads had 15 headlines and 4 descriptions each, but every one was
rated **Poor**:
- one RSA per ad group;
- the transport and the furniture ad groups had the same ad, word for word;
- one headline pinned to position 1 with no alternative;
- the main keywords ("furniture transport prices", "small move Budapest") were not inside any
  headline.

The landing page experience was below average on all the spend: the furniture keywords led to
the general transport page. A callout ("final prices, without VAT") contradicted a headline
("final prices, with invoice").

## The format (Google's limits: errors, the CLI refuses them)

| Element | Count | Characters |
|---|---|---|
| Headline | 3–15 | 30 |
| Description | 2–4 | 90 |
| Display path (path1, path2) | 0–2 | 15 each, no spaces or slashes |
| Sitelink text | 2 to show, **6+ recommended** | 25 |
| Sitelink description lines | 2 (both or none) | 35 each |
| Callout | up to 10 show | 25 |
| Structured snippet | a fixed header + 3–10 values | 25 per value |

Accented letters count as one character. Headline 1 and description 1 almost always show;
headlines 2–3 and description 2 do not always. Text may be cut with "…".

## How to write it

1. **Keywords inside headlines, word for word.** Google's Ad Strength counts a keyword only when
   it is **entirely inside one headline**, never split across two. Put the main keywords of the
   ad group into headlines as they are. A keyword longer than 30 characters goes into a
   description. **In inflected languages the word form must match too:** the Hungarian headline
   "Költöztetés Budapesten" does not contain the keyword "költöztetés budapest". Write
   "Költöztetés Budapest" or "Költöztetés árak" exactly as the keyword is.
2. **As many unique headlines as possible (up to 15), all 4 descriptions.** Headlines that differ
   only in word order, case or accents count as one.
3. **Mix lengths**: short (10–15) and long (25–30) headlines.
4. **The first three headlines must read well one after another.** Google puts them side by side.
5. **Every headline must stand alone.** Google may show unused headlines as sitelinks, and
   descriptions as sitelink descriptions.
6. **A concrete call to action**: "Call now for a fixed price". Not "Learn more".
7. **A price or an offer** in a headline or a description (call-out fee, price per m³, same-day).
8. **Local service pattern:** 1. *service + place* → 2. *trust* (0–24, invoice, fast) →
   3. *price or offer*. Calls are the goal, so write "Call now" and keep a call asset.
9. **One ad group, one service, its own ad.** Never the same ad in two ad groups.
10. **2 RSAs per ad group** (Google: +6.6 % conversions at a similar cost per conversion), each
    with "Good" or "Excellent" Ad Strength. Make them differ in angle (price vs speed), not in
    commas.
11. **Consistency:** the headline, the callouts, the sitelinks and the landing page must say the
    same thing about price, VAT, area and hours.

## Pinning

- Google: "not recommended for most advertisers". It limits the combinations and lowers Ad
  Strength.
- When the service name must always lead, pin **2–3 different versions to position 1**
  ("Moving in Budapest", "Small moves in Budapest", "Moving Budapest & Pest"). One version
  pinned alone stops the testing.
- Pin only what must always show, usually position 1 only. If every position is pinned, the
  unpinned headlines never show.

## Ad Strength

Values: Incomplete · Poor · Average · Good · Excellent. **It is not an auction factor.** Google
says it is not used for Ad Rank, Quality Score or eligibility; it is a diagnostic. What it
measures matters: keywords in headlines and unique assets. The rating itself does not: Poor ads
sometimes outperform Excellent ones. Fix the causes, do not chase the label.

## Assets

- **Sitelinks: at least 6, with both description lines** (Google: 6 sitelinks give up to +3.5 %
  conversions; without descriptions the larger format cannot show). Similar sitelinks do not
  show together. Desktop shows up to 6, mobile up to 8.
- **Callouts: at least 4** short, concrete benefits. Do not repeat a headline.
- **Structured snippet:** a complete list, e.g. header *Service catalog*: Moving, Transport,
  Waste removal. Headers come from a fixed list (Amenities, Brands, Courses, Degree programs,
  Destinations, Featured hotels, Insurance coverage, Models, Neighborhoods, Service catalog,
  Shows, Styles, Types) and are shown translated.
- **Call asset** when calls are the goal (see [assets-and-mobile](assets-and-mobile.md)).
- A lower level overrides a higher one: campaign sitelinks hide the account's sitelinks.

## The landing page

The ad's promise must be on the page, at the top, on mobile: the service, the price, the area,
the phone number. A keyword theme without its own page (here: furniture transport going to the
general transport page) shows up as "landing page experience: below average" in the Quality
Score (see [quality-score](quality-score.md)).

## What the CLI checks for you

| Check | Level | Where |
|---|---|---|
| Counts and lengths, duplicates, pin positions, path format, https final URL | error | `check-spec`, `create-campaign`, `add-ad` |
| Every position pinned (unpinned headlines can never show) | error | same |
| Sitelink, callout and snippet limits; snippet header from the fixed list | error | same |
| Keywords not inside a headline (and the coverage per ad group) | warning | `check-spec`, `add-ad`, `ads`; `suggest` → `ad-keyword-coverage` |
| Fewer than 10 headlines / 4 descriptions; similar headlines; all the same length; no number | warning | `check-spec`, `add-ad`, `ads` |
| One version pinned to a position; pins on more than one position | warning | same; `suggest` → `ad-pinning` |
| One RSA per ad group; the same ad in two groups | warning | same; `suggest` → `single-rsa`, `duplicate-ads` |
| Fewer than 6 sitelinks, sitelinks without descriptions, similar sitelinks, fewer than 4 callouts, a callout repeating a headline, no snippet, no call asset | warning | `check-spec`, `ads`; `suggest` → `ad-assets` |

Not checkable by code, so it is your job: contradictions in meaning (VAT, prices, area), a claim
that is not on the landing page, tone, the first three headlines reading well together.
