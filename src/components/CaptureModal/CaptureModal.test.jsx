import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CaptureModal from './CaptureModal';

describe('CaptureModal', () => {
  it('keeps Enter as a newline and saves the expected payload with Ctrl/Cmd+Enter', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    const runShortcut = async (shortcut) => {
      const user = userEvent.setup();
      const view = render(
        <CaptureModal
          isOpen
          onClose={onClose}
          onSave={onSave}
          vaults={[{ id: '1', title: 'Inbox' }]}
          initialVaultId="1"
        />
      );
      const content = screen.getByTestId('capture-content-input');
      await waitFor(() => expect(screen.getByTestId('capture-vault-select')).toHaveValue('1'));
      await user.type(content, 'First line title{Enter}More detail');

      expect(content).toHaveValue('First line title\nMore detail');
      expect(onSave).not.toHaveBeenCalled();

      await user.keyboard(shortcut);
      expect(onSave).toHaveBeenLastCalledWith({
        title: 'First line title',
        content: 'First line title\nMore detail',
        vaultId: '1',
      });
      view.unmount();
    };

    await runShortcut('{Control>}{Enter}{/Control}');
    onSave.mockClear();
    await runShortcut('{Meta>}{Enter}{/Meta}');
  });
});
