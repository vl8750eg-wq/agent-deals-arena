// Types for shared/agent-brief.mjs (single source of the LLM-agent brief).
export type AgentSide = 'SIDE_A' | 'SIDE_B';

export function buildStateUrl(origin: string, roomId: string, side: AgentSide, token: string): string;
export function buildMessageUrl(origin: string, roomId: string): string;
export function buildBriefUrl(origin: string, roomId: string, side: AgentSide, token: string): string;

export interface AgentBriefInput {
  origin: string;
  roomId: string;
  side: AgentSide;
  token: string;
}

export function buildAgentBrief(input: AgentBriefInput): string;
