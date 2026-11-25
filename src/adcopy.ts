/**
 * Ad copy, assets and keyword lists, checked deterministically (knowledge/playbook/ad-copy.md,
 * knowledge/playbook/keyword-planning.md). Pure functions: the same input always gives the same
 * findings, so the agent writes the text and the code checks it.
 *
 * error   = Google would refuse it, or the ad could not work (nothing is uploaded with one)
 * warning = against Google's documented recommendations or the playbook; the human decides
 */
import { stripAccents, words } from './negatives.js'

export interface AdText {
  headlines: Array<{ text: string; pin?: number }>
  descriptions: Array<{ text: string; pin?: number }>
  finalUrl?: string
  path1?: string
  path2?: string
}
export interface Issue { level: 'error' | 'warning'; code: string; message: string }

const len = (s: string) => [...s].length
export const HEADLINE_MAX = 30
export const DESCRIPTION_MAX = 90
export const PATH_MAX = 15
export const SITELINK_TEXT_MAX = 25
export const SITELINK_DESCRIPTION_MAX = 35
export const CALLOUT_MAX = 25
export const SNIPPET_VALUE_MAX = 25

/** Structured snippet headers the API accepts (shown translated to the ad's language). */
export const SNIPPET_HEADERS = [
  'Amenities', 'Brands', 'Courses', 'Degree programs', 'Destinations', 'Featured hotels', 'Insurance coverage',
  'Models', 'Neighborhoods', 'Service catalog', 'Shows', 'Styles', 'Types',
]

/** The keyword's words, in order, inside one text (case-insensitive; accents and word forms must match). */
export function containsKeyword(text: string, keyword: string): boolean {
  const k = words(keyword)
  const t = words(text)
  if (!k.length) return false
  for (let i = 0; i + k.length <= t.length; i++) if (k.every((w, j) => t[i + j] === w)) return true
  return false
}

/** Same words after removing accents, case and order: Google treats such texts as the same. */
export const sameMeaningKey = (s: string): string => words(stripAccents(s)).sort().join(' ')
/** "kis költöztetés" / "kisköltöztetés" / "koltoztetes kis": the spacing variant too. */
const compactKey = (s: string): string => words(stripAccents(s)).join('')

export interface Coverage { covered: string[]; missing: string[]; longInDescription: string[]; longMissing: string[] }

/**
 * Google's Ad Strength counts a keyword only when it is entirely inside ONE headline. A keyword
 * longer than a headline (30) can only be used in a description.
 */
export function keywordCoverage(keywords: string[], ad: AdText): Coverage {
  const out: Coverage = { covered: [], missing: [], longInDescription: [], longMissing: [] }
  const seen = new Set<string>()
  for (const raw of keywords) {
    const k = raw.trim().replace(/\s+/g, ' ')
    if (!k || seen.has(k.toLowerCase())) continue
    seen.add(k.toLowerCase())
    if (len(k) > HEADLINE_MAX) {
      (ad.descriptions.some(d => containsKeyword(d.text, k)) ? out.longInDescription : out.longMissing).push(k)
    } else {
      (ad.headlines.some(h => containsKeyword(h.text, k)) ? out.covered : out.missing).push(k)
    }
  }
  return out
}

