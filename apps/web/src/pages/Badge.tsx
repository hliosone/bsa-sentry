// Agent identity: one EU wallet scan -> the rights it proves (18+, a jurisdiction) -> Bind on the
// Flex -> our attestation -> the user picks the rights to grant -> delegation on the Flex ->
// stored on the Flex. Nothing about the person but those rights ever reaches this page.
// Afterwards each right can be removed or added on its own: a new delegation from the same
// stored attestation, signed on the Flex, stored, and the grant it replaces revoked.
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { hashTypedData, type Hex } from 'viem';
import {
  attestedClaims, EIP712_TYPES, sentryDomain, splitCredentials, verifierDomain, type AgeAttestation, type AgentDelegation, type Credentials,
} from '@bsa-sentry/types';
import type { Bsa } from '../useBsa.js';
import './badge.css';

type Session = { sessionId: Hex; mode: 'mock' | 'live'; qr: string; bind: { verifier: string; session: Hex; expiresAt: number } };
type Stage = 'start' | 'scan' | 'verified' | 'bound' | 'done' | 'failed';

const regionName = (code: string) => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code; } catch { return code; }
};
const flag = (code: string) => String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));

/** A right in the user's words. */
export function describeRight(claim: string): { title: string; detail: string; mark: string } {
  if (claim === 'age_over_18') return { title: '18 or older', detail: 'Proves adulthood, not the date of birth.', mark: '18+' };
  if (claim.startsWith('jurisdiction:')) {
    const cc = claim.slice('jurisdiction:'.length);
    return { title: `Jurisdiction: ${regionName(cc)}`, detail: 'Your nationality, from your verified ID. Not who you are.', mark: flag(cc) };
  }
  return { title: claim, detail: '', mark: '•' };
}

/** A fresh 32-byte nonce: each delegation is a new grant, with its own hash to revoke. */
export const randomNonce = (): Hex =>
  `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join('')}` as Hex;

/**
 * The held delegation with another set of rights: same agent, name, attestation and expiry,
 * a new nonce. Only rights the stored attestation proves can be granted (the facilitator
 * refuses anything else), and a grant with no right at all is a revocation, not a grant.
 */
export function regrant(held: Credentials, claims: string[], nonce: Hex): AgentDelegation {
  const next = [...new Set(claims)].sort();
  if (next.length === 0) throw new Error('a grant needs at least one right: revoke all instead');
  const attested = attestedClaims(held.attestation.claim);
  const unproven = next.find((c) => !attested.includes(c));
  if (unproven) throw new Error(`your wallet did not prove ${unproven}: scan again to add it`);
  const { agent, agentName, attestation, expiresAt } = held.delegation;
  return { agent, agentName, attestation, claims: next, expiresAt, nonce };
}

export const withoutRight = (held: Credentials, claim: string, nonce: Hex) =>
  regrant(held, held.delegation.claims.filter((c) => c !== claim), nonce);

export const withRight = (held: Credentials, claim: string, nonce: Hex) =>
  regrant(held, [...held.delegation.claims, claim], nonce);

/** Rights the stored attestation proves that the agent does not hold yet. */
export const grantableRights = (held: Credentials) =>
  attestedClaims(held.attestation.claim).filter((c) => !held.delegation.claims.includes(c));

/** Whether a regrant would still be accepted: the delegation and its attestation are both unexpired. */
export const stillValid = (held: Credentials, nowSeconds: number) =>
  held.delegation.expiresAt > BigInt(nowSeconds) && held.attestation.expiresAt > BigInt(nowSeconds);

/** What the Flex shows on "Authorize your agent", in its own format, so the user can compare. */
export const flexReview = (d: AgentDelegation) =>
  `agent ${d.agentName}, address ${d.agent.toLowerCase()}, can prove ${d.claims.join(', ')}, until ${new Date(Number(d.expiresAt) * 1000).toISOString().slice(0, 10)}`;

