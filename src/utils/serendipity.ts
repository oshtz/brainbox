export type DiscoverableItem = {
  id: string;
  title: string;
  content: string;
  summary?: string;
  updatedAt: Date;
};

const terms = (item: DiscoverableItem) => new Set(
  `${item.title} ${item.content} ${item.summary || ''}`
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((term) => !['and', 'the', 'for', 'with', 'this', 'that', 'from', 'https', 'www'].includes(term)) || []
);

export function rediscoverItems<T extends DiscoverableItem>(items: T[], day: number, offset = 0): T[] {
  if (items.length < 4) return [];
  const oldestFirst = [...items].sort((a, b) => +a.updatedAt - +b.updatedAt);
  const start = (day + offset) % oldestFirst.length;
  return Array.from({ length: Math.min(3, oldestFirst.length) }, (_, index) => oldestFirst[(start + index) % oldestFirst.length]);
}

export function relatedItems<T extends DiscoverableItem>(items: T[], selected: T): T[] {
  const selectedTerms = terms(selected);
  return items
    .filter((item) => item.id !== selected.id)
    .map((item) => ({ item, score: [...terms(item)].filter((term) => selectedTerms.has(term)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || +b.item.updatedAt - +a.item.updatedAt)
    .slice(0, 3)
    .map(({ item }) => item);
}
