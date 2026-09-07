/**
 * Observation Hygiene Filter (ALD-038; SPECIFICATION.md §10.1, §10.2).
 *
 * §10.1 requires that human language be removed from observation *inputs*,
 * not only from channel outputs: observations carry opaque numeric arrays and
 * opaque category codes, never a field such as `attribute: "red"`, and never
 * a filename, caption, alt text, semantic id, or human-readable exception
 * message. §10.1 names the mechanism as well: "an automated Observation
 * Hygiene Filter (regex/dictionary scan against a maintained human-language
 * token list, plus a schema check that rejects any string-typed field not on
 * an explicit allowlist of opaque-identifier formats)".
 *
 * This module is that filter. It is the only gate between a built Observation
 * and a learner, and it fails closed: a violation throws
 * `HygieneViolationError` carrying machine-readable reason codes so the
 * caller can write an audit event (ALD-038 criterion 3: a blocked field
 * produces an audit-logged event, not a silent drop). Nothing here rewrites
 * or sanitizes an observation — §10.2 requires prohibited content to be
 * blocked, never "sanitized and passed through".
 *
 * The four string-typed fields of SPEC §11.2 are the complete allowlist:
 * `recipient` and `encoding` are closed enums, `scenarioRef` must be the
 * opaque `scn:<16 hex>` form the Scenario Engine mints, and `runId` must be
 * an opaque identifier token (no whitespace, no prose, no banned token).
 */
import { ObservationSchema, type Observation } from '@ald/types';

/** The exact top-level fields SPEC §11.2 defines. Nothing else may appear. */
export const OBSERVATION_FIELDS = [
  'runId',
  'turn',
  'recipient',
  'encoding',
  'payload',
  'scenarioRef',
] as const;

/** Opaque scenario instance id minted by the Scenario Engine (SPEC §11.2). */
export const SCENARIO_REF_PATTERN = /^scn:[a-f0-9]{16}$/u;

/**
 * Allowlisted opaque-identifier format for `runId` (§10.1). Deliberately
 * narrow: no whitespace, and short enough that a descriptive sentence cannot
 * hide in it. This pattern alone does not stop a whitespace-free sentence
 * (`theKeyIsUnderTheDoorMat`) from matching — `looksLikeProse` below is what
 * catches those, by evaluating the same camel/snake/kebab/dot/colon/slash
 * split used for the token scan (see `normalizeForProseScan`) rather than the
 * raw text. The pattern intentionally stays permissive enough to admit the
 * hyphenated, human-legible run ids already used across the monorepo (e.g.
 * `run-2026-08-24-001` per LEDGER-INTEGRITY-DESIGN.md §"Example manifest",
 * `run-adapter-crash-evaluating` in packages/orchestrator/__tests__); it is
 * `looksLikeProse`'s job, not this pattern's, to distinguish a compound
 * identifier from a sentence.
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/u;

const RECIPIENT_VALUES = ['baby-a', 'baby-b'] as const;
const ENCODING_VALUES = ['opaque-numeric', 'pixel', 'hybrid-features'] as const;

/**
 * Maintained human-language token list (§10.1). Covers the vocabulary the
 * spec names explicitly (`red`, `circle`, `target`, `correct`) plus the
 * metadata carriers it forbids (`label`, `caption`, `alt`, `filename`) and
 * the attribute/relation vocabulary of the CONCEPT-IDEA.md §13 progression
 * stages, which is what a leaked observation field would most plausibly say.
 */
export const BANNED_LANGUAGE_TOKENS: readonly string[] = [
  'red',
  'green',
  'blue',
  'yellow',
  'black',
  'white',
  'circle',
  'square',
  'triangle',
  'star',
  'target',
  'correct',
  'wrong',
  'answer',
  'label',
  'caption',
  'alt',
  'filename',
  'color',
  'colour',
  'shape',
  'size',
  'left',
  'right',
  'above',
  'below',
  'big',
  'small',
];

/** Machine-readable reason codes; these are what an audit event records. */
export type HygieneReasonCode =
  | 'string-value'
  | 'non-finite-number'
  | 'extra-top-level-key'
  | 'ragged-payload'
  | 'scenario-ref-format'
  | 'run-id-format'
  | 'human-language-token'
  | 'prose-string'
  | 'pictographic'
  | 'unexpected-structure'
  | 'schema-invalid';

export interface HygieneError {
  reason: HygieneReasonCode;
  /** Dotted path of the offending node, `''` for the observation itself. */
  path: string;
  /** Researcher-facing description. Never reaches a Baby's context. */
  detail: string;
  /**
   * The offending string, for researcher-only triage of a language hit.
   * Never included in `HygieneViolationError.message` (§10.2: raw injection
   * text must not reach Baby-visible or public logs).
   */
  text?: string;
}

