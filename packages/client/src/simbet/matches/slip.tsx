import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** One selection on the slip, with the odds the player saw when they tapped it. */
export interface SlipLeg {
  eventId: string;
  league: string;
  home: string;
  away: string;
  kickoff: string;
  market: string;
  marketName: string;
  pick: string;
  /** Player-facing pick ("Chelsea", "Over 2.5"). */
  label: string;
  odds: number;
}

export type SlipMode = 'single' | 'multi';

interface SlipValue {
  legs: SlipLeg[];
  mode: SlipMode;
  setMode: (m: SlipMode) => void;
  /** Stake in major units as typed ("100"). */
  stake: string;
  setStake: (s: string) => void;
  acceptOddsChanges: boolean;
  setAcceptOddsChanges: (v: boolean) => void;
  toggle: (leg: SlipLeg) => void;
  remove: (eventId: string) => void;
  clear: () => void;
  /** Apply the server's current prices after an ODDS_CHANGED refusal. */
  reprice: (changes: Array<{ eventId: string; market: string; pick: string; odds: number }>) => void;
  isPicked: (eventId: string, market: string, pick: string) => boolean;
  /** Slip sheet on phones / drawer off the Matches page. */
  open: boolean;
  setOpen: (v: boolean) => void;
}

const SlipContext = createContext<SlipValue | null>(null);
const KEY = 'simbet_slip';

export function useSlip(): SlipValue {
  const v = useContext(SlipContext);
  if (!v) throw new Error('useSlip outside <SlipProvider>');
  return v;
}

function restore(): { legs: SlipLeg[]; mode: SlipMode; stake: string; accept: boolean } {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const now = Date.now();
      return {
        legs: Array.isArray(s.legs) ? (s.legs as SlipLeg[]).filter((l) => new Date(l.kickoff).getTime() > now) : [],
        mode: s.mode === 'multi' ? 'multi' : 'single',
        stake: typeof s.stake === 'string' ? s.stake : '100',
        accept: s.accept !== false,
      };
    }
  } catch { /* fresh slip */ }
  return { legs: [], mode: 'single', stake: '100', accept: true };
}

export function SlipProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(restore);
  const [legs, setLegs] = useState<SlipLeg[]>(initial.legs);
  const [mode, setMode] = useState<SlipMode>(initial.mode);
  const [stake, setStake] = useState(initial.stake);
  const [acceptOddsChanges, setAcceptOddsChanges] = useState(initial.accept);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try { sessionStorage.setItem(KEY, JSON.stringify({ legs, mode, stake, accept: acceptOddsChanges })); } catch { /* ignore */ }
  }, [legs, mode, stake, acceptOddsChanges]);

  const toggle = useCallback((leg: SlipLeg) => {
    setLegs((prev) => {
      const existing = prev.find((l) => l.eventId === leg.eventId);
      if (existing && existing.market === leg.market && existing.pick === leg.pick) return prev.filter((l) => l.eventId !== leg.eventId);
      // One pick per match: two markets on one fixture could demand contradictory scorelines.
      const next = prev.filter((l) => l.eventId !== leg.eventId);
      return [...next, leg];
    });
  }, []);

  const remove = useCallback((eventId: string) => setLegs((p) => p.filter((l) => l.eventId !== eventId)), []);
  const clear = useCallback(() => setLegs([]), []);
  const reprice = useCallback((changes: Array<{ eventId: string; market: string; pick: string; odds: number }>) => {
    setLegs((prev) => prev.map((l) => {
      const c = changes.find((x) => x.eventId === l.eventId && x.market === l.market && x.pick === l.pick);
      return c ? { ...l, odds: c.odds } : l;
    }));
  }, []);
  const isPicked = useCallback((eventId: string, market: string, pick: string) =>
    legs.some((l) => l.eventId === eventId && l.market === market && l.pick === pick), [legs]);

  const value = useMemo<SlipValue>(() => ({
    legs, mode, setMode, stake, setStake, acceptOddsChanges, setAcceptOddsChanges,
    toggle, remove, clear, reprice, isPicked, open, setOpen,
  }), [legs, mode, stake, acceptOddsChanges, toggle, remove, clear, reprice, isPicked, open]);

  return <SlipContext.Provider value={value}>{children}</SlipContext.Provider>;
}
