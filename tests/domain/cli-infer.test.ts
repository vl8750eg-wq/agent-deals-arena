import { describe, expect, it } from 'vitest';
import { inferLimits } from '../../cli/strategy.mjs';

describe('inferLimits (числа из текста условий)', () => {
  it('buyer: одно число — desired и walkaway равны ему', () => {
    expect(inferLimits('Куплю ноутбук до 30000', 'SIDE_A')).toMatchObject({
      desiredPrice: 30000,
      walkAwayPrice: 30000,
    });
  });

  it('buyer: два числа — desired=min, walkAway=max', () => {
    expect(inferLimits('Хочу за 100, предел 130', 'SIDE_A')).toMatchObject({
      desiredPrice: 100,
      walkAwayPrice: 130,
    });
  });

  it('seller: два числа — desired=max, walkAway=min', () => {
    expect(inferLimits('Хочу 150, минимум 120', 'SIDE_B')).toMatchObject({
      desiredPrice: 150,
      walkAwayPrice: 120,
    });
  });

  it('понимает пробелы в тысячах', () => {
    expect(inferLimits('Продам за 30 000 рублей', 'SIDE_B')).toMatchObject({
      desiredPrice: 30000,
      walkAwayPrice: 30000,
    });
  });

  it('без чисел — null', () => {
    expect(inferLimits('Договоримся по ходу', 'SIDE_A')).toBeNull();
  });
});
