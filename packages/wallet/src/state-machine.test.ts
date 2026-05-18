import { describe, it, expect } from 'vitest';
import {
  nextState,
  isTerminal,
  InvalidTransitionError,
  TERMINAL_STATES,
  NON_TERMINAL_STATES,
  type BetState,
  type BetEvent,
} from './state-machine.js';

// ---------------------------------------------------------------------------
// Legal transition table
// ---------------------------------------------------------------------------

const LEGAL_TRANSITIONS: [BetState, BetEvent, BetState][] = [
  // PENDING
  ['PENDING', 'bet_accepted',      'ARMED'],
  ['PENDING', 'bet_rejected',      'VOIDED'],
  // ARMED
  ['ARMED',   'round_started',     'FLYING'],
  ['ARMED',   'cashout_requested', 'SETTLING'],
  ['ARMED',   'round_crashed',     'LOST'],
  ['ARMED',   'rollback_started',  'ROLLBACK_PENDING'],
  // FLYING
  ['FLYING',  'cashout_requested', 'SETTLING'],
  ['FLYING',  'round_crashed',     'LOST'],
  ['FLYING',  'rollback_started',  'ROLLBACK_PENDING'],
  // SETTLING
  ['SETTLING', 'win_settled',      'SETTLED'],
  ['SETTLING', 'win_failed',       'WIN_FAILED'],
  ['SETTLING', 'rollback_started', 'ROLLBACK_PENDING'],
  // WIN_FAILED
  ['WIN_FAILED', 'win_force_credited', 'SETTLED'],
  ['WIN_FAILED', 'rollback_started',   'ROLLBACK_PENDING'],
  // ROLLBACK_PENDING
  ['ROLLBACK_PENDING', 'rollback_completed', 'VOIDED'],
];

// ---------------------------------------------------------------------------
// All 9 states
// ---------------------------------------------------------------------------

const ALL_STATES: BetState[] = [
  'PENDING',
  'ARMED',
  'FLYING',
  'SETTLING',
  'SETTLED',
  'LOST',
  'VOIDED',
  'WIN_FAILED',
  'ROLLBACK_PENDING',
];

describe('state-machine – legal transitions', () => {
  it.each(LEGAL_TRANSITIONS)(
    'nextState(%s, %s) === %s',
    (from, event, to) => {
      expect(nextState(from, event)).toBe(to);
    },
  );
});

describe('state-machine – illegal transitions throw InvalidTransitionError', () => {
  const ILLEGAL: [BetState, BetEvent][] = [
    ['SETTLED',  'win_settled'],
    ['ARMED',    'win_settled'],
    ['PENDING',  'cashout_requested'],
    ['VOIDED',   'rollback_started'],
  ];

  it.each(ILLEGAL)(
    'nextState(%s, %s) throws InvalidTransitionError with correct fields',
    (from, event) => {
      expect(() => nextState(from, event)).toThrow(InvalidTransitionError);
      try {
        nextState(from, event);
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidTransitionError);
        const e = err as InvalidTransitionError;
        expect(e.from).toBe(from);
        expect(e.event).toBe(event);
        expect(e.name).toBe('InvalidTransitionError');
      }
    },
  );
});

describe('state-machine – isTerminal', () => {
  it('returns true for terminal states', () => {
    expect(isTerminal('SETTLED')).toBe(true);
    expect(isTerminal('LOST')).toBe(true);
    expect(isTerminal('VOIDED')).toBe(true);
    expect(isTerminal('WIN_FAILED')).toBe(true);
  });

  it('returns false for non-terminal states', () => {
    expect(isTerminal('PENDING')).toBe(false);
    expect(isTerminal('ARMED')).toBe(false);
    expect(isTerminal('FLYING')).toBe(false);
    expect(isTerminal('SETTLING')).toBe(false);
    expect(isTerminal('ROLLBACK_PENDING')).toBe(false);
  });
});

describe('state-machine – TERMINAL_STATES / NON_TERMINAL_STATES', () => {
  it('are disjoint', () => {
    for (const s of TERMINAL_STATES) {
      expect(NON_TERMINAL_STATES.has(s)).toBe(false);
    }
    for (const s of NON_TERMINAL_STATES) {
      expect(TERMINAL_STATES.has(s)).toBe(false);
    }
  });

  it('together cover all 9 states', () => {
    const union = new Set([...TERMINAL_STATES, ...NON_TERMINAL_STATES]);
    expect(union.size).toBe(ALL_STATES.length);
    for (const s of ALL_STATES) {
      expect(union.has(s)).toBe(true);
    }
  });
});
