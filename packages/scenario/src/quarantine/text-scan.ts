/**
 * Evasion-resistant string scanning for the scenario-bundle quarantine
 * (ALD-039, ALD-068; SPECIFICATION.md §10.1, §10.2).
 *
 * §10.1 names the mechanism as a "regex/dictionary scan against a maintained
 * human-language token list"; `hygiene.ts` implements exactly that and stays
 * the single source of the token list. But ALD-068 pre-registers *alternate
 * encodings* as an attack category — homoglyph substitution, zero-width
 * insertion, base64/hex wrapping — and a raw dictionary scan of
 * `"cmVkIGNpcmNsZQ=="` or `"rеd circlе"` (Cyrillic `е`) finds nothing. This
 * module is the normalization layer in front of the §10.1 scan: it folds a
 * string into the forms an adversary is hiding behind and reports which
 * transformation exposed the hit.
 *
 * The scan is deliberately one-way. It returns reason codes and character
 * counts and NEVER returns the offending text, because ALD-039 criterion 3
 * forbids exposing raw injection text in Baby-visible or public logs and
 * §10.2 forbids sanitizing prohibited content and passing it through: a hit
 * quarantines the bundle, it does not rewrite it.
 */
import { scanForHumanLanguage } from '../hygiene.js';
import type { QuarantineReasonCode } from './errors.js';

/** Invisible formatting characters used to break up a banned token. */
const ZERO_WIDTH_PATTERN =
  /[­᠎​-‏‪-‮⁠-⁤﻿]/gu;

/**
 * Confusable code points that fold to Latin letters. Not the full Unicode
 * confusables table (that is a data file, and this package carries no data
 * dependencies) — the Cyrillic and Greek letters that are visually identical
 * to a Latin letter in a rendered caption, which is what the ALD-068
 * homoglyph fixtures use. NFKC (applied first) already covers fullwidth,
 * mathematical-alphanumeric, and circled variants.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic lower case
  'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm',
  'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't',
  'у': 'y', 'х': 'x', 'і': 'i', 'ѕ': 's', 'ј': 'j',
  'һ': 'h', 'ґ': 'r',
  // Cyrillic upper case
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M',
  'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T',
  'У': 'Y', 'Х': 'X', 'І': 'I', 'Ѕ': 'S', 'Ј': 'J',
  // Greek
  'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v',
  'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
  'γ': 'y', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Η': 'H',
  'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O',
  'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  // Armenian / Cherokee lookalikes seen in confusable corpora
  'օ': 'o', 'Ꭰ': 'D', 'Ꮮ': 'L', 'Ꭱ': 'R',
};

/** Fold NFKC-normalized text through the confusable table. */
export function foldConfusables(text: string): string {
  const normalized = text.normalize('NFKC');
  let folded = '';
  for (const character of normalized) {
    folded += CONFUSABLES[character] ?? character;
  }
  return folded;
}

/** Strip zero-width/invisible characters without reporting the result. */
export function stripInvisible(text: string): string {
  return text.replace(ZERO_WIDTH_PATTERN, '');
}

export function countInvisible(text: string): number {
  return text.match(ZERO_WIDTH_PATTERN)?.length ?? 0;
}

const BASE64_PATTERN = /[A-Za-z0-9+/]{8,}={0,2}/gu;
const HEX_PATTERN = /(?:[0-9a-fA-F]{2}){6,}/gu;

function printableRatio(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let printable = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) {
      printable += 1;
    }
  }
  return printable / text.length;
}

/**
 * Candidate plaintexts hidden inside `text` by a reversible encoding. Only
 * decodings that come back as mostly-printable ASCII are considered, so a
 * hash or an opaque id does not produce a spurious candidate.
 */
export function encodedCandidates(text: string): string[] {
  const candidates: string[] = [];
  const push = (decoded: string): void => {
    if (decoded.length >= 4 && printableRatio(decoded) >= 0.9) {
      candidates.push(decoded);
    }
  };
  for (const match of text.matchAll(BASE64_PATTERN)) {
    const token = match[0];
    if (token.replace(/=+$/u, '').length % 4 === 1) {
      continue;
    }
    try {
      push(Buffer.from(token, 'base64').toString('utf8'));
    } catch {
      // A candidate that does not decode is simply not a candidate.
    }
  }
  for (const match of text.matchAll(HEX_PATTERN)) {
    const token = match[0];
    if (token.length % 2 !== 0) {
      continue;
    }
    push(Buffer.from(token, 'hex').toString('utf8'));
  }
  return candidates;
}

/** One reason a scanned string is prohibited. Carries no offending text. */
export interface StringFinding {
  reason: QuarantineReasonCode;
  /** How many banned tokens/characters fired, for triage without content. */
  hits: number;
}

/**
 * Scan one authored string (a filename, a caption, a metadata key or value, a
 * PNG text chunk) for human language, including the ALD-068 evasion forms.
 *
 * The §10.1 dictionary/prose/pictographic scan runs on the raw string, on the
 * invisible-stripped string, on the confusable-folded string, and on every
 * reversible-encoding candidate. `hits` counts matched strings; the matched
 * text itself is discarded here and never returned.
 */
export function scanBundleString(text: string, extraTokens: string[] = []): StringFinding[] {
  const findings: StringFinding[] = [];
  const invisible = countInvisible(text);
  if (invisible > 0) {
    findings.push({ reason: 'zero-width-character', hits: invisible });
  }
  const pictographic = text.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
  if (pictographic > 0) {
    findings.push({ reason: 'pictographic', hits: pictographic });
  }

  const stripped = stripInvisible(text);
  const direct = scanForHumanLanguage(stripped, extraTokens);
  if (direct.length > 0) {
    // `scanForHumanLanguage` returns the offending strings; only the count is
    // kept, so no raw injection text can escape this function (§10.2).
    findings.push({ reason: 'human-language-token', hits: direct.length });
  }

  const folded = foldConfusables(stripped);
  if (folded !== stripped) {
    const foldedHits = scanForHumanLanguage(folded, extraTokens);
    if (foldedHits.length > direct.length) {
      findings.push({ reason: 'homoglyph-language', hits: foldedHits.length });
    }
  }

  let encodedHits = 0;
  for (const candidate of encodedCandidates(stripped)) {
    encodedHits += scanForHumanLanguage(foldConfusables(candidate), extraTokens).length;
  }
  if (encodedHits > 0) {
    findings.push({ reason: 'encoded-language', hits: encodedHits });
  }

  return findings;
}
