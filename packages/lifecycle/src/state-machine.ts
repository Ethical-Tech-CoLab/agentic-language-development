/**
 * Run lifecycle state machine (SPECIFICATION.md §7.1 Run States, §7.2 State
 * Transition Table, §7.3 Pause/Abort/Recovery behavior; BACKLOG ALD-024,
 * ALD-026).
 *
 * The §7.2 table is encoded once, as data, in {@link TRANSITIONS}. Every pair
 * that the table does not list is rejected: there is no wildcard, no implicit
 * self-transition, and no transition out of a terminal state. Two-step rows in
 * the table (`running -> pausing -> paused`, `paused -> resuming -> running`,
 * `aborting -> aborted-sealed`) are modeled as the two events named in
 * `RUN_EVENTS`, exactly as the contract in `@ald/types` documents.
 */
import {
  RUN_STATES,
  type RunEvent,
  type RunState,
  type RunStateMachine,
  type RunTransition,
} from '@ald/types';

/**
 * The "Required side effect" column of SPEC §7.2, verbatim, plus the abort
 * requirement of §7.3. The orchestrator asserts these against the work it
 * actually performed, so the strings are exported as a frozen registry rather
 * than inlined at each call site.
 */
export const RUN_SIDE_EFFECTS = {
  recordPreRegistration: 'Record protocol Git commit + config hash',
  rotateKeysAndSeedScenarios:
    'Generate/rotate per-run keys; seed Scenario Engine',
  checkpointZero: 'Checkpoint 0 (LEDGER-INTEGRITY-DESIGN.md §9)',
  checkpointAtPause: 'Checkpoint at pause (§9 of LEDGER doc)',
  verifyCommittedPrefix:
    'Verify committed prefix before accepting new writes (§7.3)',
  disablePolicyUpdates: 'Disable `updatePolicy`; use held-out scenario set',
  sealOnAbort:
    '`run.sealed` event, final checkpoint, final anchor still required',
  initializeMinimumEvidenceContext:
    'Initialize minimum evidence/signing context if needed; record failure; ' +
    'checkpoint and anchor the available prefix',
  preserveConflictingArtifacts:
    'Preserve both artifacts; stop run; require research-integrity review ' +
    'before reuse of evidence',
  verifierMustPass:
    'Verifier MUST pass before disposition is marked `valid` in the notebook',
  preserveUnanchoredTail:
    'Preserve export and unanchored-tail report; accept no turns',
  resumeExportWorkOnly: 'Resume only export/anchor/verification work',
  recordGovernanceAbandonment:
    'Append an audited governance decision; disposition remains `invalid` and ' +
    'unanchored status is permanent',
} as const;

export type RunSideEffect =
  (typeof RUN_SIDE_EFFECTS)[keyof typeof RUN_SIDE_EFFECTS];

/** SPEC §7.1: terminal states. No event may leave one of these. */
export const TERMINAL_RUN_STATES = [
  'sealed',
  'aborted-sealed',
  'forked-invalid',
] as const;

export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

/** SPEC §7.2 "any active state" for the fork-detected row: non-terminal, non-draft. */
const ACTIVE_RUN_STATES = [
  'preregistered',
  'initializing',
  'running',
  'pausing',
  'paused',
  'resuming',
  'evaluating',
  'sealing',
  'sealing-blocked',
  'aborting',
] as const satisfies readonly RunState[];

/** SPEC §7.2 abort row 1: states whose abort still seals a complete run. */
const ABORT_FROM_ACTIVE_RUN = ['running', 'paused', 'evaluating'] as const;

/** SPEC §7.2 abort row 2: abort or unrecoverable initialization failure. */
const ABORT_FROM_INITIALIZATION = [
  'preregistered',
  'initializing',
  'resuming',
] as const;

interface TransitionRow {
  readonly from: readonly RunState[];
  readonly event: RunEvent;
  readonly to: RunState;
  readonly sideEffects: readonly RunSideEffect[];
}

/**
 * One row per §7.2 table row. A table row that spans two states expands into
 * two rows here carrying the same required side effect, so the orchestrator
 * sees the same requirement whichever half it is asserting against.
 */
