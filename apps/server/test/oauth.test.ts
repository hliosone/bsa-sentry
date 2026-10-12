// OAuth 2.1 for the MCP resource, the way claude.ai drives it (recorded in our feasibility
// log): metadata discovery, dynamic client registration with client_secret_post, the
// authorization code flow with PKCE S256 and an RFC 8707 `resource`, then refresh.
//
// Unlike the feasibility server, nothing here auto-approves: /authorize needs a Ledger
// session and an explicit consent (security invariant 7: a token only lets an agent REQUEST
// payments, and the user can revoke it).
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash, randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { signSession, SESSION_COOKIE } from '../src/auth.js';
import { oauthRouter, requireBearer, SCOPE } from '../src/oauth.js';

const BASE = 'https://bsa.test';
const SECRET = 's'.repeat(64);
const ALICE = '0x21fff03ff9c6a8b845c65ef2aa2fbb09b5da5ce5';
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function setup(clock = { t: 1_760_000_000 }) {
  const db = openDb(':memory:');
  const now = () => clock.t;
  const app = express();
  app.use(oauthRouter({ db, baseUrl: BASE, webOrigin: BASE, secret: SECRET, now }));
  app.post('/mcp', requireBearer({ db, baseUrl: BASE, now }), (req, res) => res.json({ account: (req as any).account }));
  return { db, app, clock };
}

const session = (account = ALICE) => `${SESSION_COOKIE}=${encodeURIComponent(signSession(account, SECRET, () => 1_760_000_000))}`;

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** claude.ai's registration body, verbatim from the feasibility log. */
const claudeRegistration = {
  redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  client_name: 'Claude', application_type: 'web',
};

async function register(app: express.Express, body: object = claudeRegistration) {
  const res = await request(app).post('/oauth/register').send(body);
  expect(res.status).toBe(201);
  return res.body as { client_id: string; client_secret?: string };
}

const authorizeQuery = (clientId: string, challenge: string, over: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', resource: `${BASE}/mcp`, ...over,
  }).toString();

/** Walks the consent page as a logged-in user and returns the redirect. */
async function consent(app: express.Express, clientId: string, challenge: string, decision = 'allow', cookie = session()) {
  const q = authorizeQuery(clientId, challenge);
  const page = await request(app).get(`/oauth/authorize?${q}`).set('Cookie', cookie);
  expect(page.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1];
  expect(csrf, 'the consent form carries a CSRF token').toBeTruthy();
  return request(app).post(`/oauth/authorize?${q}`).set('Cookie', cookie).type('form').send({ csrf, decision });
}

async function fullFlow(app: express.Express) {
  const client = await register(app);
  const { verifier, challenge } = pkce();
  const redirect = await consent(app, client.client_id, challenge);
  const code = new URL(redirect.headers.location!).searchParams.get('code')!;
  const token = await request(app).post('/oauth/token').type('form').send({
    grant_type: 'authorization_code', code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier,
    client_id: client.client_id, client_secret: client.client_secret,
  });
  return { client, verifier, challenge, code, token };
}

describe('discovery', () => {
  it('publishes authorization-server metadata with S256 and the registration endpoint', async () => {
    const { app } = setup();
    const m = (await request(app).get('/.well-known/oauth-authorization-server')).body;
    expect(m).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [SCOPE],
    });
    expect(m.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
    expect(m.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(['client_secret_post', 'none']));
  });

  it('publishes protected-resource metadata, also under the /mcp suffix claude.ai probes', async () => {
    const { app } = setup();
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect((await request(app).get(path)).body).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    }
  });

  it('answers an unauthenticated MCP call with 401 pointing at the resource metadata', async () => {
    const { app } = setup();
    const res = await request(app).post('/mcp');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
  });
});

describe('dynamic client registration', () => {
  it('registers claude.ai with a client secret for client_secret_post', async () => {
    const { app } = setup();
    const c = await register(app);
    expect(c.client_id).toMatch(/^bsa_/);
    expect(c.client_secret).toMatch(/.{32,}/);
  });

  it('registers a public PKCE client without a secret', async () => {
    const { app } = setup();
    const c = await register(app, { redirect_uris: ['http://localhost:3333/cb'], token_endpoint_auth_method: 'none' });
    expect(c.client_secret).toBeUndefined();
  });

  it('stores only a hash of the client secret', async () => {
    const { app, db } = setup();
    const c = await register(app);
    const row = db.prepare('SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?').get(c.client_id) as any;
    expect(row.client_secret_hash).not.toBe(c.client_secret);
    expect(row.client_secret_hash).not.toContain(c.client_secret!.slice(0, 8));
  });

  it('refuses a redirect URI that is not https (localhost excepted)', async () => {
    const { app } = setup();
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'not a url']) {
      expect((await request(app).post('/oauth/register').send({ redirect_uris: [uri] })).status, uri).toBe(400);
    }
    expect((await request(app).post('/oauth/register').send({})).status).toBe(400);
  });
});

