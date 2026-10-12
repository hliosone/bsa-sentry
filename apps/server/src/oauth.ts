// OAuth 2.1 authorization server for the MCP resource, shaped by what claude.ai actually
// sends (our feasibility log): metadata discovery, dynamic client registration with
// client_secret_post, authorization code + PKCE S256 + RFC 8707 `resource`, refresh.
//
// Security invariant 7: a token lets an agent REQUEST payments for one account, nothing else,
// and the user can revoke it from the dashboard. Nothing auto-approves: /authorize needs a
// Ledger session and an explicit consent with a CSRF token. Secrets, codes and tokens are
// stored as SHA-256 hashes only.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import type { Db } from './db.js';
import { readSession } from './auth.js';

export const SCOPE = 'payments:request';
const CODE_TTL_S = 600;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;

export type OAuthOptions = {
  db: Db;
  /** Public base URL of this server, e.g. the tunnel or the deployed host. */
  baseUrl: string;
  /** Where "Log in with Ledger" lives. */
  webOrigin: string;
  secret: string;
  now?: () => number;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false;
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

type Client = { client_id: string; client_secret_hash: string | null; client_name: string | null; redirect_uris: string };

export function oauthRouter(opts: OAuthOptions) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const base = opts.baseUrl.replace(/\/$/, '');
  const resource = `${base}/mcp`;
  const db = opts.db;
  const router = Router();
  const body = [json({ limit: '16kb' }), urlencoded({ extended: false, limit: '16kb' })];

  // ------------------------------------------------------------------ discovery

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported: [SCOPE],
    });
  });

  router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => {
    res.json({ resource, authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ['header'] });
  });

  // ------------------------------------------------------------------ registration (RFC 7591)

  router.post('/oauth/register', ...body, (req, res) => {
    const uris = req.body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(validRedirect)) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'https redirect URIs are required (localhost excepted)' });
    }
    const method = req.body.token_endpoint_auth_method === 'none' ? 'none' : 'client_secret_post';
    const clientId = `bsa_${randomBytes(12).toString('hex')}`;
    const secret = method === 'none' ? undefined : randomBytes(32).toString('base64url');
    const name = typeof req.body.client_name === 'string' ? req.body.client_name.slice(0, 64) : null;
    db.prepare('INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(clientId, secret ? sha256(secret) : null, name, JSON.stringify(uris), now());
    res.status(201).json({
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: now(),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  const client = (id: unknown) =>
    typeof id === 'string' ? (db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(id) as Client | undefined) : undefined;

  // ------------------------------------------------------------------ authorize

  /** Validates the request before anything is shown or redirected. */
  function checkAuthorize(q: Record<string, unknown>): { c: Client; redirect: string } | string {
    const c = client(q.client_id);
    if (!c) return 'unknown client';
    const redirect = String(q.redirect_uri ?? '');
    if (!(JSON.parse(c.redirect_uris) as string[]).includes(redirect)) return 'redirect_uri is not registered for this client';
    if (q.response_type !== 'code') return 'only response_type=code is supported';
    if (typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return 'a PKCE code_challenge is required';
    if (q.code_challenge_method !== 'S256') return 'only PKCE S256 is supported';
    if (q.resource !== undefined && q.resource !== resource) return 'unknown resource';
    return { c, redirect };
  }

  /** Ties the consent form to this account and this exact request. */
  const csrfFor = (account: string, query: string) => createHmac('sha256', opts.secret).update(`csrf|${account}|${query}`).digest('base64url');

  router.get('/oauth/authorize', (req, res) => {
    const check = checkAuthorize(req.query as Record<string, unknown>);
    // An invalid client or redirect is shown here, never redirected to (RFC 6749 §4.1.2.1).
    if (typeof check === 'string') return res.status(400).type('html').send(page('Demande invalide', `<p>${esc(check)}</p>`));

    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    const account = readSession(req, opts.secret, now);
    if (!account) {
      const back = encodeURIComponent(`${base}/oauth/authorize?${query}`);
      return res.type('html').send(page('Login required', `
        <p>To authorize <b>${esc(check.c.client_name ?? 'this agent')}</b>, log in with your Ledger first.</p>
        <p><a class="btn" href="${esc(opts.webOrigin)}/?returnTo=${back}">Log in with Ledger</a></p>`));
    }

    res.type('html').send(page('Authorize this agent?', `
      <h1>Allow ${esc(check.c.client_name ?? 'this agent')} to request payments from your Flex?</h1>
      <p>Account <code>${esc(account)}</code></p>
      <ul>
        <li>${esc(check.c.client_name ?? 'The agent')} will be able to <b>request</b> USDC payments on Arc testnet.</li>
        <li><b>Your Flex decides</b>: it signs on its own what fits your rules, asks you about the rest, and refuses what is dangerous.</li>
        <li>You can revoke this access at any time from the dashboard.</li>
      </ul>
      <form method="post" action="/oauth/authorize?${esc(query)}">
        <input type="hidden" name="csrf" value="${esc(csrfFor(account, query))}">
        <button name="decision" value="allow" class="btn">Allow Claude to request payments from your Flex</button>
        <button name="decision" value="deny" class="btn secondary">Deny</button>
      </form>`));
  });

  router.post('/oauth/authorize', ...body, (req, res) => {
    const check = checkAuthorize(req.query as Record<string, unknown>);
    if (typeof check === 'string') return res.status(400).type('html').send(page('Demande invalide', `<p>${esc(check)}</p>`));
    const account = readSession(req, opts.secret, now);
    if (!account) return res.status(401).type('html').send(page('Login required', '<p>Session expired.</p>'));
    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    const csrf = typeof req.body?.csrf === 'string' ? req.body.csrf : '';
    if (!sameSecret(csrf, csrfFor(account, query))) return res.status(403).type('html').send(page('Denied', '<p>Invalid form token.</p>'));

    const back = new URL(check.redirect);
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (state) back.searchParams.set('state', state);
    if (req.body.decision !== 'allow') {
      back.searchParams.set('error', 'access_denied');
      return res.redirect(302, back.toString());
    }
    const code = token('code');
    db.prepare('INSERT INTO oauth_codes (code_hash, client_id, account, redirect_uri, code_challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(code), check.c.client_id, account, check.redirect, String(req.query.code_challenge), SCOPE, now() + CODE_TTL_S);
    back.searchParams.set('code', code);
    res.redirect(302, back.toString());
  });

  // ------------------------------------------------------------------ token

  function authenticateClient(b: Record<string, unknown>): Client | null {
    const c = client(b.client_id);
    if (!c) return null;
    if (!c.client_secret_hash) return c; // public PKCE client
    const secret = typeof b.client_secret === 'string' ? b.client_secret : '';
    return sameSecret(sha256(secret), c.client_secret_hash) ? c : null;
  }

  function issue(clientId: string, account: string, family: string) {
    const access = token('at');
    const refresh = token('rt');
    const insert = db.prepare('INSERT INTO oauth_tokens (token_hash, kind, client_id, account, scope, family, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(sha256(access), 'access', clientId, account, SCOPE, family, now(), now() + ACCESS_TTL_S);
    insert.run(sha256(refresh), 'refresh', clientId, account, SCOPE, family, now(), now() + REFRESH_TTL_S);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
  }

  const revokeFamily = (family: string) => db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE family = ?').run(family);

  router.post('/oauth/token', ...body, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const c = authenticateClient(b);
    if (!c) return res.status(401).json({ error: 'invalid_client' });
    const grant = (desc: string) => res.status(400).json({ error: 'invalid_grant', error_description: desc });

    if (b.grant_type === 'authorization_code') {
      const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256(String(b.code ?? ''))) as
        | { client_id: string; account: string; redirect_uri: string; code_challenge: string; used: number; expires_at: number; code_hash: string } | undefined;
      if (!row || row.client_id !== c.client_id) return grant('unknown code');
      if (row.used) {
        // RFC 6749 §4.1.2: a replayed code revokes what it produced.
        revokeFamily(row.code_hash);
        return grant('code already used');
      }
      db.prepare('UPDATE oauth_codes SET used = 1 WHERE code_hash = ?').run(row.code_hash);
      if (row.expires_at <= now()) return grant('code expired');
      if (b.redirect_uri !== row.redirect_uri) return grant('redirect_uri mismatch');
      const verifier = typeof b.code_verifier === 'string' ? b.code_verifier : '';
      const computed = createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || !sameSecret(computed, row.code_challenge)) return grant('PKCE verification failed');
      // The token family is keyed by the code, so a replay of this code can find it.
      return res.json(issue(c.client_id, row.account, row.code_hash));
    }

    if (b.grant_type === 'refresh_token') {
      const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(sha256(String(b.refresh_token ?? ''))) as
        | { client_id: string; account: string; family: string; revoked: number; expires_at: number; token_hash: string } | undefined;
      if (!row || row.client_id !== c.client_id) return grant('unknown refresh token');
      if (row.revoked) {
        // A rotated-out refresh token came back: assume it was stolen, kill the family.
        revokeFamily(row.family);
        return grant('refresh token reused');
      }
      if (row.expires_at <= now()) return grant('refresh token expired');
      // Rotation: the old refresh token and every live access token of the family go.
      revokeFamily(row.family);
      return res.json(issue(c.client_id, row.account, row.family));
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // ------------------------------------------------------------------ revocation

  router.post('/oauth/revoke', ...body, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!authenticateClient(b)) return res.status(401).json({ error: 'invalid_client' });
    const row = db.prepare('SELECT family FROM oauth_tokens WHERE token_hash = ?').get(sha256(String(b.token ?? ''))) as { family: string } | undefined;
    if (row) revokeFamily(row.family);
    res.status(200).json({}); // RFC 7009: same answer whether or not the token existed
  });

  /** The dashboard's view: one entry per grant (token family), no token material. */
  router.get('/oauth/grants', (req, res) => {
    const account = readSession(req, opts.secret, now);
    if (!account) return res.status(401).json({ error: 'not logged in' });
    const grants = db.prepare(`
      SELECT t.family AS id, c.client_name, t.scope, MIN(t.created_at) AS created_at, MAX(t.expires_at) AS expires_at
      FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.account = ? AND t.revoked = 0 AND t.expires_at > ?
      GROUP BY t.family ORDER BY created_at DESC`).all(account, now());
    res.json({ grants });
  });

  router.post('/oauth/grants/:id/revoke', (req, res) => {
    const account = readSession(req, opts.secret, now);
    if (!account) return res.status(401).json({ error: 'not logged in' });
    const owned = db.prepare('SELECT 1 FROM oauth_tokens WHERE family = ? AND account = ? LIMIT 1').get(req.params.id, account);
    if (!owned) return res.status(404).json({ error: 'no such grant' });
    revokeFamily(req.params.id);
    res.json({ ok: true });
  });

  return router;
}

/** Bearer middleware for /mcp. Sets `req.account`; 401 with the resource metadata otherwise. */
export function requireBearer(opts: { db: Db; baseUrl: string; now?: () => number }) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const meta = `${opts.baseUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource`;
  return (req: Request, res: Response, next: NextFunction) => {
    const raw = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const row = raw
      ? (opts.db.prepare("SELECT account, scope FROM oauth_tokens WHERE token_hash = ? AND kind = 'access' AND revoked = 0 AND expires_at > ?")
          .get(sha256(raw), now()) as { account: string; scope: string } | undefined)
      : undefined;
    if (!row || row.scope !== SCOPE) {
      return res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${meta}"`).json({ error: 'unauthorized' });
    }
    (req as Request & { account: string }).account = row.account;
    next();
  };
}

function page(title: string, content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)} · BSA Sentry</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;color:#111}
  h1{font-size:22px} code{background:#f2f2f2;padding:2px 6px;border-radius:4px;word-break:break-all}
  .btn{display:inline-block;margin:6px 8px 0 0;padding:12px 18px;border:0;border-radius:10px;background:#111;color:#fff;font-size:16px;cursor:pointer;text-decoration:none}
  .btn.secondary{background:#e8e8e8;color:#111} li{margin:6px 0}
</style></head><body><p><b>BSA Sentry</b> · Your agent spends. Your Ledger decides.</p>${content}</body></html>`;
}
