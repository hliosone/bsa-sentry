import { useEffect, useState } from 'react';
import type { Bsa } from '../useBsa.js';
import { defaultRules, validateRules, type RulesForm } from '../state/rules.js';
import { usdc } from '../format.js';

export function Rules({ bsa }: { bsa: Bsa }) {
  const [form, setForm] = useState<RulesForm>(defaultRules([]));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filled, setFilled] = useState(false);

  useEffect(() => {
    if (!filled && bsa.config) {
      setForm(defaultRules(bsa.config.defaultPayees));
      setFilled(true);
    }
  }, [bsa.config, filled]);

  const set = (k: keyof RulesForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const setPayee = (i: number, k: 'label' | 'address', v: string) =>
    setForm({ ...form, payees: form.payees.map((p, j) => (j === i ? { ...p, [k]: v } : p)) });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bsa.config) return;
    const r = validateRules(form, { chainId: BigInt(bsa.config.chainId), token: bsa.config.usdc });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    await bsa.setRules(r.policy);
  };

  const p = bsa.device?.policy;
  return (
    <section className="card">
      <h2>Tes règles</h2>
      <p>Elles vivent <b>dans le Flex</b>. Le site ne fait que les proposer : ton Flex te les montre et c'est toi qui les valides.</p>
      {p?.active && (
        <p className="ok" data-testid="rules-active">
          Règles actives : automatique jusqu'à {usdc(p.autoMax)} USDC, plafond {usdc(p.hardMax)} USDC, budget {usdc(p.budget)} USDC, {p.payees.length} marchands de confiance.
        </p>
      )}
      <form onSubmit={submit} className="rules">
        <label>Payé sans me demander jusqu'à (USDC)
          <input value={form.autoMax} onChange={set('autoMax')} inputMode="decimal" data-testid="autoMax" />
          {errors.autoMax && <span className="err">{errors.autoMax}</span>}
        </label>
        <label>Plafond absolu, refusé même avec ma confirmation (USDC)
          <input value={form.hardMax} onChange={set('hardMax')} inputMode="decimal" data-testid="hardMax" />
          {errors.hardMax && <span className="err">{errors.hardMax}</span>}
        </label>
        <label>Budget total (USDC)
          <input value={form.budget} onChange={set('budget')} inputMode="decimal" data-testid="budget" />
          {errors.budget && <span className="err">{errors.budget}</span>}
        </label>
        <label>Nombre de paiements max
          <input value={form.maxCount} onChange={set('maxCount')} inputMode="numeric" data-testid="maxCount" />
          {errors.maxCount && <span className="err">{errors.maxCount}</span>}
        </label>

        <h3>Marchands de confiance ({form.payees.length}/8)</h3>
        {errors.payees && <p className="err">{errors.payees}</p>}
        {form.payees.map((m, i) => (
          <div className="payee" key={i}>
            <input value={m.label} onChange={(e) => setPayee(i, 'label', e.target.value)} placeholder="Nom (16 octets max)" aria-label={`Nom du marchand ${i + 1}`} />
            <input value={m.address} onChange={(e) => setPayee(i, 'address', e.target.value)} placeholder="0x…" className="mono" aria-label={`Adresse du marchand ${i + 1}`} />
            <button type="button" className="ghost" onClick={() => setForm({ ...form, payees: form.payees.filter((_, j) => j !== i) })}>Retirer</button>
            {(errors[`payees.${i}.label`] || errors[`payees.${i}.address`]) && (
              <span className="err">{errors[`payees.${i}.label`] ?? errors[`payees.${i}.address`]}</span>
            )}
          </div>
        ))}
        {form.payees.length < 8 && (
          <button type="button" className="ghost" onClick={() => setForm({ ...form, payees: [...form.payees, { label: '', address: '' }] })}>+ Ajouter un marchand</button>
        )}
        <div><button className="primary" disabled={!bsa.signer || !!bsa.busy} data-testid="send-rules">Envoyer au Flex pour validation</button></div>
      </form>
    </section>
  );
}
