import type { Bsa } from '../useBsa.js';

export function Session({ bsa }: { bsa: Bsa }) {
  const armed = bsa.bridgeStatus.session || !!bsa.device?.sessionArmed;
  return (
    <section className="card">
      <h2>Start the agent on the Flex</h2>
      <p>Only the Flex can start the agent: no website and no server can do it for you. It stays on until you turn it off on the Flex, or block the agent.</p>
      <ol className="steps-howto">
        <li>On the BSA Sentry home screen, tap the settings icon at the top right.</li>
        <li>Turn on <b>Agent session</b>.</li>
      </ol>
      {armed ? (
        <p className="ok" data-testid="session-on">Agent started.</p>
      ) : (
        <button className="primary" onClick={() => void bsa.refreshDevice()} data-testid="session-check">I started the agent</button>
      )}
    </section>
  );
}
