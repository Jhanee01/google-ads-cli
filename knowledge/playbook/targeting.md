# Targeting: location, age, schedule

## Location

- **Local services: target by presence** (people in, or regularly in, the area):
  `google-ads set-location --campaign <id> --presence-only`. The default
  *presence or interest* also shows ads to people elsewhere who search *about* the area.
- Target the service area as geo targets (city, county), look them up with
  `google-ads geo-search`, and check the *user location* report for spend outside it.
- City names of other regions in search terms are a search-term issue (negatives), not a
  targeting issue.
- Removing the last targeted location means *all countries*; the CLI refuses that without `--force`.

## Age and gender

- In the account, the 25–64 age group got ~83 % of the traffic, but without valid conversion data
  this said nothing about *who becomes a customer*. **Do not exclude or adjust ages without
  valid conversions.**
- With valid data: exclude a range only when it spent meaningfully with zero conversions while
  the others converted (`google-ads ages`, then `set-age --exclude`). Never exclude *unknown*
  lightly; it is often a large share of the traffic.
- Under Smart Bidding, age bid adjustments are ignored; exclusions still apply.

## Ad schedule

- Ask the owner when they can answer the phone. If the answer is "almost always", run 24/7:
  night clicks are the price of being reachable, and cutting them loses calls.
- A schedule is worth it only for hours when nobody answers or with proven bad conversion data.
