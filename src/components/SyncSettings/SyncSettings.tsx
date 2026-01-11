import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import styles from './SyncSettings.module.css';

interface SyncStatus {
  sync_enabled: boolean;
  sync_folder: string | null;
  device_name: string;
  last_sync_at: string | null;
  last_sync_device: string | null;
  remote_file_exists: boolean;
  remote_exported_at: string | null;
  remote_device_name: string | null;
  has_changes: boolean;
}

interface SyncExportResult {
  exported_vaults: number;
  exported_items: number;
  exported_captures: number;
  skipped_vaults: string[];
  warnings: string[];
}

interface SyncImportResult {
  imported_vaults: number;
  imported_items: number;
  imported_captures: number;
  conflicts: string[];
  warnings: string[];
  skipped_vaults: string[];
}

interface SyncPreview {
  device_name: string;
  exported_at: string;
  vault_count: number;
  item_count: number;
  capture_count: number;
  vaults_needing_password: string[];
}

interface LockedVault {
  id: number;
  name: string;
}

// Helper to get status bubble class
const getStatusClass = (variant: 'info' | 'accent' | 'danger' | 'warning') => {
  const classes: Record<string, string> = {
    info: styles.statusInfo,
    accent: styles.statusAccent,
    danger: styles.statusDanger,
    warning: styles.statusWarning,
  };
  return `${styles.statusBubble} ${classes[variant]}`;
};

