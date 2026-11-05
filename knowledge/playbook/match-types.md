# Match types on a small budget

> Rule for the agent: **new keywords are EXACT by default.** Broad or phrase only with a reason
> and the human's approval, and only while the search term report shows they bring relevant traffic.

## What happened

With a budget of about ten clicks a day, phrase and broad keywords took **~80 % of the spend**.
The exact keywords had the best CTR (15–20 %) and the lowest cost. After a restart, broad
keywords had crept back in and again took most of the money, largely on searches by people who
wanted to bring the waste to a dump themselves.

Fix that worked: pause the four most expensive broad keywords, add the exact versions of the
relevant search terms (skipping the exact keywords that already existed), and add the do-it-
yourself intent as negatives (see [negatives](negatives.md)) in the same approved package.

The account also had the keywordless option (AI Max) enabled: zero spend, zero results.

## Rules

1. **Exact + place + intent** is the pattern that works for local services:
   `[service city]`, `[service price]`, `[service price city]`.
2. **Promote search terms, don't widen keywords.** A relevant search term that got clicks
   (and conversions, once tracking works) becomes an exact keyword:
   `google-ads add-keyword --ad-group <id> --terms "…" --match EXACT`.
3. **A broad or phrase keyword that spends a lot without conversions is paused**, its useful
   search terms are added as exact:
   `google-ads pause-keyword --criterion <adGroupId~criterionId>`.
4. **Long-tail, specific intent beats short generic head terms**, which are expensive and vague.
5. **Separate services get separate campaigns** (separate budgets), so one cannot starve the other.
6. Don't expect anything from keywordless / broad "learning" at this budget.
