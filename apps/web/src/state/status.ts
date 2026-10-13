// The always-visible status bar: one line, the most fundamental problem first.
export type StatusInput = {
  socket: 'connecting' | 'open' | 'closed' | 'replaced';
  flex: 'connected' | 'locked' | 'app_closed' | 'disconnected';
  session: boolean;
  policyActive: boolean;
};

export function statusLine(s: StatusInput): { level: 'ok' | 'warn' | 'error'; text: string } {
  if (s.socket === 'replaced') return { level: 'error', text: 'BSA Sentry is open in another tab. Use that tab, or reload this one to use it here.' };
  if (s.socket !== 'open') return { level: 'error', text: 'Reconnecting to the BSA Sentry server…' };
  if (s.flex === 'disconnected') return { level: 'error', text: 'Plug in your Flex and connect it' };
  if (s.flex === 'locked') return { level: 'warn', text: 'Your Flex is locked: unlock it' };
  if (s.flex === 'app_closed') return { level: 'warn', text: 'Open the BSA Sentry app on your Flex' };
  if (!s.policyActive) return { level: 'warn', text: 'No rules on the Flex: set your rules' };
  if (!s.session) return { level: 'warn', text: 'Agent session off: turn it on in the app settings on your Flex' };
  return { level: 'ok', text: 'Agent on. Keep this tab open and the computer awake.' };
}
