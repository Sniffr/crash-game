// Site-wide contact details and links, in one place so the business can
// replace the design's placeholder values without touching components.

export const CONTACT = {
  /** From the Figma footer — replace with the real support line before launch. */
  phone: '(259) 700 000 001',
  /** From the Figma footer — replace with a mailbox on a domain you own. */
  email: 'help@simbet.com',
};

/** Social profiles. Leave `url` null until the account exists; the icon then renders without a link. */
export const SOCIALS: Array<{ key: 'facebook' | 'instagram' | 'linkedin' | 'x' | 'youtube' | 'telegram'; label: string; url: string | null }> = [
  { key: 'facebook', label: 'Facebook', url: null },
  { key: 'instagram', label: 'Instagram', url: null },
  { key: 'linkedin', label: 'LinkedIn', url: null },
  { key: 'x', label: 'X', url: null },
  { key: 'youtube', label: 'YouTube', url: null },
  { key: 'telegram', label: 'Telegram', url: null },
];

export const NAV = [
  { to: '/matches', label: 'Simulated Matches' },
  { to: '/bet-ai', label: 'Bet with AI' },
  { to: '/fantasy', label: 'Fantasy League' },
  { to: '/promotions', label: 'Promotions' },
] as const;