export function Badge({ bsa }: { bsa: Bsa }) {
  const [stage, setStage] = useState<Stage>('start');
  const [session, setSession] = useState<Session | null>(null);
  const [svg, setSvg] = useState('');
  const [why, setWhy] = useState('');
  const [agentName, setAgentName] = useState('Claude');
  const [found, setFound] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [held, setHeld] = useState<Credentials | null>(null);
  // null while unknown: rights are only changed one by one once we know they are not revoked.
  const [revoked, setRevoked] = useState<boolean | null>(null);
  // Grants a newer one replaced but the server did not revoke yet: they still work until it does.
  const [stale, setStale] = useState<{ bundles: Credentials[]; why: string } | null>(null);
  // Kept in memory between the two device taps only; it ends up on the Flex, nowhere else.
  const attestation = useRef<{ attestation: AgeAttestation; attestationSig: Hex } | null>(null);

  // What the Flex holds now, read from the device itself.
  const readHeld = () => {
    if (!bsa.signer || !bsa.device?.hasCredentials) { setHeld(null); return; }
    void bsa.onDevice((s) => s.getCredentials()).then((c) => setHeld((c as Credentials) ?? null)).catch(() => setHeld(null));
  };
  useEffect(readHeld, [bsa.signer, bsa.device?.hasCredentials]);

  // Whether the rights on the Flex were revoked: checked against the server's revocation list.
  const heldHash = held && bsa.config ? hashTypedData({
    domain: sentryDomain(bsa.config.chainId), types: { AgentDelegation: EIP712_TYPES.AgentDelegation }, primaryType: 'AgentDelegation', message: held.delegation,
  }).toLowerCase() : null;
  useEffect(() => {
    setRevoked(null);
    if (!heldHash) return;
    let current = true;
    void fetch(`/age/revoked/${heldHash}`).then((r) => r.json()).then((b) => { if (current) setRevoked(!!b.revoked); }).catch(() => undefined);
    return () => { current = false; };
  }, [heldHash]);

  // Marks one delegation revoked on the server; merchants refuse it from then on.
  const postRevoke = async (bundle: Credentials) => {
    const r = await fetch('/age/revoke', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(splitCredentials(bundle)),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error ?? 'the revocation was refused');
  };

  const revoke = () => bsa.run('Revoking the rights your agent holds…', async () => {
    if (!held) return;
    await postRevoke(held);
    setRevoked(true);
    // "Revoked" must mean all of it: also the previous grants still waiting for their retry.
    if (stale) await retire(stale.bundles);
  });

  // Revokes grants a newer one on the Flex replaced. Any left over stay listed with a retry,
  // because until then a copy of them (the server relays credentials) would still be accepted.
  const retire = async (bundles: Credentials[]) => {
    const left: Credentials[] = [];
    let why = '';
    for (const b of bundles) {
      try { await postRevoke(b); } catch (e) { left.push(b); why = (e as Error).message; }
    }
    setStale(left.length ? { bundles: left, why } : null);
  };
  const retryRevoke = () => bsa.run('Revoking your previous grant…', async () => { if (stale) await retire(stale.bundles); });

  // One right more or less: a new delegation from the SAME stored attestation, signed on the
  // Flex (one hold) and stored there, THEN the grant it replaces is revoked. Store first, so a
  // failed revocation never leaves the user with nothing. The old grant is revoked on an
  // addition too, although it is a subset: otherwise {18+} -> add FR -> remove 18+ would leave
  // the first {18+} grant alive, and the removed right would still work.
  const change = (next: AgentDelegation, what: string) => {
    const old = held;
    if (!old || !bsa.config) return;
    const chainId = BigInt(bsa.config.chainId);
    return bsa.run(`${what} Your Flex shows "Authorize your agent": ${flexReview(next)}. Check them, then hold to authorize…`, async () => {
      const delegationSig: Hex = await bsa.onDevice((s) => s.signDelegation({ chainId, ...next }));
      const bundle: Credentials = { chainId, attestation: old.attestation, attestationSig: old.attestationSig, delegation: next, delegationSig };
      await bsa.onDevice((s) => s.storeCredentials(bundle));
      setHeld(bundle);
      await bsa.refreshDevice();
      await retire([...(stale?.bundles ?? []), old]);
    });
  };
  const removeRight = (c: string) => held && change(withoutRight(held, c, randomNonce()), `Removing "${describeRight(c).title}" from ${held.delegation.agentName}.`);
  const addRight = (c: string) => held && change(withRight(held, c, randomNonce()), `Granting "${describeRight(c).title}" to ${held.delegation.agentName}.`);

  const start = async () => {
    // Any failure is shown: a click that silently does nothing is the worst outcome here.
    try {
      const res = await fetch('/age/sessions', { method: 'POST', credentials: 'same-origin' });
      const s = await res.json().catch(() => ({ error: `server answered ${res.status}` }));
      if (!res.ok) { setWhy(s.error ?? 'error'); setStage('failed'); return; }
      setSession(s);
      setSvg(await QRCode.toString(s.qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'L' }));
      setStage('scan');
    } catch (e) {
      setWhy((e as Error).message);
      setStage('failed');
    }
  };

  // While the QR is on screen, ask the server for news. This is the page, not the bridge.
  useEffect(() => {
    if (stage !== 'scan' || !session) return;
    const t = setInterval(async () => {
      const st = await (await fetch(`/age/sessions/${session.sessionId}`, { cache: 'no-store' })).json();
      if (st.status === 'verified') {
        const claims: string[] = st.claims ?? [];
        setFound(claims);
        setChosen(claims);
        setStage('verified');
      } else if (st.status !== 'pending') { setWhy(st.status); setStage('failed'); }
    }, 2000);
    return () => clearInterval(t);
  }, [stage, session]);

  const bind = () => bsa.run('Check the verifier and the session on your Flex, then hold to link…', async () => {
    if (!session || !bsa.addresses.main) return;
    const signature = await bsa.onDevice((s) => s.signBind({
      chainId: BigInt(bsa.config!.chainId), verifier: session.bind.verifier, session: session.bind.session, expiresAt: BigInt(session.bind.expiresAt),
    }));
    const res = await fetch(`/age/sessions/${session.sessionId}/bind`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: bsa.addresses.main, signature }),
    });
    const b = await res.json();
    if (!res.ok) throw new Error(b.error ?? 'linking refused');
    attestation.current = {
      attestation: { ...b.attestation, issuedAt: BigInt(b.attestation.issuedAt), expiresAt: BigInt(b.attestation.expiresAt) },
      attestationSig: b.attestationSig,
    };
    // Only rights the attestation states can be granted.
    const attested = attestedClaims(b.attestation.claim);
    setChosen((c) => c.filter((x) => attested.includes(x)));
    setFound(attested);
    setStage('bound');
  });

  const delegate = () => bsa.run("Check the agent's name, its FULL address and the rights on your Flex, then hold to authorize…", async () => {
    const a = attestation.current;
    if (!a || !bsa.addresses.agent || !bsa.config || chosen.length === 0) return;
    // The grant this one replaces on the Flex, revoked once the new one is stored (as in `change`).
    const previous = held && revoked !== true ? held : null;
    const chainId = BigInt(bsa.config.chainId);
    const delegation = {
      agent: bsa.addresses.agent as Hex,
      agentName: agentName.trim() || 'Agent',
      attestation: hashTypedData({ domain: verifierDomain(bsa.config.chainId), types: { AgeAttestation: EIP712_TYPES.AgeAttestation }, primaryType: 'AgeAttestation', message: a.attestation }),
      claims: [...chosen].sort(),
      expiresAt: a.attestation.expiresAt,
      nonce: randomNonce(),
    };
    const delegationSig = await bsa.onDevice((s) => s.signDelegation({ chainId, ...delegation }));
    await bsa.onDevice((s) => s.storeCredentials({ chainId, attestation: a.attestation, attestationSig: a.attestationSig, delegation, delegationSig }));
    attestation.current = null;
    await bsa.refreshDevice();
    readHeld();
    if (previous) await retire([...(stale?.bundles ?? []), previous]);
    setStage('done');
  });

  const toggle = (c: string) => setChosen((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  const valid = !!held && stillValid(held, Math.floor(Date.now() / 1000));
  // One right at a time only on a live grant we know is not revoked, with the Flex and the login there.
  const editable = !!held && revoked === false && valid && !!bsa.signer && !!bsa.account;
  const idle = !bsa.busy;

  return (
    <>
      <section className="card">
        <h2>Agent identity</h2>
        <p>Let your agent prove facts about you, and nothing else. You share them once from your EU Digital Identity Wallet. They are verified by the EU Digital Identity Wallet reference verifier, then your Flex grants the rights you choose to the agent. Merchants check them without learning who you are.</p>

        {held ? (
          <div className={`rights ${revoked ? 'revoked' : ''}`} data-testid="rights-held">
            {held.delegation.claims.map((c) => {
              const r = describeRight(c);
              return (
                <div className="right" key={c}>
                  <span className="right-mark" aria-hidden="true">{r.mark}</span>
                  <div><b>{r.title}</b><span>{r.detail}</span></div>
                  {editable && held.delegation.claims.length > 1 && (
                    <button className="danger small right-action" disabled={!idle} onClick={() => void removeRight(c)} data-testid={`remove-right-${c}`}>Remove this right</button>
                  )}
                </div>
              );
            })}
            {editable && grantableRights(held).map((c) => {
              const r = describeRight(c);
              return (
                <div className="right not-granted" key={c}>
                  <span className="right-mark" aria-hidden="true">{r.mark}</span>
                  <div><b>{r.title}</b><span>Proven by your wallet, not granted to {held.delegation.agentName}.</span></div>
                  <button className="small right-action" disabled={!idle} onClick={() => void addRight(c)} data-testid={`grant-right-${c}`}>Grant to {held.delegation.agentName}</button>
                </div>
              );
            })}
            {revoked ? (
              <p className="err rights-foot" data-testid="rights-revoked">Revoked. Merchants refuse these rights from now on. Grant new ones below if you want.</p>
            ) : (
            <p className="muted rights-foot">
              Granted to {held.delegation.agentName} ({held.delegation.agent.slice(0, 6)}…{held.delegation.agent.slice(-4)}) until {new Date(Number(held.delegation.expiresAt) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. Stored on your Flex.
              {!valid && ' Expired: scan again below to grant new ones.'}
              {' '}<button className="danger small" onClick={() => void revoke()} data-testid="revoke">Revoke all</button>
            </p>
            )}
          </div>
        ) : stage === 'start' && <p className="muted">No rights granted yet.</p>}
        {stale && (
          <p className="err" role="alert" data-testid="stale-grant">
            Your Flex holds the new rights, but revoking your previous grant failed ({stale.why}). Until it is revoked, the previous grant is still valid and merchants would still accept it.
            {' '}<button className="danger small" disabled={!idle} onClick={() => void retryRevoke()} data-testid="revoke-retry">Retry revoking</button>
          </p>
        )}
      </section>

      <section className="card">
        <h2>{held ? 'Renew or change the rights' : 'Verify with your EU wallet'}</h2>
        {stage === 'start' && (
          <>
            <p>We ask your wallet for your date of birth (for "18 or older") and your nationality and the country that issued your ID (your jurisdiction), nothing else. The EU Digital Identity Wallet reference verifier checks the issuer's signature. Neither is stored: they become signed rights on your Flex.</p>
            <button className="primary" disabled={!bsa.account} onClick={() => void start()} data-testid="badge-start">Scan with my EU wallet</button>
            {held && <p className="muted">To add a right your wallet did not prove, scan again.</p>}
          </>
        )}
        {stage === 'scan' && session && (
          <div className="qr-block">
            <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
            <div>
              <p>Scan this code with your EU Digital Identity Wallet app (tested with Paradym), then share.</p>
              {session.mode === 'mock' && <p className="warn" data-testid="mock-mode">Demo mode: no real wallet is queried.</p>}
              <p className="muted"><span className="pulse inline" /> Waiting for the wallet…</p>
            </div>
          </div>
        )}
        {(stage === 'verified' || stage === 'bound') && (
          <>
            <p className="ok">Verified. These are the rights your wallet proved; choose the ones to grant your agent.</p>
            <div className="rights choose">
              {found.map((c) => {
                const r = describeRight(c);
                return (
                  <label className={`right ${chosen.includes(c) ? 'on' : ''}`} key={c}>
                    <input type="checkbox" checked={chosen.includes(c)} onChange={() => toggle(c)} />
                    <span className="right-mark" aria-hidden="true">{r.mark}</span>
                    <div><b>{r.title}</b><span>{r.detail}</span></div>
                  </label>
                );
              })}
            </div>
          </>
        )}
        {stage === 'verified' && (
          <>
            <p>First, link this result to your Ledger: your Flex shows the verifier and asks you to sign.</p>
            <button className="primary" onClick={() => void bind()} data-testid="badge-bind">Link to my Ledger</button>
          </>
        )}
        {stage === 'bound' && (
          <>
            <label className="inline-field">Agent name (shown on the Flex)
              <input value={agentName} onChange={(e) => setAgentName(e.target.value)} maxLength={24} data-testid="agent-name" />
            </label>
            <button className="primary" disabled={chosen.length === 0} onClick={() => void delegate()} data-testid="badge-delegate">Grant to {agentName || 'the agent'}</button>
          </>
        )}
        {stage === 'done' && (
          <p className="ok" data-testid="badge-done">Done: your agent can now prove these rights to merchants that ask. They are stored on your Flex.</p>
        )}
        {stage === 'failed' && (
          <>
            <p className="err">Verification failed: {why}</p>
            <button className="ghost" onClick={() => { setStage('start'); setSession(null); }}>Try again</button>
          </>
        )}
      </section>
    </>
  );
}
