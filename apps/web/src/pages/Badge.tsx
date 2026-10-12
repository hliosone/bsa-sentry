// The 18+ badge: EUDI wallet scan -> Bind on the Flex -> attestation -> delegation on the Flex
// -> stored on the Flex. Nothing about the person ever reaches this page: the server only
// answers "verified" or not.
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { hashTypedData, type Hex } from 'viem';
import { CLAIM_AGE_OVER_18, EIP712_TYPES, verifierDomain, type AgeAttestation } from '@bsa-sentry/types';
import type { Bsa } from '../useBsa.js';

type Session = { sessionId: Hex; mode: 'mock' | 'live'; qr: string; bind: { verifier: string; session: Hex; expiresAt: number } };
type Stage = 'start' | 'scan' | 'verified' | 'bound' | 'done' | 'failed';

export function Badge({ bsa }: { bsa: Bsa }) {
  const [stage, setStage] = useState<Stage>(bsa.device?.hasCredentials ? 'done' : 'start');
  const [session, setSession] = useState<Session | null>(null);
  const [svg, setSvg] = useState('');
  const [why, setWhy] = useState('');
  const [agentName, setAgentName] = useState('Claude');
  // Kept in memory between the two device taps only; it ends up on the Flex, nowhere else.
  const attestation = useRef<{ attestation: AgeAttestation; attestationSig: Hex } | null>(null);

  useEffect(() => { if (bsa.device?.hasCredentials) setStage('done'); }, [bsa.device?.hasCredentials]);

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

  // While the QR is on screen and the user is looking at this page, ask the server for news.
  // This is the page, not the bridge: no device work happens here.
  useEffect(() => {
    if (stage !== 'scan' || !session) return;
    const t = setInterval(async () => {
      const st = await (await fetch(`/age/sessions/${session.sessionId}`)).json();
      if (st.status === 'verified') setStage('verified');
      else if (st.status !== 'pending') { setWhy(st.status); setStage('failed'); }
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
    setStage('bound');
  });

  const delegate = () => bsa.run("Check the agent's name and FULL address on your Flex, then hold to authorize…", async () => {
    const a = attestation.current;
    if (!a || !bsa.addresses.agent || !bsa.config) return;
    const chainId = BigInt(bsa.config.chainId);
    const delegation = {
      agent: bsa.addresses.agent as Hex,
      agentName: agentName.trim() || 'Agent',
      attestation: hashTypedData({ domain: verifierDomain(bsa.config.chainId), types: { AgeAttestation: EIP712_TYPES.AgeAttestation }, primaryType: 'AgeAttestation', message: a.attestation }),
      claims: [CLAIM_AGE_OVER_18],
      expiresAt: a.attestation.expiresAt,
      nonce: `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join('')}` as Hex,
    };
    const delegationSig = await bsa.onDevice((s) => s.signDelegation({ chainId, ...delegation }));
    await bsa.onDevice((s) => s.storeCredentials({ chainId, attestation: a.attestation, attestationSig: a.attestationSig, delegation, delegationSig }));
    attestation.current = null;
    await bsa.refreshDevice();
    setStage('done');
  });

  return (
    <section className="card">
      <h2>18+ badge</h2>
      <p>Prove you are 18 or older with your European identity wallet. The server keeps <b>no personal data</b>: only "over 18: yes", linked to your Ledger.</p>

      {stage === 'start' && (
        <button className="primary" disabled={!bsa.account} onClick={() => void start()} data-testid="badge-start">Get my 18+ badge</button>
      )}

      {stage === 'scan' && session && (
        <div className="qr-block">
          <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
          <div>
            <p>Scan this code with your identity wallet (Procivis One).</p>
            <p className="muted">Only your date of birth is requested; we work out "18 or older" from it and forget it.</p>
            {session.mode === 'mock' && <p className="warn" data-testid="mock-mode">Demo mode: no real wallet is queried.</p>}
            <p className="muted"><span className="pulse inline" /> Waiting for the wallet…</p>
          </div>
        </div>
      )}

      {stage === 'verified' && (
        <>
          <p className="ok">Age verified.</p>
          <p>Now link this result to your Ledger account: your Flex shows the verifier and asks you to sign.</p>
          <button className="primary" onClick={() => void bind()} data-testid="badge-bind">Link to my Ledger</button>
        </>
      )}

      {stage === 'bound' && (
        <>
          <p className="ok">Badge linked to your account.</p>
          <h3>Authorize your agent to present it</h3>
          <label className="inline-field">Agent name (shown on the Flex)
            <input value={agentName} onChange={(e) => setAgentName(e.target.value)} maxLength={24} data-testid="agent-name" />
          </label>
          <button className="primary" onClick={() => void delegate()} data-testid="badge-delegate">Authorize {agentName || 'the agent'}</button>
        </>
      )}

      {stage === 'done' && (
        <p className="ok" data-testid="badge-done">18+ badge active: your agent can present it to merchants who ask for it. It is stored on your Flex.</p>
      )}

      {stage === 'failed' && (
        <>
          <p className="err">Verification failed: {why}</p>
          <button className="ghost" onClick={() => { setStage('start'); setSession(null); }}>Try again</button>
        </>
      )}
    </section>
  );
}
