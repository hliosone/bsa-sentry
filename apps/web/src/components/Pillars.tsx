// The three parts of BSA Sentry, side by side: our own Ledger app as the agent's wallet, Know Your
// Agent from the EU Digital Identity Wallet, agentic commerce rails. Used on the first screen and on
// "How it works".
// It has no buttons and none of the headings the e2e test looks for, so it fits on any page.
import type { ReactNode } from 'react';
import '../pages/overview.css';

/*
 * Official EU Digital Identity Wallet logo (dark appearance variant, white lettering), from the
 * EU reference iOS wallet app, copied unchanged:
 * https://github.com/eu-digital-identity-wallet/eudi-app-ios-wallet-ui/blob/9221795a05a8b70284a28df689173ea42c654f6b/Modules/logic-resources/Sources/Resources/Images.xcassets/logo-eu-digital-indentity-wallet.imageset/eudi-wallet-logo-dark.svg
 * Licence: EUPL-1.2 (the licence of that repository). Served from apps/web/public.
 * Shown to name the wallet BSA Sentry works with, not as an endorsement.
 */
export const EUDI_LOGO = '/eudi-wallet-logo.svg';

/** The EU Digital Identity Wallet logo at a given height (its viewBox is 140 x 46). */
export function EudiMark({ height = 46 }: { height?: number }) {
  return <img className="ov-eudi" src={EUDI_LOGO} alt="EU Digital Identity Wallet" height={height} width={Math.round((height * 140) / 46)} />;
}

const FlexGlyph = () => (
  <svg width="22" height="28" viewBox="0 0 22 28" aria-hidden="true">
    <rect x="1" y="1" width="20" height="26" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
    <rect x="5" y="5" width="12" height="14" rx="2" fill="currentColor" />
  </svg>
);

export const PILLARS = [
  {
    id: 'rules',
    title: 'Your own Ledger app',
    line: 'The agent\'s wallet. It pays within your limits and asks you only at the boundary.',
    detail:
      'Our sideloaded Ledger Flex app is your agent\'s wallet: its keys never leave the device. Payments to trusted merchants within your limits are signed with no tap, in 1 to 2 seconds. You only see the boundary: a new merchant, or a payment over your automatic limit. Above the hard limit, it refuses.',
  },
  {
    id: 'identity',
    title: 'Know Your Agent',
    line: '18 or older and a jurisdiction, never your name.',
    detail:
      'One scan with an EU Digital Identity Wallet app, verified by the EU Digital Identity Wallet reference verifier. Only "18 or older" and a jurisdiction are kept. Your Flex grants them to your agent, one right at a time, and you can revoke them.',
  },
  {
    id: 'rails',
    title: 'Agentic commerce rails',
    line: 'Our facilitator, any x402 shop, Shopify, any MCP agent.',
    detail:
      'Our x402 facilitator settles USDC on Arc testnet and checks the rights a shop requires (18 or older, not a US person) without telling it who you are. Shops keep the standard x402 middleware, Shopify stores included. Agents connect over remote MCP with OAuth.',
  },
] as const;

const MARKS: Record<(typeof PILLARS)[number]['id'], ReactNode> = {
  rules: <FlexGlyph />,
  identity: <EudiMark />,
  rails: <span className="ov-x402">x402</span>,
};

export function Pillars({ compact = false }: { compact?: boolean }) {
  return (
    <ul className={`ov-pillars${compact ? ' is-compact' : ''}`} aria-label="What BSA Sentry does">
      {PILLARS.map((p) => (
        <li className="ov-pillar" key={p.id} data-pillar={p.id}>
          <div className="ov-pillar-mark">{MARKS[p.id]}</div>
          <h3>{p.title}</h3>
          <p>{compact ? p.line : p.detail}</p>
        </li>
      ))}
    </ul>
  );
}
