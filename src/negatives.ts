/**
 * Negative keywords, deterministically: how Google matches a negative against a search, which
 * negatives miss their unaccented twin, which negatives block the account's own keywords, and
 * n-grams of the search terms. Pure functions, no network (knowledge/playbook/negatives.md).
 *
 * Google's rules this follows (support.google.com/google-ads/answer/2453972):
 *  - negatives do NOT match close variants: no plural, synonym or stem expansion;
 *  - an accented and an unaccented negative are two different negatives (café ≠ cafe);
 *  - case does not matter; commas and other punctuation separate words;
 *  - BROAD: all words in any order · PHRASE: the words in this order, more words around them
 *    allowed · EXACT: exactly these words, nothing else;
 *  - only the first 16 words of a search are checked.
 * Not modelled: the misspellings Google itself corrects. Treat this as the strict reading.
 */
import { CliError } from './config.js'
import type { MatchType } from './builders.js'

export interface NegativeKeyword { text: string; match: string }

/** lowercase words; accents kept (they matter for negatives); punctuation splits words */
export function words(text: string): string[] {
  return text.toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}&]+/u).filter(Boolean)
}

/** "Költöztetés" → "koltoztetes": lowercase, accents removed */
export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

const inOrder = (needle: string[], hay: string[]): boolean => {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((w, j) => hay[i + j] === w)) return true
  }
  return false
}

/** Would this negative keep the ad away from this search? */
export function negativeBlocks(neg: NegativeKeyword, search: string): boolean {
  const n = words(neg.text)
  const q = words(search).slice(0, 16)
  if (!n.length || !q.length) return false
  const match = (neg.match || 'BROAD').toUpperCase()
  if (match === 'EXACT') return n.length === q.length && n.every((w, i) => w === q[i])
  if (match === 'PHRASE') return inOrder(n, q)
  const set = new Set(q)
  return n.every(w => set.has(w))
}

/**
 * Does negative `a` already block every search that `b` would block? Then `b` is redundant.
 * BROAD a: its words ⊆ b's words · PHRASE a: its words in order inside b (b PHRASE or EXACT)
 * · EXACT a: the same words, b EXACT.
 */
export function subsumes(a: NegativeKeyword, b: NegativeKeyword): boolean {
  const aw = words(a.text)
  const bw = words(b.text)
  if (!aw.length || !bw.length) return false
  const am = (a.match || 'BROAD').toUpperCase()
  const bm = (b.match || 'BROAD').toUpperCase()
  if (am === 'BROAD') { const s = new Set(bw); return aw.every(w => s.has(w)) }
  if (am === 'PHRASE') return bm !== 'BROAD' && inOrder(aw, bw)
  return bm === 'EXACT' && aw.length === bw.length && aw.every((w, i) => w === bw[i])
}

/** Characters Google refuses in a keyword (a comma is a word break, so it is refused here too). */
const INVALID = /[,!@%^()={};~`<>?\\|]/
const MAX_WORDS = 10
const MAX_CHARS = 80

/** Throws with every problem at once, before any API call. */
export function checkKeywordTexts(terms: string[], what = 'keyword'): void {
  const problems: string[] = []
  for (const t of terms) {
    const bad = t.match(INVALID)
    if (bad) problems.push(`"${t}": "${bad[0]}" is not allowed in a ${what}${bad[0] === ',' ? ' (Google reads a comma as a word break: "1,5 ton" would become "1 5 ton")' : ''}`)
    if (words(t).length > MAX_WORDS) problems.push(`"${t}": more than ${MAX_WORDS} words`)
    if ([...t].length > MAX_CHARS) problems.push(`"${t}": longer than ${MAX_CHARS} characters`)
  }
  if (problems.length) throw new CliError(problems.join('; '))
}

/**
 * The terms plus the unaccented form of every accented one, in input order, without duplicates
 * (case-insensitive). "állás, munka" → ["állás", "allas", "munka"].
 */
export function withAccentVariants(terms: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (t: string) => { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t) } }
  for (const raw of terms) {
    const t = raw.trim().replace(/\s+/g, ' ')
    if (!t) continue
    add(t)
    const plain = stripAccents(t)
    if (plain !== t.toLowerCase()) add(plain)
  }
  return out
}

export interface MissingVariant { text: string; match: string; variant: string }

/**
 * Accented negatives whose unaccented form is neither present nor covered by another negative
 * in the same set (a campaign's or a shared list's negatives).
 */
export function missingAccentVariants(negatives: NegativeKeyword[]): MissingVariant[] {
  const out: MissingVariant[] = []
  const seen = new Set<string>()
  for (const n of negatives) {
    const variant = stripAccents(n.text)
    if (variant === n.text.toLowerCase()) continue
    const v = { text: variant, match: n.match }
    if (negatives.some(e => subsumes(e, v))) continue
    const key = `${variant}|${n.match}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ text: n.text, match: n.match, variant })
  }
  // A twin another (broader) missing twin will cover is not needed: "allas" BROAD covers "sofor allas" PHRASE.
  return out.filter(m => !out.some(o => o !== m && subsumes({ text: o.variant, match: o.match }, { text: m.variant, match: m.match }) &&
    !subsumes({ text: m.variant, match: m.match }, { text: o.variant, match: o.match })))
}

