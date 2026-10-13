// Agent identity: one EU wallet scan -> the rights it proves (18+, a nationality) -> Bind on the
// Flex -> our attestation -> the user picks the rights to grant -> delegation on the Flex ->
// stored on the Flex. Nothing about the person but those rights ever reaches this page.
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { hashTypedData, type Hex } from 'viem';
import { attestedClaims, EIP712_TYPES, verifierDomain, type AgeAttestation, type Credentials } from '@bsa-sentry/types';
import type { Bsa } from '../useBsa.js';

type Session = { sessionId: Hex; mode: 'mock' | 'live'; qr: string; bind: { verifier: string; session: Hex; expiresAt: number } };
type Stage = 'start' | 'scan' | 'verified' | 'bound' | 'done' | 'failed';

const regionName = (code: string) => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code; } catch { return code; }
};
const flag = (code: string) => String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));

/** A right in the user's words. */
export function describeRight(claim: string): { title: string; detail: string; mark: string } {
  if (claim === 'age_over_18') return { title: '18 or older', detail: 'Proves adulthood, not the date of birth.', mark: '18+' };
  if (claim.startsWith('nationality:')) {
    const cc = claim.slice('nationality:'.length);
    return { title: `Nationality: ${regionName(cc)}`, detail: 'Proves a nationality, not who you are.', mark: flag(cc) };
  }
  return { title: claim, detail: '', mark: '•' };
}

export function Badge({ bsa }: { bsa: Bsa }) {
  const [stage, setStage] = useState<Stage>('start');
  const [session, setSession] = useState<Session | null>(null);
  const [svg, setSvg] = useState('');
  const [why, setWhy] = useState('');
  const [agentName, setAgentName] = useState('Claude');
  const [found, setFound] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [held, setHeld] = useState<Credentials | null>(null);
  // Kept in memory between the two device taps only; it ends up on the Flex, nowhere else.
  const attestation = useRef<{ attestation: AgeAttestation; attestationSig: Hex } | null>(null);

  // What the Flex holds now, read from the device itself.
  const readHeld = () => {
    if (!bsa.signer || !bsa.device?.hasCredentials) { setHeld(null); return; }
    void bsa.onDevice((s) => s.getCredentials()).then((c) => setHeld((c as Credentials) ?? null)).catch(() => setHeld(null));
  };
  useEffect(readHeld, [bsa.signer, bsa.device?.hasCredentials]);

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
    const chainId = BigInt(bsa.config.chainId);
    const delegation = {
      agent: bsa.addresses.agent as Hex,
      agentName: agentName.trim() || 'Agent',
      attestation: hashTypedData({ domain: verifierDomain(bsa.config.chainId), types: { AgeAttestation: EIP712_TYPES.AgeAttestation }, primaryType: 'AgeAttestation', message: a.attestation }),
      claims: [...chosen].sort(),
      expiresAt: a.attestation.expiresAt,
      nonce: `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join('')}` as Hex,
    };
    const delegationSig = await bsa.onDevice((s) => s.signDelegation({ chainId, ...delegation }));
    await bsa.onDevice((s) => s.storeCredentials({ chainId, attestation: a.attestation, attestationSig: a.attestationSig, delegation, delegationSig }));
    attestation.current = null;
    await bsa.refreshDevice();
    readHeld();
    setStage('done');
  });

  const toggle = (c: string) => setChosen((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  return (
    <>
      <section className="card">
        <h2>Agent identity</h2>
        <p>Let your agent prove facts about you, and nothing else. One scan with your EU identity wallet, then your Flex grants the rights you choose to the agent. Merchants check them without learning who you are.</p>

        {held ? (
          <div className="rights" data-testid="rights-held">
            {held.delegation.claims.map((c) => {
              const r = describeRight(c);
              return (
                <div className="right" key={c}>
                  <span className="right-mark" aria-hidden="true">{r.mark}</span>
                  <div><b>{r.title}</b><span>{r.detail}</span></div>
                </div>
              );
            })}
            <p className="muted rights-foot">
              Granted to {held.delegation.agentName} ({held.delegation.agent.slice(0, 6)}…{held.delegation.agent.slice(-4)}) until {new Date(Number(held.delegation.expiresAt) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. Stored on your Flex.
            </p>
          </div>
        ) : stage === 'start' && <p className="muted">No rights granted yet.</p>}
      </section>

      <section className="card">
        <h2>{held ? 'Renew or change the rights' : 'Verify with your EU wallet'}</h2>
        {stage === 'start' && (
          <>
            <p>We ask your wallet for two things only: your date of birth (for "18 or older") and your nationality. Neither is stored: they become signed rights on your Flex.</p>
            <button className="primary" disabled={!bsa.account} onClick={() => void start()} data-testid="badge-start">Scan with my EU wallet</button>
          </>
        )}
        {stage === 'scan' && session && (
          <div className="qr-block">
            <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
            <div>
              <p>Scan this code with your identity wallet (Procivis One), then share.</p>
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
