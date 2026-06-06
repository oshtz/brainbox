import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PromptProvider } from './PromptContext';
import { VaultPasswordProvider, useVaultPassword } from './VaultPasswordContext';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

type TauriTestWindow = Window & {
  __TAURI__?: unknown;
};

const TestConsumer = () => {
  const { getVaultKey, hasKey } = useVaultPassword();
  const [status, setStatus] = useState('idle');

  const unlock = async () => {
    try {
      await getVaultKey('1', 'Protected vault', true);
      setStatus('unlocked');
    } catch (error) {
      setStatus(`error:${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div>
      <button onClick={unlock}>Unlock protected vault</button>
      <button onClick={() => setStatus(hasKey('1') ? 'cached' : 'not cached')}>Check cache</button>
      <div role="status">{status}</div>
    </div>
  );
};

const renderProvider = () => {
  render(
    <PromptProvider>
      <VaultPasswordProvider>
        <TestConsumer />
      </VaultPasswordProvider>
    </PromptProvider>
  );
};

const submitPassword = async (password: string) => {
  const dialog = await screen.findByRole('dialog', { name: /unlock vault/i });
  const input = await screen.findByLabelText(/vault password/i);
  fireEvent.change(input, { target: { value: password } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^unlock$/i }));
};

describe('VaultPasswordContext', () => {
  beforeEach(() => {
    (window as TauriTestWindow).__TAURI__ = {};
    mocks.invoke.mockReset();
  });

  afterEach(() => {
    delete (window as TauriTestWindow).__TAURI__;
  });

  it('does not cache a protected vault key when password verification fails', async () => {
    mocks.invoke.mockRejectedValueOnce('Invalid password');
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: /unlock protected vault/i }));
    await submitPassword('wrong-password');

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/error:invalid password/i);
    });

    fireEvent.click(screen.getByRole('button', { name: /check cache/i }));
    expect(screen.getByRole('status')).toHaveTextContent('not cached');

    fireEvent.click(screen.getByRole('button', { name: /unlock protected vault/i }));
    expect(await screen.findByRole('dialog', { name: /unlock vault/i })).toBeInTheDocument();
  });

  it('caches a protected vault key only after password verification succeeds', async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: /unlock protected vault/i }));
    await submitPassword('correct-password');

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('unlocked');
    });

    expect(mocks.invoke).toHaveBeenCalledWith(
      'verify_vault_password',
      expect.objectContaining({ vaultId: 1 })
    );

    fireEvent.click(screen.getByRole('button', { name: /check cache/i }));
    expect(screen.getByRole('status')).toHaveTextContent('cached');
  });
});
