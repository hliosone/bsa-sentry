// A test PID issuer (OpenID4VCI 1.0, pre-authorized code) for wallets that cannot get a PID from
// the EU test issuer: issuer.eudiw.dev requires hardware key attestations (iso_18045_high) on
// every proof type, which only the EU reference wallet provides. Like the EU issuer's "FormEU",
// it issues a PID from what you type in a form: test data, for demos only.
//
// It signs an SD-JWT VC (vct urn:eudi:pid:1) with a leaf certificate under our own test CA. The
// real EU verifier then checks it, because the server adds that CA to `issuer_chain`
// (EUDIW_EXTRA_ISSUER_CA, printed below). Form data lives in memory until issued; nothing is
// stored or logged (requests are logged without values).
//
//   pnpm exec tsx scripts/test-issuer.ts      -> prints the public URL; open it, fill, scan.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { startTunnel } from './tunnel.js';

const QRCode = createRequire(new URL('../apps/web/package.json', import.meta.url))('qrcode') as { toString: (s: string, o: object) => Promise<string> };

const PORT = Number(process.env.ISSUER_PORT ?? 4100);
const DIR = '.run/test-issuer';
const CONFIG_ID = 'pid_sd_jwt';
const VCT = 'urn:eudi:pid:1';

// ---- keys and certificates (openssl) -----------------------------------------------------
mkdirSync(DIR, { recursive: true });
const ossl = (...args: string[]) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
if (!existsSync(`${DIR}/ca.pem`)) {
  ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${DIR}/ca.key`);
  ossl('req', '-x509', '-new', '-key', `${DIR}/ca.key`, '-days', '365', '-subj', '/C=CH/O=BSA Sentry/CN=BSA Sentry Test PID CA',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', 'subjectKeyIdentifier=hash', '-out', `${DIR}/ca.pem`);
}
const caPem = readFileSync(`${DIR}/ca.pem`, 'utf8');

function leafFor(host: string) {
  ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${DIR}/leaf.key`);
  ossl('req', '-new', '-key', `${DIR}/leaf.key`, '-subj', `/C=CH/O=BSA Sentry/CN=BSA Sentry Test PID Issuer`, '-out', `${DIR}/leaf.csr`);
  writeFileSync(`${DIR}/leaf.ext`, [
    'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature',
    `subjectAltName=DNS:${host},URI:https://${host}`, 'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid',
  ].join('\n'));
  ossl('x509', '-req', '-in', `${DIR}/leaf.csr`, '-CA', `${DIR}/ca.pem`, '-CAkey', `${DIR}/ca.key`, '-CAcreateserial',
    '-days', '90', '-extfile', `${DIR}/leaf.ext`, '-out', `${DIR}/leaf.pem`);
  const der = new X509Certificate(readFileSync(`${DIR}/leaf.pem`)).raw.toString('base64');
  return { key: createPrivateKey(readFileSync(`${DIR}/leaf.key`)), x5c: [der] };
}

// ---- helpers -------------------------------------------------------------------------------
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const json64 = (o: unknown) => b64u(JSON.stringify(o));
const rand = (n = 24) => randomBytes(n).toString('base64url');
const es256 = (key: ReturnType<typeof createPrivateKey>, data: string) => b64u(sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }));

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if ((req.headers['content-type'] ?? '').includes('json')) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

