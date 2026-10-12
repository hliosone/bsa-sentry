// The website's logic, kept out of React so it can be tested without a browser:
// the onboarding steps, the rules form, the dashboard feed and the status bar.
import { describe, expect, it } from 'vitest';
import { onboarding, type Facts } from '../src/state/onboarding.js';
import { validateRules, defaultRules, parseUsdc } from '../src/state/rules.js';
import { feedReducer, initialFeed, type FeedEvent } from '../src/state/feed.js';
import { statusLine } from '../src/state/status.js';

const TOKEN = '0x3600000000000000000000000000000000000000' as const;
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175';
const RESTO = '0xd4e15888844c2df59cf371917c11a99267917af5';

describe('onboarding', () => {
  const none: Facts = {
    deviceConnected: false, loggedIn: false, policyActive: false, sessionArmed: false,
    hasCredentials: false, hasBackup: false, claudeConnected: false,
  };

  it('starts at connecting the Flex', () => {
    expect(onboarding(none).current).toBe('connect');
  });

  it('walks connect -> login -> rules -> session -> claude -> done', () => {
    const order: string[] = [];
    let f = { ...none };
    const fill: (keyof Facts)[] = ['deviceConnected', 'loggedIn', 'policyActive', 'sessionArmed', 'claudeConnected'];
    for (const k of fill) {
      order.push(onboarding(f).current);
      f = { ...f, [k]: true };
    }
    order.push(onboarding(f).current);
    expect(order).toEqual(['connect', 'login', 'rules', 'session', 'claude', 'done']);
  });

  it('never skips a missing earlier step, whatever is true later', () => {
    // Logged in a previous visit but the Flex is unplugged now: connect comes first.
    expect(onboarding({ ...none, loggedIn: true, policyActive: true }).current).toBe('connect');
  });

  it('treats the 18+ badge and the backup as optional', () => {
    const s = onboarding({ ...none, deviceConnected: true, loggedIn: true, policyActive: true, sessionArmed: true, claudeConnected: true });
    expect(s.current).toBe('done');
    const badge = s.steps.find((x) => x.id === 'badge')!;
    expect(badge.optional).toBe(true);
    expect(badge.done).toBe(false);
    expect(s.steps.find((x) => x.id === 'backup')!.optional).toBe(true);
  });

  it('marks exactly one step as current', () => {
    const s = onboarding({ ...none, deviceConnected: true });
    expect(s.steps.filter((x) => x.current)).toHaveLength(1);
  });
});

