# Keyword planning for a new campaign

> Rule for the agent: plan keywords per **service** (one campaign or ad group each), from what the
> business really sells and how its customers say it. Volume is a tie-breaker, not the goal.
> The CLI gives the numbers (`keyword-ideas`) and checks the list (`check-spec`); you decide
> what fits the business.

Sources: Google Ads Help (*Keyword close variants*, *About keyword matching options*, *Use
Keyword Planner*) and practitioner sources. See also [match-types](match-types.md) and
[negatives](negatives.md).

## How Google matches keywords

| Match | Syntax | Shows for |
|---|---|---|
| Broad | `moving` | searches *related* to the keyword, other words too |
| Phrase | `"moving"` | searches that include the keyword's *meaning*, with words around it |
| Exact | `[moving]` | searches with the *same meaning* |

**Every match type, exact too, also matches close variants**, and this cannot be switched off.
Close variants are:
- misspellings, singular and plural, stems, abbreviations;
- **accents (all languages)**;
- reordered words with the same meaning, added or removed function words, implied words;
- synonyms and paraphrases, the same search intent.

So:
- **Do not add the unaccented, reordered or differently spaced copy of a keyword.** Google
  already matches it, and the copy only splits the statistics. `check-spec` reports these as
  `close-variant-keywords`.
- "Exact" still needs the search terms report: it is the same meaning, not the same words.
- Negatives work differently: **no** close variants ([negatives](negatives.md)).

## Which match type

- Google: Smart Bidding is critical with broad match. Practitioners put Smart Bidding's minimum
  at about 30–50 conversions a month per campaign. This playbook is stricter: not below 15 in 30
  days ([bidding](bidding.md)).
- With a small budget, few conversions or tracking not yet verified: **exact**. Phrase only for
  a measured expansion. Broad only with clean tracking and steady lead volume, in its own ad
  group or campaign, so its cost per lead can be compared.
- Do not put the same keyword in several match types in one ad group: they compete.

## Structure

- **One service → its own campaign** when budgets must not starve each other; inside it, **one
  theme → one ad group** whose ad can contain its keywords word for word
  ([ad-copy](ad-copy.md)). A group holds only as many keywords as its headlines can cover.
- A theme that deserves its own ad group usually deserves its **own landing page**. Without one,
  the landing page experience drops (here: furniture transport → general transport page).
- **The same keyword in two campaigns makes them bid against each other** (`check-spec` →
  `keyword-in-two-campaigns`). Keep it in one, and exclude the other campaign's core words with
  negatives.
- Low search volume keywords do not serve. Do not keep a long tail of variants alive: let the
  search terms show which ones exist, then promote them to exact ([match-types](match-types.md)).

## Where the keywords come from

1. **The business:** its services, as the website and the customers name them. Also what it
   does *not* do: that becomes the negative list before launch.
2. **`google-ads keyword-ideas --seed … --url … --geo … --language …`**: Keyword Planner ideas
   for the service area (filter by location: national numbers mislead a local business). Each
   idea shows:
   - `avgMonthlySearches`, `competition` and the top-of-page bid range;
   - `inAccount`: already a keyword, close variants count;
   - `blockedIn`: a negative of an enabled campaign would block it.

   Google: quality matters more than the number of keywords; small businesses do better with
   medium or low competition terms.
3. **The search terms** of running campaigns (`search-terms`, `ngrams`): what really got clicks.
4. **Competitors' ads** (Ads Transparency Center): which service names they use.

## Choosing

- Intent first: **service + place** and **service + price** are the buyers
  (`[moving budapest]`, `[moving prices]`). "How to", "free", "jobs", "rental" are not.
- A generic head term (`[moving]`) is expensive and vague. Keep it only with a reason, and
  watch it in the first week.
- Bid range vs the CPC cap: a keyword whose low top-of-page bid is above the campaign's CPC cap
  will hardly show.
- Every chosen keyword must fit a headline of its ad group (≤ 30 characters), or be accepted as
  description-only.

## What the CLI checks for you

| Check | Where |
|---|---|
| Keyword characters (no commas or `! @ % ^ ( ) = { } ; ~ < > ? \ |`), ≤ 10 words, ≤ 80 characters | `check-spec`, `create-campaign`, `add-keyword` |
| Close variants of each other in one campaign (accents, order, spacing) | `check-spec` → `close-variant-keywords` |
| The same keyword in two campaigns | `check-spec` → `keyword-in-two-campaigns` |
| A negative of the campaign blocks its own keyword (Google's matching, commas included) | `check-spec` (error), `suggest` → `negative-blocks-keyword` |
| Keywords not inside a headline of their ad group | `check-spec` coverage, `suggest` → `ad-keyword-coverage` |
| Idea already in the account, or blocked by a negative | `keyword-ideas` → `inAccount`, `blockedIn` |
