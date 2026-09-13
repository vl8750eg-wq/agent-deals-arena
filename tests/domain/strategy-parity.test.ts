import { describe, expect, it } from 'vitest';
import { nextOffer as tsOffer, type StrategyInput } from '../../src/domain/agent-strategy';
import { nextOffer as jsOffer } from '../../cli/strategy.mjs';

const fixtures: StrategyInput[] = [
  { role: 'SIDE_A', desiredPrice: 100, walkAwayPrice: 130, strategy: 'cooperative', messages: [], myTurnsTaken: 0 },
  { role: 'SIDE_A', desiredPrice: 100, walkAwayPrice: 130, strategy: 'cooperative', messages: [], myTurnsTaken: 2 },
  { role: 'SIDE_B', desiredPrice: 150, walkAwayPrice: 120, strategy: 'firm', messages: [], myTurnsTaken: 1 },
  {
    role: 'SIDE_A', desiredPrice: 100, walkAwayPrice: 130, strategy: 'cooperative', myTurnsTaken: 1,
    messages: [{ id: 'm1', side: 'SIDE_B', offer: { price: 140, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'hi' }],
  },
  {
    role: 'SIDE_B', desiredPrice: 150, walkAwayPrice: 120, strategy: 'mirror', myTurnsTaken: 1,
    messages: [
      { id: 'm1', side: 'SIDE_B', offer: { price: 140, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'a' },
      { id: 'm2', side: 'SIDE_A', offer: { price: 120, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'b' },
    ],
  },
  {
    role: 'SIDE_A', desiredPrice: 100, walkAwayPrice: 130, strategy: 'cooperative', myTurnsTaken: 2,
    messages: [{ id: 'm9', side: 'SIDE_B', offer: { price: 95, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'deal?' }],
  },
  {
    role: 'SIDE_B', desiredPrice: 30000, walkAwayPrice: 30000, strategy: 'cooperative', myTurnsTaken: 3,
    messages: [
      { id: 'm1', side: 'SIDE_A', offer: { price: 20000, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'a' },
      { id: 'm2', side: 'SIDE_B', offer: { price: 30000, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'b' },
      { id: 'm3', side: 'SIDE_A', offer: { price: 20000, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'a' },
      { id: 'm4', side: 'SIDE_B', offer: { price: 30000, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'b' },
      { id: 'm5', side: 'SIDE_A', offer: { price: 20000, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'a' },
    ],
  },
  {
    role: 'SIDE_A', desiredPrice: 100, walkAwayPrice: 130, strategy: 'cooperative', messages: [], myTurnsTaken: 0,
    lotTitle: 'Ноутбук',
  },
  {
    role: 'SIDE_B', desiredPrice: 30000, walkAwayPrice: 30000, strategy: 'cooperative', myTurnsTaken: 2,
    lotTitle: 'Ноутбук',
    conditionsText: 'Продаю ноутбук, минимум 30000',
    messages: [
      { id: 'm1', side: 'SIDE_A', offer: { price: 20000, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'a' },
      { id: 'm2', side: 'SIDE_B', offer: { price: 30000, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'b' },
      { id: 'm3', side: 'SIDE_A', offer: { price: 20000, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'a' },
    ],
  },
];

describe('strategy parity (TS domain <-> CLI runtime)', () => {
  for (const [index, fixture] of fixtures.entries()) {
    it(`fixture ${index} matches`, () => {
      expect(jsOffer(fixture)).toEqual(tsOffer(fixture));
    });
  }
});
