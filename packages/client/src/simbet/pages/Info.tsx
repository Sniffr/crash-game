import type { ReactNode } from 'react';
import { PRIVACY, TERMS, type LegalSection } from '../content/legal';
import { CONTACT } from '../content/site';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { Bolt, Gift, Shield } from '../components/glyphs';
import { Button, PageHeader } from '../components/ui';

// ─── Coming soon: Bet with AI, Promotions ────────────────────────────────────

export function BetWithAiPage() {
  return (
    <ComingSoon
      title="Bet with AI"
      image="/simbet/bet-bot.jpg"
      lead="Bet Bot is on its way."
      body="Ask about upcoming matches, compare odds and build a slip by chatting — your AI betting assistant is being trained on the same real odds that price Simulated Matches."
      points={['Odds and form for any fixture, on request', 'Slip suggestions you can edit before placing', 'Answers grounded in live match data']}
    />
  );
}

export function PromotionsPage() {
  return (
    <ComingSoon
      title="Promotions"
      icon={<Gift className="h-14 w-14" />}
      lead="Promotions are coming soon."
      body="Daily cashback, deposit bonuses and login rewards are in the works. We’ll only launch an offer once its terms are final — check back here."
      points={['Daily Cashback on every single bet', 'Deposit Bonus', 'Daily Login rewards']}
    />
  );
}

function ComingSoon({ title, image, icon, lead, body, points }: {
  title: string; image?: string; icon?: ReactNode; lead: string; body: string; points: string[];
}) {
  return (
    <>
      <PageHeader title={title} />
      <div className="mx-auto max-w-[760px] px-4 pt-10 text-center">
        {image
          ? <img src={image} alt="" className="mx-auto h-40 w-40 rounded-full object-cover ring-4 ring-sb-primary/30" />
          : <span className="mx-auto grid h-32 w-32 place-items-center rounded-full bg-sb-primary/10 text-sb-accent">{icon}</span>}
        <span className="mt-6 inline-block rounded-full bg-sb-primary px-3 py-1 text-[12px] font-semibold uppercase tracking-wide text-white">Coming soon</span>
        <h2 className="mt-4 font-sb-display text-[34px] leading-tight sm:text-[40px]">{lead}</h2>
        <p className="mx-auto mt-3 max-w-xl text-[16px] text-sb-muted">{body}</p>
        <ul className="mx-auto mt-8 grid max-w-xl gap-3 text-left sm:grid-cols-3">
          {points.map((p) => (
            <li key={p} className="rounded-xl border border-sb-line bg-sb-surface p-4 text-[14px]">
              <Bolt className="mb-2 h-5 w-5 text-sb-accent" />{p}
            </li>
          ))}
        </ul>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Button onClick={() => navigate('/matches')}>Play Simulated Matches</Button>
          <Button variant="outline" onClick={() => navigate('/fantasy')}>Join a Fantasy League</Button>
        </div>
      </div>
    </>
  );
}

// ─── Legal & help ────────────────────────────────────────────────────────────

function Document({ title, sections }: { title: string; sections: LegalSection[] }) {
  return (
    <>
      <PageHeader title={title} />
      <article className="mx-auto max-w-[900px] px-4 pt-8 text-[15px] leading-relaxed">
        {sections.map((s, i) => (
          <section key={i} className="mb-8">
            {s.heading && <h2 className="mb-3 font-sb-display text-[24px] leading-tight">{s.heading}</h2>}
            {s.paragraphs.flatMap((p) => p.split('\n')).map((p, j) => <p key={j} className="mb-3 text-sb-text/90">{p}</p>)}
          </section>
        ))}
      </article>
    </>
  );
}

export const TermsPage = () => <Document title="Terms & Conditions" sections={TERMS} />;
export const PrivacyPage = () => <Document title="Privacy Policy" sections={PRIVACY} />;

