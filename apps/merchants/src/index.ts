// Starts the demo merchants. The facilitator (our server) must already be up: the x402
// middleware asks it `/supported` once, at startup.
import 'dotenv/config';
import { createMerchantsApp } from './app.js';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const port = Number(process.env.MERCHANTS_PORT ?? 4021);
const app = await createMerchantsApp({
  facilitatorUrl: process.env.FACILITATOR_URL ?? 'http://localhost:8787/x402',
  network: `eip155:${process.env.CHAIN_ID ?? 5042002}` as `${string}:${string}`,
  payTo: {
    cafe: need('MERCHANT_CAFE_ADDRESS'),
    cave: need('MERCHANT_CAVE_ADDRESS'),
    resto: need('MERCHANT_RESTO_ADDRESS'),
    evil: need('MERCHANT_EVIL_ADDRESS'),
  },
  publicUrl: process.env.MERCHANT_URL ?? `http://localhost:${port}`,
});
app.listen(port, () => console.log(`[merchants] listening on :${port}`));
