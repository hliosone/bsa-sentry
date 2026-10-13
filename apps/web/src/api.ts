// The server's HTTP API, same origin (Vite proxies in dev; the server serves the site in prod).
export type Config = {
  chainId: number;
  chainName: string;
  usdc: `0x${string}`;
  explorer: string;
  mcpUrl: string;
  merchantUrl: string | null;
  defaultPayees: { label: string; address: string }[];
  /** Every demo merchant, with its spending category. */
  merchants?: { label: string; address: string; category: string }[];
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${path} -> HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

export const api = {
  config: () => call<Config>('/api/config'),
  me: () => call<{ account: string }>('/auth/me').catch(() => null),
  challenge: () => post<{ nonce: `0x${string}`; origin: string; issuedAt: number; expiresAt: number; chainId: number }>('/auth/challenge'),
  login: (address: string, nonce: string, signature: string) => post<{ account: string }>('/auth/login', { address, nonce, signature }),
  logout: () => post<{ ok: true }>('/auth/logout'),
  grants: () => call<{ grants: { id: string; client_name: string; scope: string; created_at: number; expires_at: number }[] }>('/oauth/grants'),
  revokeGrant: (id: string) => post<{ ok: true }>(`/oauth/grants/${encodeURIComponent(id)}/revoke`),
};

/** The relay socket, on the same origin so the session cookie goes with it. */
export const relayUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;