/** One responsive search ad against Google's limits and recommendations. */
export function lintAd(ad: AdText, keywords: string[], where: string): Issue[] {
  const issues: Issue[] = []
  const err = (code: string, message: string) => issues.push({ level: 'error', code, message: `${where}: ${message}` })
  const warn = (code: string, message: string) => issues.push({ level: 'warning', code, message: `${where}: ${message}` })
  const H = ad.headlines
  const D = ad.descriptions

  // Google's limits
  if (H.length < 3 || H.length > 15) err('headline-count', `an RSA needs 3–15 headlines, got ${H.length}`)
  if (D.length < 2 || D.length > 4) err('description-count', `an RSA needs 2–4 descriptions, got ${D.length}`)
  for (const h of H) if (len(h.text) < 1 || len(h.text) > HEADLINE_MAX) err('headline-length', `headline "${h.text}" is ${len(h.text)} characters (max ${HEADLINE_MAX})`)
  for (const d of D) if (len(d.text) < 1 || len(d.text) > DESCRIPTION_MAX) err('description-length', `description is ${len(d.text)} characters (max ${DESCRIPTION_MAX}): "${d.text}"`)
  const dupes = (list: Array<{ text: string }>) => list.map(x => x.text.trim().toLowerCase()).filter((t, i, all) => all.indexOf(t) !== i)
  for (const t of dupes(H)) err('duplicate-headline', `duplicate headline "${t}"`)
  for (const t of dupes(D)) err('duplicate-description', `duplicate description "${t}"`)
  for (const h of H) if (h.pin !== undefined && ![1, 2, 3].includes(h.pin)) err('pin', `headline pin must be 1, 2 or 3 ("${h.text}")`)
  for (const d of D) if (d.pin !== undefined && ![1, 2].includes(d.pin)) err('pin', `description pin must be 1 or 2`)
  for (const p of [ad.path1, ad.path2]) if (p !== undefined && (len(p) > PATH_MAX || /\s|\//.test(p))) err('path', `display path "${p}" must be ≤${PATH_MAX} characters, no spaces or slashes`)
  if (ad.path2 && !ad.path1) err('path', 'path2 needs path1')
  if (ad.finalUrl !== undefined && !/^https:\/\/\S+$/.test(ad.finalUrl)) err('final-url', `finalUrl must be an https:// URL, got "${ad.finalUrl}"`)
  const pinnedPositions = new Set(H.filter(h => h.pin).map(h => h.pin))
  if ([1, 2, 3].every(p => pinnedPositions.has(p)) && H.some(h => !h.pin)) {
    err('all-positions-pinned', 'every headline position is pinned, so the unpinned headlines can never show')
  }

  // Recommendations (Google Ads Help: RSA best practices, Ad Strength)
  if (H.length < 10) warn('few-headlines', `${H.length} headlines: add unique ones up to 15 (Google: as many unique headlines as you can)`)
  if (D.length < 4) warn('few-descriptions', `${D.length} descriptions: use all 4`)
  const cov = keywordCoverage(keywords, ad)
  if (cov.missing.length) {
    warn('keyword-not-in-headline', `${cov.missing.length} of ${cov.missing.length + cov.covered.length} keywords are not entirely inside one headline: ` +
      `${cov.missing.slice(0, 12).map(k => `"${k}"`).join(', ')}${cov.missing.length > 12 ? '…' : ''}. Put the main ones word for word into a headline`)
  }
  if (cov.longMissing.length) warn('long-keyword-not-in-description', `keywords longer than a headline and not in a description: ${cov.longMissing.map(k => `"${k}"`).join(', ')}`)
  for (const p of pinnedPositions) {
    const n = H.filter(h => h.pin === p).length
    if (n === 1) warn('pinned-single-variant', `only one headline is pinned to position ${p}: pin 2–3 different versions there, so Google can still test`)
  }
  if (pinnedPositions.size > 1) warn('too-many-pins', `headlines are pinned to ${pinnedPositions.size} positions: pin only what must always show (usually position 1)`)
  if (D.some(d => d.pin)) warn('pinned-description', 'pinned descriptions limit the combinations; pin only legally required text')
  const byKey = new Map<string, string[]>()
  for (const h of H) byKey.set(sameMeaningKey(h.text), [...(byKey.get(sameMeaningKey(h.text)) ?? []), h.text])
  for (const same of byKey.values()) if (same.length > 1) warn('similar-headlines', `headlines differ only in order, case or accents: ${same.map(t => `"${t}"`).join(', ')}`)
  const lengths = H.map(h => len(h.text))
  if (H.length >= 5 && Math.max(...lengths) - Math.min(...lengths) < 10) warn('same-length-headlines', `headline lengths are all ${Math.min(...lengths)}–${Math.max(...lengths)} characters: mix short and long ones`)
  if (![...H, ...D].some(x => /\d/.test(x.text))) warn('no-price-or-number', 'no number anywhere (price, time, size): Google recommends a price or an offer in a headline or description')
  return issues
}

/** Two ads with the same headlines (any order) are the same ad to the auction. */
const adKey = (ad: AdText) => ad.headlines.map(h => sameMeaningKey(h.text)).sort().join('|')

/** Ads of one ad group: each ad, plus Google's "at least 2 RSAs per ad group". */
export function lintAdGroup(ads: AdText[], keywords: string[], where: string): Issue[] {
  const issues = ads.flatMap((ad, i) => lintAd(ad, keywords, ads.length > 1 ? `${where} › ad ${i + 1}` : where))
  if (ads.length === 0) issues.push({ level: 'error', code: 'no-ad', message: `${where}: no ad` })
  else if (ads.length === 1) issues.push({ level: 'warning', code: 'single-rsa', message: `${where}: one RSA; Google recommends 2 per ad group (its data: +6.6 % conversions at a similar cost per conversion)` })
  const keys = ads.map(adKey)
  if (keys.some((k, i) => keys.indexOf(k) !== i)) issues.push({ level: 'warning', code: 'duplicate-ads', message: `${where}: two ads have the same headlines` })
  return issues
}

/** The same ad in several ad groups: the groups cannot speak to their own keywords. */
export function duplicateAdsAcrossGroups(groups: Array<{ name: string; ads: AdText[] }>): Issue[] {
  const seen = new Map<string, string>()
  const issues: Issue[] = []
  for (const g of groups) {
    for (const k of new Set(g.ads.map(adKey))) {
      const other = seen.get(k)
      if (other) issues.push({ level: 'warning', code: 'duplicate-ads-across-groups', message: `"${g.name}" and "${other}" use an ad with the same headlines: write one for each group's own keywords` })
      else seen.set(k, g.name)
    }
  }
  return issues
}

export interface SitelinkText { text: string; description1?: string; description2?: string }
export interface Snippet { header: string; values: string[] }

/** Campaign assets: limits (error) and the recommended amounts (warning). */
export function lintAssets(a: { sitelinks: SitelinkText[]; callouts: string[]; snippets: Snippet[]; headlines: string[] }, where: string): Issue[] {
  const issues: Issue[] = []
  const err = (code: string, message: string) => issues.push({ level: 'error', code, message: `${where}: ${message}` })
  const warn = (code: string, message: string) => issues.push({ level: 'warning', code, message: `${where}: ${message}` })
  for (const s of a.sitelinks) {
    if (len(s.text) < 1 || len(s.text) > SITELINK_TEXT_MAX) err('sitelink-length', `sitelink "${s.text}" must be 1–${SITELINK_TEXT_MAX} characters`)
    for (const d of [s.description1, s.description2]) if (d !== undefined && len(d) > SITELINK_DESCRIPTION_MAX) err('sitelink-description-length', `sitelink description "${d}" is over ${SITELINK_DESCRIPTION_MAX} characters`)
    if ((s.description1 === undefined) !== (s.description2 === undefined)) err('sitelink-description', `sitelink "${s.text}" needs both description lines or neither`)
  }
  for (const c of a.callouts) if (len(c) < 1 || len(c) > CALLOUT_MAX) err('callout-length', `callout "${c}" must be 1–${CALLOUT_MAX} characters`)
  for (const s of a.snippets) {
    if (!SNIPPET_HEADERS.includes(s.header)) err('snippet-header', `structured snippet header "${s.header}" is not one of: ${SNIPPET_HEADERS.join(', ')}`)
    if (s.values.length < 3 || s.values.length > 10) err('snippet-values', `structured snippet "${s.header}" needs 3–10 values, got ${s.values.length}`)
    for (const v of s.values) if (len(v) < 1 || len(v) > SNIPPET_VALUE_MAX) err('snippet-value-length', `snippet value "${v}" must be 1–${SNIPPET_VALUE_MAX} characters`)
  }

  if (a.sitelinks.length < 6) warn('few-sitelinks', `${a.sitelinks.length} sitelinks: Google recommends at least 6 (its data: up to +3.5 % conversions); at least 2 are needed to show`)
  const noDesc = a.sitelinks.filter(s => !s.description1)
  if (noDesc.length) warn('sitelink-without-description', `${noDesc.length} sitelink(s) without descriptions (${noDesc.map(s => `"${s.text}"`).join(', ')}): without them the larger format cannot show`)
  const sl = new Map<string, string[]>()
  for (const s of a.sitelinks) sl.set(sameMeaningKey(s.text), [...(sl.get(sameMeaningKey(s.text)) ?? []), s.text])
  for (const same of sl.values()) if (same.length > 1) warn('similar-sitelinks', `similar sitelinks do not show together: ${same.map(t => `"${t}"`).join(', ')}`)
  if (a.callouts.length < 4) warn('few-callouts', `${a.callouts.length} callouts: add at least 4 short, concrete benefits`)
  const hl = new Set(a.headlines.map(sameMeaningKey))
  for (const c of a.callouts) if (hl.has(sameMeaningKey(c))) warn('callout-repeats-headline', `callout "${c}" repeats a headline word for word: use it for another benefit`)
  if (!a.snippets.length) warn('no-structured-snippet', 'no structured snippet: list the services (header "Service catalog", 3–10 values)')
  return issues
}

/**
 * Keywords that Google treats as the same search (accents, order, spacing): within one campaign
 * they are redundant, across campaigns they bid against each other.
 */
export function lintKeywords(campaigns: Array<{ name: string; adGroups: Array<{ name: string; keywords: string[] }> }>): Issue[] {
  const issues: Issue[] = []
  const all: Array<{ key: string; compact: string; text: string; campaign: string; adGroup: string }> = []
  for (const c of campaigns) for (const g of c.adGroups) for (const k of g.keywords) {
    const text = k.trim().replace(/\s+/g, ' ')
    if (text) all.push({ key: sameMeaningKey(text), compact: compactKey(text), text, campaign: c.name, adGroup: g.name })
  }
  const groups = new Map<string, typeof all>()
  for (const k of all) {
    const id = [...groups.keys()].find(g => groups.get(g)!.some(o => o.key === k.key || o.compact === k.compact)) ?? k.key
    groups.set(id, [...(groups.get(id) ?? []), k])
  }
  for (const list of groups.values()) {
    const texts = [...new Set(list.map(k => k.text.toLowerCase()))]
    const places = [...new Set(list.map(k => `${k.campaign} › ${k.adGroup}`))]
    const campaignsOf = new Set(list.map(k => k.campaign))
    if (campaignsOf.size > 1) {
      issues.push({ level: 'warning', code: 'keyword-in-two-campaigns', message: `${texts.map(t => `"${t}"`).join(' / ')} is a keyword in ${places.join(' and ')}: the campaigns bid against each other; keep it in one and exclude it in the other` })
    } else if (texts.length > 1) {
      issues.push({ level: 'warning', code: 'close-variant-keywords', message: `${texts.map(t => `"${t}"`).join(', ')} (${places.join(', ')}) are close variants of each other: Google matches one to the other's searches anyway, keep one` })
    } else if (list.length > 1) {
      issues.push({ level: 'warning', code: 'duplicate-keyword', message: `"${texts[0]}" is in ${places.join(' and ')} more than once` })
    }
  }
  return issues
}