describe('rules form', () => {
  const ctx = { chainId: 5042002n, token: TOKEN };

  it('parses USDC amounts to base units without floating point', () => {
    expect(parseUsdc('5')).toBe(5_000_000n);
    expect(parseUsdc('4.5')).toBe(4_500_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(parseUsdc(' 20 ')).toBe(20_000_000n);
    expect(parseUsdc('1,5')).toBe(1_500_000n); // French decimal comma
    for (const bad of ['', 'abc', '-1', '1.0000001', '1e3', '0x10']) expect(parseUsdc(bad), bad).toBeNull();
  });

  it('accepts the demo rules', () => {
    const r = validateRules(defaultRules([{ label: 'Cafe Sat', address: CAFE }, { label: 'Restaurant', address: RESTO }]), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy).toMatchObject({ autoMax: 5_000_000n, hardMax: 50_000_000n, budget: 20_000_000n, maxCount: 10, token: TOKEN, active: true });
    expect(r.policy.payees.map((p) => p.address)).toEqual([CAFE, RESTO]);
  });

  it('rejects an auto limit above the hard ceiling', () => {
    const r = validateRules({ ...defaultRules([]), autoMax: '60', hardMax: '50' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.autoMax).toMatch(/hard limit/i);
  });

  it('rejects zero or malformed amounts and counts', () => {
    const r = validateRules({ ...defaultRules([]), budget: '0', maxCount: '1.5', hardMax: 'abc' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['budget', 'hardMax', 'maxCount']);
  });

  it('rejects more than 8 merchants, long labels, bad and duplicate addresses', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `M${i}`, address: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
    const r1 = validateRules(defaultRules(many), ctx);
    expect(!r1.ok && r1.errors.payees).toMatch(/8/);

    const r2 = validateRules(defaultRules([{ label: 'x'.repeat(17), address: CAFE }]), ctx);
    expect(!r2.ok && r2.errors['payees.0.label']).toMatch(/16/);

    const r3 = validateRules(defaultRules([{ label: 'ok', address: '0x1234' }]), ctx);
    expect(!r3.ok && r3.errors['payees.0.address']).toBeTruthy();

    const r4 = validateRules(defaultRules([{ label: 'a', address: CAFE }, { label: 'b', address: CAFE.toUpperCase().replace('0X', '0x') }]), ctx);
    expect(!r4.ok && r4.errors['payees.1.address']).toMatch(/already/i);
  });

  it('applies EIP-55: any single case is fine, a wrong mixed-case checksum is a typo', async () => {
    const { isValidAddress } = await import('../src/state/rules.js');
    expect(isValidAddress('0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf')).toBe(true);
    expect(isValidAddress('0xAA6ABF8F8C5F003A69D26D12D5A625DA77E2D9BF')).toBe(true);
    expect(isValidAddress('0xAa6aBf8F8c5F003A69D26d12d5a625Da77e2D9bF')).toBe(true); // correct checksum
    expect(isValidAddress('0xAa6aBf8F8c5F003A69D26d12d5a625Da77e2D9bf')).toBe(false); // last char flipped
  });

  it('counts the label limit in UTF-8 bytes, like the device', () => {
    const r = validateRules(defaultRules([{ label: 'Épicerie Zürich!', address: CAFE }]), ctx); // 16 chars, 18 bytes
    expect(r.ok).toBe(false);
  });

  it('requires a label, because the device shows it', () => {
    const r = validateRules(defaultRules([{ label: '  ', address: CAFE }]), ctx);
    expect(!r.ok && r.errors['payees.0.label']).toBeTruthy();
  });
});

describe('dashboard feed', () => {
  const req = (id: string, value = '3000000', hint = 'Cafe Sat'): FeedEvent => ({
    type: 'request', id, at: 1000,
    message: { type: 'sign_payment', fields: { to: CAFE, value }, hint },
  });

  it('a request appears as pending with its amount and merchant', () => {
    const s = feedReducer(initialFeed, req('a'));
    expect(s.items[0]).toMatchObject({ id: 'a', stage: 'pending', amount: '3', merchant: 'Cafe Sat', payee: CAFE });
  });

  it('a signature moves it to signed, then settlement adds the explorer link', () => {
    let s = feedReducer(initialFeed, req('a'));
    s = feedReducer(s, { type: 'answer', id: 'a', answer: { ok: true } });
    expect(s.items[0]!.stage).toBe('signed');
    s = feedReducer(s, { type: 'payment', kind: 'paid', url: 'https://m/cafe', amount: '3', payee: CAFE, txHash: '0xabc', at: 1001 });
    expect(s.items[0]).toMatchObject({ stage: 'settled', txHash: '0xabc' });
  });

  it('a refusal is marked and raises the banner', () => {
    let s = feedReducer(initialFeed, req('a', '400000000', 'Deposit'));
    s = feedReducer(s, { type: 'answer', id: 'a', answer: { ok: false, reason: 'OVER_HARD_MAX' } });
    expect(s.items[0]).toMatchObject({ stage: 'refused', reason: 'OVER_HARD_MAX', amount: '400' });
    expect(s.banner).toMatchObject({ reason: 'OVER_HARD_MAX', amount: '400' });
  });

  it('dismissing the banner keeps the history', () => {
    let s = feedReducer(initialFeed, req('a'));
    s = feedReducer(s, { type: 'answer', id: 'a', answer: { ok: false, reason: 'USER_REJECTED' } });
    s = feedReducer(s, { type: 'dismiss' });
    expect(s.banner).toBeNull();
    expect(s.items).toHaveLength(1);
  });

  it('newest first, and capped so a long session does not grow forever', () => {
    let s = initialFeed;
    for (let i = 0; i < 60; i++) s = feedReducer(s, req(`r${i}`));
    expect(s.items[0]!.id).toBe('r59');
    expect(s.items.length).toBeLessThanOrEqual(50);
  });

  it('ignores an answer for a request it never saw', () => {
    const s = feedReducer(initialFeed, { type: 'answer', id: 'ghost', answer: { ok: true } });
    expect(s.items).toHaveLength(0);
  });
});

describe('status bar', () => {
  it('is green when everything is ready', () => {
    expect(statusLine({ socket: 'open', flex: 'connected', session: true, policyActive: true })).toMatchObject({ level: 'ok' });
  });

  it('says exactly what to fix, most fundamental first', () => {
    expect(statusLine({ socket: 'closed', flex: 'connected', session: true, policyActive: true }).text).toMatch(/server/i);
    expect(statusLine({ socket: 'open', flex: 'disconnected', session: false, policyActive: false }).text).toMatch(/plug in/i);
    expect(statusLine({ socket: 'open', flex: 'locked', session: false, policyActive: true }).text).toMatch(/unlock/i);
    expect(statusLine({ socket: 'open', flex: 'app_closed', session: false, policyActive: true }).text).toMatch(/open.*BSA Sentry/i);
    expect(statusLine({ socket: 'open', flex: 'connected', session: true, policyActive: false }).text).toMatch(/rules/i);
    expect(statusLine({ socket: 'open', flex: 'connected', session: false, policyActive: true }).text).toMatch(/session/i);
  });

  it('always reminds to keep the computer awake while ready', () => {
    expect(statusLine({ socket: 'open', flex: 'connected', session: true, policyActive: true }).text).toMatch(/awake/i);
  });
});