export function ResponsibleGamingPage() {
  const { token, requireAuth } = useSession();
  return (
    <>
      <PageHeader title="Responsible Gaming" icon={<Shield className="h-7 w-7 shrink-0" />} />
      <article className="mx-auto max-w-[900px] px-4 pt-8 text-[15px] leading-relaxed text-sb-text/90">
        <p className="mb-4">Betting should be entertainment, never a way to make money or escape problems. SimBet is for adults aged 18 and over only.</p>
        <h2 className="mb-2 mt-6 font-sb-display text-[24px] text-sb-text">Stay in control</h2>
        <ul className="mb-4 list-disc space-y-1 pl-6">
          <li>Decide how much you can afford to lose before you play, and stop when you reach it.</li>
          <li>Never chase losses or bet with money meant for rent, bills or food.</li>
          <li>Take regular breaks, and don’t bet when you’re upset, stressed or have been drinking.</li>
        </ul>
        <h2 className="mb-2 mt-6 font-sb-display text-[24px] text-sb-text">Tools on your account</h2>
        <ul className="mb-4 list-disc space-y-1 pl-6">
          <li><b>Self exclusion</b> — lock yourself out for 24 hours up to 90 days. It can’t be undone early.</li>
          <li><b>Deactivate account</b> — close your account; you can reactivate it later with an SMS code.</li>
        </ul>
        <Button variant="outline" className="mt-2" onClick={() => requireAuth(() => navigate('/account/settings?tab=exclusion'))}>
          {token ? 'Open self exclusion' : 'Log in to set limits'}
        </Button>
        <h2 className="mb-2 mt-8 font-sb-display text-[24px] text-sb-text">Need to talk?</h2>
        <p>If gambling is causing you harm, contact our support team on {CONTACT.phone} or {CONTACT.email}, and reach out to a counsellor or a trusted person near you.</p>
      </article>
    </>
  );
}

const FAQS: Array<[string, string]> = [
  ['What are Simulated Matches?', 'Real upcoming fixtures, priced from real bookmaker odds. When you place a bet, the match is simulated instantly by a provably fair engine — you get the result straight away instead of waiting for kick-off.'],
  ['Can I check a result was fair?', 'Yes. Every bet shows a provably-fair proof: a commitment published before the result, and the seed revealed after it, so anyone can recompute the outcome.'],
  ['How do deposits work?', 'Tap Deposit, enter an amount and approve the M-PESA prompt on your phone. Your balance updates as soon as M-PESA confirms.'],
  ['How do withdrawals work?', 'Withdrawals are sent by M-PESA to the phone number on your account, usually within minutes. You’ll see each one under Transactions.'],
  ['How does Fantasy League work?', 'Pick 11 real Premier League players for a gameweek within budget, choose a captain (double points) and join a league. Official Fantasy Premier League points decide the table, and the top three share the prize pool.'],
  ['I forgot my password.', 'Choose “Forgot Password?” on the login screen. We’ll text a code to your phone so you can set a new one.'],
  ['How do I reactivate my account?', 'Use “Reactivate Account” in the footer. We’ll text you a code and you’ll set a new password.'],
];

export function FaqsPage() {
  return (
    <>
      <PageHeader title="FAQs" />
      <div className="mx-auto max-w-[900px] px-4 pt-8">
        {FAQS.map(([q, a]) => (
          <details key={q} className="group mb-3 rounded-xl border border-sb-line bg-sb-surface px-5 py-4 open:border-sb-primary/60">
            <summary className="cursor-pointer list-none font-semibold marker:hidden">{q}</summary>
            <p className="mt-2 text-[15px] leading-relaxed text-sb-muted">{a}</p>
          </details>
        ))}
      </div>
    </>
  );
}

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-[600px] px-4 py-24 text-center">
      <p className="font-sb-display text-[64px] text-sb-accent">404</p>
      <p className="mt-2 text-[16px] text-sb-muted">That page doesn’t exist.</p>
      <Button className="mt-6" onClick={() => navigate('/')}>Back to Home</Button>
    </div>
  );
}
