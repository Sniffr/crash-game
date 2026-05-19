export type OperatorStatus = 'active' | 'paused' | 'sandbox';
export type OperatorAdapter = 'native' | 'softswiss';

export interface Operator {
  operatorId: string;
  name: string;
  walletBaseUrl: string;
  apiKey: string;
  signingKey: Buffer;           // 32 bytes, decoded from base64 on read
  adapter: OperatorAdapter;
  currencies: string[];          // ['EUR', 'USD'] etc.
  minBetMinor: number;
  maxBetMinor: number;
  rtpVariant: number;            // e.g. 97.0
  jurisdictions: string[];
  status: OperatorStatus;
  /** Revenue share in basis points (0–10000). Default 1500 = 15%. Used for settlement §8.2. */
  shareBps: number;
  createdAt: number;             // unix seconds
  updatedAt: number;
}

export interface OperatorCreate {
  operatorId: string;
  name: string;
  walletBaseUrl: string;
  adapter?: OperatorAdapter;     // default 'native'
  currencies: string[];
  minBetMinor?: number;          // default 10
  maxBetMinor?: number;          // default 500_000
  rtpVariant?: number;           // default 97.0
  jurisdictions?: string[];      // default []
  status?: OperatorStatus;       // default 'sandbox'
  /** Revenue share basis points (0–10000). Default 1500 = 15%. */
  shareBps?: number;
}

export interface OperatorUpdate {
  name?: string;
  walletBaseUrl?: string;
  adapter?: OperatorAdapter;
  currencies?: string[];
  minBetMinor?: number;
  maxBetMinor?: number;
  rtpVariant?: number;
  jurisdictions?: string[];
  status?: OperatorStatus;
  /** Revenue share basis points (0–10000). */
  shareBps?: number;
}

/** Returned ONCE on create + rotate. Never re-emitted. */
export interface OperatorCredentials {
  apiKey: string;
  signingKeyBase64: string;
}