const TRANSITION_ROWS: readonly TransitionRow[] = [
  {
    from: ['draft'],
    event: 'preregister',
    to: 'preregistered',
    sideEffects: [RUN_SIDE_EFFECTS.recordPreRegistration],
  },
  {
    from: ['preregistered'],
    event: 'start',
    to: 'initializing',
    sideEffects: [RUN_SIDE_EFFECTS.rotateKeysAndSeedScenarios],
  },
  {
    from: ['initializing'],
    event: 'ready',
    to: 'running',
    sideEffects: [RUN_SIDE_EFFECTS.checkpointZero],
  },
  {
    from: ['running'],
    event: 'pause',
    to: 'pausing',
    sideEffects: [RUN_SIDE_EFFECTS.checkpointAtPause],
  },
  {
    from: ['pausing'],
    event: 'pause-complete',
    to: 'paused',
    sideEffects: [RUN_SIDE_EFFECTS.checkpointAtPause],
  },
  {
    from: ['paused'],
    event: 'resume',
    to: 'resuming',
    sideEffects: [RUN_SIDE_EFFECTS.verifyCommittedPrefix],
  },
  {
    from: ['resuming'],
    event: 'resume-complete',
    to: 'running',
    sideEffects: [RUN_SIDE_EFFECTS.verifyCommittedPrefix],
  },
  {
    from: ['running'],
    event: 'begin-evaluation',
    to: 'evaluating',
    sideEffects: [RUN_SIDE_EFFECTS.disablePolicyUpdates],
  },
  {
    from: ['evaluating'],
    event: 'evaluation-complete',
    to: 'sealing',
    sideEffects: [],
  },
  {
    from: ABORT_FROM_ACTIVE_RUN,
    event: 'abort',
    to: 'aborting',
    sideEffects: [RUN_SIDE_EFFECTS.sealOnAbort],
  },
  {
    from: ABORT_FROM_INITIALIZATION,
    event: 'abort',
    to: 'aborting',
    sideEffects: [RUN_SIDE_EFFECTS.initializeMinimumEvidenceContext],
  },
  {
    from: ['aborting'],
    event: 'abort-complete',
    to: 'aborted-sealed',
    sideEffects: [RUN_SIDE_EFFECTS.sealOnAbort],
  },
  {
    from: ['sealing'],
    event: 'seal-complete',
    to: 'sealed',
    sideEffects: [RUN_SIDE_EFFECTS.verifierMustPass],
  },
  {
    from: ['sealing', 'aborting'],
    event: 'seal-blocked',
    to: 'sealing-blocked',
    sideEffects: [RUN_SIDE_EFFECTS.preserveUnanchoredTail],
  },
  {
    from: ['sealing-blocked'],
    event: 'seal-retry',
    to: 'sealing',
    sideEffects: [RUN_SIDE_EFFECTS.resumeExportWorkOnly],
  },
  {
    from: ['sealing-blocked'],
    event: 'abandon-recovery',
    to: 'aborted-sealed',
    sideEffects: [RUN_SIDE_EFFECTS.recordGovernanceAbandonment],
  },
  {
    from: ACTIVE_RUN_STATES,
    event: 'fork-detected',
    to: 'forked-invalid',
    sideEffects: [RUN_SIDE_EFFECTS.preserveConflictingArtifacts],
  },
];

/** The flattened, immutable §7.2 transition table. */
export const TRANSITIONS: readonly RunTransition[] = Object.freeze(
  TRANSITION_ROWS.flatMap((row) =>
    row.from.map((from) => Object.freeze({ from, event: row.event, to: row.to })),
  ),
);

function transitionKey(from: RunState, event: RunEvent): string {
  return `${from}|${event}`;
}

const TRANSITION_BY_KEY: ReadonlyMap<string, RunTransition> = new Map(
  TRANSITIONS.map((transition) => [
    transitionKey(transition.from, transition.event),
    transition,
  ]),
);

const SIDE_EFFECTS_BY_KEY: ReadonlyMap<string, readonly RunSideEffect[]> =
  new Map(
    TRANSITION_ROWS.flatMap((row) =>
      row.from.map(
        (from) =>
          [transitionKey(from, row.event), Object.freeze([...row.sideEffects])] as const,
      ),
    ),
  );

/** Thrown by {@link RunLifecycle.apply} for any pair absent from §7.2. */
export class InvalidTransitionError extends Error {
  readonly state: RunState;
  readonly event: RunEvent;
  readonly runId: string | undefined;

  constructor(state: RunState, event: RunEvent, runId?: string) {
    const subject = runId === undefined ? 'run' : `run "${runId}"`;
    super(
      `invalid transition: ${subject} cannot apply event "${event}" from ` +
        `state "${state}" (SPECIFICATION.md §7.2)`,
    );
    this.name = 'InvalidTransitionError';
    this.state = state;
    this.event = event;
    this.runId = runId;
  }
}

/** Thrown when turn work is attempted in a state that does not accept turns. */
export class RunNotAcceptingTurnsError extends Error {
  readonly state: RunState;
  readonly runId: string;