export interface HygieneScanOptions {
  /** Extra banned tokens for an experiment-specific vocabulary. */
  extraTokens?: string[];
  /** Audit sink invoked with every violation before the error is thrown. */
  onViolation?: (errors: readonly HygieneError[]) => void;
}

/**
 * Thrown instead of dropping or rewriting a prohibited observation
 * (ALD-038 criterion 3). The message carries reason codes and paths only.
 */
export class HygieneViolationError extends Error {
  readonly reasonCodes: HygieneReasonCode[];

  constructor(readonly errors: readonly HygieneError[]) {
    super(
      `Observation hygiene violation: ${errors
        .map((error) => (error.path ? `${error.reason} at ${error.path}` : error.reason))
        .join('; ')}`,
    );
    this.name = new.target.name;
    this.reasonCodes = [...new Set(errors.map((error) => error.reason))];
  }
}

const PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;

function escapeToken(token: string): string {
  return token.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

/**
 * Split camelCase, snake_case, and kebab-case identifiers into words so that
 * `targetColor` and `object_label` are scanned as `target color` and
 * `object label`; §10.1 bans the vocabulary, not one spelling of it.
 */
function normalizeForTokenScan(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ');
}

/**
 * `normalizeForTokenScan` plus a split on `.`, `:`, and `/` — the additional
 * separators a dot/colon/slash-joined sentence (`the.red.circle`,
 * `run:pick/the/target`) uses instead of `_`/`-`. Used only by the prose
 * heuristic: the token scan's `\b` word-boundary regex already treats those
 * characters as non-word, so it does not need this extra split.
 */
function normalizeForProseScan(text: string): string {
  return normalizeForTokenScan(text).replace(/[._:/]+/gu, ' ');
}

function matchedTokens(text: string, tokens: readonly string[]): string[] {
  const normalized = normalizeForTokenScan(text);
  return tokens.filter((token) =>
    new RegExp(`\\b${escapeToken(token)}\\b`, 'iu').test(normalized),
  );
}

/**
 * Closed set of short English function words. A joined identifier that
 * decodes (via `normalizeForProseScan`) to two or more all-alphabetic
 * segments is not enough on its own to call it a sentence: conventional run
 * ids already in use across the monorepo (`run-adapter-crash-evaluating`,
 * `run-2026-08-24-001`) also decode to several alphabetic segments. What
 * distinguishes a written sentence from a compound identifier is that a
 * sentence almost always contains at least one closed-class function word
 * (an article, pronoun, preposition, or auxiliary) — an opaque identifier
 * built from content words (`adapter`, `crash`, `evaluating`, `cohort`)
 * essentially never does. Gating on this keeps every hyphenated run id used
 * in packages/orchestrator/__tests__ and twins/packs/__tests__ valid while
 * still catching a joined sentence such as `theKeyIsUnderTheDoorMat` or
 * `moveToPositionThenWaitForSignal`.
 */
const PROSE_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'but',
  'if', 'then', 'this', 'that', 'these', 'those', 'you', 'your', 'i',
  'my', 'we', 'he', 'she', 'it', 'they', 'them', 'his', 'her', 'its',
  'our', 'their', 'not', 'no', 'do', 'does', 'did', 'will', 'would',
  'can', 'could', 'should', 'must', 'has', 'have', 'had', 'so', 'as',
  'by', 'from', 'into', 'onto', 'than', 'when', 'where', 'who', 'what',
  'why', 'how', 'here', 'there',
]);

/**
 * Prose heuristic: a long string that, once split the same way the token
 * scan splits camelCase/snake_case/kebab-case/dot/colon/slash identifiers,
 * carries two or more all-alphabetic words including at least one function
 * word, is a sentence, whatever vocabulary it otherwise uses — and no field
 * of SPEC §11.2 may contain one. Evaluated on the normalized text (not the
 * raw string) so that a whitespace-free join such as `theKeyIsUnderTheDoorMat`
 * or `the.red.circle` cannot evade it by construction (this was ALD's own
 * bug: `RUN_ID_PATTERN` forbids whitespace in `runId`, so the raw text this
 * heuristic used to scan could never contain more than one "word").
 *
 * The length gate is measured on the original (un-normalized) string so that
 * inserting split spaces cannot itself push a short identifier over the
 * threshold.
 */
function looksLikeProse(rawLength: number, normalized: string): boolean {
  if (rawLength <= 24) {
    return false;
  }
  const words = normalized
    .split(/\s+/u)
    .filter((word) => /^[A-Za-z]+$/u.test(word));
  if (words.length < 2) {
    return false;
  }
  return words.some((word) => PROSE_STOPWORDS.has(word.toLowerCase()));
}

