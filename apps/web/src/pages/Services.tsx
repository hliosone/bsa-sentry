// What the agent can buy: each service, its price, what it requires, and whether this agent
// qualifies today (trusted on the Flex, rights it holds). With a prompt to give Claude.
import { useEffect, useState } from 'react';
import { describeRequirement, satisfies, type Credentials } from '@bsa-sentry/types';
import type { Bsa } from '../useBsa.js';
import { usdc } from '../format.js';

type Service = { path: string; name: string; what: string; price: number | null; requires: string[]; prompt: string; note?: string };

const SERVICES: Service[] = [
  { path: '/cafe', name: 'Cafe Sat', what: 'An espresso', price: 3, requires: [], prompt: 'Buy me a coffee at {url}' },
  { path: '/bakery', name: 'Bakery', what: 'A croissant', price: 2, requires: [], prompt: 'Get me a croissant at {url}' },
  { path: '/restaurant', name: 'Restaurant', what: 'A table for two tonight', price: 20, requires: [], prompt: 'Book the restaurant at {url}' },
  { path: '/wine', name: 'Corner Wines', what: 'A bottle of Chasselas', price: 4.5, requires: ['age_over_18'], prompt: 'Buy a bottle of wine at {url}' },
  { path: '/presale', name: 'Token Presale', what: '500 STY allocation, not offered to US persons', price: 5, requires: ['jurisdiction_not:US'], prompt: 'Buy the token presale allocation at {url}' },
  { path: '/promo', name: 'Deals page', what: 'A free page that hides a 400 USDC scam aimed at AI agents', price: null, requires: [], prompt: 'Check out the deals at {url}', note: 'Your Flex refuses the hidden deposit without asking you.' },
];

export function Services({ bsa }: { bsa: Bsa }) {
  const base = bsa.config?.merchantUrl ?? '';
  const p = bsa.device?.policy;
  const [held, setHeld] = useState<Credentials | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!bsa.signer || !bsa.device?.hasCredentials) { setHeld(null); return; }
    void bsa.onDevice((s) => s.getCredentials()).then((c) => setHeld((c as Credentials) ?? null)).catch(() => setHeld(null));
  }, [bsa.signer, bsa.device?.hasCredentials]);
  const rights = held?.delegation.claims ?? [];

  return (
    <section className="card">
      <h2>Services</h2>
      <p>Places your agent can pay, with what each one asks for. Copy a prompt into Claude: your Flex decides every payment.</p>
      <div className="services">
        {SERVICES.map((s) => {
          const url = `${base}${s.path}`;
          const prompt = s.prompt.replace('{url}', url);
          const trusted = p?.active && p.payees.some((m) => m.label.toLowerCase().startsWith(s.name.toLowerCase().slice(0, 10)));
          const auto = trusted && s.price !== null && BigInt(Math.round(s.price * 1e6)) <= p!.autoMax;
          const missing = s.requires.filter((r) => !satisfies(r, rights));
          return (
            <article className="service" key={s.path} data-testid={`service-${s.path.slice(1)}`}>
              <div className="service-head">
                <h3>{s.name}</h3>
                <span className="price">{s.price === null ? 'Free' : `${s.price} USDC`}</span>
              </div>
              <p className="service-what">{s.what}</p>
              <ul className="facts">
                {s.price !== null && (
                  <li className={auto ? 'good' : 'ask'}>
                    {auto ? `Paid without asking (trusted, up to ${usdc(p!.autoMax)} USDC)` : trusted ? 'Your Flex asks you (above the automatic limit)' : 'Your Flex asks you (not a trusted merchant)'}
                  </li>
                )}
                {s.requires.map((r) => (
                  <li key={r} className={missing.includes(r) ? 'bad' : 'good'}>
                    Requires: {describeRequirement(r)} — {missing.includes(r) ? <a href="#/badge">not granted yet</a> : 'your agent can prove it'}
                  </li>
                ))}
                {s.note && <li className="good">{s.note}</li>}
              </ul>
              <div className="prompt">
                <span title={prompt}>{s.prompt.replace('{url}', `…/shops${s.path}`)}</span>
                <button className="ghost small" onClick={() => { void navigator.clipboard?.writeText(prompt); setCopied(s.path); }}>{copied === s.path ? 'Copied' : 'Copy'}</button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
