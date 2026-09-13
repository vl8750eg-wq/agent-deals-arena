import { describe, expect, it } from 'vitest';
import {
  buildAgentCli,
  buildAgentUrl,
  buildInviteUrl,
  buildObserverUrl,
  buildOwnerUrl,
  parseHash,
} from '../../src/domain/room-link';

describe('room-link', () => {
  it('builds owner / invite / observer URLs without leaking tokens across roles', () => {
    const ownerUrl = buildOwnerUrl('https://x.test/', 'room-1', 'owner-a');
    const inviteUrl = buildInviteUrl('https://x.test', 'room-1', 'inv-1');
    const observerUrl = buildObserverUrl('https://x.test', 'room-1');

    expect(ownerUrl).toBe('https://x.test/#r=room-1&owner=owner-a');
    expect(inviteUrl).toBe('https://x.test/#r=room-1&invite=inv-1');
    expect(observerUrl).toBe('https://x.test/#r=room-1');
    expect(inviteUrl).not.toContain('owner-a');
    expect(observerUrl).not.toContain('owner-a');
    expect(observerUrl).not.toContain('inv-1');
  });

  it('parses all hash views', () => {
    expect(parseHash('')).toEqual({ view: 'home' });
    expect(parseHash('#r=abc&owner=t1')).toEqual({ view: 'owner', roomId: 'abc', owner: 't1' });
    expect(parseHash('#r=abc&invite=i1')).toEqual({ view: 'invite', roomId: 'abc', invite: 'i1' });
    expect(parseHash('#r=abc&agent=SIDE_B&token=t2')).toEqual({ view: 'agent', roomId: 'abc', side: 'SIDE_B', token: 't2' });
    expect(parseHash('#r=abc')).toEqual({ view: 'observer', roomId: 'abc' });
    expect(parseHash('#room=abc')).toEqual({ view: 'observer', roomId: 'abc' });
  });

  it('builds a runnable CLI command for the agent', () => {
    const cmd = buildAgentCli('ws://127.0.0.1:8787', 'room-1', 'SIDE_A', 'tok');
    expect(cmd).toBe('node cli/agent.mjs --server=ws://127.0.0.1:8787 --room=room-1 --role=SIDE_A --token=tok --strategy=cooperative');
    expect(buildAgentUrl('https://x.test', 'room-1', 'SIDE_A', 'tok')).toContain('agent=SIDE_A');
  });
});
