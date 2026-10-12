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
      <h2>Your rules</h2>
      <p>They live <b>in the Flex</b>. This website only proposes them: your Flex shows them to you and you approve them.</p>
      {p?.active && (
        <p className="ok" data-testid="rules-active">
          Active rules: automatic up to {usdc(p.autoMax)} USDC, hard limit {usdc(p.hardMax)} USDC, budget {usdc(p.budget)} USDC, {p.payees.length} trusted merchants.
        </p>
      )}
      <form onSubmit={submit} className="rules">
        <label>Paid without asking me up to (USDC)
          <input value={form.autoMax} onChange={set('autoMax')} inputMode="decimal" data-testid="autoMax" />
          {errors.autoMax && <span className="err">{errors.autoMax}</span>}
        </label>
        <label>Hard limit, refused even if I confirm (USDC)
          <input value={form.hardMax} onChange={set('hardMax')} inputMode="decimal" data-testid="hardMax" />
          {errors.hardMax && <span className="err">{errors.hardMax}</span>}
        </label>
        <label>Total budget (USDC)
          <input value={form.budget} onChange={set('budget')} inputMode="decimal" data-testid="budget" />
          {errors.budget && <span className="err">{errors.budget}</span>}
        </label>
        <label>Maximum number of payments
          <input value={form.maxCount} onChange={set('maxCount')} inputMode="numeric" data-testid="maxCount" />
          {errors.maxCount && <span className="err">{errors.maxCount}</span>}
        </label>

        <h3>Trusted merchants ({form.payees.length}/8)</h3>
        {errors.payees && <p className="err">{errors.payees}</p>}
        {form.payees.map((m, i) => (
          <div className="payee" key={i}>
            <input value={m.label} onChange={(e) => setPayee(i, 'label', e.target.value)} placeholder="Name (16 bytes max)" aria-label={`Merchant ${i + 1} name`} />
            <input value={m.address} onChange={(e) => setPayee(i, 'address', e.target.value)} placeholder="0x…" className="mono" aria-label={`Merchant ${i + 1} address`} />
            <button type="button" className="ghost" onClick={() => setForm({ ...form, payees: form.payees.filter((_, j) => j !== i) })}>Remove</button>
            {(errors[`payees.${i}.label`] || errors[`payees.${i}.address`]) && (
              <span className="err">{errors[`payees.${i}.label`] ?? errors[`payees.${i}.address`]}</span>
            )}
          </div>
        ))}
        {form.payees.length < 8 && (
          <button type="button" className="ghost" onClick={() => setForm({ ...form, payees: [...form.payees, { label: '', address: '' }] })}>+ Add a merchant</button>
        )}
        <div><button className="primary" disabled={!bsa.signer || !!bsa.busy} data-testid="send-rules">Send to the Flex for approval</button></div>
      </form>
    </section>
  );
}
