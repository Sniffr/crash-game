export type AdminRole = 'admin' | 'finance' | 'support' | 'viewer';

export const ADMIN_ROLES = ['admin', 'finance', 'support', 'viewer'] as const;

export function isAdminRole(s: string): s is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(s);
}

export interface AdminUser {
  username: string;
  roles: AdminRole[];
  createdAt: number;
  lastLoginAt: number | null;
}

export class DuplicateAdminError extends Error {
  constructor(username: string) {
    super(`Admin '${username}' already exists`);
    this.name = 'DuplicateAdminError';
  }
}

export class AdminNotFoundError extends Error {
  constructor(username: string) {
    super(`Admin '${username}' not found`);
    this.name = 'AdminNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  actor: string;
  action: string;
  target: string;
  payload?: unknown;
}
