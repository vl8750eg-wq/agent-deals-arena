import { describe, expect, it } from 'vitest';
import { nextOffer, type StrategyMessage } from '../../src/domain/agent-strategy';

const msg = (id: string, side: 'SIDE_A' | 'SIDE_B', price: number): StrategyMessage => ({
  id,
  side,
  offer: { price, currency: 'USD', terms: [], status: 'PROPOSE' },
  message: `Offer ${price}`,
});

describe('agent-strategy (CLI brains)', () => {
  it('buyer accepts a seller offer inside walk-away bound and references it', () => {
    const turn = nextOffer({
      role: 'SIDE_A',
      desiredPrice: 100,
      walkAwayPrice: 130,
      strategy: 'cooperative',
      myTurnsTaken: 0,
      messages: [msg('m1', 'SIDE_B', 125)],
    });

    expect(turn.offer.status).toBe('ACCEPT');
    expect(turn.offer.price).toBe(125);
    expect(turn.offer.accepts).toBe('m1');
  });

  it('seller accepts a buyer offer inside walk-away bound', () => {
    const turn = nextOffer({
      role: 'SIDE_B',
      desiredPrice: 150,
      walkAwayPrice: 120,
      strategy: 'cooperative',
      myTurnsTaken: 0,
      messages: [msg('m1', 'SIDE_A', 125)],
    });

    expect(turn.offer.status).toBe('ACCEPT');
    expect(turn.offer.accepts).toBe('m1');
  });

  it('concedes from desired toward walk-away without crossing it', () => {
    const base = {
      role: 'SIDE_A' as const,
      desiredPrice: 100,
      walkAwayPrice: 130,
      strategy: 'cooperative' as const,
      messages: [],
    };
    const first = nextOffer({ ...base, myTurnsTaken: 0 });
    const second = nextOffer({ ...base, myTurnsTaken: 1 });

    expect(first.offer.status).toBe('PROPOSE');
    expect(first.offer.price).toBeGreaterThan(100);
    expect(first.offer.price).toBeLessThanOrEqual(130);
    expect(second.offer.price).toBeGreaterThan(first.offer.price);
    expect(second.offer.price).toBeLessThanOrEqual(130);
  });
  it('keeps proposing (never accepts) when opponent price is unacceptable', () => {
    const turn = nextOffer({
      role: 'SIDE_A',
      desiredPrice: 100,
      walkAwayPrice: 130,
      strategy: 'firm',
      myTurnsTaken: 0,
      messages: [msg('m1', 'SIDE_B', 200)],
    });

    expect(turn.offer.status).toBe('PROPOSE');
    expect(turn.offer.price).toBeLessThanOrEqual(130);
  });

  it('rejects early when the opponent repeats an unacceptable price three times', () => {
    const turn = nextOffer({
      role: 'SIDE_B',
      desiredPrice: 30000,
      walkAwayPrice: 30000,
      strategy: 'cooperative',
      myTurnsTaken: 3,
      messages: [msg('m1', 'SIDE_A', 20000), msg('m2', 'SIDE_B', 30000), msg('m3', 'SIDE_A', 20000), msg('m4', 'SIDE_B', 30000), msg('m5', 'SIDE_A', 20000)],
    });

    expect(turn.offer.status).toBe('REJECT');
    expect(turn.offer.price).toBe(20000);
  });
});
