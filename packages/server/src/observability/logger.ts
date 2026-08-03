/**
 * Structured logger — Task 8.2 (Phase 8).
 *
 * Thin pino wrapper. LOG_LEVEL env var selects the level (default: 'info').
 *
 * Safety rules (enforced by convention; reviewer-checkable):
 *   - NEVER log request bodies, tokens, signingKey/apiKey/JWT secrets.
 *   - When logging operator/admin actions, include only the bounded fields:
 *     { operatorId, actor, endpoint, code }. Anything that could leak PII or
 *     secrets (player ids, IPs, raw request payloads) must NOT be logged here.
 *
 * No global mutation, no side effects on import — just a constructed logger
 * export. Existing `console.*` call sites (42 across the server) are
 * INTENTIONALLY left alone in Task 8.2 and will be migrated in a separate
 * follow-up pass; using the new logger for new code only keeps this task
 * additive.
 */

import pino from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
});

/**
 * Child logger for HTTP-layer events. Kept minimal — bind only the scope tag.
 * Add more bindings at the call site as needed (e.g. `logger.child({ requestId })`).
 */
export const httpLogger = logger.child({ scope: 'http' });
