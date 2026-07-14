import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ItemPanel from './ItemPanel';

const ai = vi.hoisted(() => ({
  generate: vi.fn(),
  isConfigured: vi.fn(),
}));

vi.mock('../../utils/ai', () => ({
  aiService: {
    generate: ai.generate,
    isConfigured: ai.isConfigured,
    getActiveProviderType: () => 'openai',
    getProviderConfig: () => ({ name: 'OpenAI' }),
  },
}));

vi.mock('../../contexts/VaultPasswordContext', () => ({
  useVaultPassword: () => ({ getVaultKey: vi.fn().mockResolvedValue([]) }),
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn() }),
}));

vi.mock('../../contexts/PromptContext', () => ({
  usePrompt: () => vi.fn(),
}));

describe('ItemPanel', () => {
  beforeEach(() => {
    ai.isConfigured.mockReturnValue(true);
    ai.generate.mockResolvedValue('Generated through the selected provider.');
  });

  it('routes summary generation through the active AI provider', async () => {
    const onUpdateSummary = vi.fn();

    render(
      <ItemPanel
        item={{ id: '7', title: 'Provider parity', content: 'Use the selected provider.', metadata: { item_type: 'note' } }}
        vaults={[{ id: '1', title: 'Inbox' }]}
        currentVaultId="1"
        onClose={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
        onUpdateImage={vi.fn()}
        onDelete={vi.fn()}
        onUpdateSummary={onUpdateSummary}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(ai.generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('Provider parity'),
    })));
    await waitFor(() => expect(onUpdateSummary).toHaveBeenCalledWith('7', 'Generated through the selected provider.'));
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Generated through the selected provider.')).toBeInTheDocument();
  });

  it('keeps a background summary tied to the item that requested it', async () => {
    let finish!: (summary: string) => void;
    ai.generate.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onUpdateSummary = vi.fn();
    const onSummarizingChange = vi.fn();
    const props = {
      vaults: [{ id: '1', title: 'Inbox' }],
      currentVaultId: '1',
      onClose: vi.fn(),
      onRename: vi.fn(),
      onMove: vi.fn(),
      onUpdateImage: vi.fn(),
      onDelete: vi.fn(),
      onUpdateSummary,
      onSummarizingChange,
    };
    const { rerender } = render(
      <ItemPanel item={{ id: '7', title: 'First item', content: 'First content', metadata: { item_type: 'note' } }} {...props} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(onSummarizingChange).toHaveBeenCalledWith('7', true));
    rerender(<ItemPanel item={{ id: '8', title: 'Second item', content: 'Second content', metadata: { item_type: 'note' } }} {...props} />);
    finish('Summary for the first item.');

    await waitFor(() => expect(onUpdateSummary).toHaveBeenCalledWith('7', 'Summary for the first item.'));
    expect(onSummarizingChange).toHaveBeenLastCalledWith('7', false);
    expect(screen.getByText('Second item')).toBeInTheDocument();
    expect(screen.queryByText('Summary for the first item.')).not.toBeInTheDocument();
  });
});
