// A cloudflared quick tunnel to a local port, returning its public https URL.
//
// Always http2 + IPv4: on this network QUIC and IPv6 tunnels dropped after ~60 s in the
// feasibility tests, which is shorter than a payment that waits on the confirmation screen.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';

export async function startTunnel(port: number, logFile = '.run/tunnel.log'): Promise<{ url: string; stop: () => void; proc: ChildProcess }> {
  mkdirSync('.run', { recursive: true });
  const log = createWriteStream(logFile, { flags: 'a' });
  const proc = spawn('cloudflared', [
    'tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4', '--url', `http://localhost:${port}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cloudflared did not print a URL within 45 s; see .run/tunnel.log')), 45_000);
    const scan = (chunk: Buffer) => {
      log.write(chunk);
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    proc.stdout!.on('data', scan);
    proc.stderr!.on('data', scan);
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`cloudflared exited (${code})`)); });
  });
  // The URL is printed before the edge is ready to route; wait until it actually answers.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) break;
    } catch { /* not routable yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { url, proc, stop: () => proc.kill('SIGTERM') };
}

// CLI: pnpm tunnel [port]  — prints the public URL to put in PUBLIC_API_URL and claude.ai.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
  const t = await startTunnel(port);
  console.log(`\n  public URL : ${t.url}\n  MCP URL    : ${t.url}/mcp   (claude.ai > Settings > Connectors > Add custom connector)\n`);
  console.log('  Restart the server with PUBLIC_API_URL set to the public URL so OAuth metadata matches. Ctrl-C to stop.');
  process.on('SIGINT', () => { t.stop(); process.exit(0); });
}
