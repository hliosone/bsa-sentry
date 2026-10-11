// The always-visible status bar: one line, the most fundamental problem first.
export type StatusInput = {
  socket: 'connecting' | 'open' | 'closed';
  flex: 'connected' | 'locked' | 'app_closed' | 'disconnected';
  session: boolean;
  policyActive: boolean;
};

export function statusLine(s: StatusInput): { level: 'ok' | 'warn' | 'error'; text: string } {
  if (s.socket !== 'open') return { level: 'error', text: 'Pas de connexion au serveur BSA Sentry — reconnexion…' };
  if (s.flex === 'disconnected') return { level: 'error', text: 'Branche ton Flex et clique « Connecter le Flex »' };
  if (s.flex === 'locked') return { level: 'warn', text: 'Ton Flex est verrouillé : déverrouille-le' };
  if (s.flex === 'app_closed') return { level: 'warn', text: "Ouvre l'app BSA Sentry sur ton Flex" };
  if (!s.policyActive) return { level: 'warn', text: "Aucune règle sur le Flex : définis tes règles" };
  if (!s.session) return { level: 'warn', text: "Session agent arrêtée : démarre-la dans les réglages de l'app sur le Flex" };
  return { level: 'ok', text: "Flex connecté · agent actif · garde cet onglet ouvert et l'ordinateur hors veille" };
}