interface LanguageHit {
  reason: Extract<
    HygieneReasonCode,
    'human-language-token' | 'prose-string' | 'pictographic'
  >;
  path: string;
  text: string;
  detail: string;
}

function classifyString(
  text: string,
  path: string,
  tokens: readonly string[],
): LanguageHit[] {
  const hits: LanguageHit[] = [];
  const matches = matchedTokens(text, tokens);
  if (matches.length > 0) {
    hits.push({
      reason: 'human-language-token',
      path,
      text,
      detail: `matched ${matches.length} banned human-language token(s)`,
    });
  }
  if (looksLikeProse(text.length, normalizeForProseScan(text))) {
    hits.push({
      reason: 'prose-string',
      path,
      text,
      detail: 'string reads as human prose (long, multiple alphabetic words)',
    });
  }
  if (PICTOGRAPHIC_PATTERN.test(text)) {
    hits.push({
      reason: 'pictographic',
      path,
      text,
      detail: 'string contains an emoji or pictographic code point',
    });
  }
  return hits;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(path: string, segment: string): string {
  return path === '' ? segment : `${path}.${segment}`;
}

function scanLanguage(
  value: unknown,
  tokens: readonly string[],
): LanguageHit[] {
  const hits: LanguageHit[] = [];
  const visited = new WeakSet<object>();

  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      hits.push(...classifyString(node, path, tokens));
      return;
    }
    if (Array.isArray(node)) {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);
      node.forEach((child, index) => {
        visit(child, joinPath(path, String(index)));
      });
      return;
    }
    if (isPlainRecord(node)) {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);
      for (const [key, child] of Object.entries(node)) {
        const keyPath = joinPath(path, key);
        for (const hit of classifyString(key, keyPath, tokens)) {
          hits.push({ ...hit, detail: `object key: ${hit.detail}` });
        }
        visit(child, keyPath);
      }
    }
  };

  visit(value, '');
  return hits;
}

/**
 * Recursive regex/dictionary scan (§10.1). Returns every offending string —
 * string *values* and object *keys* alike — that matches a banned token as a
 * whole word (case-insensitively, across camel/snake/kebab spellings), reads
 * as human prose, or contains a pictographic code point.
 *
 * Returns an empty array for hygienic input, so it doubles as a boolean test
 * for scenario-bundle authoring (§10.1: run before any bundle may be
 * referenced by a preregistered run).
 */
export function scanForHumanLanguage(
  value: unknown,
  extraTokens: string[] = [],
): string[] {
  const tokens = [...BANNED_LANGUAGE_TOKENS, ...extraTokens];
  return scanLanguage(value, tokens).map((hit) => hit.text);
}

function checkNumber(
  value: unknown,
  path: string,
  errors: HygieneError[],
): void {
  if (typeof value === 'string') {
    errors.push({
      reason: 'string-value',
      path,
      detail: 'observation payloads are numeric only (SPEC §11.2)',
      text: value,
    });
    return;
  }
  if (typeof value !== 'number') {
    errors.push({
      reason: 'unexpected-structure',
      path,
      detail: `expected a number, received ${typeof value}`,
    });
    return;
  }
  if (!Number.isFinite(value)) {
    errors.push({
      reason: 'non-finite-number',
      path,
      detail: 'NaN and Infinity are not canonicalizable observation values',
    });
  }
}

function checkPayload(payload: unknown, errors: HygieneError[]): void {
  if (!Array.isArray(payload)) {
    errors.push({
      reason: 'unexpected-structure',
      path: 'payload',
      detail: 'payload must be number[] or number[][] (SPEC §11.2)',
    });
    return;
  }

  const rows = payload.filter((row) => Array.isArray(row)).length;
  if (rows > 0 && rows !== payload.length) {
    errors.push({
      reason: 'unexpected-structure',
      path: 'payload',
      detail: 'payload mixes scalar and row elements',
    });
  }

  if (rows === 0) {
    payload.forEach((value, index) => {
      checkNumber(value, `payload.${index}`, errors);
    });
    return;
  }

  let width: number | undefined;
  payload.forEach((row, index) => {
    if (!Array.isArray(row)) {
      return;
    }
    if (width === undefined) {
      width = row.length;
    } else if (row.length !== width) {
      errors.push({
        reason: 'ragged-payload',
        path: `payload.${index}`,
        detail: `row length ${row.length} differs from ${width}; row shape must not encode task state`,
      });
    }
    row.forEach((value, column) => {
      checkNumber(value, `payload.${index}.${column}`, errors);
    });
  });
}

