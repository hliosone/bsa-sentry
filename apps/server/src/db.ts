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
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  transaction_id TEXT,
  status TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  evidence TEXT,
  bound_to TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
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
  db.exec(SCHEMA);
  return db;
}
