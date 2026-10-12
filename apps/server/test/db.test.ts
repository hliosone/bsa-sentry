// A database volume outlives code changes: a table created by an older version must not break
// the routes that use it (the 18+ page once crashed the server on an old age_sessions table).
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openDb } from '../src/db.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('openDb on an existing file', () => {
  it('replaces an age_sessions table from an older schema (its rows are short-lived sessions)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bsa-db-')), 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE age_sessions (id TEXT PRIMARY KEY, nonce TEXT NOT NULL, transaction_id TEXT, status TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0, evidence TEXT, bound_to TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    old.close();

    const db = openDb(path);
    const cols = (db.prepare('PRAGMA table_info(age_sessions)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['account', 'mode', 'verifier']));
    db.prepare(`INSERT INTO age_sessions (id, account, mode, verifier, transaction_id, status, created_at, expires_at)
      VALUES ('s', 'a', 'live', 'v', 't', 'pending', 1, 2)`).run();
  });

  it('keeps the data of tables that are already up to date', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bsa-db-')), 'cur.sqlite');
    const first = openDb(path);
    first.prepare(`INSERT INTO vault (account, ciphertext, delegation, updated_at) VALUES ('a', 'c', 'd', 1)`).run();
    first.close();
    const again = openDb(path);
    expect(again.prepare('SELECT count(*) AS n FROM vault').get()).toMatchObject({ n: 1 });
  });
});
