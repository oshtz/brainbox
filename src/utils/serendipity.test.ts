import { expect, it } from 'vitest';
import { rediscoverItems, relatedItems } from './serendipity';

const item = (id: string, text: string, day: number) => ({ id, title: text, content: text, updatedAt: new Date(2026, 0, day) });

it('rotates older saves and ranks related items by shared terms', () => {
  const items = [item('1', 'shader design', 1), item('2', 'shader animation', 2), item('3', 'private notes', 3), item('4', 'capture links', 4)];
  expect(rediscoverItems(items, 0).map(({ id }) => id)).toEqual(['1', '2', '3']);
  expect(rediscoverItems(items, 1).map(({ id }) => id)).toEqual(['2', '3', '4']);
  expect(relatedItems(items, items[0]).map(({ id }) => id)).toEqual(['2']);
});
