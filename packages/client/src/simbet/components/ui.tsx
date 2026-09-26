import {
  forwardRef, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode,
} from 'react';
import { LogoMark } from '../icons';
import { ArrowLeft, CaretDown, Check, ChevronLeft, ChevronRight, Close, Eye, EyeOff } from './glyphs';
import { navigate } from '../lib/router';

// ─── Brand ───────────────────────────────────────────────────────────────────

/** "SimBet" logo: the mark + "Sim" in text colour + "Bet" in primary. */
export function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const s = size === 'lg' ? { mark: 'h-10 w-10', text: 'text-[40px]' } : size === 'sm' ? { mark: 'h-7 w-7', text: 'text-[26px]' } : { mark: 'h-9 w-9', text: 'text-[36px]' };
  return (
    <span className="inline-flex items-center gap-0.5 font-sb-display leading-none" aria-label="SimBet">
      <LogoMark className={s.mark} />
      <span className={s.text} aria-hidden>
        <span className="text-sb-text">Sim</span><span className="text-sb-primary">Bet</span>
      </span>
    </span>
  );
}

// ─── Buttons ─────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'soft';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-sb-primary text-white hover:brightness-110 disabled:brightness-100',
  outline: 'border border-sb-primary text-sb-accent hover:bg-sb-primary/10',
  ghost: 'text-sb-muted hover:text-sb-text hover:bg-sb-surface2',
  danger: 'border border-sb-error text-sb-error hover:bg-sb-error/10',
  soft: 'bg-sb-surface2 text-sb-text hover:bg-sb-line',
};
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[15px]',
  md: 'h-10 px-5 text-[18px]',
  lg: 'h-12 px-6 text-[20px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; size?: ButtonSize; busy?: boolean;
}>(function Button({ variant = 'primary', size = 'md', busy = false, className = '', children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      className={`inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-sb-display leading-none transition-[filter,background-color,color,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {busy ? <Spinner className="h-4 w-4" /> : null}
      {children}
    </button>
  );
});

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ─── Form fields ─────────────────────────────────────────────────────────────

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | null;
  hint?: ReactNode;
  prefix?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, error, hint, prefix, className = '', id, ...rest }, ref) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div className={className}>
      <label htmlFor={fieldId} className="mb-1.5 block font-sb-form text-[14px] font-medium text-sb-text">{label}</label>
      <div className={`flex h-11 items-center rounded-md bg-sb-input/20 ring-sb-primary/60 focus-within:ring-2 ${error ? 'ring-2 ring-sb-error/70' : ''}`}>
        {prefix && <span className="pl-3 font-sb-form text-[14px] text-sb-muted">{prefix}</span>}
        <input
          ref={ref}
          id={fieldId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-err` : undefined}
          className="h-full min-w-0 flex-1 bg-transparent px-3 font-sb-form text-[15px] text-sb-text outline-none placeholder:text-sb-muted/70"
          {...rest}
        />
      </div>
      {error ? <p id={`${fieldId}-err`} role="alert" className="mt-1.5 font-sb-form text-[13px] text-sb-error">{error}</p>
        : hint ? <p className="mt-1.5 font-sb-form text-[12px] text-sb-muted">{hint}</p> : null}
    </div>
  );
});