describe('authorize', () => {
  it('asks a logged-out user to sign in with Ledger first, and issues no code', async () => {
    const { app } = setup();
    const c = await register(app);
    const res = await request(app).get(`/oauth/authorize?${authorizeQuery(c.client_id, pkce().challenge)}`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Log in with Ledger/);
    expect(res.text).not.toMatch(/name="csrf"/);
  });

  it('shows the consent question to a logged-in user', async () => {
    const { app } = setup();
    const c = await register(app);
    const res = await request(app).get(`/oauth/authorize?${authorizeQuery(c.client_id, pkce().challenge)}`).set('Cookie', session());
    expect(res.text).toMatch(/Allow Claude to request payments from your Flex/);
    expect(res.text).toMatch(/0x21ff/i);
  });

  it('issues a code and redirects back with the state on consent', async () => {
    const { app } = setup();
    const c = await register(app);
    const res = await consent(app, c.client_id, pkce().challenge);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE_REDIRECT);
    expect(loc.searchParams.get('code')).toMatch(/.{20,}/);
    expect(loc.searchParams.get('state')).toBe('st-123');
  });

  it('redirects with access_denied when the user refuses', async () => {
    const { app } = setup();
    const c = await register(app);
    const res = await consent(app, c.client_id, pkce().challenge, 'deny');
    expect(new URL(res.headers.location!).searchParams.get('error')).toBe('access_denied');
    expect(new URL(res.headers.location!).searchParams.get('code')).toBeNull();
  });

  it('refuses a consent POST without the CSRF token from the page', async () => {
    const { app } = setup();
    const c = await register(app);
    const q = authorizeQuery(c.client_id, pkce().challenge);
    const res = await request(app).post(`/oauth/authorize?${q}`).set('Cookie', session()).type('form').send({ decision: 'allow' });
    expect(res.status).toBe(403);
  });

  it('refuses a CSRF token minted for another account', async () => {
    const { app } = setup();
    const c = await register(app);
    const q = authorizeQuery(c.client_id, pkce().challenge);
    const page = await request(app).get(`/oauth/authorize?${q}`).set('Cookie', session());
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)![1];
    const res = await request(app).post(`/oauth/authorize?${q}`)
      .set('Cookie', session('0x0000000000000000000000000000000000000bad')).type('form').send({ csrf, decision: 'allow' });
    expect(res.status).toBe(403);
  });

  it('never redirects to an unregistered redirect URI', async () => {
    const { app } = setup();
    const c = await register(app);
    const q = authorizeQuery(c.client_id, pkce().challenge, { redirect_uri: 'https://evil.example/cb' });
    const res = await request(app).get(`/oauth/authorize?${q}`).set('Cookie', session());
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it('refuses an unknown client, a missing PKCE challenge, plain PKCE, or another resource', async () => {
    const { app } = setup();
    const c = await register(app);
    const ch = pkce().challenge;
    for (const q of [
      authorizeQuery('bsa_unknown', ch),
      authorizeQuery(c.client_id, ''),
      authorizeQuery(c.client_id, ch, { code_challenge_method: 'plain' }),
      authorizeQuery(c.client_id, ch, { resource: 'https://other.example/mcp' }),
      authorizeQuery(c.client_id, ch, { response_type: 'token' }),
    ]) {
      expect((await request(app).get(`/oauth/authorize?${q}`).set('Cookie', session())).status, q).toBe(400);
    }
  });
});

