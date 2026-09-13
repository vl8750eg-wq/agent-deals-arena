import { describe, expect, it } from 'vitest';
import {
  ConductRules,
  NegotiationRoom,
  type OpponentConditions,
} from '../../src/domain/negotiation-room';

const buyerConditions: OpponentConditions = {
  text: 'I want to pay up to 130, ideally 100. I can collect the item this week.',
  desiredPrice: 100,
  walkAwayPrice: 130,
};

const sellerConditions: OpponentConditions = {
  text: 'I want 150, can go down to 120. The item is ready for pickup.',
  desiredPrice: 150,
  walkAwayPrice: 120,
};

describe('NegotiationRoom', () => {
  it('keeps negotiation locked until both opponents submit conditions', () => {
    const room = new NegotiationRoom();

    expect(room.status).toBe('WAITING_FOR_SUBMISSIONS');
    room.submitConditions('SIDE_A', buyerConditions);

    expect(room.status).toBe('WAITING_FOR_SUBMISSIONS');
    expect(room.canStartNegotiation()).toBe(false);

    room.submitConditions('SIDE_B', sellerConditions);

    expect(room.status).toBe('READY_TO_NEGOTIATE');
    expect(room.canStartNegotiation()).toBe(true);
  });

  it('exposes the same conduct rules to both agents', () => {
    const room = new NegotiationRoom();
    room.submitConditions('SIDE_A', buyerConditions);
    room.submitConditions('SIDE_B', sellerConditions);

    expect(room.getAgentContext('SIDE_A').conductRules).toEqual(ConductRules);
    expect(room.getAgentContext('SIDE_B').conductRules).toEqual(ConductRules);
  });

  it('accepts free-text-only conditions (numbers are optional)', () => {
    const room = new NegotiationRoom();
    expect(() => room.submitConditions('SIDE_A', { text: 'Куплю ноутбук, по цене договоримся' })).not.toThrow();
    expect(room.status).toBe('WAITING_FOR_SUBMISSIONS');
  });

  it('keeps each opponent conditions out of the other context', () => {    const room = new NegotiationRoom();
    room.submitConditions('SIDE_A', buyerConditions);
    room.submitConditions('SIDE_B', sellerConditions);

    expect(room.getAgentContext('SIDE_A').privateConditions).toEqual(buyerConditions);
    expect(room.getAgentContext('SIDE_A')).not.toHaveProperty('opponentConditions');
    expect(room.getAgentContext('SIDE_B').privateConditions).toEqual(sellerConditions);
    expect(room.getAgentContext('SIDE_B')).not.toHaveProperty('opponentConditions');
  });
});
