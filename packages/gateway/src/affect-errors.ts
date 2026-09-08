/**
 * Operator-facing faults of the six-display affect protocol
 * (SPECIFICATION.md §9.3, ALD-033).
 *
 * The distinction this file draws is the same one `errors.ts` draws for the
 * channel: a *Baby* violation is never an error. Every malformed, repeated,
 * combined, or out-of-window affect submission is committed as a
 * `channel.rejected` event with reason `affect-violation` and returned as an
 * `AffectSubmitResult` of kind `rejected` (SPEC §9.3 rule 6), carrying only a
 * reason code, a payload hash, and counters. The classes here cover the cases
 * where the *runtime or operator* asked for something the protocol may not do
 * at all — an affect call on a run that disabled the channel, a `derived`
 * mapping name that was never pre-registered, a window the Gateway never
 * opened.
 *
 * None of these messages may reach a Baby context (SPEC §10.3): they are
 * raised to the Nursery Controller, which surfaces opaque codes to adapters.
 */
import { GatewayError } from './errors.js';

/** Closed set of affect-protocol fault codes. */
export type AffectErrorCode =
  | 'affect-disabled'
  | 'affect-mode-mismatch'
  | 'unknown-derived-mapping'
  | 'invalid-window'
  | 'window-not-open'
  | 'invalid-window-schedule';

/** Base class carrying the closed {@link AffectErrorCode}. */
export class AffectProtocolError extends GatewayError {
  constructor(
    readonly affectCode: AffectErrorCode,
    code: 'INVALID_REQUEST' | 'FORBIDDEN' | 'CONFLICT',
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(code, message, { ...details, affectCode });
  }
}

/**
 * SPEC §9.3: the affect channel is disabled by default
 * (`affectMode: "none"`). A run that never enabled it has no affect surface
 * at all, so this is a configuration fault rather than a rejection.
 */
export class AffectDisabledError extends AffectProtocolError {
  constructor() {
    super(
      'affect-disabled',
      'FORBIDDEN',
      'The affect channel is disabled for this run (affectMode: "none")',
    );
  }
}

/**
 * The call does not belong to the run's `affectMode`: `recordDerivedAffect`
 * on a `declared`/`permuted`/`opaque` run, or a measurement recorded on an
 * `emergent` run (where no Affect Event is ever produced).
 */
export class AffectModeMismatchError extends AffectProtocolError {
  constructor(
    readonly affectMode: string,
    readonly expected: readonly string[],
  ) {
    super(
      'affect-mode-mismatch',
      'FORBIDDEN',
      `This call requires affectMode in [${expected.join(', ')}]; the run is ${affectMode}`,
      { affectMode, expected: [...expected] },
    );
  }
}

/**
 * SPEC §9.3 `derived`: the measurement→display mapping is *fixed and
 * pre-registered*. An unknown `affectDerivedMapping` name is refused rather
 * than defaulted, so a run cannot silently acquire a different mapping than
 * the one it registered.
 */
export class UnknownAffectDerivedMappingError extends AffectProtocolError {
  constructor(
    readonly mapping: string,
    readonly registered: readonly string[],
  ) {
    super(
      'unknown-derived-mapping',
      'INVALID_REQUEST',
      `Affect mapping "${mapping}" is not registered; pre-registered mappings: ${registered.join(', ')}`,
      { mapping, registered: [...registered] },
    );
  }
}

/** The `AffectWindow` handed to the protocol is not a well-formed §9.3 window. */
export class InvalidAffectWindowError extends AffectProtocolError {
  constructor(detail: string) {
    super('invalid-window', 'INVALID_REQUEST', `Invalid affect window: ${detail}`);
  }
}

/**
 * SPEC §9.3 rule 2: a window opens only immediately after a Gateway-defined
 * outcome event. `recordDerivedAffect` is a runtime call, so a closed or
 * unknown window is a runtime fault; the equivalent *Baby* submission is an
 * `affect-violation` rejection instead.
 */
export class AffectWindowNotOpenError extends AffectProtocolError {
  constructor(readonly windowId: string) {
    super(
      'window-not-open',
      'CONFLICT',
      `No affect window with id ${windowId} is open`,
      { windowId },
    );
  }
}

/** `RunConfig.affectWindowSchedule` is not one of the recognised fixed schedules. */
export class InvalidAffectWindowScheduleError extends AffectProtocolError {
  constructor(
    readonly schedule: string,
    readonly recognised: readonly string[],
  ) {
    super(
      'invalid-window-schedule',
      'INVALID_REQUEST',
      `affectWindowSchedule "${schedule}" is not recognised; expected ${recognised.join(', ')}`,
      { schedule, recognised: [...recognised] },
    );
  }
}
