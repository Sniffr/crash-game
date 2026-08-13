import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

/**
 * Shared chrome for the lobby and Simulate — the "terminal" layer.
 *
 * The design decisions these primitives encode, once, so no call site has to
 * re-derive them:
 *
 *   Depth        edges only. No shadows (they don't read on near-black) and no
 *                surface gradients. Hierarchy comes from lightness + space.
 *   Surfaces     canvas space-950 (3%) → panel space-850 (7%) → raised
 *                space-800 (10%). Inputs go DARKER than their surround (3%),
 *                because an input is inset — it receives content.
 *   Accent       ember #fb6514 only, and sparingly (~10% of any view). Green =
 *                money in, red = money lost, amber = cash-out. Colour means
 *                something or it isn't used.
 *   Type         Poppins. Three levers — size, weight, colour — never size
 *                alone. Uppercase letter-spacing is reserved for <Eyebrow>;
 *                when every label is tracked out, tracking stops signalling.
 *   Motion       150ms, ease-snap, transform/opacity only, scale(0.97) press.
 */

// ─── Button ──────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_BASE = [
  'inline-flex items-center justify-center gap-2 rounded-btn font-semibold whitespace-nowrap',
  'transition-[background-color,border-color,color,opacity,transform] duration-150 ease-snap',
  'active:scale-[0.97]',
  'disabled:pointer-events-none',
].join(' ');

// Disabled is declared per-variant, not as one blanket opacity: a 40%-opacity
// ember fill on near-black turns into a muddy brown smear that reads as broken
// rather than inert, so the primary drops to a neutral surface instead.
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // The one loud thing on screen. Black text on ember — the accent carries the
  // single action the user came for.
  primary: 'bg-brand-500 text-black hover:bg-brand-400 disabled:bg-white/[0.05] disabled:text-neutral-600',
  // A real control, but demoted: it borrows the raised surface, not the accent.
  secondary: 'bg-white/[0.05] text-neutral-200 border border-edge hover:bg-white/[0.09] hover:text-white disabled:opacity-40',
  // Text-weight action. No box until you're pointing at it.
  quiet: 'text-neutral-400 hover:text-white hover:bg-white/[0.06] disabled:opacity-40',
  // Destructive / dismissive.
  ghost: 'text-neutral-500 hover:text-loss-400 disabled:opacity-40',
};

// 40px is the hit-area floor for every size — `sm` is smaller in padding and
// type, never in touch target. (An earlier 36px `sm` failed the tap audit on
// the stake chips and the lobby's Demo button.)
const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-10 px-3 text-xs',
  md: 'h-10 px-4 text-[13px]',
  lg: 'h-12 px-6 text-sm',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type="button"
      {...rest}
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
    />
  );
}

// ─── App bar ─────────────────────────────────────────────────────────────────

/**
 * 56px of chrome, shared by the lobby and Simulate so they read as one product.
 * Same background as the canvas — a bar in its own colour would split the page
 * into "header world" and "content world". A single hairline is enough.
 */
export function AppBar({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-edge-soft bg-space-950/85 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-[1080px] items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">{left}</div>
        <div className="flex shrink-0 items-center gap-2">{right}</div>
      </div>
    </header>
  );
}

/** The mark: a solid ember lozenge, the name, and a caption behind a hairline. */
export function Wordmark({ caption }: { caption?: string }) {
  return (
    <a href="/" className="flex h-10 min-w-0 items-center gap-2.5 rounded-btn">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-btn bg-brand-500">
        <RocketGlyph className="h-4 w-4 text-black" />
      </span>
      <span className="whitespace-nowrap text-[15px] font-bold tracking-tight text-neutral-100">Game Hub</span>
      {caption && (
        <>
          <span className="hidden h-4 w-px shrink-0 bg-white/10 sm:block" aria-hidden />
          <span className="hidden truncate text-[11px] font-medium text-neutral-500 sm:block">{caption}</span>
        </>
      )}
    </a>
  );
}

/**
 * A wallet / balance readout. Two tiers at one small size — the owner line in
 * muted 400, the figure in 600 — so it stays legible without shouting over the
 * page's one focal number.
 */
export function Readout({ label, value, className = '' }: { label: string; value: ReactNode; className?: string }) {
  return (
    // Capped: a long username would otherwise stretch this flex child and push
    // the rest of the bar off a narrow screen.
    <div
      title={label}
      className={`flex h-10 max-w-[9.5rem] flex-col justify-center rounded-btn border border-edge bg-white/[0.04] px-3 leading-none ${className}`}
    >
      <span className="truncate text-[10px] font-medium text-neutral-500">{label}</span>
      <span className="mt-1 truncate text-[13px] font-semibold tabular-nums text-neutral-100">{value}</span>
    </div>
  );
}

// ─── Surfaces ────────────────────────────────────────────────────────────────

export function Panel({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-card border border-edge bg-space-850 ${className}`}>{children}</div>
  );
}

/** The section label — the ONLY place uppercase tracking is allowed. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500 ${className}`}>
      {children}
    </span>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'up';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-white/[0.06] text-neutral-400 border-edge',
    accent: 'bg-brand-500/12 text-brand-300 border-brand-500/25',
    up: 'bg-bet-500/12 text-bet-400 border-bet-500/25',
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * A labelled readout. Hierarchy is carried by weight and colour, not size —
 * label 400/muted over value 600/primary at the same small scale still reads
 * as two clear tiers.
 */
export function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'up' | 'down' | 'accent';
}) {
  const tones = {
    default: 'text-neutral-200',
    up: 'text-bet-400',
    down: 'text-loss-400',
    accent: 'text-brand-400',
  } as const;
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-600">{label}</div>
      <div className={`mt-0.5 text-[15px] font-semibold tabular-nums truncate ${tones[tone]}`}>{value}</div>
    </div>
  );
}