function send(res: ServerResponse, status: number, payload: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

/** The holder key from an OpenID4VCI proof JWT: a `jwk` header, or a did:jwk `kid`. */
function holderKey(header: Record<string, any>): Record<string, string> | null {
  if (header.jwk) return header.jwk;
  if (typeof header.kid === 'string' && header.kid.startsWith('did:jwk:')) return JSON.parse(Buffer.from(header.kid.slice(8).split('#')[0], 'base64url').toString('utf8'));
  return null;
}

// ---- state (memory only) -------------------------------------------------------------------
type Person = { given_name: string; family_name: string; birthdate: string; nationality: string };
const offers = new Map<string, { person: Person; at: number }>();   // pre-authorized code -> form data
const tokens = new Map<string, Person>();                          // access token -> form data
const nonces = new Set<string>();

// ---- start ---------------------------------------------------------------------------------
let ISS = '';
let leaf: ReturnType<typeof leafFor>;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let status = 200;
  let bodyKeys = '';
  const reply = (s: number, p: unknown, t?: string) => { status = s; send(res, s, p, t); };
  try {
    const b = req.method === 'POST' ? await body(req) : {};
    bodyKeys = Object.keys(b).join(',');
    if (url.pathname === '/health') return reply(200, { ok: true });

    if (url.pathname === '/.well-known/openid-credential-issuer') {
      const claim = (path: string[], name: string) => ({ path, display: [{ name, locale: 'en' }] });
      return reply(200, {
        credential_issuer: ISS,
        credential_endpoint: `${ISS}/credential`,
        nonce_endpoint: `${ISS}/nonce`,
        display: [{ name: 'BSA Sentry Test PID Issuer', locale: 'en' }],
        credential_configurations_supported: {
          [CONFIG_ID]: {
            format: 'dc+sd-jwt',
            vct: VCT,
            scope: 'pid',
            cryptographic_binding_methods_supported: ['jwk'],
            credential_signing_alg_values_supported: ['ES256'],
            proof_types_supported: { jwt: { proof_signing_alg_values_supported: ['ES256'] } },
            credential_metadata: {
              display: [{ name: 'Test PID', locale: 'en', description: 'Test person identification data (demo only)' }],
              claims: [
                claim(['given_name'], 'Given name'), claim(['family_name'], 'Family name'), claim(['birthdate'], 'Date of birth'),
                claim(['nationalities'], 'Nationalities'), claim(['issuing_country'], 'Issuing country'), claim(['issuing_authority'], 'Issuing authority'),
              ],
            },
          },
        },
      });
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return reply(200, {
        issuer: ISS,
        token_endpoint: `${ISS}/token`,
        grant_types_supported: ['urn:ietf:params:oauth:grant-type:pre-authorized_code'],
        'pre-authorized_grant_anonymous_access_supported': true,
        token_endpoint_auth_methods_supported: ['none'],
        response_types_supported: ['code'],
      });
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const code = b['pre-authorized_code'];
      const offer = offers.get(code);
      if (b.grant_type !== 'urn:ietf:params:oauth:grant-type:pre-authorized_code' || !offer || Date.now() - offer.at > 10 * 60_000) {
        return reply(400, { error: 'invalid_grant' });
      }
      offers.delete(code);
      const token = rand();
      tokens.set(token, offer.person);
      const c_nonce = rand();
      nonces.add(c_nonce);
      return reply(200, { access_token: token, token_type: 'Bearer', expires_in: 600, c_nonce, c_nonce_expires_in: 600 });
    }

    if (url.pathname === '/nonce' && req.method === 'POST') {
      const c_nonce = rand();
      nonces.add(c_nonce);
      return reply(200, { c_nonce });
    }

    if (url.pathname === '/credential' && req.method === 'POST') {
      const token = (req.headers.authorization ?? '').replace(/^(Bearer|DPoP)\s+/i, '');
      const person = tokens.get(token);
      if (!person) return reply(401, { error: 'invalid_token' });
      const jwt: string | undefined = b.proofs?.jwt?.[0] ?? b.proof?.jwt;
      if (!jwt) return reply(400, { error: 'invalid_proof', error_description: 'a jwt proof is required' });
      const [h, p, s] = jwt.split('.');
      const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8'));
      const claims = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'));
      const jwk = holderKey(header);
      if (!jwk) return reply(400, { error: 'invalid_proof', error_description: 'no holder key (jwk or did:jwk) in the proof' });
      const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk as any, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'));
      if (!ok) return reply(400, { error: 'invalid_proof', error_description: 'bad proof signature' });
      if (claims.nonce && !nonces.has(claims.nonce)) return reply(400, { error: 'invalid_nonce' });
      nonces.delete(claims.nonce);
      tokens.delete(token);

      const disclose = (name: string, value: unknown) => json64([rand(16), name, value]);
      const disclosures = [
        disclose('given_name', person.given_name), disclose('family_name', person.family_name),
        disclose('birthdate', person.birthdate), disclose('nationalities', [person.nationality]),
      ];
      const now = Math.floor(Date.now() / 1000);
      const { kty, crv, x, y } = jwk;
      const payload = {
        iss: ISS, iat: now, exp: now + 60 * 24 * 3600, vct: VCT,
        issuing_country: 'CH', issuing_authority: 'BSA Sentry Test Issuer',
        cnf: { jwk: { kty, crv, x, y } },
        _sd: disclosures.map((d) => createHash('sha256').update(d, 'ascii').digest('base64url')).sort(),
        _sd_alg: 'sha-256',
      };
      const signingInput = `${json64({ alg: 'ES256', typ: 'dc+sd-jwt', x5c: leaf.x5c })}.${json64(payload)}`;
      const credential = `${signingInput}.${es256(leaf.key, signingInput)}~${disclosures.join('~')}~`;
      return reply(200, { credentials: [{ credential }] });
    }

    if (url.pathname === '/' && req.method === 'GET') {
      return reply(200, page(`
        <h1>Test PID issuer</h1>
        <p>Issues a <b>test</b> EU PID (SD-JWT VC) to your wallet, like the EU issuer's "FormEU". Type test data.</p>
        <form method="post" action="/offer">
          <label>Given name <input name="given_name" value="Alex" required></label>
          <label>Family name <input name="family_name" value="Muster" required></label>
          <label>Date of birth <input name="birthdate" type="date" value="1990-01-01" required></label>
          <label>Nationality (ISO code) <input name="nationality" value="CH" maxlength="2" required></label>
          <button>Create the credential offer</button>
        </form>`), 'text/html');
    }

    if (url.pathname === '/offer' && req.method === 'POST') {
      const person: Person = {
        given_name: String(b.given_name ?? ''), family_name: String(b.family_name ?? ''),
        birthdate: String(b.birthdate ?? ''), nationality: String(b.nationality ?? '').toUpperCase(),
      };
      const code = rand();
      offers.set(code, { person, at: Date.now() });
      const offer = {
        credential_issuer: ISS,
        credential_configuration_ids: [CONFIG_ID],
        grants: { 'urn:ietf:params:oauth:grant-type:pre-authorized_code': { 'pre-authorized_code': code } },
      };
      const link = `openid-credential-offer://?credential_offer=${encodeURIComponent(JSON.stringify(offer))}`;
      const svg = await QRCode.toString(link, { type: 'svg', margin: 2, errorCorrectionLevel: 'L' });
      return reply(200, page(`<h1>Scan with your wallet</h1><div class="qr">${svg}</div><p><a id="offer" href="${link}">Open in my wallet</a> (on the phone itself)</p><p>Valid 10 minutes, once. <a href="/">New offer</a></p>`), 'text/html');
    }

    return reply(404, { error: 'not_found' });
  } catch (e) {
    console.error('[issuer] error', (e as Error).message);
    if (!res.headersSent) reply(500, { error: 'server_error' });
  } finally {
    // What the wallet asked for, never the values.
    if (url.pathname !== '/health') console.log(`[issuer] ${req.method} ${url.pathname} body=[${bodyKeys}] accept=${req.headers.accept ?? ''} -> ${status}`);
  }
});

const page = (inner: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Test PID issuer</title><style>body{font:16px system-ui;max-width:520px;margin:40px auto;padding:0 16px}
label{display:block;margin:10px 0}input{display:block;width:100%;padding:8px;font:inherit}button{margin-top:14px;padding:10px 16px;font:inherit}
.qr svg{width:340px;height:340px}</style>${inner}`;

server.listen(PORT, async () => {
  const t = await startTunnel(PORT, '.run/tunnel-issuer.log');
  ISS = t.url;
  leaf = leafFor(new URL(ISS).host);
  console.log(`\n  Test PID issuer : ${ISS}\n  Trust its CA    : EUDIW_EXTRA_ISSUER_CA=${Buffer.from(caPem).toString('base64')}\n`);
});
