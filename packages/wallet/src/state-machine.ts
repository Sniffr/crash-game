// ---------------------------------------------------------------------------
// BetState / BetEvent types
// ---------------------------------------------------------------------------

export type BetState =
  | 'PENDING'
  | 'ARMED'
  | 'FLYING'
  | 'SETTLING'
  | 'SETTLED'
  | 'LOST'
  | 'ROLLBACK_PENDING'
  | 'VOIDED'
  | 'WIN_FAILED';

export type BetEvent =
  | 'bet_accepted'        // PENDING → ARMED
  | 'bet_rejected'        // PENDING → VOIDED
  | 'round_started'       // ARMED → FLYING
  | 'cashout_requested'   // FLYING → SETTLING (also ARMED → SETTLING edge case)
  | 'win_settled'         // SETTLING → SETTLED
  | 'win_failed'          // SETTLING → WIN_FAILED
  | 'win_force_credited'  // WIN_FAILED → SETTLED
  | 'round_crashed'       // FLYING → LOST (also ARMED → LOST)
  | 'rollback_started'    // ANY non-terminal → ROLLBACK_PENDING
  | 'rollback_completed'; // ROLLBACK_PENDING → VOIDED

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

const ALL_STATES: readonly BetState[] = [
  'PENDING', 'ARMED', 'FLYING', 'SETTLING', 'SETTLED',
  'LOST', 'ROLLBACK_PENDING', 'VOIDED', 'WIN_FAILED',
];

export const TERMINAL_STATES: ReadonlySet<BetState> = new Set<BetState>([
  'SETTLED',
  'LOST',
  'VOIDED',
  'WIN_FAILED',
]);

export const NON_TERMINAL_STATES: ReadonlySet<BetState> = new Set(
  ALL_STATES.filter((s) => !TERMINAL_STATES.has(s)),
);

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class InvalidTransitionError extends Error {
  readonly from: BetState;
  readonly event: BetEvent;

  constructor(from: BetState, event: BetEvent) {
    super(`Invalid transition: ${from} + ${event}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.event = event;
  }
}

// ---------------------------------------------------------------------------
// Transition table
// Key format: `${state}:${event}` → next state
// ---------------------------------------------------------------------------

const TRANSITIONS = new Map<string, BetState>([
  // PENDING
  ['PENDING:bet_accepted',        'ARMED'],
  ['PENDING:bet_rejected',        'VOIDED'],
  // ARMED
  ['ARMED:round_started',         'FLYING'],
  ['ARMED:cashout_requested',     'SETTLING'],
  ['ARMED:round_crashed',         'LOST'],
  ['ARMED:rollback_started',      'ROLLBACK_PENDING'],
  // FLYING
  ['FLYING:cashout_requested',    'SETTLING'],
  ['FLYING:round_crashed',        'LOST'],
  ['FLYING:rollback_started',     'ROLLBACK_PENDING'],
  // SETTLING
  ['SETTLING:win_settled',        'SETTLED'],
  ['SETTLING:win_failed',         'WIN_FAILED'],
  ['SETTLING:rollback_started',   'ROLLBACK_PENDING'],
  // WIN_FAILED (terminal-but-recoverable)
  ['WIN_FAILED:win_force_credited', 'SETTLED'],
  ['WIN_FAILED:rollback_started', 'ROLLBACK_PENDING'],
  // ROLLBACK_PENDING
  ['ROLLBACK_PENDING:rollback_completed', 'VOIDED'],
]);

// ---------------------------------------------------------------------------
// Pure state machine function
// ---------------------------------------------------------------------------

/**
 * Given current state and an event, return the next state.
 * Throws InvalidTransitionError on illegal combinations.
 */
export function nextState(current: BetState, event: BetEvent): BetState {
  const key = `${current}:${event}`;
  const next = TRANSITIONS.get(key);
  if (next === undefined) {
    throw new InvalidTransitionError(current, event);
  }
  return next;
}

/**
 * True when no transition exists on the *normal* event path out of `state`.
 * Includes WIN_FAILED: it has no normal successor (only the exceptional
 * admin `win_force_credited` path can move it to SETTLED), so callers that
 * support force-credit must check for WIN_FAILED explicitly rather than
 * relying on isTerminal().
 */
export function isTerminal(state: BetState): boolean {
  return TERMINAL_STATES.has(state);
}
