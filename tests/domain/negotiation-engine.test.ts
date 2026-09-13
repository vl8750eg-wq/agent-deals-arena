import { describe, expect, it } from 'vitest';
import {
  NegotiationEngine,
  type AgentTurn,
} from '../../src/domain/negotiation-engine';
import {
  NegotiationRoom,
  type OpponentConditions,
} from '../../src/domain/negotiation-room';

const sideAConditions: OpponentConditions = {
  text: 'Buyer: want 100, limit 130.',
  desiredPrice: 100,
  walkAwayPrice: 130,
};

const sideBConditions: OpponentConditions = {
  text: 'Seller: want 150, limit 120.',
  desiredPrice: 150,
  walkAwayPrice: 120,
};

const offer = (price: number, status: AgentTurn['offer']['status']): AgentTurn => ({
  offer: { price, currency: 'USD', terms: [], status },
  message: `Offer ${price}`,
});

describe('NegotiationEngine', () => {
  it('does not start until both opponents submit conditions', () => {
    const room = new NegotiationRoom();
    const engine = new NegotiationEngine(room, {
      SIDE_A: () => offer(100, 'PROPOSE'),
      SIDE_B: () => offer(120, 'ACCEPT'),
    });

    expect(() => engine.run()).toThrow('Both opponents must submit conditions');
  });

  it('alternates mock agents until an agent accepts an offer', () => {
    const room = new NegotiationRoom();
    room.submitConditions('SIDE_A', sideAConditions);
    room.submitConditions('SIDE_B', sideBConditions);
    const turns: string[] = [];
    const engine = new NegotiationEngine(room, {
      SIDE_A: () => {
        turns.push('SIDE_A');
        return offer(130, 'PROPOSE');
      },
      SIDE_B: () => {
        turns.push('SIDE_B');
        return offer(130, 'ACCEPT');
      },
    });

    const result = engine.run();

    expect(result.status).toBe('DEAL_AGREED');
    expect(result.rounds).toBe(2);
    expect(turns).toEqual(['SIDE_A', 'SIDE_B']);
  });

  it('stops when the round limit is reached', () => {
    const room = new NegotiationRoom();
    room.submitConditions('SIDE_A', sideAConditions);
    room.submitConditions('SIDE_B', sideBConditions);
    const engine = new NegotiationEngine(room, {
      SIDE_A: () => offer(100, 'PROPOSE'),
      SIDE_B: () => offer(150, 'PROPOSE'),
    }, 3);

    expect(engine.run()).toMatchObject({
      status: 'MAX_ROUNDS_REACHED',
      rounds: 3,
    });
  });
});
