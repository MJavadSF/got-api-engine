export interface SsrfConfig {
  enabled?: boolean;
  /** Allow private / loopback ranges. @default false */
  allowPrivateNetworks?: boolean;
  /** Hostname allowlist (exact or `*.suffix`). Authoritative when set. */
  allowHosts?: string[];
  /** Hostname blocklist. */
  blockHosts?: string[];
  /** Follow redirects only within the original origin. @default true */
  sameOriginRedirectsOnly?: boolean;
  /** Validate resolved IPs at connect time (defeats DNS rebinding). @default true */
  checkResolvedAddresses?: boolean;
}

export interface TlsConfig {
  /** Extra CA certificates (PEM). */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Client certificate for mTLS (PEM). */
  cert?: string | Buffer | Array<string | Buffer>;
  /** Client private key for mTLS (PEM). */
  key?: string | Buffer | Array<string | Buffer>;
  passphrase?: string;
  /** Minimum TLS version. @default "TLSv1.2" */
  minVersion?: "TLSv1.2" | "TLSv1.3";
}
