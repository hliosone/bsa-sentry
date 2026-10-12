// The website against the REAL server, with a software stand-in for the Flex (?fakeDevice=1,
// dev builds only). Walks the whole onboarding, then has the agent API ask for payments so
// the dashboard feed, the refusal banner and the kill switch are exercised end to end.
// Screenshots of every page land in docs/screens/web/.
import { test, expect, type Page } from '@playwright/test';
import { createServer as createVite, type ViteDevServer } from 'vite';
import { createServer as createNet, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { startBsaServer } from '../../server/src/main.js';
import { createMerchantsApp } from '../../merchants/src/app.js';

const REPO = resolve(import.meta.dirname, '../../..');
loadEnv({ path: resolve(REPO, '.env'), quiet: true });

const freePort = () => new Promise<number>((r) => {
  const s = createNet().listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); });
});

let bsa: Awaited<ReturnType<typeof startBsaServer>>;
let vite: ViteDevServer;
let shop: string;
let web: string;
let merchantsClose: () => void;

const shot = (page: Page, name: string) => page.screenshot({ path: resolve(REPO, 'docs/screens/web', `${name}.png`), fullPage: true });

test.beforeAll(async () => {
  const apiPort = await freePort();
  const webPort = await freePort();
  web = `http://localhost:${webPort}`;
  // The site is served by Vite on its own port and proxies to the server, so the server's
  // public URL (Login origin, OAuth issuer) is the Vite origin, exactly as the user sees it.
  bsa = await startBsaServer({ ...process.env, PORT: String(apiPort), PUBLIC_API_URL: web, DB_PATH: ':memory:', WEB_ORIGIN: undefined, WEB_DIST: '/nonexistent', EUDIW_MODE: 'mock' }, { log: () => {} });
  const merchants = await createMerchantsApp({
    facilitatorUrl: `http://127.0.0.1:${apiPort}/x402`, network: 'eip155:5042002',
    payTo: {
      cafe: process.env.MERCHANT_CAFE_ADDRESS!, cave: process.env.MERCHANT_CAVE_ADDRESS!, resto: process.env.MERCHANT_RESTO_ADDRESS!,
      evil: process.env.MERCHANT_EVIL_ADDRESS!, boulangerie: process.env.MERCHANT_BOULANGERIE_ADDRESS!,
    },
    publicUrl: 'http://127.0.0.1:0',
  });
  const ms = merchants.listen(0);
  await new Promise((r) => ms.once('listening', r));
  shop = `http://127.0.0.1:${(ms.address() as AddressInfo).port}`;
  merchantsClose = () => ms.close();

  process.env.BSA_SERVER = `http://localhost:${apiPort}`;
  process.env.WEB_PORT = String(webPort);
  vite = await createVite({ root: resolve(import.meta.dirname, '..'), configFile: resolve(import.meta.dirname, '../vite.config.ts'), logLevel: 'error' });
  await vite.listen();
});

test.afterAll(async () => {
  await vite?.close();
  merchantsClose?.();
  await bsa?.close();
});

test('onboarding, then the dashboard follows what the agent does', async ({ page }) => {
  await page.goto(`${web}/?fakeDevice=1`);
  await expect(page.getByTestId('statusbar')).toContainText('Connect your Flex');
  await shot(page, '01-connect');

  // 1-2. Connect the (fake) Flex, then "Log in with Ledger" against the real server.
  await page.getByTestId('connect').click();
  await expect(page.locator('dl.addresses')).toContainText('0x');
  await page.getByTestId('login').click();
  // The app moves on to the next onboarding step by itself once logged in.
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await expect(page.getByRole('link', { name: '✓ Log in with Ledger' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your rules' })).toBeVisible();
  await shot(page, '02-logged-in');

  // 3. Rules: the form is pre-filled with the demo merchants; an invalid value is caught first.
  await page.goto(`${web}/?fakeDevice=1#/rules`);
  await expect(page.locator('.payee')).toHaveCount(3);
  await page.getByTestId('autoMax').fill('60');
  await page.getByTestId('send-rules').click();
  await expect(page.locator('.err').first()).toContainText('hard limit');
  await page.getByTestId('autoMax').fill('5');
  await page.getByTestId('send-rules').click();
  await expect(page.getByTestId('rules-active')).toContainText('budget 20 USDC');
  await shot(page, '03-rules');

  // 4. Session: only the device can arm it (here, the fake's stand-in for the switch).
  await page.goto(`${web}/?fakeDevice=1#/session`);
  await page.evaluate(() => (window as any).__bsaFake.armSession(true));
  await page.getByTestId('session-check').click();
  await expect(page.getByTestId('session-on')).toBeVisible();
  await expect(page.getByTestId('statusbar')).toContainText('agent active');
  await shot(page, '04-session');

  // 5. Connect Claude: the MCP URL is the public one.
  await page.goto(`${web}/?fakeDevice=1#/claude`);
  await expect(page.getByTestId('mcp-url')).toHaveText(`${web}/mcp`);
  await shot(page, '05-claude');

  // The dashboard, then the agent asks for money through the real server.
  await page.goto(`${web}/?fakeDevice=1#/dashboard`);
  await expect(page.getByTestId('budget-left')).toContainText('20');
  await expect(page.getByTestId('topup')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wallets' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Spending limit' })).toBeVisible();
  const account = (await page.evaluate(() => fetch('/auth/me').then((r) => r.json()))).account as string;

  // The prompt-injection deposit: the device refuses it, the banner says why.
  const evil = await bsa.agent.fetch(account, { url: `${shop}/evil/deposit` });
  expect(evil.kind).toBe('refused');
  await expect(page.getByTestId('refusal-banner')).toContainText('hard limit');
  await expect(page.getByTestId('feed')).toContainText('400 USDC');
  await shot(page, '06-dashboard-refusal');

  // A coffee: the device signs; the fake agent holds no USDC, so the facilitator rejects the
  // settlement and the feed shows that honestly. (Real settlement is covered by e2e-mcp.)
  const coffee = await bsa.agent.fetch(account, { url: `${shop}/cafe` });
  expect(coffee.kind).toBe('error');
  await expect(page.getByTestId('feed').locator('li').first()).toContainText('3 USDC');
  await expect(page.getByTestId('feed').locator('li').first()).toContainText('failed');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('refusal-banner')).toHaveCount(0);
  await shot(page, '07-dashboard-feed');

  // The kill switch wipes the rules on the device.
  await page.getByTestId('kill').click();
  await expect(page.getByText('No active rules on the Flex.')).toBeVisible();
  await expect(page.getByTestId('statusbar')).toContainText('No rules');
});

