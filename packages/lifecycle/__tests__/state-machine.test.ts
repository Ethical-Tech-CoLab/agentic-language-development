import { describe, expect, it } from 'vitest';

import {
  RUN_EVENTS,
  RUN_STATES,
  type RunEvent,
  type RunState,
} from '@ald/types';
import {
  InvalidTransitionError,
  RUN_SIDE_EFFECTS,
  RunLifecycle,
  RunNotAcceptingTurnsError,
  TERMINAL_RUN_STATES,
  TRANSITIONS,
  acceptsTurns,
  isActiveState,
  isRunState,
  isTerminalState,
  requiredSideEffects,
  transitionsFrom,
} from '@ald/lifecycle';

const ACTIVE_STATES: RunState[] = [
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
];

const ABORTABLE_STATES: RunState[] = [
  'running',
  'paused',
  'evaluating',
  'preregistered',
  'initializing',
  'resuming',
];

function listed(from: RunState, event: RunEvent): RunState | undefined {
  return TRANSITIONS.find(
    (transition) => transition.from === from && transition.event === event,
  )?.to;
}

describe('SPEC §7.2 transition table', () => {
  it('lists exactly the 31 transitions of the table', () => {
    expect(TRANSITIONS).toHaveLength(31);
    expect(RUN_STATES).toHaveLength(14);
    expect(RUN_EVENTS).toHaveLength(16);
  });

  it('has no duplicate (state, event) pair', () => {
    const keys = TRANSITIONS.map(
      (transition) => `${transition.from}|${transition.event}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('encodes every named transition with the exact event names', () => {
    expect(listed('draft', 'preregister')).toBe('preregistered');
    expect(listed('preregistered', 'start')).toBe('initializing');
    expect(listed('initializing', 'ready')).toBe('running');
    expect(listed('running', 'pause')).toBe('pausing');
    expect(listed('pausing', 'pause-complete')).toBe('paused');
    expect(listed('paused', 'resume')).toBe('resuming');
    expect(listed('resuming', 'resume-complete')).toBe('running');
    expect(listed('running', 'begin-evaluation')).toBe('evaluating');
    expect(listed('evaluating', 'evaluation-complete')).toBe('sealing');
    expect(listed('aborting', 'abort-complete')).toBe('aborted-sealed');
    expect(listed('sealing', 'seal-complete')).toBe('sealed');
    expect(listed('sealing', 'seal-blocked')).toBe('sealing-blocked');
    expect(listed('aborting', 'seal-blocked')).toBe('sealing-blocked');
    expect(listed('sealing-blocked', 'seal-retry')).toBe('sealing');
    expect(listed('sealing-blocked', 'abandon-recovery')).toBe('aborted-sealed');
    for (const state of ABORTABLE_STATES) {
      expect(listed(state, 'abort')).toBe('aborting');
    }
    for (const state of ACTIVE_STATES) {
      expect(listed(state, 'fork-detected')).toBe('forked-invalid');
    }
  });

  it('never leaves a terminal state and never re-enters draft', () => {
    for (const transition of TRANSITIONS) {
      expect(isTerminalState(transition.from)).toBe(false);
      expect(transition.to).not.toBe('draft');
    }
  });

  it('only allows fork-detected from an active state (not draft)', () => {
    expect(listed('draft', 'fork-detected')).toBeUndefined();
    const forkSources = TRANSITIONS.filter(
      (transition) => transition.event === 'fork-detected',
    ).map((transition) => transition.from);
    expect(forkSources.sort()).toEqual([...ACTIVE_STATES].sort());
  });
});

describe('exhaustive (state × event) matrix', () => {
  it('accepts exactly the listed pairs and rejects all 193 others', () => {
    let accepted = 0;
    let rejected = 0;

    for (const state of RUN_STATES) {
      for (const event of RUN_EVENTS) {
        const machine = new RunLifecycle('run-matrix', state);
        const expected = listed(state, event);

        if (expected === undefined) {
          rejected += 1;
          expect(machine.canApply(event)).toBe(false);
          expect(() => machine.apply(event)).toThrow(InvalidTransitionError);
          expect(machine.state).toBe(state);
          expect(machine.history()).toHaveLength(0);
        } else {
          accepted += 1;
          expect(machine.canApply(event)).toBe(true);
          expect(machine.apply(event)).toBe(expected);
          expect(machine.state).toBe(expected);
        }
      }
    }

    expect(accepted).toBe(TRANSITIONS.length);
    expect(accepted).toBe(31);
    expect(rejected).toBe(RUN_STATES.length * RUN_EVENTS.length - 31);
    expect(rejected).toBe(193);
  });

  it('reports both the state and the event in the invalid-transition error', () => {
    const machine = new RunLifecycle('run-err', 'paused');
    expect(() => machine.apply('ready')).toThrowError(
      /invalid transition/u,
    );
    try {
      machine.apply('ready');
      expect.unreachable('apply should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      const thrown = error as InvalidTransitionError;
      expect(thrown.message).toContain('invalid transition');
      expect(thrown.message).toContain('paused');
      expect(thrown.message).toContain('ready');
      expect(thrown.message).toContain('run-err');
      expect(thrown.state).toBe('paused');
      expect(thrown.event).toBe('ready');
      expect(thrown.runId).toBe('run-err');
    }
  });

  it('mirrors canApply and availableEvents against the table', () => {
    for (const state of RUN_STATES) {
      const machine = new RunLifecycle('run-mirror', state);
      const available = machine.availableEvents();
      for (const event of RUN_EVENTS) {
        expect(machine.canApply(event)).toBe(available.includes(event));
      }
      expect([...available].sort()).toEqual(
        transitionsFrom(state)
          .map((transition) => transition.event)
          .sort(),
      );
    }
  });
});

describe('happy path and history', () => {
  it('runs draft → sealed through every mandatory state', () => {
    const machine = new RunLifecycle('run-happy');
    expect(machine.state).toBe('draft');

    const path: Array<[RunEvent, RunState]> = [
      ['preregister', 'preregistered'],
      ['start', 'initializing'],
      ['ready', 'running'],
      ['begin-evaluation', 'evaluating'],
      ['evaluation-complete', 'sealing'],
      ['seal-complete', 'sealed'],
    ];

    for (const [event, expected] of path) {
      expect(machine.apply(event)).toBe(expected);
    }

    expect(machine.state).toBe('sealed');
    expect(machine.isTerminal).toBe(true);
    expect(machine.history().map((transition) => transition.event)).toEqual(
      path.map(([event]) => event),
    );
    expect(machine.history().map((transition) => transition.to)).toEqual(
      path.map(([, state]) => state),
    );
    expect(machine.history()[0]?.from).toBe('draft');
  });

  it('keeps history immutable and independent of later transitions', () => {
    const machine = new RunLifecycle('run-history');
    machine.apply('preregister');
    const snapshot = machine.history();
    machine.apply('start');
    expect(snapshot).toHaveLength(1);
    expect(machine.history()).toHaveLength(2);
    expect(() => {
      (snapshot as unknown as unknown[]).push({});
    }).toThrow();
  });

  it('starts empty history from a recovered state (SPEC §7.3)', () => {
    const machine = new RunLifecycle('run-recovered', 'running');
    expect(machine.state).toBe('running');
    expect(machine.history()).toHaveLength(0);
    expect(machine.apply('pause')).toBe('pausing');
    expect(machine.history()[0]).toEqual({
      from: 'running',
      event: 'pause',
      to: 'pausing',
    });
  });

  it('rejects an unknown initial state or an empty runId', () => {
    expect(() => new RunLifecycle('', 'draft')).toThrow(/runId/u);
    expect(
      () => new RunLifecycle('run-bad', 'not-a-state' as RunState),
    ).toThrow(/unknown run state/u);
  });
});

describe('pause and resume (SPEC §7.3, ALD-026)', () => {
  it('cycles running → pausing → paused → resuming → running', () => {
    const machine = new RunLifecycle('run-pause', 'running');
    expect(machine.acceptsTurns).toBe(true);

    expect(machine.apply('pause')).toBe('pausing');
    expect(machine.acceptsTurns).toBe(false);
    expect(() => machine.assertAcceptsTurn()).toThrow(
      RunNotAcceptingTurnsError,
    );

    expect(machine.apply('pause-complete')).toBe('paused');
    expect(machine.acceptsTurns).toBe(false);

    expect(machine.apply('resume')).toBe('resuming');
    expect(machine.acceptsTurns).toBe(false);

    expect(machine.apply('resume-complete')).toBe('running');
    expect(machine.acceptsTurns).toBe(true);
    expect(() => machine.assertAcceptsTurn()).not.toThrow();
  });

  it('cannot pause a paused run or resume a running run', () => {
    const paused = new RunLifecycle('run-p', 'paused');
    expect(() => paused.apply('pause')).toThrow(InvalidTransitionError);
    const running = new RunLifecycle('run-r', 'running');
    expect(() => running.apply('resume')).toThrow(InvalidTransitionError);
    expect(() => running.apply('pause-complete')).toThrow(
      InvalidTransitionError,
    );
  });

  it('accepts turns only in running and evaluating', () => {
    for (const state of RUN_STATES) {
      const expected = state === 'running' || state === 'evaluating';
      expect(acceptsTurns(state)).toBe(expected);
      expect(new RunLifecycle('run-turns', state).acceptsTurns).toBe(expected);
    }
  });
});

describe('abort (SPEC §7.2, §7.3, ALD-026)', () => {
  it('aborts from each permitted state and ends aborted-sealed', () => {
    for (const state of ABORTABLE_STATES) {
      const machine = new RunLifecycle(`run-abort-${state}`, state);
      expect(machine.apply('abort')).toBe('aborting');
      expect(machine.acceptsTurns).toBe(false);
      expect(machine.apply('abort-complete')).toBe('aborted-sealed');
      expect(machine.isTerminal).toBe(true);
      expect(machine.acceptsTurns).toBe(false);
      expect(() => machine.assertAcceptsTurn()).toThrow(
        RunNotAcceptingTurnsError,
      );
    }
  });

  it('cannot abort from draft, sealing, sealing-blocked, or a terminal state', () => {
    for (const state of [
      'draft',
      'pausing',
      'sealing',
      'sealing-blocked',
      'sealed',
      'aborted-sealed',
      'forked-invalid',
    ] as RunState[]) {
      expect(new RunLifecycle('run-noabort', state).canApply('abort')).toBe(
        false,
      );
    }
  });

  it('makes an aborted-sealed run permanently closed to every event', () => {
    const machine = new RunLifecycle('run-terminal', 'aborted-sealed');
    for (const event of RUN_EVENTS) {
      expect(machine.canApply(event)).toBe(false);
      expect(() => machine.apply(event)).toThrow(InvalidTransitionError);
    }
    expect(machine.state).toBe('aborted-sealed');
    expect(() => machine.assertAcceptsTurn()).toThrowError(
      /does not accept turns/u,
    );
  });

  it('reports the run and state on a rejected turn', () => {
    const machine = new RunLifecycle('run-turn-guard', 'aborted-sealed');
    try {
      machine.assertAcceptsTurn();
      expect.unreachable('assertAcceptsTurn should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RunNotAcceptingTurnsError);
      const thrown = error as RunNotAcceptingTurnsError;
      expect(thrown.runId).toBe('run-turn-guard');
      expect(thrown.state).toBe('aborted-sealed');
      expect(thrown.message).toContain('aborted-sealed');
    }
  });
});

describe('sealing-blocked recovery (SPEC §7.2)', () => {
  it('retries from sealing-blocked back to sealed', () => {
    const machine = new RunLifecycle('run-block', 'sealing');
    expect(machine.apply('seal-blocked')).toBe('sealing-blocked');
    expect(machine.acceptsTurns).toBe(false);
    expect(machine.apply('seal-retry')).toBe('sealing');
    expect(machine.apply('seal-complete')).toBe('sealed');
    expect(machine.isTerminal).toBe(true);
  });

  it('abandons recovery from sealing-blocked into aborted-sealed', () => {
    const machine = new RunLifecycle('run-abandon', 'sealing-blocked');
    expect(machine.apply('abandon-recovery')).toBe('aborted-sealed');
    expect(machine.isTerminal).toBe(true);
  });

  it('reaches sealing-blocked from aborting as well', () => {
    const machine = new RunLifecycle('run-abort-block', 'running');
    machine.apply('abort');
    expect(machine.apply('seal-blocked')).toBe('sealing-blocked');
    expect(machine.apply('abandon-recovery')).toBe('aborted-sealed');
  });

  it('does not allow seal-retry or abandon-recovery anywhere else', () => {
    for (const state of RUN_STATES) {
      if (state === 'sealing-blocked') {
        continue;
      }
      const machine = new RunLifecycle('run-noretry', state);
      expect(machine.canApply('seal-retry')).toBe(false);
      expect(machine.canApply('abandon-recovery')).toBe(false);
    }
  });
});

describe('fork detection (SPEC §7.2, §7.3)', () => {
  it('moves every active state to forked-invalid', () => {
    for (const state of ACTIVE_STATES) {
      const machine = new RunLifecycle(`run-fork-${state}`, state);
      expect(machine.apply('fork-detected')).toBe('forked-invalid');
      expect(machine.isTerminal).toBe(true);
      expect(machine.acceptsTurns).toBe(false);
      expect(machine.history()).toEqual([
        { from: state, event: 'fork-detected', to: 'forked-invalid' },
      ]);
    }
  });

  it('rejects fork-detected from draft and from terminal states', () => {
    for (const state of ['draft', ...TERMINAL_RUN_STATES] as RunState[]) {
      expect(
        new RunLifecycle('run-nofork', state).canApply('fork-detected'),
      ).toBe(false);
    }
  });
});

describe('state predicates', () => {
  it('classifies terminal, active, and draft states', () => {
    expect([...TERMINAL_RUN_STATES]).toEqual([
      'sealed',
      'aborted-sealed',
      'forked-invalid',
    ]);
    for (const state of RUN_STATES) {
      const terminal = (TERMINAL_RUN_STATES as readonly RunState[]).includes(
        state,
      );
      expect(isTerminalState(state)).toBe(terminal);
      expect(isActiveState(state)).toBe(!terminal && state !== 'draft');
    }
    expect(isActiveState('draft')).toBe(false);
  });

  it('recognizes only the 14 documented state names', () => {
    for (const state of RUN_STATES) {
      expect(isRunState(state)).toBe(true);
    }
    expect(isRunState('not-a-state')).toBe(false);
    expect(isRunState(undefined)).toBe(false);
    expect(isRunState(7)).toBe(false);
  });
});

describe('required side effects (SPEC §7.2)', () => {
  it('returns the verbatim table entry for each transition', () => {
    expect(
      requiredSideEffects({ from: 'draft', event: 'preregister', to: 'preregistered' }),
    ).toEqual([RUN_SIDE_EFFECTS.recordPreRegistration]);
    expect(
      requiredSideEffects({ from: 'preregistered', event: 'start', to: 'initializing' }),
    ).toEqual([RUN_SIDE_EFFECTS.rotateKeysAndSeedScenarios]);
    expect(
      requiredSideEffects({ from: 'initializing', event: 'ready', to: 'running' }),
    ).toEqual([RUN_SIDE_EFFECTS.checkpointZero]);
    expect(
      requiredSideEffects({ from: 'running', event: 'pause', to: 'pausing' }),
    ).toEqual([RUN_SIDE_EFFECTS.checkpointAtPause]);
    expect(
      requiredSideEffects({ from: 'paused', event: 'resume', to: 'resuming' }),
    ).toEqual([RUN_SIDE_EFFECTS.verifyCommittedPrefix]);
    expect(
      requiredSideEffects({ from: 'running', event: 'begin-evaluation', to: 'evaluating' }),
    ).toEqual([RUN_SIDE_EFFECTS.disablePolicyUpdates]);
    expect(
      requiredSideEffects({ from: 'running', event: 'abort', to: 'aborting' }),
    ).toEqual([RUN_SIDE_EFFECTS.sealOnAbort]);
    expect(
      requiredSideEffects({ from: 'initializing', event: 'abort', to: 'aborting' }),
    ).toEqual([RUN_SIDE_EFFECTS.initializeMinimumEvidenceContext]);
    expect(
      requiredSideEffects({ from: 'sealing', event: 'seal-complete', to: 'sealed' }),
    ).toEqual([RUN_SIDE_EFFECTS.verifierMustPass]);
    expect(
      requiredSideEffects({ from: 'sealing', event: 'seal-blocked', to: 'sealing-blocked' }),
    ).toEqual([RUN_SIDE_EFFECTS.preserveUnanchoredTail]);
    expect(
      requiredSideEffects({
        from: 'sealing-blocked',
        event: 'abandon-recovery',
        to: 'aborted-sealed',
      }),
    ).toEqual([RUN_SIDE_EFFECTS.recordGovernanceAbandonment]);
    expect(
      requiredSideEffects({ from: 'running', event: 'fork-detected', to: 'forked-invalid' }),
    ).toEqual([RUN_SIDE_EFFECTS.preserveConflictingArtifacts]);
  });

  it('is defined for every listed transition and empty only where the table says "—"', () => {
    for (const transition of TRANSITIONS) {
      const effects = requiredSideEffects(transition);
      if (
        transition.from === 'evaluating' &&
        transition.event === 'evaluation-complete'
      ) {
        expect(effects).toEqual([]);
      } else {
        expect(effects.length).toBeGreaterThan(0);
      }
    }
  });

  it('throws for an unlisted transition and for a wrong destination', () => {
    expect(() =>
      requiredSideEffects({ from: 'paused', event: 'ready', to: 'running' }),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      requiredSideEffects({ from: 'running', event: 'pause', to: 'paused' }),
    ).toThrow(InvalidTransitionError);
  });

  it('exposes the side effects of the next transition from the machine', () => {
    const machine = new RunLifecycle('run-effects', 'running');
    expect(machine.requiredSideEffects('pause')).toEqual([
      RUN_SIDE_EFFECTS.checkpointAtPause,
    ]);
    expect(() => machine.requiredSideEffects('resume')).toThrow(
      InvalidTransitionError,
    );
  });
});
