import { useEffect, type ReactNode } from 'react';
import { useLocation } from './lib/router';
import { SessionProvider, useSession } from './lib/session';
import { BottomNav, Footer, Header, Toasts } from './components/Shell';
import { Button, Empty, Spinner } from './components/ui';
import { SlipProvider } from './matches/slip';
import { SlipDock } from './matches/Betslip';
import AuthModal from './modals/AuthModal';
import { DepositModal, WithdrawModal } from './modals/WalletModals';
import { SupportWidget } from './modals/SupportWidget';
import Home from './pages/Home';
import Matches from './pages/Matches';
import { FantasyHome, FantasyLeaguePage } from './pages/Fantasy';
import { AccountPage, BetHistoryPage, TransactionsPage } from './pages/Account';
import SettingsPage from './pages/Settings';
import {
  BetWithAiPage, FaqsPage, NotFoundPage, PrivacyPage, PromotionsPage, ResponsibleGamingPage, TermsPage,
} from './pages/Info';

/**
 * SimBet — simbet.games.soa.plus. Its own site (header, footer, theme, accounts by
 * phone) over the same server as Game Hub: Simulated Matches with the real
 * KES wallet, and Fantasy League.
 */
export default function SimBetApp() {
  return (
    <SessionProvider>
      <SlipProvider>
        <Layout />
      </SlipProvider>
    </SessionProvider>
  );
}

const TITLES: Array<[RegExp, string]> = [
  [/^\/matches/, 'Simulated Matches'],
  [/^\/fantasy/, 'Fantasy League'],
  [/^\/bet-ai/, 'Bet with AI'],
  [/^\/promotions/, 'Promotions'],
  [/^\/account\/bets/, 'Bet History'],
  [/^\/account\/transactions/, 'Transactions'],
  [/^\/account\/settings/, 'Settings'],
  [/^\/account/, 'Profile'],
  [/^\/terms/, 'Terms & Conditions'],
  [/^\/privacy/, 'Privacy Policy'],
  [/^\/responsible-gaming/, 'Responsible Gaming'],
  [/^\/faqs/, 'FAQs'],
];

function Layout() {
  const { path } = useLocation();
  const { modal, closeModal, supportOpen } = useSession();

  useEffect(() => {
    const t = TITLES.find(([re]) => re.test(path))?.[1];
    document.title = t ? `${t} · SimBet` : 'SimBet';
  }, [path]);

  return (
    <div className="flex min-h-screen flex-col bg-sb-bg font-sb-body text-sb-text">
      <a href="#sb-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded focus:bg-sb-primary focus:px-3 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <Header />
      <main id="sb-main" className="flex-1 pb-6">
        <Routes path={path} />
      </main>
      <Footer />
      <BottomNav />
      <SlipDock />
      <Toasts />

      {(modal === 'login' || modal === 'register' || modal === 'forgot' || modal === 'reactivate') && (
        <AuthModal key={modal} entry={modal} onClose={closeModal} />
      )}
      {modal === 'deposit' && <DepositModal onClose={closeModal} />}
      {modal === 'withdraw' && <WithdrawModal onClose={closeModal} />}
      {supportOpen && <SupportWidget />}
    </div>
  );
}

function Routes({ path }: { path: string }) {
  if (path === '/') return <Home />;
  if (path === '/matches') return <Matches />;
  if (path === '/fantasy') return <FantasyHome />;
  const league = /^\/fantasy\/([^/]+)$/.exec(path);
  if (league) return <FantasyLeaguePage key={league[1]} leagueId={decodeURIComponent(league[1]!)} />;
  if (path === '/bet-ai') return <BetWithAiPage />;
  if (path === '/promotions') return <PromotionsPage />;
  if (path === '/account') return <SignedIn><AccountPage /></SignedIn>;
  if (path === '/account/bets') return <SignedIn><BetHistoryPage /></SignedIn>;
  if (path === '/account/transactions') return <SignedIn><TransactionsPage /></SignedIn>;
  if (path === '/account/settings') return <SignedIn><SettingsPage /></SignedIn>;
  if (path === '/terms') return <TermsPage />;
  if (path === '/privacy') return <PrivacyPage />;
  if (path === '/responsible-gaming') return <ResponsibleGamingPage />;
  if (path === '/faqs') return <FaqsPage />;
  return <NotFoundPage />;
}

/** Account pages: wait for a saved session to be checked, else ask to log in. */
function SignedIn({ children }: { children: ReactNode }) {
  const { ready, token, openModal } = useSession();
  if (!ready) return <div className="grid place-items-center py-32"><Spinner className="h-10 w-10 text-sb-primary" /></div>;
  if (!token) {
    return (
      <div className="mx-auto max-w-[600px] px-4 py-16">
        <Empty title="Log in to see your account" body="Your balance, bets and settings are here once you’re signed in."
          action={<div className="flex gap-3"><Button onClick={() => openModal('login')}>Login</Button><Button variant="outline" onClick={() => openModal('register')}>Register</Button></div>} />
      </div>
    );
  }
  return <>{children}</>;
}