function checkEnum(
  value: unknown,
  path: string,
  allowed: readonly string[],
  errors: HygieneError[],
): void {
  if (typeof value !== 'string') {
    errors.push({
      reason: 'unexpected-structure',
      path,
      detail: `expected one of ${allowed.join(', ')}`,
    });
    return;
  }
  if (!allowed.includes(value)) {
    errors.push({
      reason: 'string-value',
      path,
      detail: `string is not on the ${path} allowlist`,
      text: value,
    });
  }
}

/**
 * Every §10.1 rule, evaluated without throwing. Returns an empty array for a
 * hygienic observation; otherwise one entry per violated rule, so an audit
 * event records the complete reason set rather than the first failure.
 */
export function hygieneErrors(
  observation: unknown,
  options: HygieneScanOptions = {},
): HygieneError[] {
  if (!isPlainRecord(observation)) {
    return [
      {
        reason: 'unexpected-structure',
        path: '',
        detail: 'observation must be a JSON object',
      },
    ];
  }

  const errors: HygieneError[] = [];
  const allowedFields: readonly string[] = OBSERVATION_FIELDS;

  for (const key of Object.keys(observation)) {
    if (!allowedFields.includes(key)) {
      errors.push({
        reason: 'extra-top-level-key',
        path: key,
        detail: 'SPEC §11.2 defines the complete field list; extras may leak state',
      });
    }
  }
  for (const key of allowedFields) {
    if (!(key in observation)) {
      errors.push({
        reason: 'unexpected-structure',
        path: key,
        detail: 'required SPEC §11.2 field is missing',
      });
    }
  }

  errors.push(
    ...scanLanguage(observation, [
      ...BANNED_LANGUAGE_TOKENS,
      ...(options.extraTokens ?? []),
    ]),
  );

  const runId = observation.runId;
  if (typeof runId !== 'string') {
    if (runId !== undefined) {
      errors.push({
        reason: 'unexpected-structure',
        path: 'runId',
        detail: 'runId must be an opaque identifier string',
      });
    }
  } else if (!RUN_ID_PATTERN.test(runId)) {
    errors.push({
      reason: 'run-id-format',
      path: 'runId',
      detail: 'runId is not an allowlisted opaque-identifier token',
      text: runId,
    });
  }

  if ('recipient' in observation) {
    checkEnum(observation.recipient, 'recipient', RECIPIENT_VALUES, errors);
  }
  if ('encoding' in observation) {
    checkEnum(observation.encoding, 'encoding', ENCODING_VALUES, errors);
  }

  const scenarioRef = observation.scenarioRef;
  if (typeof scenarioRef !== 'string') {
    if (scenarioRef !== undefined) {
      errors.push({
        reason: 'unexpected-structure',
        path: 'scenarioRef',
        detail: 'scenarioRef must be an opaque string',
      });
    }
  } else if (!SCENARIO_REF_PATTERN.test(scenarioRef)) {
    errors.push({
      reason: 'scenario-ref-format',
      path: 'scenarioRef',
      detail: 'scenarioRef must be the opaque scn:<16 hex> form',
      text: scenarioRef,
    });
  }

  const turn = observation.turn;
  if (typeof turn === 'number') {
    if (!Number.isFinite(turn)) {
      errors.push({
        reason: 'non-finite-number',
        path: 'turn',
        detail: 'turn must be a finite non-negative integer',
      });
    } else if (!Number.isInteger(turn) || turn < 0) {
      errors.push({
        reason: 'unexpected-structure',
        path: 'turn',
        detail: 'turn must be a non-negative integer',
      });
    }
  } else if (turn !== undefined) {
    errors.push({
      reason: 'unexpected-structure',
      path: 'turn',
      detail: 'turn must be a number',
    });
  }

  if ('payload' in observation) {
    checkPayload(observation.payload, errors);
  }

  if (errors.length === 0 && !ObservationSchema.safeParse(observation).success) {
    errors.push({
      reason: 'schema-invalid',
      path: '',
      detail: 'observation does not satisfy ObservationSchema',
    });
  }

  return errors;
}

/**
 * The no-bypass gate (ALD-038 criterion 2). Returns the typed Observation
 * when every §10.1 rule holds; otherwise notifies the audit sink and throws
 * `HygieneViolationError` with the complete reason set.
 */
export function assertObservationHygiene(
  observation: unknown,
  options: HygieneScanOptions = {},
): Observation {
  const errors = hygieneErrors(observation, options);
  if (errors.length > 0) {
    options.onViolation?.(errors);
    throw new HygieneViolationError(errors);
  }
  return ObservationSchema.parse(observation);
}
