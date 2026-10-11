// /vault/:main — the Key Ring backup, as ciphertext only (security invariant 8). It is
// encrypted in the browser under the user's seed (Ledger Key Ring); the server cannot read it.
//
// Writing needs proof of control of 0xMAIN: the Ledger login session for that address, or an
// AgentDelegation signed by it. Both are signatures the Flex only makes after a tap. Reading
// needs the owner's session: the ciphertext is useless to others, but there is no reason to
// hand it out.
import { Router, json } from 'express';
import { getAddress, isAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { EIP712_TYPES, sentryDomain, toViemSignature } from '@bsa-sentry/types';
import type { Db } from './db.js';
import { readSession } from './auth.js';

/** A full backup (8 payees + credentials) is under 1 KB; leave room for the encryption envelope. */
const MAX_CIPHERTEXT_B64 = 16_384;

export function vaultRouter(o: { db: Db; chainId: number; secret: string; now?: () => number }) {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const router = Router();
  router.use(json({ limit: '64kb' }));

  async function delegationSigner(d: any): Promise<Hex | null> {
    try {
      const m = d?.message;
      return getAddress(await recoverTypedDataAddress({
        domain: sentryDomain(o.chainId),
        types: { AgentDelegation: EIP712_TYPES.AgentDelegation },
        primaryType: 'AgentDelegation',
        message: { agent: m.agent, agentName: m.agentName, attestation: m.attestation, claims: m.claims, expiresAt: BigInt(m.expiresAt), nonce: m.nonce },
        signature: toViemSignature(d.signature),
      }));
    } catch {
      return null;
    }
  }

  router.put('/:main', async (req, res) => {
    const main = req.params.main;
    if (!isAddress(main)) return res.status(400).json({ error: 'not an address' });
    const owner = main.toLowerCase();
    const { ciphertext, delegation } = req.body ?? {};
    if (typeof ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) {
      return res.status(400).json({ error: 'ciphertext must be base64' });
    }
    if (ciphertext.length > MAX_CIPHERTEXT_B64) return res.status(413).json({ error: 'backup too large' });

    const bySession = readSession(req, o.secret, now) === owner;
    const byDelegation = !bySession && delegation ? (await delegationSigner(delegation))?.toLowerCase() === owner : false;
    if (!bySession && !byDelegation) return res.status(403).json({ error: 'only the owner of this address can write its backup' });

    o.db.prepare(`INSERT INTO vault (account, ciphertext, delegation, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(account) DO UPDATE SET ciphertext = excluded.ciphertext, delegation = excluded.delegation, updated_at = excluded.updated_at`)
      .run(owner, ciphertext, delegation ? JSON.stringify(delegation) : '', now());
    res.json({ ok: true });
  });

  router.get('/:main', (req, res) => {
    const main = req.params.main;
    if (!isAddress(main)) return res.status(400).json({ error: 'not an address' });
    if (readSession(req, o.secret, now) !== main.toLowerCase()) return res.status(403).json({ error: 'log in as the owner first' });
    const row = o.db.prepare('SELECT ciphertext, updated_at FROM vault WHERE account = ?').get(main.toLowerCase()) as
      | { ciphertext: string; updated_at: number } | undefined;
    if (!row) return res.status(404).json({ error: 'no backup' });
    res.json({ ciphertext: row.ciphertext, updatedAt: row.updated_at });
  });

  return router;
}
