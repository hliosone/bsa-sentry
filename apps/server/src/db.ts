// SQLite through Node's built-in `node:sqlite`: no native module to compile in Docker.
//
// What is stored, and what is not (security invariant 8): login nonces, OAuth clients,
// authorization codes and tokens (as SHA-256 hashes only), 18+ results and evidence hashes,
// and vault ciphertext. Never a PID attribute, never a raw token.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded through require: Vite 5 (vitest) does not list `sqlite` as a Node builtin and
// strips the `node:` prefix from a static import, which then fails to resolve.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS login_nonces (
  nonce TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  account TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL,
  account TEXT NOT NULL,
  scope TEXT NOT NULL,
  family TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS oauth_tokens_account ON oauth_tokens(account);
CREATE TABLE IF NOT EXISTS age_sessions (
  id TEXT PRIMARY KEY,           -- random bytes32, also the Bind "session" the Flex signs
  account TEXT NOT NULL,         -- the logged-in 0xMAIN that opened it
  mode TEXT NOT NULL,            -- 'mock' | 'live'
  verifier TEXT NOT NULL,        -- the Bind "verifier" string shown on the Flex
  transaction_id TEXT,           -- the EUDIW backend's opaque transaction id
  status TEXT NOT NULL,          -- pending | verified | not_over_18 | rejected | wallet_error
  evidence TEXT,                 -- keccak256(transaction id): the only trace of the presentation
  bound_to TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revocations (
  delegation_hash TEXT PRIMARY KEY, -- EIP-712 hash of the AgentDelegation the user revoked
  account TEXT NOT NULL,            -- the 0xMAIN that signed it, and revoked it
  revoked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault (
  account TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  delegation TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export type Db = DatabaseSyncType;

/** Opens (and migrates) the database. `:memory:` for tests. */
export function openDb(path = process.env.DB_PATH ?? ':memory:'): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  // age_sessions only holds short-lived verification sessions: if a volume still has the table
  // from an older schema, replacing it loses nothing and keeps the 18+ routes working.
  const ageCols = (db.prepare('PRAGMA table_info(age_sessions)').all() as { name: string }[]).map((c) => c.name);
  if (ageCols.length > 0 && !['account', 'mode', 'verifier'].every((c) => ageCols.includes(c))) {
    db.exec('DROP TABLE age_sessions;');
  }
  db.exec(SCHEMA);
  return db;
}
