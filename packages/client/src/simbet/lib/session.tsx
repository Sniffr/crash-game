import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { api, configureApi, type ApiError } from './api';
import { longDate } from './format';

/**
 * Everything app-wide on SimBet: the signed-in account and its balance, which
 * modal is open, the support widget, toasts and the colour theme.
 */

const TOKEN_KEY = 'simbet_token';
const THEME_KEY = 'simbet_theme';

export interface Account {
  playerId: string;
  username: string;
  phone: string | null;
  currency: string;
  balanceMinor: number;
}

/** What /register/verify, /login, /password/reset and /reactivate/complete return. */
export interface SignedIn {
  token: string;
  player: { playerId: string; username: string; phone: string | null };
  balanceMinor: number;
  currency: string;
}

export type ModalKind = 'login' | 'register' | 'forgot' | 'reactivate' | 'deposit' | 'withdraw';
export type Theme = 'light' | 'dark';
export interface Toast { id: number; text: string; tone: 'info' | 'success' | 'error' }

interface SessionValue {
  /** False until a saved token has been checked. */
  ready: boolean;
  token: string | null;
  account: Account | null;
  signIn: (s: SignedIn) => void;
  signOut: (notice?: string) => void;
  refresh: () => Promise<void>;
  setBalance: (minor: number) => void;
  /** Run `then` now if signed in, else open Login and run it after sign-in. */
  requireAuth: (then?: () => void) => boolean;

  modal: ModalKind | null;
  openModal: (m: ModalKind) => void;
  closeModal: () => void;

  supportOpen: boolean;
  setSupportOpen: (open: boolean) => void;

  toasts: Toast[];
  notify: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;

  theme: Theme;
  setTheme: (t: Theme) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside <SessionProvider>');
  return v;
}

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode: session only lasts the tab */ }
}

function initialTheme(): Theme {
  return document.documentElement.dataset.sbTheme === 'dark' ? 'dark' : 'light';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => readStored(TOKEN_KEY));
  const [account, setAccount] = useState<Account | null>(null);
  const [ready, setReady] = useState(() => readStored(TOKEN_KEY) == null);
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const pendingAfterAuth = useRef<(() => void) | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const notify = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const signOut = useCallback((notice?: string) => {
    writeStored(TOKEN_KEY, null);
    tokenRef.current = null;
    setToken(null);
    setAccount(null);
    setSupportOpen(false);
    setModal((m) => (m === 'deposit' || m === 'withdraw' ? null : m));
    if (notice) notify(notice, 'info');
  }, [notify]);

  // Any authed call that finds the session over (logged out elsewhere, self-excluded,
  // deactivated) signs the player out here, once, with the server's reason.
  useEffect(() => {
    configureApi({
      getToken: () => tokenRef.current,
      onSessionEnded: (err: ApiError) => {
        if (!tokenRef.current) return;
        const until = typeof err.details.until === 'string' ? ` (until ${longDate(err.details.until)})` : '';
        signOut(err.code === 'INVALID_JWT' ? 'Your session has ended — please log in again.' : `${err.message}${until}`);
      },
    });
  }, [signOut]);

  const refresh = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const me = await api<Account & { phoneVerified: boolean }>('/api/account/me', { auth: true });
      setAccount({ playerId: me.playerId, username: me.username, phone: me.phone, currency: me.currency, balanceMinor: me.balanceMinor });
    } catch {
      /* session-ending errors already signed us out; anything else keeps the last known account */
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [token, refresh]);

  // Balance moves outside this tab (deposits land by webhook, fantasy prizes
  // settle later) — pick that up whenever the player comes back to the tab.
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [refresh]);

  const signIn = useCallback((s: SignedIn) => {
    writeStored(TOKEN_KEY, s.token);
    tokenRef.current = s.token;
    setToken(s.token);
    setAccount({ ...s.player, currency: s.currency, balanceMinor: s.balanceMinor });
    setReady(true);
    setModal(null);
    const next = pendingAfterAuth.current;
    pendingAfterAuth.current = null;
    if (next) window.setTimeout(next, 0);
  }, []);

  const setBalance = useCallback((minor: number) => {
    setAccount((a) => (a ? { ...a, balanceMinor: minor } : a));
  }, []);

  const requireAuth = useCallback((then?: () => void) => {
    if (tokenRef.current) { then?.(); return true; }
    pendingAfterAuth.current = then ?? null;
    setModal('login');
    return false;
  }, []);

  const openModal = useCallback((m: ModalKind) => {
    if ((m === 'deposit' || m === 'withdraw') && !tokenRef.current) {
      pendingAfterAuth.current = () => setModal(m);
      setModal('login');
      return;
    }
    setModal(m);
  }, []);
  const closeModal = useCallback(() => {
    // Closing Login/Register abandons whatever was waiting on it.
    pendingAfterAuth.current = null;
    setModal(null);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    document.documentElement.dataset.sbTheme = t;
    writeStored(THEME_KEY, t);
  }, []);

  const value = useMemo<SessionValue>(() => ({
    ready, token, account, signIn, signOut, refresh, setBalance, requireAuth,
    modal, openModal, closeModal, supportOpen, setSupportOpen,
    toasts, notify, dismissToast, theme, setTheme,
  }), [ready, token, account, signIn, signOut, refresh, setBalance, requireAuth, modal, openModal, closeModal,
    supportOpen, toasts, notify, dismissToast, theme, setTheme]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
