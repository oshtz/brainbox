import { describe, expect, it } from 'vitest';
import { splitSourcedNote } from './urlPreview';

describe('splitSourcedNote', () => {
  it('extracts only a valid final HTTP source line', () => {
    expect(splitSourcedNote('Chosen words\n\nSource: https://example.com/article')).toEqual({
      body: 'Chosen words',
      sourceUrl: 'https://example.com/article',
    });
    expect(splitSourcedNote('Source: https://example.com\n\nMore notes')).toEqual({
      body: 'Source: https://example.com\n\nMore notes',
      sourceUrl: null,
    });
    expect(splitSourcedNote('Chosen words\n\nSource: file:///tmp/note')).toEqual({
      body: 'Chosen words\n\nSource: file:///tmp/note',
      sourceUrl: null,
    });
  });
});