/** Pulsing dot — only rendered once a round has actually been observed to tick. */
export function LiveDot({ className = '' }: { className?: string }) {
  return (
    <span className={`relative inline-flex h-1.5 w-1.5 shrink-0 ${className}`} aria-hidden>
      <span className="animate-pulse-dot absolute inset-0 rounded-full bg-bet-400" />
    </span>
  );
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * Text input. Sunk below its surround (space-950 on a space-850 panel) so the
 * "type here" affordance comes from depth rather than a heavy border. `prefix`
 * renders a currency symbol or unit inside the well.
 */
export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: ReactNode; prefix?: ReactNode }
>(function TextInput({ label, hint, prefix, className = '', ...rest }, ref) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-medium text-neutral-400">{label}</span>
          {hint && <span className="text-[11px] text-neutral-600">{hint}</span>}
        </span>
      )}
      <span className="flex items-center gap-2 rounded-btn border border-edge bg-space-950 px-3 transition-colors duration-150 ease-snap focus-within:border-brand-500/60">
        {prefix && <span className="shrink-0 text-sm text-neutral-500">{prefix}</span>}
        <input
          ref={ref}
          {...rest}
          className={`h-11 w-full min-w-0 bg-transparent text-[15px] font-medium text-neutral-100 outline-none placeholder:text-neutral-600 ${className}`}
        />
      </span>
    </label>
  );
});

// ─── Modal ───────────────────────────────────────────────────────────────────

/**
 * The behaviour contract every overlay owes, in one place: Escape, scroll lock,
 * focus moved in on open and returned to the opener on close, and Tab kept
 * inside the panel. Shared by Modal and Drawer so a new overlay can't quietly
 * ship without it.
 */
function useOverlay(panelRef: { current: HTMLElement | null }, onClose: () => void) {
  // Held in a ref so the effect runs ONCE per overlay: call sites pass inline
  // arrows, and re-running setup on every parent render re-focuses the panel —
  // focus jumps out of whatever you were typing in mid-interaction.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    // Land on the first field, not the close button — the close button is first
    // in the DOM but is the last thing anyone opening a dialog wants.
    const preferred =
      panelRef.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      panelRef.current?.querySelector<HTMLElement>('input:not([disabled]), textarea, select') ??
      focusables()[0];
    (preferred ?? panelRef.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [panelRef]);
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 'max-w-sm',
  padded = true,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  /** Off when the child brings its own edge-to-edge structure (lists, tickets). */
  padded?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useOverlay(panelRef, onClose);

  return (
    // Scroll lives on the backdrop and the panel is centred by a min-h-full flex
    // wrapper — `place-items-center` on a scrolling parent clips the top of any
    // dialog taller than the viewport.
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/75 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex min-h-full items-center justify-center p-4"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          className={`animate-rise w-full ${width} overflow-hidden rounded-card border border-edge-strong bg-space-850 outline-none`}
        >
          <div className="flex items-center justify-between gap-3 border-b border-edge-soft px-5 py-4">
            <h2 className="text-[15px] font-semibold text-neutral-100">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-2 grid h-10 w-10 shrink-0 place-items-center rounded-btn text-neutral-500 transition-colors duration-150 ease-snap hover:bg-white/[0.06] hover:text-neutral-200"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <div className={padded ? 'px-5 py-5' : ''}>{children}</div>
          {footer && <div className="border-t border-edge-soft px-5 py-4">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

/** Side panel. Same contract as Modal — it just enters from the edge. */
export function Drawer({
  title,
  onClose,
  children,
  width = 'max-w-md',
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useOverlay(panelRef, onClose);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`animate-slide-in h-full w-full ${width} overflow-y-auto border-l border-edge-strong bg-space-850 outline-none`}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-edge-soft bg-space-850 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-neutral-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 grid h-10 w-10 shrink-0 place-items-center rounded-btn text-neutral-500 transition-colors duration-150 ease-snap hover:bg-white/[0.06] hover:text-neutral-200"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────
// One stroke weight (1.8), one cap style, throughout.

const ICON = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function RocketGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

export function BallGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" />
      <path d="M12 7.4l3.9 2.8-1.5 4.6h-4.8L8.1 10.2z" />
      <path d="M12 2.8v4.6M20.6 9.9l-4.7.3M18.4 19.4l-4-4.6M5.6 19.4l4-4.6M3.4 9.9l4.7.3" />
    </svg>
  );
}

export function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} strokeWidth={2.2} aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function MinusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}

export function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function SpeakerIcon({ className, muted = false }: { className?: string; muted?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} aria-hidden="true">
      <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" />
      {muted ? (
        <path d="M22 9l-5 6M17 9l5 6" />
      ) : (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      )}
    </svg>
  );
}

export function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function LogOutIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} aria-hidden="true">
      <path d="M15 17l5-5-5-5M20 12H9M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

export function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...ICON} aria-hidden="true">
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <span
      className={`inline-block shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60 ${className}`}
      aria-hidden
    />
  );
}
