import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from '../../test/utils';
import { mockInvoke } from '../../test/setup';
import { FolderSync } from './FolderSync';

const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mockOpen }));
vi.mock('../../utils/tauriRuntime', () => ({ isTauriRuntime: () => true }));
vi.mock('../../contexts/PromptContext', () => ({ usePrompt: () => vi.fn() }));
vi.mock('../../contexts/VaultPasswordContext', () => ({
  useVaultPassword: () => ({
    getVaultPasswords: () => new Map(),
    setVaultPassword: vi.fn(),
    clearKey: vi.fn(),
  }),
}));

describe('FolderSync', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockOpen.mockReset();
    mockInvoke.mockImplementation((command) => {
      if (command === 'get_folder_sync_status') {
        return Promise.resolve({
          state: 'disabled',
          folder: null,
          device_name: 'Laptop',
          last_success_at: null,
          peers: [],
          message: null,
        });
      }
      if (command === 'inspect_folder_sync') {
        return Promise.resolve({
          state: 'empty',
          folder: 'C:\\Sync\\Brainbox Sync',
          devices: [],
          vault_count: 0,
          item_count: 0,
          needs_sync_passphrase: false,
          vaults_needing_password: [],
          message: null,
        });
      }
      return Promise.resolve(null);
    });
  });

  test('nudges toward Syncthing and opens new-folder setup', async () => {
    mockOpen.mockResolvedValue('C:\\Sync\\Brainbox Sync');
    render(<FolderSync />);

    expect(await screen.findByText('Want a free, private option?')).toBeVisible();
    expect(screen.getByRole('link', { name: /Get Syncthing/ })).toHaveAttribute(
      'href',
      'https://syncthing.net/downloads/',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Choose sync folder' }));
    expect(await screen.findByLabelText('Device name')).toHaveValue('Laptop');
    expect(screen.getByText('New Brainbox sync')).toBeVisible();
  });
});
