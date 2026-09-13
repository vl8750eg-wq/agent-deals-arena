export type AgentSide = 'SIDE_A' | 'SIDE_B';

export type ParsedHash =
  | { view: 'home' }
  | { view: 'owner'; roomId: string; owner: string }
  | { view: 'invite'; roomId: string; invite: string }
  | { view: 'agent'; roomId: string; side: AgentSide; token: string }
  | { view: 'observer'; roomId: string };

export function buildOwnerUrl(origin: string, roomId: string, owner: string): string {
  return `${origin.replace(/\/$/, '')}/#r=${encodeURIComponent(roomId)}&owner=${encodeURIComponent(owner)}`;
}

export function buildInviteUrl(origin: string, roomId: string, invite: string): string {
  return `${origin.replace(/\/$/, '')}/#r=${encodeURIComponent(roomId)}&invite=${encodeURIComponent(invite)}`;
}

export function buildObserverUrl(origin: string, roomId: string): string {
  return `${origin.replace(/\/$/, '')}/#r=${encodeURIComponent(roomId)}`;
}

export function buildAgentUrl(origin: string, roomId: string, side: AgentSide, token: string): string {
  return `${origin.replace(/\/$/, '')}/#r=${encodeURIComponent(roomId)}&agent=${side}&token=${encodeURIComponent(token)}`;
}

export function buildAgentCli(serverWsOrigin: string, roomId: string, side: AgentSide, token: string, strategy = 'cooperative'): string {
  return `node cli/agent.mjs --server=${serverWsOrigin} --room=${roomId} --role=${side} --token=${token} --strategy=${strategy}`;
}

export function parseHash(hash: string): ParsedHash {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  // legacy: #room=<id>
  const roomId = params.get('r') ?? params.get('room');
  if (!roomId) return { view: 'home' };

  const owner = params.get('owner');
  if (owner) return { view: 'owner', roomId, owner };

  const invite = params.get('invite');
  if (invite) return { view: 'invite', roomId, invite };

  const agent = params.get('agent');
  const token = params.get('token');
  if ((agent === 'SIDE_A' || agent === 'SIDE_B') && token) {
    return { view: 'agent', roomId, side: agent, token };
  }

  return { view: 'observer', roomId };
}
