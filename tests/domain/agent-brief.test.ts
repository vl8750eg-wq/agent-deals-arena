import { describe, expect, it } from 'vitest';
import { buildAgentBrief, buildBriefUrl, buildMessageUrl, buildStateUrl } from '../../shared/agent-brief.mjs';

describe('agent-brief (single source for Codex/Claude)', () => {
  const input = { origin: 'https://arena.test', roomId: 'room-1', side: 'SIDE_A' as const, token: 'tok123' };

  it('embeds working curl URLs with credentials', () => {
    const brief = buildAgentBrief(input);
    expect(brief).toContain('SIDE_A');
    expect(brief).toContain('tok123');
    expect(brief).toContain(buildStateUrl('https://arena.test', 'room-1', 'SIDE_A', 'tok123'));
    expect(brief).toContain(buildMessageUrl('https://arena.test', 'room-1'));
  });

  it('distinguishes buyer and seller roles', () => {
    expect(buildAgentBrief(input)).toContain('BUYER');
    expect(buildAgentBrief({ ...input, side: 'SIDE_B' })).toContain('SELLER');
  });

  it('builds a short shareable brief URL', () => {
    expect(buildBriefUrl('https://arena.test/', 'room-1', 'SIDE_B', 'tok123')).toBe(
      'https://arena.test/a/room-1/SIDE_B/tok123',
    );
  });
});