export interface ScopedNegative extends NegativeKeyword {
  level: 'campaign' | 'adGroup' | 'list'
  campaignId?: string
  adGroupId?: string
  listId?: string
  listName?: string
}
export interface PositiveKeyword { text: string; match: string; status: string; campaignId: string; adGroupId: string; adGroup?: string }
export interface Conflict { keyword: PositiveKeyword; negative: ScopedNegative }

/**
 * Enabled keywords that a negative in their own campaign, ad group or an attached shared list
 * blocks: the keyword's own text, searched as is, would not show the ad.
 * `lists` maps a shared list ID to the campaign IDs it is attached to.
 */
export function keywordConflicts(keywords: PositiveKeyword[], negatives: ScopedNegative[], lists: Record<string, string[]> = {}): Conflict[] {
  const applies = (n: ScopedNegative, k: PositiveKeyword) =>
    n.level === 'campaign' ? n.campaignId === k.campaignId
      : n.level === 'adGroup' ? n.adGroupId === k.adGroupId
        : (lists[n.listId ?? ''] ?? []).includes(k.campaignId)
  const out: Conflict[] = []
  for (const k of keywords) {
    if (k.status !== 'ENABLED') continue
    for (const n of negatives) {
      if (applies(n, k) && negativeBlocks(n, k.text)) out.push({ keyword: k, negative: n })
    }
  }
  return out
}

export interface TermStat { term: string; cost: number; clicks: number; impressions: number; conversions: number; campaignId?: string }
export interface NGram {
  ngram: string; n: number; terms: number; cost: number; clicks: number; impressions: number; conversions: number; examples: string[]
  /** campaigns whose search terms contain it */
  campaignIds: string[]
}

/**
 * 1-, 2- and 3-word pieces of the search terms with the summed metrics of every term that
 * contains them (a piece counts once per term). Sorted by cost, then clicks.
 */
export function ngrams(terms: TermStat[], sizes: number[] = [1, 2, 3]): NGram[] {
  const acc = new Map<string, NGram>()
  for (const t of terms) {
    const w = words(t.term)
    const pieces = new Set<string>()
    for (const n of sizes) for (let i = 0; i + n <= w.length; i++) pieces.add(w.slice(i, i + n).join(' '))
    for (const p of pieces) {
      const g = acc.get(p) ?? { ngram: p, n: p.split(' ').length, terms: 0, cost: 0, clicks: 0, impressions: 0, conversions: 0, examples: [], campaignIds: [] }
      g.terms++
      g.cost += t.cost; g.clicks += t.clicks; g.impressions += t.impressions; g.conversions += t.conversions
      if (g.examples.length < 3 && !g.examples.includes(t.term)) g.examples.push(t.term)
      if (t.campaignId && !g.campaignIds.includes(t.campaignId)) g.campaignIds.push(t.campaignId)
      acc.set(p, g)
    }
  }
  const r2 = (v: number) => Math.round(v * 100) / 100
  return [...acc.values()]
    .map(g => ({ ...g, cost: r2(g.cost), conversions: r2(g.conversions) }))
    .sort((a, b) => b.cost - a.cost || b.clicks - a.clicks || a.ngram.localeCompare(b.ngram))
}

export const isMatch = (m: string): m is MatchType => m === 'EXACT' || m === 'PHRASE' || m === 'BROAD'
