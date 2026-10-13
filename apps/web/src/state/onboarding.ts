// The onboarding steps, derived from facts rather than clicks: if the Flex is unplugged,
// "connect" is current again, whatever the user did on a previous visit.
export type Facts = {
  deviceConnected: boolean;
  loggedIn: boolean;
  policyActive: boolean;
  sessionArmed: boolean;
  hasCredentials: boolean;
  hasBackup: boolean;
  claudeConnected: boolean;
};

export type StepId = 'connect' | 'login' | 'rules' | 'session' | 'badge' | 'backup' | 'claude' | 'done';

export type Step = { id: StepId; label: string; done: boolean; current: boolean; optional: boolean };

const REQUIRED: { id: StepId; label: string; fact: keyof Facts }[] = [
  { id: 'connect', label: 'Plug in the Flex', fact: 'deviceConnected' },
  { id: 'login', label: 'Log in with Ledger', fact: 'loggedIn' },
  { id: 'rules', label: 'Set your rules', fact: 'policyActive' },
  { id: 'session', label: 'Start the agent on the Flex', fact: 'sessionArmed' },
  { id: 'claude', label: 'Connect your agent', fact: 'claudeConnected' },
];

const OPTIONAL: { id: StepId; label: string; fact: keyof Facts }[] = [
  { id: 'badge', label: 'Agent identity (optional)', fact: 'hasCredentials' },
  { id: 'backup', label: 'Key Ring backup (optional)', fact: 'hasBackup' },
];

export function onboarding(f: Facts): { current: StepId; steps: Step[] } {
  const firstMissing = REQUIRED.find((s) => !f[s.fact]);
  const current: StepId = firstMissing?.id ?? 'done';
  const steps: Step[] = [
    ...REQUIRED.map((s) => ({ id: s.id, label: s.label, done: f[s.fact], current: s.id === current, optional: false })),
    ...OPTIONAL.map((s) => ({ id: s.id, label: s.label, done: f[s.fact], current: false, optional: true })),
  ];
  return { current, steps };
}
