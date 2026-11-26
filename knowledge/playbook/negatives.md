# Negative keywords: planning and upkeep

> Rule for the agent: build the negative list **before launch**, by category, from the account's
> `what-we-dont-offer` page; afterwards compare every search term report and every `ngrams`
> run with it. Everything that can be checked mechanically, the CLI checks: matching,
> accent twins, conflicts with the account's own keywords, redundancy, invalid characters.
> Your job is the judgement: is a word really never wanted for this business?

## What happened

The business offers waste removal **in bags**, not in skips/containers. Before the negative list
was complete, about **16 % of the first five weeks' spend** went to container searches. A single
one-word broad negative (the word for "container", plus its spelling without accents) later
covered all the variants, including competitor names combined with it.

Later, a phrase negative for "5 tonne" vans (to keep out heavy trucks) would also have blocked the
business's own "1.5 tonne van" searches: Google reads the comma in "1,5" as a word break.

## How Google matches a negative (the CLI does exactly this: `src/negatives.ts`)

Source: Google Ads Help, *About negative keywords*.

| Negative | Blocks the search when | Negative `running shoes` |
|---|---|---|
| BROAD (default) | it contains **all** the words, in any order | blocks "blue running shoes", "shoes running"; not "running shoe" |
| PHRASE | it contains the words **in this order**, more words around them allowed | blocks "blue running shoes"; not "shoes running" |
| EXACT | it is **exactly** these words | blocks "running shoes" only |

- **No close variants.** Unlike positive keywords, a negative does not expand to plurals,
  suffixed forms, synonyms or reordered meanings. Add them yourself.
- **An accented and an unaccented negative are two different negatives** (*café* ≠ *cafe*).
  In languages with accents, people often search without them: add both
  (`add-negative --with-accent-variants`).
- Case does not matter. Google also handles the misspellings it corrects in its own results;
  older help pages said otherwise, so add the frequent misspellings anyway.
- **Invalid characters:** `, ! @ % ^ ( ) = { } ; ~ < > ? \ |` are refused, and a comma is a
  word break. Use EXACT for a negative that contains a number like "5 tonne", so it does not hit
  "1,5 tonne". The CLI refuses these terms before calling the API.
- Only the first 16 words of a search are checked.
- Negatives from the search terms report are added as EXACT by default; change them to BROAD
  when the *word* is the problem.

## Levels and limits

| Level | Use it for |
|---|---|
| **Shared negative keyword list** (`create-negative-list`, `attach-negative-list`) | words that are wrong for **every** campaign: jobs, free, rental, what the business never offers. One place to edit; campaigns cannot drift apart. A list blocks nothing until it is attached. |
| **Campaign** (`add-negative --campaign`) | what is wrong for this campaign only, and the **cross-campaign negatives**: campaign A excludes campaign B's core words so the two do not bid against each other. |
| **Ad group** | rarely: steering a search to the right ad group inside one campaign. |

Limits: 20 shared lists per account, 5,000 keywords per list, 10,000 negatives per campaign.
Too many negatives also narrow the reach (Google's own warning): exclude what you are *sure* of.

## Before launch: the list by category

| Category | Examples (translate to the account's language) |
|---|---|
| A variant of the service you don't offer | the wrong format, size, material; *container*, *skip hire* |
| Sizes and units of that variant | *m3*, *cubic metre*, *kg*, *how many kg* |
| Do-it-yourself intent | *drop off*, *dump*, *recycling centre*, *where to take*, *opening hours* |
| No paying intent | *free*, *free of charge*, *DIY* |
| Rental instead of service | *rent*, *hire a van*, *trailer* |
| Jobs | *job*, *salary*, *driver*, *hiring*, *student job* |
| Others who share a word | courier, post, taxi, towing, animal transport |
| Area you don't serve | *international*, *abroad*, other countries and regions |
| Competitor brands | the names that show up in the search terms |
| **The other campaigns' core words** | moving ↔ transport ↔ waste removal |

For each word: the plural or common suffixed forms, and the unaccented twin.

## While running: from the search terms

1. `google-ads suggest`: `always-negative` (words from `alwaysNegative` still getting through),
   `wasted-search-terms` (spent ≥ the waste threshold, no conversion, *trusted tracking only*),
   `negative-missing-accent-variant`, `negative-blocks-keyword`.
2. `google-ads ngrams --days 60`: the search terms split into 1–3 word pieces, by cost. Look for
   **one word** that makes many terms irrelevant. A small account needs 30–60 days of data;
   with less, rare words show no pattern. Pieces an existing negative already blocks are hidden
   (`--show-covered` shows them).
3. **Relevant but not converting is not a negative.** It needs time, a better ad or a better
   page. With unverified tracking, "did not convert" means nothing
   (see [measurement](measurement.md)).
4. Put the words that are always negative for the account into `google-ads.rules.json`
   (`alwaysNegative`) so `suggest` flags them in every report.

## What the CLI checks for you

| Check | Where |
|---|---|
| A term already present, or covered by a broader negative (also from an attached list) | `add-negative` skips it with a warning |
| The unaccented twin is missing | `suggest` → `negative-missing-accent-variant` (with the plan command); `--with-accent-variants` adds it |
| A negative blocks a service the business does offer | check `search-terms`, then `remove-negative --campaign … --terms …` (`suggest` → `negative-blocks-keyword` gives the command when it blocks a keyword) |
| A negative blocks an enabled keyword of its own campaign (campaign, ad group or attached list) | `suggest` → `negative-blocks-keyword` |
| A comma or another refused character, more than 10 words, more than 80 characters | every negative command, before the API |
| Searches a piece of text appears in, and whether a negative already covers it | `ngrams` |