test('the OAuth consent page asks a logged-out user to sign in with Ledger', async ({ page }) => {
  const reg = await (await fetch(`${web}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' }),
  })).json();
  const q = new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', state: 'x',
  });
  await page.goto(`${web}/oauth/authorize?${q}`);
  await expect(page.getByText('Log in with Ledger')).toBeVisible();
  await shot(page, '08-oauth-login-required');
});

test('the 18+ badge: wallet (mock) -> Bind -> delegation -> the facilitator accepts the chain', async ({ page }) => {
  await page.goto(`${web}/?fakeDevice=1`);
  await page.getByTestId('connect').click();
  await page.getByTestId('login').click();
  await expect(page.getByRole('heading', { name: 'Your rules' })).toBeVisible();
  await page.getByTestId('send-rules').click();
  // The app moves on to the next step once the rules are on the device.
  await expect(page.getByRole('link', { name: '✓ Set your rules' })).toBeVisible();
  await page.evaluate(() => (window as any).__bsaFake.armSession(true));
  // A hash change is a same-document navigation: the (fake) device connection survives it.
  await page.goto(`${web}/?fakeDevice=1#/badge`);

  await page.getByTestId('badge-start').click();
  await expect(page.locator('.qr svg')).toBeVisible();
  await expect(page.getByTestId('mock-mode')).toBeVisible();
  await shot(page, '09-badge-qr');
  await page.getByTestId('badge-bind').click({ timeout: 10_000 });
  await page.getByTestId('agent-name').fill('Claude');
  await page.getByTestId('badge-delegate').click();
  await expect(page.getByTestId('badge-done')).toBeVisible();
  await shot(page, '10-badge-done');

  // The agent now buys wine. The fake agent holds no USDC, so the payment cannot settle — but
  // the facilitator must get past the whole 18+ chain first and fail only on the balance.
  const account = (await page.evaluate(() => fetch('/auth/me').then((r) => r.json()))).account as string;
  await page.evaluate(() => (window as any).__bsaFake.armSession(true));
  const wine = await bsa.agent.fetch(account, { url: `${shop}/wine` });
  expect(wine.kind).toBe('error');
  expect(wine.kind === 'error' && wine.message).toMatch(/insufficient_funds/);
  expect(wine.kind === 'error' && wine.message).not.toMatch(/AGE_PROOF|DELEGATION_|ATTESTATION_|SUBJECT_MISMATCH/);
});

test('Key Ring backup, a wiped Flex, and a one-tap restore', async ({ page }) => {
  await page.goto(`${web}/?fakeDevice=1`);
  await page.getByTestId('connect').click();
  await page.getByTestId('login').click();
  await page.getByTestId('send-rules').click();
  await expect(page.getByRole('link', { name: '✓ Set your rules' })).toBeVisible();

  await page.goto(`${web}/?fakeDevice=1#/backup`);
  await page.getByTestId('backup').click();
  await expect(page.getByTestId('backup-result')).toContainText('Backed up');
  await expect(page.getByTestId('backup-exists')).toBeVisible();
  await shot(page, '11-backup');

  // The vault holds ciphertext only: nothing readable about the rules.
  const main = (await page.evaluate(() => fetch('/auth/me').then((r) => r.json()))).account as string;
  const vault = await page.evaluate((m) => fetch(`/vault/${m}`).then((r) => r.json()), main);
  expect(Buffer.from(vault.ciphertext, 'base64').toString('latin1')).not.toMatch(/Cafe Sat|Restaurant/);

  // Reinstalling the app wipes it.
  await page.evaluate(() => (window as any).__bsaFake.wipe());
  await page.goto(`${web}/?fakeDevice=1#/restore`);
  await page.getByTestId('restore').click();
  await expect(page.getByTestId('restore-result')).toContainText('Restored');
  const restored = await page.evaluate(() => (window as any).__bsaFake.getState());
  expect(restored.policy.active).toBe(true);
  expect(restored.policy.payees.map((p: any) => p.label)).toEqual(['Cafe Sat', 'Corner Wines', 'Restaurant']);
  await shot(page, '12-restore');

  // Restoring over live rules is refused rather than silent.
  await page.getByTestId('restore').click();
  await expect(page.getByTestId('restore-result')).toContainText('already has rules');
});
