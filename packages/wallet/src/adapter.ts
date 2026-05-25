// ---------------------------------------------------------------------------
// WalletAdapter — pluggable foreign-protocol layer (Task 7.1)
// ---------------------------------------------------------------------------
// Non-native operators (e.g. SoftSwiss, Task 7.2) speak a different wallet
// protocol: different path, body shape, headers, signature scheme and error
// mapping. An adapter fully controls BOTH the outbound wire request and the
// inbound response decode, translating between OUR canonical request/response
// types and the foreign protocol.
//
// Dependency direction: this interface lives in `wallet` and uses wallet's
// canonical types. `WalletClient` accepts an INJECTED adapter via options and
// never imports the adapters package — the adapters package depends on wallet,
// not the other way round (no circular dependency).
// ---------------------------------------------------------------------------

import type { Operator } from './types.js';

/** Canonical endpoint keys — one per public WalletClient method. */
export type AdapterEndpoint = 'authenticate' | 'balance' | 'bet' | 'win' | 'rollback' | 'roundEnd';

/** Inputs handed to an adapter when building a foreign wire request. */
export interface AdapterRequestContext {
  endpoint: AdapterEndpoint;
  payload: unknown;           // canonical request in OUR shape (BetRequest, etc.)
  operator: Operator;         // apiKey, signingKey, walletBaseUrl
  timestamp: number;          // unix seconds (the same clock WalletClient uses)
  nonce: string;
}

/** The foreign wire request the adapter wants WalletClient to send. */
export interface AdapterWireRequest {
  method: 'POST' | 'GET';
  url: string;                // absolute URL to fetch
  headers: Record<string, string>;
  body: string;               // serialized foreign body ('' for none/GET)
}

/** Inputs handed to an adapter when decoding a foreign response. */
export interface AdapterResponseContext {
  endpoint: AdapterEndpoint;
  status: number;
  headers: Headers;           // for the adapter's own signature verification
  bodyText: string;
  requestTimestamp: number;   // echoes the request (some sigs bind it)
  requestNonce: string;
  operator: Operator;
}

export interface WalletAdapter {
  readonly name: string;
  /** Build the foreign wire request from a canonical call. */
  encodeRequest(ctx: AdapterRequestContext): AdapterWireRequest;
  /** Verify the foreign response signature and map it to OUR canonical response
   *  value (e.g. a BetResponse). MUST throw a WalletError (signature →
   *  ResponseSignatureError, non-2xx → walletErrorFromResponse-equivalent,
   *  malformed 2xx → WalletError MALFORMED_RESPONSE) on failure, matching native
   *  semantics so the retry/idempotency layers behave identically. */
  decodeResponse(ctx: AdapterResponseContext): unknown;
}