export function PasswordField(props: Omit<FieldProps, 'type'>) {
  const [shown, setShown] = useState(false);
  const auto = useId();
  const fieldId = props.id ?? auto;
  return (
    <div className={props.className}>
      <label htmlFor={fieldId} className="mb-1.5 block font-sb-form text-[14px] font-medium text-sb-text">{props.label}</label>
      <div className={`flex h-11 items-center rounded-md bg-sb-input/20 ring-sb-primary/60 focus-within:ring-2 ${props.error ? 'ring-2 ring-sb-error/70' : ''}`}>
        <input
          {...props}
          id={fieldId}
          className="h-full min-w-0 flex-1 bg-transparent px-3 font-sb-form text-[15px] text-sb-text outline-none placeholder:text-sb-muted/70"
          type={shown ? 'text' : 'password'}
        />
        <button type="button" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide password' : 'Show password'}
          className="grid h-11 w-11 shrink-0 place-items-center text-sb-muted hover:text-sb-text">
          {shown ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
        </button>
      </div>
      {props.error ? <p role="alert" className="mt-1.5 font-sb-form text-[13px] text-sb-error">{props.error}</p>
        : props.hint ? <p className="mt-1.5 font-sb-form text-[12px] text-sb-muted">{props.hint}</p> : null}
    </div>
  );
}

/** Six single-digit boxes that behave as one field (paste, backspace, arrows). */
export function OtpInput({ value, onChange, onComplete, disabled }: {
  value: string; onChange: (v: string) => void; onComplete?: (v: string) => void; disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  useEffect(() => { refs.current[0]?.focus(); }, []);

  const set = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, 6);
    onChange(clean);
    if (clean.length === 6) onComplete?.(clean);
    refs.current[Math.min(clean.length, 5)]?.focus();
  };
  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      set(value.slice(0, i > value.length - 1 ? value.length - 1 : i) + value.slice(i + 1));
      refs.current[Math.max(0, i - 1)]?.focus();
    } else if (e.key === 'ArrowLeft') refs.current[Math.max(0, i - 1)]?.focus();
    else if (e.key === 'ArrowRight') refs.current[Math.min(5, i + 1)]?.focus();
  };
  return (
    <div className="flex justify-center gap-2 sm:gap-3" role="group" aria-label="One-time code">
      {Array.from({ length: 6 }, (_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          value={value[i] ?? ''}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${i + 1}`}
          maxLength={6}
          onKeyDown={(e) => onKey(i, e)}
          onChange={(e) => set(value.slice(0, i) + e.target.value.replace(/\D/g, '') + value.slice(i + 1))}
          onFocus={(e) => e.target.select()}
          className="h-12 w-11 rounded-md border border-sb-line bg-sb-surface text-center font-sb-form text-[20px] font-semibold text-sb-text outline-none focus:border-sb-primary focus:ring-2 focus:ring-sb-primary/30 sm:h-14 sm:w-12"
        />
      ))}
    </div>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[15px] text-sb-text">
      <span className={`grid h-5 w-5 place-items-center rounded ${checked ? 'bg-sb-primary text-white' : 'border border-sb-line bg-sb-surface'}`}>
        {checked && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
      </span>
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────────

/**
 * The design's 640px dialog: logo on top, centred copy, pill actions. Closes on
 * Escape and on a backdrop click; keeps focus inside while open.
 */
export function Modal({
  onClose, children, width = 'max-w-[640px]', showLogo = true, labelledBy, padded = true,
}: {
  onClose: () => void; children: ReactNode; width?: string; showLogo?: boolean; labelledBy?: string; padded?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('input, button:not([data-close]), [href], select, textarea');
    (first ?? panel.current)?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
        if (items.length === 0) return;
        const [a, z] = [items[0]!, items[items.length - 1]!];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="sb-fade fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/20 px-4 py-10 backdrop-blur-[2px] sm:items-center dark:bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}
        className={`sb-rise relative w-full ${width} rounded-xl bg-sb-surface text-sb-text shadow-[0_24px_64px_-16px_rgb(15_23_42/0.35)] outline-none ${padded ? 'px-5 pb-8 pt-10 sm:px-16' : ''}`}>
        <button type="button" data-close onClick={onClose} aria-label="Close"
          className="absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-full text-sb-text hover:bg-sb-surface2">
          <Close className="h-5 w-5" />
        </button>
        {showLogo && <div className="mb-5 flex justify-center"><Logo /></div>}
        {children}
      </div>
    </div>
  );
}

export function ModalTitle({ id, children, sub }: { id?: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-6 text-center">
      <h2 id={id} className="font-sb-display text-[26px] leading-tight text-sb-text">{children}</h2>
      {sub && <p className="mx-auto mt-1.5 max-w-sm text-[15px] text-sb-muted">{sub}</p>}
    </div>
  );
}

// ─── Tabs, badges, dropdown, pagination ──────────────────────────────────────

export function Tabs<K extends string>({ items, value, onChange, className = '', size = 'md' }: {
  items: ReadonlyArray<{ key: K; label: ReactNode }>; value: K; onChange: (k: K) => void; className?: string; size?: 'sm' | 'md';
}) {
  return (
    <div role="tablist" className={`sb-noscroll flex min-w-0 overflow-x-auto ${className}`}>
      {items.map((t) => {
        const active = t.key === value;
        return (
          <button key={t.key} type="button" role="tab" aria-selected={active} onClick={() => onChange(t.key)}
            className={`shrink-0 whitespace-nowrap border-b-2 px-4 ${size === 'sm' ? 'py-1.5 text-[14px]' : 'py-2 text-[16px]'} transition-colors ${
              active ? 'border-sb-primary font-semibold text-sb-accent' : 'border-transparent text-sb-text hover:text-sb-accent'}`}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export type BadgeTone = 'active' | 'won' | 'lost' | 'pending' | 'success' | 'failed' | 'neutral';

const BADGE: Record<BadgeTone, string> = {
  active: 'bg-sb-primary text-white',
  won: 'bg-sb-success text-white',
  success: 'bg-sb-success text-white',
  lost: 'bg-sb-error text-white dark:bg-[#7f1d1d]',
  failed: 'bg-sb-error text-white dark:bg-[#7f1d1d]',
  pending: 'bg-sb-pending text-white',
  neutral: 'bg-sb-surface2 text-sb-muted',
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium leading-5 ${BADGE[tone]}`}>
      {tone === 'won' && <Check className="h-3 w-3" strokeWidth={2.5} />}
      {tone === 'lost' && <Close className="h-3 w-3" strokeWidth={2.5} />}
      {children}
    </span>
  );
}

/** The design's pill dropdown ("Today ▾", "All Dates ▾", "Select ▾"). */
export function Dropdown<K extends string>({ value, options, onChange, label, block = false, placeholder = 'Select' }: {
  value: K | null; options: ReadonlyArray<{ key: K; label: string }>; onChange: (k: K) => void; label: string; block?: boolean; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const current = options.find((o) => o.key === value);
  return (
    <div ref={root} className={`relative ${block ? 'w-full' : ''}`}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}
        className={`flex items-center justify-between gap-6 border border-sb-line bg-sb-header text-[15px] text-sb-text ${
          block ? 'h-11 w-full rounded-md px-3' : 'h-11 rounded-full px-5 shadow-sm'}`}>
        <span className={current ? '' : 'text-sb-muted'}>{current?.label ?? placeholder}</span>
        <CaretDown className={`h-5 w-5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul role="listbox" aria-label={label}
          className={`sb-fade absolute z-30 mt-1 min-w-full overflow-hidden rounded-md border border-sb-line bg-sb-header py-1 shadow-lg ${block ? 'left-0 right-0' : 'right-0'}`}>
          {options.map((o) => (
            <li key={o.key} role="option" aria-selected={o.key === value}>
              <button type="button" onClick={() => { onChange(o.key); setOpen(false); }}
                className={`block w-full whitespace-nowrap px-4 py-2 text-left text-[14px] hover:bg-sb-surface2 ${o.key === value ? 'font-semibold text-sb-accent' : 'text-sb-text'}`}>
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  // 1 … around-current … last, as in the design's mobile pager.
  const nums = [...new Set([1, page - 1, page, page + 1, pages].filter((n) => n >= 1 && n <= pages))].sort((a, b) => a - b);
  const items: Array<number | 'gap'> = [];
  nums.forEach((n, i) => { if (i > 0 && n - nums[i - 1]! > 1) items.push('gap'); items.push(n); });
  const btn = 'grid h-8 min-w-8 place-items-center rounded-md px-1.5 text-[14px]';
  return (
    <nav className="mt-6 flex items-center justify-center gap-1.5" aria-label="Pages">
      <button type="button" className={`${btn} text-sb-text disabled:opacity-30`} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
        <ChevronLeft className="h-4 w-4" />
      </button>
      {items.map((n, i) => n === 'gap'
        ? <span key={`g${i}`} className="px-1 text-sb-muted">…</span>
        : (
          <button key={n} type="button" onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined}
            className={`${btn} ${n === page ? 'bg-sb-primary text-white' : 'text-sb-text hover:bg-sb-surface2'}`}>{n}</button>
        ))}
      <button type="button" className={`${btn} text-sb-text disabled:opacity-30`} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
        <ChevronRight className="h-4 w-4" />
      </button>
    </nav>
  );
}

// ─── Page scaffolding ────────────────────────────────────────────────────────

/** "← Bet History" page header, as on the account pages. */
export function PageHeader({ title, back, icon, action }: { title: string; back?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="border-b border-sb-line">
      <div className="mx-auto flex max-w-[1396px] items-center gap-3 px-4 py-5 sm:px-[22px]">
        {back && (
          <button type="button" onClick={() => (window.history.length > 1 ? window.history.back() : navigate(back))} aria-label="Back"
            className="-ml-2 grid h-10 w-10 place-items-center rounded-full text-sb-text hover:bg-sb-surface2">
            <ArrowLeft className="h-6 w-6" />
          </button>
        )}
        {icon}
        <h1 className="min-w-0 flex-1 truncate font-sb-display text-[26px] leading-tight text-sb-text sm:text-[32px]">{title}</h1>
        {action}
      </div>
    </div>
  );
}

export function SectionTitle({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      {icon && <span className="text-sb-text">{icon}</span>}
      <h2 className="min-w-0 flex-1 font-sb-display text-[26px] leading-tight text-sb-text sm:text-[32px]">{children}</h2>
      {action}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-sb-line bg-sb-surface px-6 py-14 text-center">
      <p className="font-sb-display text-[22px] text-sb-text">{title}</p>
      {body && <p className="mx-auto mt-1.5 max-w-sm text-[14px] text-sb-muted">{body}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-md bg-sb-error/10 px-3 py-2 text-[14px] text-sb-error">{children}</p>;
}