export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncMessageType, setSyncMessageType] = useState<'info' | 'accent' | 'danger' | 'warning'>('info');
  const [deviceName, setDeviceName] = useState('');
  const [purgeDays, setPurgeDays] = useState(30);
  const [syncOnClose, setSyncOnClose] = useState(false);
  const [checkOnStartup, setCheckOnStartup] = useState(true);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [lockedVaults, setLockedVaults] = useState<LockedVault[]>([]);
  const [passwords, setPasswords] = useState<Record<string, string>>({});

  // Load sync status on mount
  useEffect(() => {
    loadSyncStatus();
  }, []);

  const loadSyncStatus = async () => {
    setIsLoading(true);
    try {
      const [statusResult, hostname, settings] = await Promise.all([
        invoke<SyncStatus>('get_sync_status'),
        invoke<string>('get_hostname'),
        invoke<Record<string, string>>('get_sync_settings'),
      ]);
      
      setStatus(statusResult);
      setDeviceName(statusResult.device_name || hostname);
      setPurgeDays(parseInt(settings.purge_deleted_after_days || '30', 10));
      setSyncOnClose(settings.sync_on_close === 'true');
      setCheckOnStartup(settings.check_sync_on_startup !== 'false'); // Default true

      // Check for remote sync file
      if (statusResult.sync_enabled && statusResult.remote_file_exists) {
        const previewResult = await invoke<SyncPreview | null>('get_sync_preview');
        setPreview(previewResult);
      }

      // Get locked vaults
      const locked = await invoke<[number, string][]>('get_locked_vaults_for_sync');
      setLockedVaults(locked.map(([id, name]) => ({ id, name })));
    } catch (e) {
      console.error('Failed to load sync status:', e);
      setSyncMessage(`Failed to load sync status: ${e}`);
      setSyncMessageType('danger');
    } finally {
      setIsLoading(false);
    }
  };

  const [folderInput, setFolderInput] = useState('');

  const handleSetFolder = async () => {
    if (!folderInput.trim()) {
      setSyncMessage('Please enter a folder path.');
      setSyncMessageType('warning');
      return;
    }
    try {
      await invoke('set_sync_folder', { path: folderInput.trim() });
      await loadSyncStatus();
      setSyncMessage('Sync folder set successfully.');
      setSyncMessageType('accent');
      setFolderInput('');
    } catch (e) {
      console.error('Failed to set folder:', e);
      setSyncMessage(`Failed to set sync folder: ${e}`);
      setSyncMessageType('danger');
    }
  };

  const handleDeviceNameChange = async (name: string) => {
    setDeviceName(name);
    try {
      await invoke('set_device_name', { name });
    } catch (e) {
      console.error('Failed to set device name:', e);
    }
  };

  const handleSyncOnCloseChange = async (enabled: boolean) => {
    setSyncOnClose(enabled);
    try {
      await invoke('set_sync_on_close', { enabled });
    } catch (e) {
      console.error('Failed to set sync on close:', e);
    }
  };

  const handleCheckOnStartupChange = async (enabled: boolean) => {
    setCheckOnStartup(enabled);
    try {
      await invoke('set_check_sync_on_startup', { enabled });
    } catch (e) {
      console.error('Failed to set check on startup:', e);
    }
  };

  const handlePurgeDaysChange = async (days: number) => {
    setPurgeDays(days);
    try {
      await invoke('set_sync_setting', { key: 'purge_deleted_after_days', value: days.toString() });
    } catch (e) {
      console.error('Failed to set purge days:', e);
    }
  };

  const handleExport = async () => {
    setIsSyncing(true);
    setSyncMessage('Exporting vaults...');
    setSyncMessageType('info');

    try {
      // Build passwords map: vault_id -> key bytes
      const passwordMap: Record<number, number[]> = {};
      for (const vault of lockedVaults) {
        const pwd = passwords[vault.id.toString()];
        if (pwd) {
          // Derive key from password
          const { deriveKeyFromPassword, keyToArray } = await import('../../utils/crypto');
          const key = await deriveKeyFromPassword(pwd, vault.id.toString());
          passwordMap[vault.id] = Array.from(keyToArray(key));
        }
      }

      const result = await invoke<SyncExportResult>('sync_export_vaults', { passwords: passwordMap });
      
      let message = `Exported ${result.exported_vaults} vaults, ${result.exported_items} items`;
      if (result.exported_captures > 0) {
        message += `, ${result.exported_captures} captures`;
      }
      if (result.skipped_vaults.length > 0) {
        message += `. Skipped: ${result.skipped_vaults.join(', ')}`;
      }
      
      setSyncMessage(message);
      setSyncMessageType(result.skipped_vaults.length > 0 ? 'warning' : 'accent');
      await loadSyncStatus();
    } catch (e) {
      console.error('Export failed:', e);
      setSyncMessage(`Export failed: ${e}`);
      setSyncMessageType('danger');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleImport = async () => {
    setIsSyncing(true);
    setSyncMessage('Importing vaults...');
    setSyncMessageType('info');

    try {
      // Build passwords map: vault_uuid -> password
      const passwordMap: Record<string, string> = {};
      // For import, we need to map by vault UUID from the preview
      // For now, we'll ask for passwords for vaults that need them
      if (preview?.vaults_needing_password) {
        for (const vaultName of preview.vaults_needing_password) {
          // Find matching local vault or use provided password
          const localVault = lockedVaults.find(v => v.name === vaultName);
          if (localVault && passwords[localVault.id.toString()]) {
            // We'd need the UUID here - for now use vault name as approximation
            passwordMap[vaultName] = passwords[localVault.id.toString()];
          }
        }
      }

      const result = await invoke<SyncImportResult>('sync_import_vaults', { passwords: passwordMap });
      
      // Rebuild search index after import
      if (result.imported_items > 0) {
        setSyncMessage('Rebuilding search index...');
        try {
          const { rebuildIndex } = await import('../../utils/searchIndexer');
          await rebuildIndex();
        } catch (indexError) {
          console.error('Failed to rebuild search index:', indexError);
          // Don't fail the import just because indexing failed
        }
      }
      
      let message = `Imported ${result.imported_vaults} vaults, ${result.imported_items} items`;
      if (result.imported_captures > 0) {
        message += `, ${result.imported_captures} captures`;
      }
      if (result.conflicts.length > 0) {
        message += `. Conflicts: ${result.conflicts.length}`;
      }
      if (result.skipped_vaults.length > 0) {
        message += `. Skipped: ${result.skipped_vaults.join(', ')}`;
      }
      
      setSyncMessage(message);
      setSyncMessageType(result.conflicts.length > 0 || result.skipped_vaults.length > 0 ? 'warning' : 'accent');
      await loadSyncStatus();
      
      // Notify the rest of the app that data has changed
      if (result.imported_vaults > 0 || result.imported_items > 0) {
        await emit('vaults-changed');
        await emit('items-changed', { type: 'sync-import' });
      }
    } catch (e) {
      console.error('Import failed:', e);
      setSyncMessage(`Import failed: ${e}`);
      setSyncMessageType('danger');
    } finally {
      setIsSyncing(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    try {
      const date = new Date(dateStr);
      return date.toLocaleString();
    } catch {
      return dateStr;
    }
  };

  if (isLoading) {
    return (
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <div style={{ flex: '1 1 auto' }}>
            <h2 className={styles.cardTitle}>Sync</h2>
            <p className={styles.cardDescription}>Loading sync settings...</p>
          </div>
        </header>
      </section>
    );
  }

  return (
    <section id="sync-settings" className={styles.card}>
      <header className={styles.cardHeader}>
        <div style={{ flex: '1 1 auto' }}>
          <h2 className={styles.cardTitle}>Sync</h2>
          <p className={styles.cardDescription}>
            Synchronize your vaults across devices using any file sync service.
          </p>
        </div>
      </header>

      <div className={styles.cardBody}>
        {/* Sync Folder */}
        <div>
          <label className={styles.label}>Sync Folder</label>
          {status?.sync_folder && !folderInput ? (
            <div className={styles.folderRow}>
              <span className={styles.folderPath}>{status.sync_folder}</span>
              <button type="button" className={styles.button} onClick={() => {
                setFolderInput(status?.sync_folder || '');
              }}>
                Change
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  value={folderInput}
                  onChange={(e) => setFolderInput(e.target.value)}
                  placeholder="Enter full path to sync folder"
                  className={styles.input}
                  style={{ flex: 1 }}
                />
                <button type="button" className={styles.button} onClick={handleSetFolder}>
                  Set Folder
                </button>
                {status?.sync_folder && (
                  <button type="button" className={styles.button} onClick={() => setFolderInput('')}>
                    Cancel
                  </button>
                )}
              </div>
              <p className={styles.hint} style={{ margin: 0 }}>
                Enter the full path to a folder that syncs across your devices (e.g., Dropbox, OneDrive, Google Drive, Syncthing).
              </p>
            </div>
          )}
        </div>

        {/* Device Name */}
        <div>
          <label className={styles.label}>Device Name</label>
          <input
            type="text"
            value={deviceName}
            onChange={(e) => handleDeviceNameChange(e.target.value)}
            className={styles.input}
            placeholder="Enter device name"
          />
          <p className={styles.hint}>
            Identifies this device in sync history.
          </p>
        </div>

        {/* Segmented Toggles */}
        <div>
          <div className={styles.settingRow}>
            <div className={styles.settingLabel}>
              <span className={styles.settingLabelTitle}>Sync on close</span>
              <span className={styles.settingLabelHint}>
                Automatically export when closing the app
              </span>
            </div>
            <div className={styles.segmentedToggle}>
              <button
                type="button"
                className={`${styles.segmentedButton} ${!syncOnClose ? styles.segmentedButtonActive : ''}`}
                onClick={() => handleSyncOnCloseChange(false)}
              >
                Off
              </button>
              <button
                type="button"
                className={`${styles.segmentedButton} ${syncOnClose ? styles.segmentedButtonActive : ''}`}
                onClick={() => handleSyncOnCloseChange(true)}
              >
                On
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingLabel}>
              <span className={styles.settingLabelTitle}>Check for sync on startup</span>
              <span className={styles.settingLabelHint}>
                Prompt to import if newer sync data is available
              </span>
            </div>
            <div className={styles.segmentedToggle}>
              <button
                type="button"
                className={`${styles.segmentedButton} ${!checkOnStartup ? styles.segmentedButtonActive : ''}`}
                onClick={() => handleCheckOnStartupChange(false)}
              >
                Off
              </button>
              <button
                type="button"
                className={`${styles.segmentedButton} ${checkOnStartup ? styles.segmentedButtonActive : ''}`}
                onClick={() => handleCheckOnStartupChange(true)}
              >
                On
              </button>
            </div>
          </div>
        </div>

        {/* Purge Days */}
        <div>
          <label className={styles.label}>Purge deleted items after (days)</label>
          <input
            type="number"
            value={purgeDays}
            onChange={(e) => handlePurgeDaysChange(parseInt(e.target.value, 10) || 30)}
            min={1}
            max={365}
            className={styles.input}
            style={{ width: 120 }}
          />
          <p className={styles.hint}>
            Soft-deleted items are permanently removed after this many days.
          </p>
        </div>

        {/* Locked Vaults - Password Entry */}
        {lockedVaults.length > 0 && (
          <div>
            <span className={styles.subtleLabel}>Password-Protected Vaults</span>
            <p className={styles.hint} style={{ margin: '0.5rem 0' }}>
              Enter passwords for vaults to include them in sync:
            </p>
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {lockedVaults.map((vault) => (
                <div key={vault.id} className={styles.vaultPasswordRow}>
                  <span className={styles.vaultName}>{vault.name}</span>
                  <input
                    type="password"
                    placeholder="Password"
                    value={passwords[vault.id.toString()] || ''}
                    onChange={(e) => setPasswords({ ...passwords, [vault.id.toString()]: e.target.value })}
                    className={styles.input}
                    style={{ flex: 1 }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sync Status & Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div className={styles.actionsRow}>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={!status?.sync_enabled || isSyncing}
              onClick={handleExport}
            >
              {isSyncing ? 'Syncing...' : 'Sync Now (Export)'}
            </button>

            {status?.remote_file_exists && (
              <button
                type="button"
                className={styles.button}
                disabled={isSyncing}
                onClick={handleImport}
              >
                Import from Sync
              </button>
            )}
          </div>

          {/* Last sync info */}
          {status?.last_sync_at && (
            <p className={styles.hint} style={{ margin: 0 }}>
              Last synced: {formatDate(status.last_sync_at)}
              {status.last_sync_device && ` from ${status.last_sync_device}`}
            </p>
          )}

          {/* Remote sync info */}
          {preview && (
            <div className={getStatusClass(status?.has_changes ? 'warning' : 'info')}>
              <strong>Sync available from {preview.device_name}</strong>
              <br />
              {preview.vault_count} vaults, {preview.item_count} items
              {preview.capture_count > 0 && `, ${preview.capture_count} captures`}
              <br />
              <span style={{ fontSize: '0.85rem' }}>
                Exported: {formatDate(preview.exported_at)}
              </span>
            </div>
          )}

          {/* Sync message */}
          {syncMessage && (
            <div className={getStatusClass(syncMessageType)}>
              {syncMessage}
            </div>
          )}
        </div>

        {/* Security Warning */}
        <div className={getStatusClass('warning')}>
          <strong>Security Note:</strong> Your sync file contains decrypted vault data. 
          Ensure your sync folder is secured (encrypted drive, trusted sync service, or local network only).
        </div>
      </div>
    </section>
  );
}

export default SyncSettings;
