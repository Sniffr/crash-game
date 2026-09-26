import type { SVGProps } from 'react';

// Line icons for SimBet chrome, drawn on a 24px grid at 1.5px stroke to sit
// with the Figma's Iconsax set. Colour comes from `currentColor`.

type P = SVGProps<SVGSVGElement>;

function Line({ children, ...props }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export const ChevronRight = (p: P) => <Line {...p}><path d="m9 6 6 6-6 6" /></Line>;
export const ChevronLeft = (p: P) => <Line {...p}><path d="m15 6-6 6 6 6" /></Line>;
export const ChevronDown = (p: P) => <Line {...p}><path d="m6 9 6 6 6-6" /></Line>;
export const ArrowLeft = (p: P) => <Line {...p}><path d="M20 12H4m6-6-6 6 6 6" /></Line>;
export const Close = (p: P) => <Line {...p}><path d="M18 6 6 18M6 6l12 12" /></Line>;
export const Check = (p: P) => <Line {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Line>;
export const Info = (p: P) => <Line {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Line>;
export const PlusCircle = (p: P) => <Line {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></Line>;
export const Eye = (p: P) => <Line {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></Line>;
export const EyeOff = (p: P) => <Line {...p}><path d="M10.6 5.6A9.9 9.9 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-2.9 3.7M6.6 6.6C3.9 8.4 2.5 12 2.5 12S6 18.5 12 18.5c1.9 0 3.5-.6 4.9-1.4M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Line>;
export const Trash = (p: P) => <Line {...p}><path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2l1-12M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" /></Line>;
export const Send = (p: P) => <Line {...p}><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z" /></Line>;
export const Ball = (p: P) => <Line {...p}><circle cx="12" cy="12" r="9" /><path d="m12 7.5 4 2.9-1.5 4.8h-5L8 10.4l4-2.9ZM12 3v4.5M21 10.4l-5 0M17.3 19.6l-2.8-4.4M6.7 19.6l2.8-4.4M3 10.4h5" /></Line>;

// Profile-menu set.
export const UserCircle = (p: P) => <Line {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.2 18.4a6.5 6.5 0 0 1 11.6 0" /></Line>;
export const MoneyAdd = (p: P) => <Line {...p}><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 9v6M18 9v6" /></Line>;
export const CardSend = (p: P) => <Line {...p}><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M2.5 10h19M6.5 15h4M15 15.5l2.5-2.5 2.5 2.5" /></Line>;
export const Receipt = (p: P) => <Line {...p}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 8h6M9 12h6M9 16h3" /></Line>;
export const Coins = (p: P) => <Line {...p}><ellipse cx="9" cy="7" rx="6" ry="3" /><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7M3 12v5c0 1.7 2.7 3 6 3 1.2 0 2.3-.2 3.2-.5M15 12.2c.9-.3 1.9-.2 3 .3 1.7.8 3 2 3 3.5s-2.7 3-6 3" /></Line>;
export const Headset = (p: P) => <Line {...p}><path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2v-2ZM20 14a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2v-2ZM17 18c0 1.7-2 3-5 3" /></Line>;
export const Gift = (p: P) => <Line {...p}><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M12 8v13M12 8S10.5 3.5 8 3.5a2.2 2.2 0 0 0 0 4.5h4ZM12 8s1.5-4.5 4-4.5a2.2 2.2 0 0 1 0 4.5h-4Z" /></Line>;
export const Cog = (p: P) => <Line {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Line>;
export const LogOut = (p: P) => <Line {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" /></Line>;
export const Ranking = (p: P) => <Line {...p}><circle cx="12" cy="8.5" r="5.5" /><path d="m8.5 13-1.5 8 5-3 5 3-1.5-8M12 6l.9 1.8 2 .3-1.5 1.4.4 2L12 10.6 10.2 11.5l.4-2L9.1 8.1l2-.3L12 6Z" /></Line>;
export const Star = (p: P) => <Line {...p}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3Z" /></Line>;
export const Users = (p: P) => <Line {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" /></Line>;
export const Bolt = (p: P) => <Line {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></Line>;
export const Shield = (p: P) => <Line {...p}><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m9 12 2 2 4-4" /></Line>;
export const Calendar = (p: P) => <Line {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></Line>;

/** Solid caret, as on the design's dropdowns and league accordions. */
export const CaretDown = (p: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}><path d="M6 9h12l-6 7-6-7Z" /></svg>
);
export const CaretRight = (p: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}><path d="M9 6v12l7-6-7-6Z" /></svg>
);
/** The purple pennant beside each fixture: the match's stats badge. */
export const StatsBadge = (p: P) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M3 2.5h10v8.2c0 .4-.2.7-.5.9L8 14l-4.5-2.4a1 1 0 0 1-.5-.9V2.5Z" />
    <path d="M5.5 6h5M5.5 8.5h5" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);
