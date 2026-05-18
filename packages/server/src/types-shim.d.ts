// Ambient module declarations for the level/rocksdb stack.
// The official @types packages exist but pull in many transitive types;
// the surface we use is tiny, so a hand-rolled shim keeps the build clean.

declare module 'rocksdb' {
  function rocksdb(location: string): unknown;
  export default rocksdb;
}

declare module 'encoding-down' {
  interface EncodingOptions {
    keyEncoding?: string;
    valueEncoding?: string;
  }
  function encoding(db: unknown, opts?: EncodingOptions): unknown;
  export default encoding;
}

declare module 'levelup' {
  export interface LevelUp {
    open(cb: (err: Error | undefined) => void): void;
    close(): Promise<void>;
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
  }
  function levelup(db: unknown): LevelUp;
  export default levelup;
}
