import type {
  Operator,
  OperatorCreate,
  OperatorCredentials,
  OperatorStatus,
  OperatorUpdate,
} from './types.js';

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class DuplicateApiKeyError extends Error {
  readonly apiKey: string;
  constructor(apiKey: string) {
    super(`An operator with this api_key already exists`);
    this.name = 'DuplicateApiKeyError';
    this.apiKey = apiKey;
  }
}

export class DuplicateOperatorIdError extends Error {
  readonly operatorId: string;
  constructor(operatorId: string) {
    super(`Operator with id '${operatorId}' already exists`);
    this.name = 'DuplicateOperatorIdError';
    this.operatorId = operatorId;
  }
}

export class OperatorNotFoundError extends Error {
  constructor(operatorId: string) {
    super(`Operator '${operatorId}' not found`);
    this.name = 'OperatorNotFoundError';
  }
}

// Read-only operator lookups. Both the SQLite OperatorRegistry and the Postgres
// PgOperatorRegistry (in-memory cache) serve these synchronously, so hot paths
// (signature middleware, WalletClientCache) never await.
export interface OperatorReader {
  getById(operatorId: string): import('./types.js').Operator | null;
  getByApiKey(apiKey: string): import('./types.js').Operator | null;
  list(opts?: { status?: import('./types.js').OperatorStatus }): import('./types.js').Operator[];
}

// ---------------------------------------------------------------------------
// Derive the Statement type from the prepare() method signature so we don't
// have to use the Database namespace (which is unavailable via `import type`).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Injection hooks (used in tests to force determinism / collisions)
// ---------------------------------------------------------------------------

export interface OperatorRegistryOpts {
  generateApiKey?: (status: OperatorStatus) => string;
  generateSigningKey?: () => Buffer;
}
