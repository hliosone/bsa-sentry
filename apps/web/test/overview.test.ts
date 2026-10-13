// The overview copy (first screen, "How it works", the pillars): rendered to HTML it must keep
// the copy rules (no dashes, honest identity wording), link the demo shops correctly, and show a
// merchant snippet that still matches the real merchants code.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HowItWorks, SHOPS, merchantSnippet, shopUrl } from '../src/pages/HowItWorks.js';
import { EUDI_LOGO, Pillars } from '../src/components/Pillars.js';
import type { Bsa } from '../src/useBsa.js';
import type { Config } from '../src/api.js';

const config = (merchantUrl: string | null): Config => ({
  chainId: 5042002, chainName: 'Arc testnet', usdc: '0x3600000000000000000000000000000000000000',
  explorer: 'https://explorer.testnet.arc.io', mcpUrl: 'https://bsa.example/mcp', merchantUrl, defaultPayees: [],
});
const howItWorks = (c: Config | null) => renderToStaticMarkup(createElement(HowItWorks, { bsa: { config: c } as unknown as Bsa }));
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// En dash, em dash, right arrow.
const BANNED = /[\u2013\u2014\u2192]/;

describe('overview copy', () => {
  it('has no en dash, em dash or arrow, rendered or in the sources', () => {
    for (const html of [howItWorks(config(null)), howItWorks(null), renderToStaticMarkup(createElement(Pillars, { compact: true }))]) {
      expect(html).not.toMatch(BANNED);
    }
    for (const f of ['../src/pages/Landing.tsx', '../src/pages/HowItWorks.tsx', '../src/components/Pillars.tsx', '../src/pages/overview.css']) {
      expect(read(f), f).not.toMatch(BANNED);
    }
  });

  it('describes the identity check honestly', () => {
    const html = howItWorks(config(null));
    expect(html).toContain('verified by the EU Digital Identity Wallet reference verifier');
    expect(html).toContain('tested with Paradym');
    expect(html).toContain('test PID');
    expect(html).not.toMatch(/state-issued/i);
    expect(renderToStaticMarkup(createElement(Pillars))).toContain('verified by the EU Digital Identity Wallet reference verifier');
  });

  it('shows the EU Digital Identity Wallet logo from public/', () => {
    expect(renderToStaticMarkup(createElement(Pillars, { compact: true }))).toContain(`src="${EUDI_LOGO}"`);
    const file = new URL(`../public${EUDI_LOGO}`, import.meta.url);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trimStart().startsWith('<svg')).toBe(true);
  });
});

describe('demo shop links', () => {
  it('use MERCHANT_URL as the shops base when set, without doubling /shops', () => {
    const html = howItWorks(config('https://merchants.example/'));
    for (const s of SHOPS) expect(html).toContain(`href="https://merchants.example${s.path}"`);
    expect(html).not.toContain('/shops/shops');
    expect(shopUrl('https://bsa.example/shops', '/wine')).toBe('https://bsa.example/shops/wine');
  });

  it("fall back to this server's /shops", () => {
    const html = howItWorks(config(null));
    for (const p of ['/cafe', '/bakery', '/restaurant', '/wine', '/presale', '/promo']) expect(html).toContain(`href="/shops${p}"`);
  });
});

describe('merchant snippet', () => {
  const merchants = read('../../merchants/src/app.ts');
  const snippet = merchantSnippet({ facilitatorUrl: 'https://bsa.example/x402', chainId: 5042002 });

  it('uses the same imports and route fields as apps/merchants', () => {
    const imports = snippet.split('\n').filter((l) => l.startsWith('import '));
    expect(imports).toHaveLength(3);
    for (const l of imports) expect(merchants).toContain(l);
    for (const s of ["scheme: 'exact'", 'extra: { requires:', "path: '/wine'", "price: '$4.5'", "'age_over_18'", "'jurisdiction_not:US'"]) {
      expect(merchants).toContain(s);
    }
  });

  it('points at our facilitator on the configured chain', () => {
    expect(snippet).toContain("new HTTPFacilitatorClient({ url: 'https://bsa.example/x402' })");
    expect(snippet).toContain("'eip155:5042002'");
    expect(howItWorks(config(null))).toContain('https://bsa.example/x402');
  });
});
