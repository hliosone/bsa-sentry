// Serves the demo shops under the server's own public address (/shops/*), so a live demo needs
// a single tunnel. A plain passthrough: method, path, query, body and headers both ways, which
// is all x402 needs (PAYMENT-REQUIRED out, PAYMENT-SIGNATURE in, PAYMENT-RESPONSE out).
import express, { type RequestHandler } from 'express';

// Hop-by-hop headers, and the ones fetch recomputes itself.
const SKIP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding']);

export function shopsProxy(upstream: string): RequestHandler[] {
  const base = upstream.replace(/\/$/, '');
  return [
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && !SKIP.has(k)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
      try {
        const r = await fetch(`${base}${req.url}`, {
          method: req.method, headers, redirect: 'manual', ...(hasBody ? { body: req.body } : {}),
        });
        res.status(r.status);
        r.headers.forEach((v, k) => { if (!SKIP.has(k)) res.setHeader(k, v); });
        res.send(Buffer.from(await r.arrayBuffer()));
      } catch {
        res.status(502).json({ error: 'the demo shops are not reachable' });
      }
    },
  ];
}