describe('token', () => {
  it('exchanges the code for an access token bound to the logged-in account', async () => {
    const { app } = setup();
    const { token } = await fullFlow(app);
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({ token_type: 'Bearer', scope: SCOPE });
    expect(token.body.expires_in).toBeLessThanOrEqual(3600);
    const me = await request(app).post('/mcp').set('Authorization', `Bearer ${token.body.access_token}`);
    expect(me.body.account).toBe(ALICE);
  });

  it('stores tokens as hashes only', async () => {
    const { app, db } = setup();
    const { token } = await fullFlow(app);
    const rows = db.prepare('SELECT token_hash FROM oauth_tokens').all() as { token_hash: string }[];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.token_hash).not.toBe(token.body.access_token);
      expect(r.token_hash).not.toBe(token.body.refresh_token);
    }
  });

  it('refuses a wrong PKCE verifier', async () => {
    const { app } = setup();
    const client = await register(app);
    const { challenge } = pkce();
    const code = new URL((await consent(app, client.client_id, challenge)).headers.location!).searchParams.get('code');
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: CLAUDE_REDIRECT, code_verifier: pkce().verifier,
      client_id: client.client_id, client_secret: client.client_secret,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refuses a wrong client secret', async () => {
    const { app } = setup();
    const client = await register(app);
    const { verifier, challenge } = pkce();
    const code = new URL((await consent(app, client.client_id, challenge)).headers.location!).searchParams.get('code');
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier,
      client_id: client.client_id, client_secret: 'wrong',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('a code is single-use, and replaying it revokes the tokens it produced', async () => {
    const { app } = setup();
    const { client, verifier, code, token } = await fullFlow(app);
    const replay = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier,
      client_id: client.client_id, client_secret: client.client_secret,
    });
    expect(replay.status).toBe(400);
    expect((await request(app).post('/mcp').set('Authorization', `Bearer ${token.body.access_token}`)).status).toBe(401);
  });

  it('a code expires after a few minutes', async () => {
    const { app, clock } = setup();
    const client = await register(app);
    const { verifier, challenge } = pkce();
    const code = new URL((await consent(app, client.client_id, challenge)).headers.location!).searchParams.get('code');
    clock.t += 601;
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier,
      client_id: client.client_id, client_secret: client.client_secret,
    });
    expect(res.status).toBe(400);
  });

  it('an access token expires', async () => {
    const { app, clock } = setup();
    const { token } = await fullFlow(app);
    clock.t += 3601;
    expect((await request(app).post('/mcp').set('Authorization', `Bearer ${token.body.access_token}`)).status).toBe(401);
  });

  it('refresh rotates both tokens, and reusing the old refresh token revokes the family', async () => {
    const { app } = setup();
    const { client, token } = await fullFlow(app);
    const refreshed = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: token.body.refresh_token, client_id: client.client_id, client_secret: client.client_secret,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(token.body.refresh_token);
    const works = await request(app).post('/mcp').set('Authorization', `Bearer ${refreshed.body.access_token}`);
    expect(works.body.account).toBe(ALICE);

    // A stolen old refresh token is replayed: everything in the family dies.
    const replay = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: token.body.refresh_token, client_id: client.client_id, client_secret: client.client_secret,
    });
    expect(replay.status).toBe(400);
    expect((await request(app).post('/mcp').set('Authorization', `Bearer ${refreshed.body.access_token}`)).status).toBe(401);
  });

  it('accepts a JSON body as well as a form', async () => {
    const { app } = setup();
    const client = await register(app);
    const { verifier, challenge } = pkce();
    const code = new URL((await consent(app, client.client_id, challenge)).headers.location!).searchParams.get('code');
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'authorization_code', code, redirect_uri: CLAUDE_REDIRECT, code_verifier: verifier,
      client_id: client.client_id, client_secret: client.client_secret,
    });
    expect(res.status).toBe(200);
  });
});

describe('revocation', () => {
  it('RFC 7009 revoke kills the token', async () => {
    const { app } = setup();
    const { client, token } = await fullFlow(app);
    expect((await request(app).post('/oauth/revoke').type('form').send({
      token: token.body.access_token, client_id: client.client_id, client_secret: client.client_secret,
    })).status).toBe(200);
    expect((await request(app).post('/mcp').set('Authorization', `Bearer ${token.body.access_token}`)).status).toBe(401);
  });

  it('the dashboard lists the account\'s grants and revokes one, killing access and refresh', async () => {
    const { app } = setup();
    const { client, token } = await fullFlow(app);
    const list = await request(app).get('/oauth/grants').set('Cookie', session());
    expect(list.status).toBe(200);
    expect(list.body.grants).toHaveLength(1);
    expect(list.body.grants[0]).toMatchObject({ client_name: 'Claude', scope: SCOPE });
    expect(JSON.stringify(list.body)).not.toContain(token.body.access_token);

    const revoked = await request(app).post(`/oauth/grants/${list.body.grants[0].id}/revoke`).set('Cookie', session());
    expect(revoked.status).toBe(200);
    expect((await request(app).post('/mcp').set('Authorization', `Bearer ${token.body.access_token}`)).status).toBe(401);
    const refresh = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: token.body.refresh_token, client_id: client.client_id, client_secret: client.client_secret,
    });
    expect(refresh.status).toBe(400);
  });

  it('another account cannot see or revoke Alice\'s grants', async () => {
    const { app } = setup();
    await fullFlow(app);
    const bob = session('0x000000000000000000000000000000000000b0b0');
    expect((await request(app).get('/oauth/grants').set('Cookie', bob)).body.grants).toHaveLength(0);
    const aliceGrant = (await request(app).get('/oauth/grants').set('Cookie', session())).body.grants[0].id;
    expect((await request(app).post(`/oauth/grants/${aliceGrant}/revoke`).set('Cookie', bob)).status).toBe(404);
  });

  it('the grant list needs a session', async () => {
    const { app } = setup();
    expect((await request(app).get('/oauth/grants')).status).toBe(401);
  });
});
