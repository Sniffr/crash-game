import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/api';
import { dateTime } from '../lib/format';
import { useSession } from '../lib/session';
import { Close, Headset, Send } from '../components/glyphs';
import { Logo, Spinner } from '../components/ui';
import { NavHomeIcon } from '../icons';

interface Message { id: number; sender: 'player' | 'agent'; agent: string | null; body: string; createdAt: string }

/**
 * Customer support: a chat panel pinned bottom-right (full screen on phones).
 * Staff answer from the admin support inbox; replies arrive by polling while open.
 */
export function SupportWidget() {
  const { setSupportOpen, account } = useSession();
  const [tab, setTab] = useState<'home' | 'messages'>('home');
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setSupportOpen(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ messages: Message[] }>('/api/account/support/messages', { auth: true });
      setMessages(r.messages);
    } catch { setMessages((m) => m ?? []); }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(load, 8000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (tab === 'messages') listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const r = await api<{ message: Message }>('/api/account/support/messages', { body: { body }, auth: true });
      setMessages((m) => [...(m ?? []), r.message]);
      setDraft('');
      setTab('messages');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your message didn’t send — try again.');
    } finally { setSending(false); }
  };

  const composer = (
    <form onSubmit={send} className="border-t border-sb-line p-3">
      {error && <p role="alert" className="mb-2 text-[13px] text-sb-error">{error}</p>}
      <div className="flex items-end gap-2 rounded-lg border border-sb-line bg-sb-surface px-3 py-2 focus-within:border-sb-primary">
        <label htmlFor="sb-support-msg" className="sr-only">Message</label>
        <textarea id="sb-support-msg" rows={1} maxLength={2000} value={draft} placeholder="Send us a message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(e); } }}
          className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent text-[14px] outline-none placeholder:text-sb-muted" />
        <button type="submit" disabled={!draft.trim() || sending} aria-label="Send"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-sb-primary text-white disabled:opacity-40">
          {sending ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
    </form>
  );

  return (
    <div role="dialog" aria-label="Customer support"
      className="sb-rise fixed inset-0 z-50 flex flex-col bg-sb-header sm:inset-auto sm:bottom-6 sm:right-6 sm:h-[min(640px,calc(100vh-120px))] sm:w-[400px] sm:rounded-2xl sm:border sm:border-sb-line sm:shadow-2xl">
      <div className="flex items-center justify-between px-4 pt-4">
        <Logo size="sm" />
        <button type="button" onClick={close} aria-label="Close support" className="grid h-10 w-10 place-items-center rounded-full hover:bg-sb-surface2">
          <Close className="h-5 w-5" />
        </button>
      </div>

      {tab === 'home' ? (
        <div className="flex flex-1 flex-col">
          <div className="flex-1 px-5 pt-6">
            <h2 className="font-sb-display text-[28px] leading-tight">Hi{account && account.username !== account.phone ? ` ${account.username}` : ' there'}, how can we help?</h2>
            <p className="mt-2 text-[15px] text-sb-muted">Send us a message below and we will get right back.</p>
            {messages && messages.length > 0 && (
              <button type="button" onClick={() => setTab('messages')} className="mt-6 w-full rounded-lg border border-sb-line p-3 text-left hover:border-sb-primary">
                <p className="text-[12px] text-sb-muted">Your conversation</p>
                <p className="mt-1 truncate text-[14px]">{messages[messages.length - 1]!.body}</p>
              </button>
            )}
          </div>
          {composer}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <h2 className="px-5 pt-3 text-center font-sb-display text-[24px]">Messages</h2>
          <div ref={listRef} className="sb-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages == null ? <div className="grid place-items-center py-16"><Spinner className="h-6 w-6 text-sb-primary" /></div>
              : messages.length === 0 ? (
                <div className="py-16 text-center">
                  <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-sb-primary/10 text-sb-accent"><Headset className="h-8 w-8" /></span>
                  <p className="mt-4 text-[15px] text-sb-muted">No new messages at the moment</p>
                </div>
              ) : messages.map((m) => (
                <div key={m.id} className={`flex ${m.sender === 'player' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[14px] ${m.sender === 'player' ? 'rounded-br-sm bg-sb-primary text-white' : 'rounded-bl-sm bg-sb-surface2'}`}>
                    <p className={`mb-0.5 text-[11px] ${m.sender === 'player' ? 'text-white/70' : 'text-sb-muted'}`}>
                      {m.sender === 'player' ? 'You' : m.agent ?? 'SimBet Support'} · {dateTime(m.createdAt)}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  </div>
                </div>
              ))}
          </div>
          {composer}
        </div>
      )}

      <div className="grid grid-cols-2 border-t border-sb-line pb-[env(safe-area-inset-bottom)] text-[13px]">
        {(['home', 'messages'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t}
            className={`flex flex-col items-center gap-1 py-2.5 ${tab === t ? 'font-semibold text-sb-accent' : 'text-sb-muted'}`}>
            {t === 'home' ? <NavHomeIcon className="h-6 w-12" /> : <Send className="h-5 w-5" />}
            {t === 'home' ? 'Home' : 'Messages'}
          </button>
        ))}
      </div>
    </div>
  );
}
