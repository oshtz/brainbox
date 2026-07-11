import { describe, expect, it } from 'vitest';
import { getDefaultSettings } from './types';
import { settingsForStorage } from './service';

describe('AI settings persistence', () => {
  it('never serializes cloud API keys into browser storage', () => {
    const settings = getDefaultSettings();
    settings.providers.openai.apiKey = 'sk-sensitive';
    settings.providers.anthropic.apiKey = 'also-sensitive';

    const serialized = JSON.stringify(settingsForStorage(settings));

    expect(serialized).not.toContain('sk-sensitive');
    expect(serialized).not.toContain('also-sensitive');
    expect(settingsForStorage(settings).providers.openai.apiKey).toBeUndefined();
  });
});
