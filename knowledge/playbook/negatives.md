# Negative keywords

> Rule for the agent: compare every new search term report with the account's
> `what-we-dont-offer` list and propose the matches as negatives.

## What happened

The business offers waste removal **in bags**, not in skips/containers. Before the negative list
was complete, about **16 % of the first five weeks' spend** went to container searches. A single
one-word broad negative (the word for "container", plus its spelling without accents) later
covered all the variants, including competitor names combined with it.

## Build the list before launch, by category

| Category | Examples (translate to the account's language) |
|---|---|
| A variant of the service you don't offer | the wrong format, size, material; *container*, *skip hire* |
| Sizes and units of that variant | *m3*, *cubic metre*, *kg*, *how many kg* |
| Do-it-yourself intent | *drop off*, *dump*, *recycling centre*, *where to take*, *opening hours* |
| No paying intent | *free*, *free of charge*, *DIY* |
| Competitor brands | the names that show up in the search terms |
| Other services nobody asked you for | services that share a word with yours |
| Jobs | *job*, *salary*, *hiring* |

## Rules

1. **One broad negative word catches the variants**; use exact negatives only for single
   phrases you must block without blocking the word.
2. **Write accent-free and common misspellings too** (users type them).
3. **A search term that spent money and is clearly irrelevant → negative.** One that is relevant
   but did not convert is *not* a negative (and with broken tracking, "did not convert" means
   nothing; see [measurement](measurement.md)).
4. Put the words that are always negative for the account into `google-ads.rules.json`
   (`alwaysNegative`) so `suggest` flags them in every report.
