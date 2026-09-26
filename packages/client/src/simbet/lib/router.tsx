import { useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/**
 * A tiny History-API router: SimBet has a dozen flat routes, not enough to
 * justify a router dependency. `navigate()` pushes state and notifies every
 * `useLocation()` subscriber; the back button arrives as `popstate`.
 */

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') window.addEventListener('popstate', emit);

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

const snapshot = () => window.location.pathname + window.location.search;

export function navigate(to: string, opts: { replace?: boolean; scroll?: boolean } = {}): void {
  if (to !== snapshot()) {
    window.history[opts.replace ? 'replaceState' : 'pushState'](null, '', to);
    emit();
  }
  if (opts.scroll !== false) window.scrollTo({ top: 0 });
}

export function useLocation(): { path: string; query: URLSearchParams } {
  const href = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => {
    const url = new URL(href, window.location.origin);
    return { path: url.pathname.replace(/\/+$/, '') || '/', query: url.searchParams };
  }, [href]);
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

/** An <a> that routes in-app on a plain click, and behaves like a link otherwise. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
