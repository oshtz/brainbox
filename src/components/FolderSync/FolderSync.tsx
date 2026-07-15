import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useConfirm } from '../../contexts/ConfirmContext';
import { usePrompt } from '../../contexts/PromptContext';
import { useToast } from '../../contexts/ToastContext';
import { useVaultPassword } from '../../contexts/VaultPasswordContext';
import type { BackendVault } from '../../types';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import styles from './FolderSync.module.css';

type Peer = {
  device_id: string;
  device_name: string;
  exported_at: string;
  last_imported_at?: string | null;
};

type VaultPasswordInfo = { uuid: string; name: string };

type FolderSyncStatus = {
  state: 'disabled' | 'up_to_date' | 'changes_waiting' | 'passphrase_required' | 'folder_unavailable' | 'error';
  folder?: string | null;
  device_name: string;
  last_success_at?: string | null;
  peers: Peer[];
  message?: string | null;
};

type FolderInspection = {
  state: 'empty' | 'existing' | 'invalid';
  folder: string;
  devices: Peer[];
  vault_count: number;
  item_count: number;
  needs_sync_passphrase: boolean;
  vaults_needing_password: VaultPasswordInfo[];
  message?: string | null;
};

export type FolderSyncResult = {
  state: 'up_to_date' | 'unlock_required';
  imported_vaults: number;
  imported_items: number;
  exported_vaults: number;
  exported_items: number;
  conflicts: string[];
  data_changed: boolean;
  skipped_peers: string[];
  warnings: string[];
  vaults_needing_password: VaultPasswordInfo[];
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function FolderSync({ onDataChange }: { onDataChange?: () => void }) {
  const { getVaultPasswords, setVaultPassword, clearKey } = useVaultPassword();
  const { showError, showSuccess, showWarning } = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [status, setStatus] = useState<FolderSyncStatus | null>(null);
  const [inspection, setInspection] = useState<FolderInspection | null>(null);
  const [verifiedInspection, setVerifiedInspection] = useState<FolderInspection | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [requiredVaults, setRequiredVaults] = useState<VaultPasswordInfo[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const next = await invoke<FolderSyncStatus>('get_folder_sync_status');
      setStatus(next);
      setDeviceName((current) => current || next.device_name);
    } catch (error) {
      showError(errorMessage(error));
    }
  }, [showError]);

  const credentials = useCallback(async (extra: Record<string, string> = {}) => {
    const vaults = await invoke<BackendVault[]>('list_vaults');
    const cached = getVaultPasswords();
    const passwords: Record<string, string> = { ...extra };
    for (const vault of vaults) {
      const password = cached.get(String(vault.id));
      if (vault.uuid && password !== undefined) passwords[vault.uuid] = password;
    }
    return { vaults, passwords };
  }, [getVaultPasswords]);

  const runSync = useCallback(async (
    extra: Record<string, string> = {},
    successToast = true,
  ) => {
    if (busy) return null;
    setBusy(true);
    try {
      const { passwords } = await credentials(extra);
      const result = await invoke<FolderSyncResult>('run_folder_sync', {
        passwordsByVaultUuid: passwords,
      });
      setRequiredVaults(result.vaults_needing_password);
      if (result.data_changed) onDataChange?.();
      await refreshStatus();
      if (successToast && result.state === 'up_to_date') showSuccess('Brainbox is up to date.');
      if (result.warnings.length) showWarning(result.warnings[0]);
      return result;
    } catch (error) {
      showError(errorMessage(error));
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, credentials, onDataChange, refreshStatus, showError, showSuccess, showWarning]);

  useEffect(() => {
    void refreshStatus();
    const handleResult = (event: Event) => {
      const result = (event as CustomEvent<FolderSyncResult>).detail;
      if (result) setRequiredVaults(result.vaults_needing_password || []);
      void refreshStatus();
    };
    window.addEventListener('brainbox:folder-sync-result', handleResult);
    return () => window.removeEventListener('brainbox:folder-sync-result', handleResult);
  }, [refreshStatus]);

  const chooseFolder = async () => {
    if (!isTauriRuntime()) return;
    const folder = await open({ directory: true, multiple: false, title: 'Choose Brainbox sync folder' });
    if (typeof folder !== 'string') return;
    setBusy(true);
    try {
      const next = await invoke<FolderInspection>('inspect_folder_sync', { path: folder });
      setInspection(next);
      setVerifiedInspection(next.state === 'empty' ? next : null);
      setPassphrase('');
      setPassphraseConfirm('');
    } catch (error) {
      showError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const verifyExistingFolder = async () => {
    if (!inspection || !passphrase.trim()) return;
    setBusy(true);
    try {
      const next = await invoke<FolderInspection>('inspect_folder_sync', {
        path: inspection.folder,
        syncPassphrase: passphrase,
      });
      setVerifiedInspection(next);
    } catch (error) {
      showError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!inspection || !verifiedInspection || !passphrase.trim()) return;
    if (inspection.state === 'empty' && passphrase !== passphraseConfirm) {
      showError('Sync passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      const next = await invoke<FolderSyncStatus>('configure_folder_sync', {
        path: inspection.folder,
        deviceName,
        syncPassphrase: passphrase,
      });
      setStatus(next);
      setInspection(null);
      setVerifiedInspection(null);
      setPassphrase('');
      setPassphraseConfirm('');
    } catch (error) {
      showError(errorMessage(error));
      setBusy(false);
      return;
    }
    setBusy(false);
    await runSync({}, false);
  };

  const unlockVaults = async () => {
    const { vaults } = await credentials();
    const supplied: Record<string, string> = {};
    for (const required of requiredVaults) {
      const password = await prompt({
        title: 'Unlock vault for sync',
        message: `Enter the password for “${required.name}”. It stays in memory for this session.`,
        label: 'Vault password',
        inputType: 'password',
        autoComplete: 'current-password',
        confirmLabel: 'Unlock',
      });
      if (password === null) return;
      const local = vaults.find((vault) => vault.uuid === required.uuid);
      if (local) {
        const key = await setVaultPassword(String(local.id), password);
        try {
          await invoke('verify_vault_password', { vaultId: local.id, key });
        } catch (error) {
          clearKey(String(local.id));
          showError(errorMessage(error));
          return;
        }
      }
      supplied[required.uuid] = password;
    }
    await runSync(supplied);
  };

  const resumeWithPassphrase = async () => {
    const value = await prompt({
      title: 'Resume folder sync',
      message: 'Enter the shared sync passphrase for this folder.',
      label: 'Sync passphrase',
      inputType: 'password',
      autoComplete: 'current-password',
      confirmLabel: 'Resume',
    });
    if (value === null) return;
    try {
      const next = await invoke<FolderSyncStatus>('unlock_folder_sync', { syncPassphrase: value });
      setStatus(next);
      await runSync({}, false);
    } catch (error) {
      showError(errorMessage(error));
    }
  };

  const disconnect = async () => {
    const accepted = await confirm({
      title: 'Disconnect folder sync?',
      message: 'This removes this device’s snapshot and local sync settings. Peer snapshots and your Brainbox data remain.',
      confirmLabel: 'Disconnect',
    });
    if (!accepted) return false;
    setBusy(true);
    try {
      const warning = await invoke<string | null>('disconnect_folder_sync');
      if (warning) showWarning(warning);
      setRequiredVaults([]);
      setInspection(null);
      await refreshStatus();
      return true;
    } catch (error) {
      showError(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changeFolder = async () => {
    if (await disconnect()) await chooseFolder();
  };

  if (!status) return <p className={styles.muted}>Loading sync settings…</p>;

  if (inspection) {
    const existing = inspection.state === 'existing';
    return (
      <div className={styles.stack} data-testid="folder-sync-setup">
        <div className={styles.path}>{inspection.folder}</div>
        <label className={styles.field}>
          <span>Device name</span>
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span>Shared sync passphrase</span>
          <input
            type="password"
            value={passphrase}
            autoComplete={existing ? 'current-password' : 'new-password'}
            onChange={(event) => {
              setPassphrase(event.target.value);
              if (existing) setVerifiedInspection(null);
            }}
          />
        </label>
        {!existing && (
          <label className={styles.field}>
            <span>Confirm passphrase</span>
            <input
              type="password"
              value={passphraseConfirm}
              autoComplete="new-password"
              onChange={(event) => setPassphraseConfirm(event.target.value)}
            />
          </label>
        )}
        {existing && !verifiedInspection && (
          <button className={styles.primaryButton} disabled={busy || !passphrase.trim()} onClick={verifyExistingFolder}>
            Check folder
          </button>
        )}
        {verifiedInspection && (
          <div className={styles.preview}>
            <strong>{existing ? 'Existing Brainbox sync found' : 'New Brainbox sync'}</strong>
            <span>{verifiedInspection.devices.length} devices · {verifiedInspection.vault_count} vaults · {verifiedInspection.item_count} items</span>
          </div>
        )}
        <p className={styles.muted}>Choose this same synchronized folder on every device. Don’t place it inside two sync services at once.</p>
        <div className={styles.actions}>
          {verifiedInspection && (
            <button className={styles.primaryButton} disabled={busy || !deviceName.trim() || !passphrase.trim()} onClick={connect}>
              {busy ? 'Connecting…' : existing ? 'Connect & sync' : 'Start sync'}
            </button>
          )}
          <button className={styles.button} disabled={busy} onClick={() => setInspection(null)}>Cancel</button>
        </div>
      </div>
    );
  }

  if (status.state === 'disabled') {
    return (
      <div className={styles.stack}>
        <p>Keep Brainbox up to date through a folder you choose. Brainbox encrypts the sync files before they leave this device.</p>
        <div className={styles.discovery}>
          <strong>Want a free, private option?</strong>
          <span>Syncthing can sync this folder directly between your devices—no Brainbox account or paid cloud required. Set up a <strong>Send & Receive</strong> folder, then choose it here.</span>
          <a href="https://syncthing.net/downloads/" target="_blank" rel="noreferrer">Get Syncthing ↗</a>
        </div>
        <p className={styles.muted}>Already use Dropbox, Google Drive, OneDrive, Box, or iCloud Drive? Choose a dedicated “Brainbox Sync” folder there and keep it downloaded on every device.</p>
        <button className={styles.primaryButton} disabled={busy} onClick={chooseFolder}>Choose sync folder</button>
      </div>
    );
  }

  return (
    <div className={styles.stack} data-testid="folder-sync-connected">
      <div className={styles.statusRow}>
        <span className={styles.status} data-state={status.state}>{status.state.replace(/_/g, ' ')}</span>
        {status.last_success_at && <span className={styles.muted}>Last synced {new Date(status.last_success_at).toLocaleString()}</span>}
      </div>
      {status.folder && <div className={styles.path}>{status.folder}</div>}
      {status.message && <p className={styles.warning}>{status.message}</p>}
      {status.peers.length > 0 && (
        <div className={styles.peers}>
          {status.peers.map((peer) => <span key={peer.device_id}>{peer.device_name}</span>)}
        </div>
      )}
      {requiredVaults.length > 0 && (
        <div className={styles.warning}>
          Unlock {requiredVaults.map((vault) => vault.name).join(', ')} to continue syncing.
          <button className={styles.button} disabled={busy} onClick={unlockVaults}>Unlock vaults</button>
        </div>
      )}
      <div className={styles.actions}>
        {status.state === 'passphrase_required' ? (
          <button className={styles.primaryButton} disabled={busy} onClick={resumeWithPassphrase}>Enter passphrase</button>
        ) : (
          <button className={styles.primaryButton} disabled={busy || status.state === 'folder_unavailable'} onClick={() => runSync()}>
            {busy ? 'Syncing…' : 'Sync now'}
          </button>
        )}
        <button className={styles.button} disabled={busy} onClick={changeFolder}>Change folder</button>
        <button className={styles.dangerButton} disabled={busy} onClick={disconnect}>Disconnect this device</button>
      </div>
      <p className={styles.muted}>Sync propagates edits and deletions. Keep using encrypted backups for point-in-time recovery.</p>
    </div>
  );
}
