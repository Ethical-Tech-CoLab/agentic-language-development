/**
 * Affect-window construction and the fixed window schedule
 * (SPECIFICATION.md §9.3 rules 2 and 5, §18 `affectWindowSchedule`; ALD-033).
 *
 * > An affect window opens only immediately after a Gateway-defined
 * > action/outcome event, never at a Baby-chosen arbitrary point. Window
 * > frequency (`affectWindowSchedule`) is fixed before the run. — SPEC §9.3
 * > rule 2
 *
 * Two consequences are encoded here:
 *
 * - the schedule is a pure function of the turn index and the pre-registered
 *   schedule string, so no Baby action can create, delay, or repeat a window
 *   (an unrecognised schedule is refused rather than defaulted, which is what
 *   keeps "fixed before the run" checkable);
 * - a window names exactly one permitted `sender`, which is how rule 5 ("the
 *   receiving Baby cannot reply through the affect channel until the next
 *   Gateway-defined window") is enforced: the recipient of a window has no
 *   submission right in it at all.
 *
 * Window ids are deterministic (`w-<turn>-<sender>`) so a replay from the same
 * configuration reconstructs the same window identities (SPEC §14.3).
 */
import type { AffectWindow, BabyRole, RunConfig } from '@ald/types';

import {
  InvalidAffectWindowError,
  InvalidAffectWindowScheduleError,
} from './affect-errors.js';

/** SPEC §9.3 rule 2: the only window trigger in v1 is the outcome event. */
export const AFFECT_WINDOW_TRIGGER = 'outcome' as const;

/**
 * Recognised `affectWindowSchedule` values.
 *
 * `every-turn` and `every-<n>-turns` are the fixed low-frequency schedules
 * E20 registers; `never` is the explicit "enabled mode, no windows" schedule
 * used by control conditions that keep `affectMode` set for configuration
 * symmetry while opening no windows at all.
 */
export const RECOGNISED_AFFECT_WINDOW_SCHEDULES: readonly string[] = [
  'never',
  'every-turn',
  'every-<n>-turns',
];

export interface AffectWindowSchedule {
  /** The literal configuration string this schedule was parsed from. */
  readonly schedule: string;
  /** Turn period; `undefined` when no window ever opens. */
  readonly everyTurns: number | undefined;
}

const EVERY_N_TURNS = /^every-([1-9][0-9]{0,3})-turns$/u;

/**
 * Parses `RunConfig.affectWindowSchedule`. Unknown schedules raise
 * {@link InvalidAffectWindowScheduleError}: a run may not fall back to a
 * different window frequency than the one it pre-registered.
 */
export function parseAffectWindowSchedule(
  schedule: string,
): AffectWindowSchedule {
  if (schedule === 'never') {
    return { schedule, everyTurns: undefined };
  }
  if (schedule === 'every-turn') {
    return { schedule, everyTurns: 1 };
  }
  const match = EVERY_N_TURNS.exec(schedule);
  if (match) {
    return { schedule, everyTurns: Number(match[1]) };
  }
  throw new InvalidAffectWindowScheduleError(
    schedule,
    RECOGNISED_AFFECT_WINDOW_SCHEDULES,
  );
}

/** True when the fixed schedule opens a window after turn `turn`'s outcome. */
export function affectWindowDue(
  schedule: AffectWindowSchedule,
  turn: number,
): boolean {
  if (!Number.isInteger(turn) || turn < 0) {
    throw new InvalidAffectWindowError('turn must be a non-negative integer');
  }
  const period = schedule.everyTurns;
  if (period === undefined || turn === 0) {
    return false;
  }
  return turn % period === 0;
}

/** SPEC §9.3: deterministic window identity, `w-<turn>-<sender>`. */
export function affectWindowId(turn: number, sender: BabyRole): string {
  return `w-${turn}-${sender}`;
}

/**
 * The window that opens after turn `turn`'s outcome, or `undefined` when the
 * fixed schedule opens none. The Baby that acted on the turn is the single
 * permitted sender; the other Baby may not answer until its own next window
 * (SPEC §9.3 rule 5).
 */
export function affectWindowFor(options: {
  schedule: AffectWindowSchedule;
  turn: number;
  sender: BabyRole;
  recipient: BabyRole;
}): AffectWindow | undefined {
  if (!affectWindowDue(options.schedule, options.turn)) {
    return undefined;
  }
  return createAffectWindow(options);
}

/** Builds one well-formed window; the schedule check is the caller's. */
export function createAffectWindow(options: {
  turn: number;
  sender: BabyRole;
  recipient: BabyRole;
}): AffectWindow {
  assertWindowRoles(options.sender, options.recipient);
  if (!Number.isInteger(options.turn) || options.turn < 0) {
    throw new InvalidAffectWindowError('turn must be a non-negative integer');
  }
  return {
    windowId: affectWindowId(options.turn, options.sender),
    turn: options.turn,
    sender: options.sender,
    recipient: options.recipient,
    opensAfter: AFFECT_WINDOW_TRIGGER,
  };
}

/** Structural validation of a window handed in by the runtime. */
export function assertValidAffectWindow(window: AffectWindow): void {
  if (typeof window.windowId !== 'string' || window.windowId.length === 0) {
    throw new InvalidAffectWindowError('windowId must be a non-empty string');
  }
  if (!Number.isInteger(window.turn) || window.turn < 0) {
    throw new InvalidAffectWindowError('turn must be a non-negative integer');
  }
  assertWindowRoles(window.sender, window.recipient);
  if (window.opensAfter !== AFFECT_WINDOW_TRIGGER) {
    throw new InvalidAffectWindowError(
      `opensAfter must be "${AFFECT_WINDOW_TRIGGER}" (SPEC §9.3 rule 2)`,
    );
  }
  if (window.windowId !== affectWindowId(window.turn, window.sender)) {
    throw new InvalidAffectWindowError(
      'windowId must be the deterministic w-<turn>-<sender> identity',
    );
  }
}

function assertWindowRoles(sender: BabyRole, recipient: BabyRole): void {
  if (sender !== 'baby-a' && sender !== 'baby-b') {
    throw new InvalidAffectWindowError('sender must be a Baby role');
  }
  if (recipient !== 'baby-a' && recipient !== 'baby-b') {
    throw new InvalidAffectWindowError('recipient must be a Baby role');
  }
  if (sender === recipient) {
    throw new InvalidAffectWindowError('sender and recipient must differ');
  }
}

/**
 * SPEC §6.3: `submit_affect` is available only inside an open window, and
 * never at all under `derived` (the Gateway maps a private measurement
 * instead) or `emergent` (no Affect Event is produced). This is the helper the
 * Nursery Controller uses to build `TurnBudget.availableActions`, so the
 * "derived mode disables `submit_affect`" rule of ALD-033 criterion 2 has one
 * implementation shared by the runtime and the Gateway's own checks.
 */
export function affectActionAvailable(
  affectMode: RunConfig['affectMode'],
  windowOpen: boolean,
): boolean {
  if (!windowOpen) {
    return false;
  }
  return (
    affectMode === 'declared' ||
    affectMode === 'permuted' ||
    affectMode === 'opaque'
  );
}