  constructor(runId: string, state: RunState) {
    super(
      `run "${runId}" does not accept turns in state "${state}" ` +
        '(SPECIFICATION.md §7.1, §7.3)',
    );
    this.name = 'RunNotAcceptingTurnsError';
    this.state = state;
    this.runId = runId;
  }
}

export function isRunState(value: unknown): value is RunState {
  return (
    typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value)
  );
}

/** SPEC §7.1: `sealed`, `aborted-sealed`, and `forked-invalid` are terminal. */
export function isTerminalState(state: RunState): state is TerminalRunState {
  return (TERMINAL_RUN_STATES as readonly RunState[]).includes(state);
}

/**
 * SPEC §7.2 "any active state": every non-terminal state except `draft`, whose
 * configuration is not yet committed. This is the domain of the fork-detected
 * row.
 */
export function isActiveState(state: RunState): boolean {
  return state !== 'draft' && !isTerminalState(state);
}

/**
 * SPEC §7.1: turns execute only while `running`; `evaluating` executes
 * held-out scenarios for measurement with learning disabled. Every other
 * state — including `pausing`, `sealing-blocked`, and all terminal states —
 * accepts no turn (§7.3).
 */
export function acceptsTurns(state: RunState): boolean {
  return state === 'running' || state === 'evaluating';
}

/** The §7.2 required side effects for one listed transition. */
export function requiredSideEffects(
  transition: RunTransition,
): readonly RunSideEffect[] {
  const key = transitionKey(transition.from, transition.event);
  const listed = TRANSITION_BY_KEY.get(key);
  if (listed === undefined || listed.to !== transition.to) {
    throw new InvalidTransitionError(transition.from, transition.event);
  }
  return SIDE_EFFECTS_BY_KEY.get(key) ?? [];
}

/** Every transition the table lists out of `state`. */
export function transitionsFrom(state: RunState): readonly RunTransition[] {
  return TRANSITIONS.filter((transition) => transition.from === state);
}

/**
 * The SPEC §7.2 run state machine.
 *
 * Construct one per run. `initialState` exists for recovery (§7.3): after a
 * restart the orchestrator rebuilds the machine at the state derived from the
 * last committed evidence prefix, so `history()` then covers only transitions
 * applied since that reconstruction.
 */
export class RunLifecycle implements RunStateMachine {
  readonly runId: string;

  #state: RunState;

  readonly #history: RunTransition[] = [];

  constructor(runId: string, initialState: RunState = 'draft') {
    if (runId.length === 0) {
      throw new Error('runId must not be empty');
    }
    if (!isRunState(initialState)) {
      throw new Error(
        `unknown run state: ${String(initialState)} (SPECIFICATION.md §7.1)`,
      );
    }
    this.runId = runId;
    this.#state = initialState;
  }

  get state(): RunState {
    return this.#state;
  }

  /** True while the run is in a terminal state (§7.1). */
  get isTerminal(): boolean {
    return isTerminalState(this.#state);
  }

  /** True only in `running` and `evaluating` (§7.1, ALD-026). */
  get acceptsTurns(): boolean {
    return acceptsTurns(this.#state);
  }

  canApply(event: RunEvent): boolean {
    return TRANSITION_BY_KEY.has(transitionKey(this.#state, event));
  }

  apply(event: RunEvent): RunState {
    const transition = TRANSITION_BY_KEY.get(transitionKey(this.#state, event));
    if (transition === undefined) {
      throw new InvalidTransitionError(this.#state, event, this.runId);
    }
    this.#state = transition.to;
    this.#history.push(transition);
    return this.#state;
  }

  history(): readonly RunTransition[] {
    return Object.freeze([...this.#history]);
  }

  /** Events that are legal right now, in table order. */
  availableEvents(): readonly RunEvent[] {
    return transitionsFrom(this.#state).map((transition) => transition.event);
  }

  /**
   * ALD-026: guard every turn entry point. An `aborted-sealed` (or otherwise
   * terminal) run can never accept another turn, and neither can a paused,
   * pausing, sealing, or blocked run.
   */
  assertAcceptsTurn(): void {
    if (!this.acceptsTurns) {
      throw new RunNotAcceptingTurnsError(this.runId, this.#state);
    }
  }

  /** The §7.2 side effects required by the transition `event` would take. */
  requiredSideEffects(event: RunEvent): readonly RunSideEffect[] {
    const transition = TRANSITION_BY_KEY.get(transitionKey(this.#state, event));
    if (transition === undefined) {
      throw new InvalidTransitionError(this.#state, event, this.runId);
    }
    return requiredSideEffects(transition);
  }
}
