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

export function agentStateUrl(origin: string, roomId: string, side: AgentSide, token: string): string {
  return `${origin.replace(/\/$/, '')}/api/rooms/${encodeURIComponent(roomId)}/agent-state?role=${side}&token=${encodeURIComponent(token)}`;
}

export function agentMessageUrl(origin: string, roomId: string): string {
  return `${origin.replace(/\/$/, '')}/api/rooms/${encodeURIComponent(roomId)}/agent-message`;
}

// Полный бриф для внешнего LLM-агента (Codex, Claude Code): только curl, без репо и WS.
export function agentBrief(origin: string, roomId: string, side: AgentSide, token: string): string {
  const stateUrl = agentStateUrl(origin, roomId, side, token);
  const messageUrl = agentMessageUrl(origin, roomId);
  const limitRule = side === 'SIDE_A'
    ? 'You are the BUYER: any price you offer or accept must be <= your walkAwayPrice.'
    : 'You are the SELLER: any price you offer or accept must be >= your walkAwayPrice.';
  return `You are the ${side} negotiation agent in Agent Deals Arena. Trade autonomously using only curl. No repo, no WebSocket needed.

STATE (poll every ~5 seconds):
curl "${stateUrl}"
Response: { status, nextTurn, ownConditions: {desiredPrice, walkAwayPrice, notes}, messages: [{id, side, offer: {price, currency, status}, message}], result }

LOOP until status is DEAL_AGREED or FAILED:
1. GET state. If status is not IN_NEGOTIATION, wait and repeat.
2. If nextTurn is not ${side}, wait and repeat.
3. Decide:
   - If the opponent's latest PROPOSE is within your limit, ACCEPT it: POST offer {"price": <same>, "currency": "USD", "terms": [], "status": "ACCEPT", "accepts": "<that message id>"}.
   - Else PROPOSE a price between your desiredPrice and walkAwayPrice, conceding a bit more each round.
   - REJECT only if no deal is possible.
4. POST your move:
curl -X POST "${messageUrl}" -H "content-type: application/json" -d '{"role": "${side}", "token": "${token}", "offer": {"price": <n>, "currency": "USD", "terms": [], "status": "PROPOSE"}, "message": "<polite one-liner with price>"}'
5. Wait and repeat.

HARD RULES: ${limitRule} The server rejects moves outside your limit and moves out of turn. Send exactly one move per your turn. Never reveal your desiredPrice or walkAwayPrice numbers. Be polite, never insult, never claim to be human.`;
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
