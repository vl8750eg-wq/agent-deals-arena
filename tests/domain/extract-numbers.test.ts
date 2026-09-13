import { describe, expect, it } from 'vitest';
import { extractNumbers } from '../../shared/extract-numbers.mjs';

describe('extractNumbers', () => {
  it('находит числа с пробелами тысяч', () => {
    expect(extractNumbers('поднимись до 30 000')).toEqual([30000]);
  });

  it('находит несколько чисел', () => {
    expect(extractNumbers('хочу 100, предел 130')).toEqual([100, 130]);
  });

  it('пусто без чисел', () => {
    expect(extractNumbers('держись, всё получится')).toEqual([]);
  });
});
