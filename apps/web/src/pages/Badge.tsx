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
    const res = await fetch('/age/sessions', { method: 'POST', credentials: 'same-origin' });
    const s = await res.json();
    if (!res.ok) { setWhy(s.error ?? 'erreur'); setStage('failed'); return; }
    setSession(s);
    setSvg(await QRCode.toString(s.qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'L' }));
    setStage('scan');
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

  const bind = () => bsa.run('Vérifie le vérificateur et la session sur ton Flex, puis maintiens pour lier…', async () => {
    if (!session || !bsa.addresses.main) return;
    const signature = await bsa.onDevice((s) => s.signBind({
      chainId: BigInt(bsa.config!.chainId), verifier: session.bind.verifier, session: session.bind.session, expiresAt: BigInt(session.bind.expiresAt),
    }));
    const res = await fetch(`/age/sessions/${session.sessionId}/bind`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: bsa.addresses.main, signature }),
    });
    const b = await res.json();
    if (!res.ok) throw new Error(b.error ?? 'liaison refusée');
    attestation.current = {
      attestation: { ...b.attestation, issuedAt: BigInt(b.attestation.issuedAt), expiresAt: BigInt(b.attestation.expiresAt) },
      attestationSig: b.attestationSig,
    };
    setStage('bound');
  });

  const delegate = () => bsa.run("Vérifie le nom et l'adresse COMPLÈTE de l'agent sur ton Flex, puis maintiens pour autoriser…", async () => {
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
      <h2>Badge 18+</h2>
      <p>Prouve ta majorité avec ton portefeuille d'identité européen. Le serveur ne garde <b>aucune donnée personnelle</b> : seulement « majeur : oui », lié à ton Ledger.</p>

      {stage === 'start' && (
        <button className="primary" disabled={!bsa.account} onClick={() => void start()} data-testid="badge-start">Obtenir mon badge 18+</button>
      )}

      {stage === 'scan' && session && (
        <div className="qr-block">
          <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
          <div>
            <p>Scanne ce code avec ton portefeuille d'identité (Procivis One).</p>
            <p className="muted">Seule ta date de naissance est demandée ; on en déduit « 18 ans ou plus » et on l'oublie.</p>
            {session.mode === 'mock' && <p className="warn" data-testid="mock-mode">Mode démo : aucun portefeuille réel n'est interrogé.</p>}
            <p className="muted"><span className="pulse inline" /> En attente du portefeuille…</p>
          </div>
        </div>
      )}

      {stage === 'verified' && (
        <>
          <p className="ok">Majorité vérifiée.</p>
          <p>Lie maintenant ce résultat à ton compte Ledger : ton Flex affiche le vérificateur et te demande de signer.</p>
          <button className="primary" onClick={() => void bind()} data-testid="badge-bind">Lier à mon Ledger</button>
        </>
      )}

      {stage === 'bound' && (
        <>
          <p className="ok">Badge lié à ton compte.</p>
          <h3>Autoriser ton agent à le présenter</h3>
          <label className="inline-field">Nom de l'agent (affiché sur le Flex)
            <input value={agentName} onChange={(e) => setAgentName(e.target.value)} maxLength={24} data-testid="agent-name" />
          </label>
          <button className="primary" onClick={() => void delegate()} data-testid="badge-delegate">Autoriser {agentName || "l'agent"}</button>
        </>
      )}

      {stage === 'done' && (
        <p className="ok" data-testid="badge-done">Badge 18+ actif : ton agent peut le présenter aux marchands qui le demandent. Il est stocké sur ton Flex.</p>
      )}

      {stage === 'failed' && (
        <>
          <p className="err">Vérification impossible : {why}</p>
          <button className="ghost" onClick={() => { setStage('start'); setSession(null); }}>Réessayer</button>
        </>
      )}
    </section>
  );
}
