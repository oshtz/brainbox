import { afterEach, expect, it, vi } from 'vitest';
import { LMStudioProvider } from './openai-compatible';

afterEach(() => vi.unstubAllGlobals());

it('budgets for local reasoning and reports a truncated answer', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '', reasoning_content: 'thinking' }, finish_reason: 'length' }] }),
  });
  vi.stubGlobal('fetch', fetchMock);

  const provider = new LMStudioProvider({ enabled: true, baseUrl: 'http://localhost/v1', model: 'local-model' });
  await expect(provider.generate({ prompt: 'Summarize this.' })).rejects.toThrow('output budget');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(4096);
});
