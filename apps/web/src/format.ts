export const usdc = (units: bigint) => {
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${units / 1_000_000n}.${frac}` : `${units / 1_000_000n}`;
};
export const shortAddr = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
export const time = (ms: number) => new Date(ms).toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
