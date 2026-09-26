import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Age18Icon, FacebookIcon, InstagramIcon, LinkedInIcon, MastercardIcon, NavBetAiIcon, NavFantasyIcon,
  NavHomeIcon, NavMatchesIcon, NavProfileIcon, TelegramIcon, VisaIcon, XIcon, YouTubeIcon,
} from '../icons';
import { CONTACT, NAV, SOCIALS } from '../content/site';
import { money } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import {
  CardSend, ChevronRight, Close, Cog, Coins, Gift, Headset, LogOut, MoneyAdd, PlusCircle, Receipt, UserCircle,
} from './glyphs';
import { Button, Logo } from './ui';

// ─── Header ──────────────────────────────────────────────────────────────────

const isActive = (path: string, to: string) => path === to || path.startsWith(`${to}/`);

export function Header() {
  const { account, token, openModal } = useSession();
  const { path } = useLocation();
  return (
    <header className="sticky top-0 z-40 border-b border-sb-line bg-sb-header/95 backdrop-blur supports-[backdrop-filter]:bg-sb-header/85">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 lg:h-[88px] lg:px-[30px]">
        <Link to="/" aria-label="SimBet home" className="shrink-0">
          <span className="lg:hidden"><Logo size="sm" /></span>
          <span className="hidden lg:inline"><Logo /></span>
        </Link>

        <nav aria-label="Main" className="hidden flex-1 items-center justify-center lg:flex">
          {NAV.map((item, i) => (
            <span key={item.to} className="flex items-center">
              {i > 0 && <span className="mx-3 h-6 w-px bg-sb-line xl:mx-4" aria-hidden />}
              <Link to={item.to} aria-current={isActive(path, item.to) ? 'page' : undefined}
                className={`font-sb-display text-[20px] leading-none transition-colors xl:text-[24px] ${
                  isActive(path, item.to) ? 'text-sb-accent' : 'text-sb-muted hover:text-sb-text'}`}>
                {item.label}
              </Link>
            </span>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 lg:ml-0 lg:gap-3">
          {token ? (
            <>
              <button type="button" onClick={() => openModal('deposit')} title="Your balance — tap to deposit"
                className="h-9 rounded-full border-2 border-sb-primary px-3 font-sb-display text-[17px] leading-none text-sb-accent sb-tabular lg:h-10 lg:px-4 lg:text-[20px]">
                {account ? money(account.balanceMinor, account.currency) : '…'}
              </button>
              <Button onClick={() => openModal('deposit')} className="hidden !text-[20px] lg:inline-flex xl:!text-[22px]">
                <PlusCircle className="h-5 w-5" strokeWidth={2} /> Deposit
              </Button>
              <ProfileMenu />
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => openModal('login')} className="lg:h-10 lg:px-6 lg:text-[20px]">Login</Button>
              <Button size="sm" onClick={() => openModal('register')} className="lg:h-10 lg:px-6 lg:text-[20px]">Register</Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function Avatar({ name, className = 'h-10 w-10' }: { name: string; className?: string }) {
  // Phone-number usernames have no initials; show the account glyph instead.
  const letter = /^[a-z]/i.test(name) ? name[0]!.toUpperCase() : null;
  return (
    <span className={`grid shrink-0 place-items-center rounded-full bg-sb-primary/15 font-sb-display text-[20px] text-sb-accent ring-2 ring-sb-primary/30 ${className}`}>
      {letter ?? <UserCircle className="h-6 w-6" />}
    </span>
  );
}

/** The avatar dropdown: account pages, wallet actions, support and sign-out. */
function ProfileMenu() {
  const { account, openModal, setSupportOpen, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { path } = useLocation();

  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const act = (fn: () => void) => () => { setOpen(false); fn(); };
  const items = accountMenu({ openModal, setSupportOpen, signOut });

  return (
    <div ref={root} className="relative hidden lg:block">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" className="rounded-full">
        <Avatar name={account?.username ?? ''} />
      </button>
      {open && (
        <div role="menu" className="sb-fade absolute right-0 top-full mt-2 w-[240px] overflow-hidden rounded-md border border-sb-line bg-sb-header py-1 shadow-xl">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" onClick={act(it.run)}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-[14px] transition-colors hover:bg-sb-primary hover:text-white ${it.danger ? 'text-sb-error' : 'text-sb-text'}`}>
              <it.icon className="h-[18px] w-[18px] shrink-0" />
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shared by the desktop dropdown and the mobile Profile page. */
export function accountMenu({ openModal, setSupportOpen, signOut }: Pick<ReturnType<typeof useSession>, 'openModal' | 'setSupportOpen' | 'signOut'>) {
  return [
    { label: 'My Account Info', icon: UserCircle, run: () => navigate('/account'), mobile: false },
    { label: 'Deposit', icon: MoneyAdd, run: () => openModal('deposit'), mobile: true },
    { label: 'Withdraw', icon: CardSend, run: () => openModal('withdraw'), mobile: true },
    { label: 'Bet History', icon: Receipt, run: () => navigate('/account/bets'), mobile: true },
    { label: 'Transactions', icon: Coins, run: () => navigate('/account/transactions'), mobile: true },
    { label: 'Customer Support', icon: Headset, run: () => setSupportOpen(true), mobile: true },
    { label: 'Promotions', icon: Gift, run: () => navigate('/promotions'), mobile: true },
    { label: 'Settings', icon: Cog, run: () => navigate('/account/settings'), mobile: true },
    { label: 'Log Out', icon: LogOut, run: () => { signOut(); navigate('/'); }, mobile: true, danger: true },
  ];
}

// ─── Mobile bottom nav ───────────────────────────────────────────────────────

export function BottomNav() {
  const { path } = useLocation();
  const { token, openModal } = useSession();
  const items = [
    { to: '/', label: 'Home', icon: NavHomeIcon, wide: true, active: path === '/' },
    { to: '/matches', label: 'Matches', icon: NavMatchesIcon, active: isActive(path, '/matches') },
    { to: '/bet-ai', label: 'Bet AI', icon: NavBetAiIcon, active: isActive(path, '/bet-ai') },
    { to: '/fantasy', label: 'Fantasy', icon: NavFantasyIcon, active: isActive(path, '/fantasy') },
    { to: '/account', label: 'Profile', icon: NavProfileIcon, active: isActive(path, '/account') },
  ];
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-sb-line bg-sb-header pb-[env(safe-area-inset-bottom)] lg:hidden">
      <ul className="mx-auto flex max-w-md justify-between px-2 pt-2 pb-1.5">
        {items.map((it) => (
          <li key={it.to} className="flex-1">
            <Link to={it.to} aria-current={it.active ? 'page' : undefined}
              onClick={(e) => { if (it.to === '/account' && !token) { e.preventDefault(); openModal('login'); } }}
              className={`flex flex-col items-center gap-1 text-[12px] ${it.active ? 'text-sb-accent' : 'text-sb-muted'}`}>
              <span className={`grid h-8 w-16 place-items-center rounded-full transition-colors ${it.active ? 'bg-sb-primary text-white' : ''}`}>
                <it.icon className={it.wide ? 'h-8 w-16' : 'h-8 w-8'} />
              </span>
              {it.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ─── Footer ──────────────────────────────────────────────────────────────────

const SOCIAL_ICON = { facebook: FacebookIcon, instagram: InstagramIcon, linkedin: LinkedInIcon, x: XIcon, youtube: YouTubeIcon, telegram: TelegramIcon };

function FooterLink({ children, onClick, to }: { children: ReactNode; to?: string; onClick?: () => void }) {
  const cls = 'flex w-full items-center justify-between gap-6 py-1 text-[14px] text-sb-footer-muted transition-colors hover:text-sb-footer-text';
  return (
    <li>
      {to ? <Link to={to} className={cls}>{children}<ChevronRight className="h-4 w-4 shrink-0 text-sb-footer-text" /></Link>
        : <button type="button" onClick={onClick} className={cls}>{children}<ChevronRight className="h-4 w-4 shrink-0 text-sb-footer-text" /></button>}
    </li>
  );
}

export function Footer() {
  const { theme, setTheme, openModal, setSupportOpen, requireAuth } = useSession();
  return (
    <footer className="mt-12 bg-sb-footer text-sb-footer-text">
      <div className="mx-auto grid max-w-[1440px] gap-10 px-4 py-10 sm:px-[75px] md:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.2fr]">
        <div>
          <Logo />
          <p className="mt-3 font-sb-display text-[18px]">Your growth, our reward.</p>
          <div className="mt-4 flex items-center gap-2" aria-label="Payment methods">
            <span className="grid h-6 w-9 place-items-center rounded border border-sb-line bg-white"><VisaIcon className="h-6 w-9" /></span>
            <span className="grid h-6 w-9 place-items-center rounded border border-sb-line bg-white"><MastercardIcon className="h-6 w-9" /></span>
            <span className="grid h-6 w-9 place-items-center rounded border border-sb-line bg-white p-0.5"><img src="/simbet/mpesa.png" alt="M-PESA" className="max-h-full" /></span>
          </div>
          <ThemeToggle theme={theme} onChange={setTheme} />
        </div>
        <div>
          <h3 className="mb-3 font-sb-display text-[18px]">Sim Bet</h3>
          <ul>
            <FooterLink to="/terms">Terms &amp; Conditions</FooterLink>
            <FooterLink to="/responsible-gaming">Responsible Gaming</FooterLink>
            <FooterLink to="/privacy">Privacy Policy</FooterLink>
            <FooterLink onClick={() => openModal('reactivate')}>Reactivate Account</FooterLink>
            <FooterLink to="/faqs">FAQs</FooterLink>
          </ul>
        </div>
        <div>
          <h3 className="mb-3 font-sb-display text-[18px]">Play</h3>
          <ul>
            <FooterLink to="/matches">Simulated Betting</FooterLink>
            <FooterLink to="/bet-ai">AI Betting</FooterLink>
            <FooterLink to="/fantasy">Fantasy Leagues</FooterLink>
            <FooterLink to="/promotions">Promotions</FooterLink>
            <FooterLink onClick={() => requireAuth(() => setSupportOpen(true))}>Customer Care</FooterLink>
          </ul>
        </div>
        <div>
          <h3 className="mb-3 font-sb-display text-[18px]">Connect with us</h3>
          <p className="text-[14px] text-sb-footer-muted">Telephone: {CONTACT.phone}</p>
          <p className="mt-1 text-[14px] text-sb-footer-muted">Email: <a href={`mailto:${CONTACT.email}`} className="hover:text-sb-footer-text">{CONTACT.email}</a></p>
          <ul className="mt-4 flex items-center gap-3 text-sb-footer-text">
            {SOCIALS.map((s) => {
              const Icon = SOCIAL_ICON[s.key];
              return (
                <li key={s.key}>
                  {s.url
                    ? <a href={s.url} target="_blank" rel="noopener noreferrer" aria-label={s.label}><Icon className="h-6 w-6" /></a>
                    : <Icon className="h-6 w-6" aria-hidden={false} aria-label={s.label} role="img" />}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <div className="bg-sb-footer2">
        <div className="mx-auto flex max-w-[1440px] items-center justify-center gap-3 px-4 py-4 text-center text-[13px] sm:text-[14px]">
          <Age18Icon className="h-9 w-9 shrink-0" />
          <p>Age 18 and above only. Play Responsibly. Betting is addictive and can be psychologically harmful.</p>
        </div>
      </div>
      <div className="bg-sb-primary pb-[calc(env(safe-area-inset-bottom)+76px)] text-white lg:pb-0">
        <div className="mx-auto max-w-[1440px] px-4 py-4 text-[13px] sm:px-[75px]">© {new Date().getFullYear()} Sim Bet. All rights reserved.</div>
      </div>
    </footer>
  );
}

function ThemeToggle({ theme, onChange }: { theme: 'light' | 'dark'; onChange: (t: 'light' | 'dark') => void }) {
  const dark = theme === 'dark';
  return (
    <div className="mt-4 flex items-center gap-2 text-[14px]">
      <span className={dark ? 'text-sb-footer-muted' : 'font-semibold'}>Light Mode</span>
      <button type="button" role="switch" aria-checked={dark} aria-label="Dark mode" onClick={() => onChange(dark ? 'light' : 'dark')}
        className={`relative h-6 w-11 rounded-full transition-colors ${dark ? 'bg-sb-primary' : 'bg-zinc-300'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${dark ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
      </button>
      <span className={dark ? 'font-semibold' : 'text-sb-footer-muted'}>Dark Mode</span>
    </div>
  );
}

// ─── Toasts ──────────────────────────────────────────────────────────────────

export function Toasts() {
  const { toasts, dismissToast } = useSession();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-20 z-[60] flex flex-col items-center gap-2 px-4 lg:top-24" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`sb-rise pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg px-4 py-3 text-[14px] shadow-lg ${
          t.tone === 'error' ? 'bg-sb-error text-white' : t.tone === 'success' ? 'bg-sb-success text-white' : 'bg-sb-text text-sb-bg'}`}>
          <p className="flex-1">{t.text}</p>
          <button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss" className="-mr-1 opacity-80 hover:opacity-100"><Close className="h-4 w-4" /></button>
        </div>
      ))}
    </div>
  );
}
