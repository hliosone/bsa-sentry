// The always-visible status bar: one line, the most fundamental problem first.
export type StatusInput = {
  socket: 'connecting' | 'open' | 'closed';
  flex: 'connected' | 'locked' | 'app_closed' | 'disconnected';
  session: boolean;
  policyActive: boolean;
};

export function statusLine(s: StatusInput): { level: 'ok' | 'warn' | 'error'; text: string } {
  if (s.socket !== 'open') return { level: 'error', text: 'No connection to the BSA Sentry server — reconnecting…' };
  if (s.flex === 'disconnected') return { level: 'error', text: 'Plug in your Flex and click "Connect the Flex"' };
  if (s.flex === 'locked') return { level: 'warn', text: 'Your Flex is locked: unlock it' };
  if (s.flex === 'app_closed') return { level: 'warn', text: 'Open the BSA Sentry app on your Flex' };
  if (!s.policyActive) return { level: 'warn', text: 'No rules on the Flex: set your rules' };
  if (!s.session) return { level: 'warn', text: 'Agent session stopped: start it in the app settings on the Flex' };
  return { level: 'ok', text: 'Flex connected · agent active · keep this tab open and the computer awake' };
}
