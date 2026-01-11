import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

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

// Styles
const cardStyle: React.CSSProperties = {
  background: 'var(--color-elevated)',
  borderRadius: 16,
  border: '1px solid var(--color-border)',
  padding: '1.75rem',
  boxShadow: '0px 18px 40px rgba(15, 23, 42, 0.12)',
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '1.5rem',
  flexWrap: 'wrap',
  marginBottom: '1.5rem',
};

const cardTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '1.15rem',
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};

const cardDescriptionStyle: React.CSSProperties = {
  margin: '0.35rem 0 0',
  fontSize: '0.95rem',
  color: 'var(--color-text-secondary)',
  lineHeight: 1.4,
};

const cardBodyStyle: React.CSSProperties = {
  display: 'grid',
  gap: '1.5rem',
};

const buttonStyle: React.CSSProperties = {
  padding: '0.6rem 1.1rem',
  borderRadius: 999,
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '0.95rem',
  transition: 'transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease',
  boxShadow: '0 10px 20px rgba(15, 23, 42, 0.08)',
};

const inputStyle: React.CSSProperties = {
  padding: '0.65rem 0.9rem',
  borderRadius: 10,
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  width: '100%',
  fontSize: '0.95rem',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.9rem',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  marginBottom: 6,
};

const subtleLabelStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--color-text-secondary)',
};

const toggleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '0.75rem 0',
  borderBottom: '1px solid var(--color-border)',
};

const toggleLabelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const toggleStyle: React.CSSProperties = {
  position: 'relative',
  width: 48,
  height: 26,
  borderRadius: 13,
  background: 'var(--color-border)',
  cursor: 'pointer',
  transition: 'background 0.2s ease',
  flexShrink: 0,
};

const toggleActiveStyle: React.CSSProperties = {
  ...toggleStyle,
  background: 'var(--color-accent)',
};

const toggleKnobStyle: React.CSSProperties = {
  position: 'absolute',
  top: 3,
  left: 3,
  width: 20,
  height: 20,
  borderRadius: '50%',
  background: '#fff',
  transition: 'transform 0.2s ease',
  boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
};

const toggleKnobActiveStyle: React.CSSProperties = {
  ...toggleKnobStyle,
  transform: 'translateX(22px)',
};

const statusBubbleStyle = (variant: 'info' | 'accent' | 'danger' | 'warning' = 'info'): React.CSSProperties => {
  const palette = {
    info: {
      border: 'var(--color-border)',
      background: 'var(--color-surface)',
      color: 'var(--color-text-secondary)',
    },
    accent: {
      border: 'var(--color-accent)',
      background: 'rgba(99, 102, 241, 0.08)',
      color: 'var(--color-accent)',
    },
    danger: {
      border: '#ef4444',
      background: 'rgba(239, 68, 68, 0.08)',
      color: '#ef4444',
    },
    warning: {
      border: '#f59e0b',
      background: 'rgba(245, 158, 11, 0.08)',
      color: '#f59e0b',
    },
  }[variant];

  return {
    padding: '0.75rem 1rem',
    borderRadius: 12,
    border: `1px solid ${palette.border}`,
    background: palette.background,
    color: palette.color,
    fontSize: '0.92rem',
    lineHeight: 1.4,
  };
};

const folderRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '0.75rem',
  background: 'var(--color-surface)',
  borderRadius: 10,
  border: '1px solid var(--color-border)',
};

const folderPathStyle: React.CSSProperties = {
  flex: 1,
  fontSize: '0.9rem',
  color: 'var(--color-text-primary)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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
      <section style={cardStyle}>
        <header style={cardHeaderStyle}>
          <div style={{ flex: '1 1 auto' }}>
            <h2 style={cardTitleStyle}>Sync</h2>
            <p style={cardDescriptionStyle}>Loading sync settings...</p>
          </div>
        </header>
      </section>
    );
  }

  return (
    <section id="sync-settings" style={cardStyle}>
      <header style={cardHeaderStyle}>
        <div style={{ flex: '1 1 auto' }}>
          <h2 style={cardTitleStyle}>Sync</h2>
          <p style={cardDescriptionStyle}>
            Synchronize your vaults across devices using any file sync service.
          </p>
        </div>
      </header>

      <div style={cardBodyStyle}>
        {/* Sync Folder */}
        <div>
          <label style={labelStyle}>Sync Folder</label>
          {status?.sync_folder && !folderInput ? (
            <div style={folderRowStyle}>
              <span style={folderPathStyle}>{status.sync_folder}</span>
              <button type="button" style={buttonStyle} onClick={() => {
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
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button type="button" style={buttonStyle} onClick={handleSetFolder}>
                  Set Folder
                </button>
                {status?.sync_folder && (
                  <button type="button" style={buttonStyle} onClick={() => setFolderInput('')}>
                    Cancel
                  </button>
                )}
              </div>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                Enter the full path to a folder that syncs across your devices (e.g., Dropbox, OneDrive, Google Drive, Syncthing).
              </p>
            </div>
          )}
        </div>

        {/* Device Name */}
        <div>
          <label style={labelStyle}>Device Name</label>
          <input
            type="text"
            value={deviceName}
            onChange={(e) => handleDeviceNameChange(e.target.value)}
            style={inputStyle}
            placeholder="Enter device name"
          />
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
            Identifies this device in sync history.
          </p>
        </div>

        {/* Toggles */}
        <div>
          <div style={toggleRowStyle}>
            <div style={toggleLabelStyle}>
              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>Sync on close</span>
              <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                Automatically export when closing the app
              </span>
            </div>
            <button
              type="button"
              style={syncOnClose ? toggleActiveStyle : toggleStyle}
              onClick={() => handleSyncOnCloseChange(!syncOnClose)}
              aria-pressed={syncOnClose}
            >
              <span style={syncOnClose ? toggleKnobActiveStyle : toggleKnobStyle} />
            </button>
          </div>

          <div style={toggleRowStyle}>
            <div style={toggleLabelStyle}>
              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>Check for sync on startup</span>
              <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                Prompt to import if newer sync data is available
              </span>
            </div>
            <button
              type="button"
              style={checkOnStartup ? toggleActiveStyle : toggleStyle}
              onClick={() => handleCheckOnStartupChange(!checkOnStartup)}
              aria-pressed={checkOnStartup}
            >
              <span style={checkOnStartup ? toggleKnobActiveStyle : toggleKnobStyle} />
            </button>
          </div>
        </div>

        {/* Purge Days */}
        <div>
          <label style={labelStyle}>Purge deleted items after (days)</label>
          <input
            type="number"
            value={purgeDays}
            onChange={(e) => handlePurgeDaysChange(parseInt(e.target.value, 10) || 30)}
            min={1}
            max={365}
            style={{ ...inputStyle, width: 120 }}
          />
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
            Soft-deleted items are permanently removed after this many days.
          </p>
        </div>

        {/* Locked Vaults - Password Entry */}
        {lockedVaults.length > 0 && (
          <div>
            <span style={subtleLabelStyle}>Password-Protected Vaults</span>
            <p style={{ margin: '0.5rem 0', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
              Enter passwords for vaults to include them in sync:
            </p>
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {lockedVaults.map((vault) => (
                <div key={vault.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span style={{ minWidth: 120, fontWeight: 500 }}>{vault.name}</span>
                  <input
                    type="password"
                    placeholder="Password"
                    value={passwords[vault.id.toString()] || ''}
                    onChange={(e) => setPasswords({ ...passwords, [vault.id.toString()]: e.target.value })}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sync Status & Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              style={{
                ...buttonStyle,
                background: 'var(--color-accent)',
                border: '1px solid var(--color-accent)',
                color: '#fff',
                opacity: !status?.sync_enabled || isSyncing ? 0.6 : 1,
              }}
              disabled={!status?.sync_enabled || isSyncing}
              onClick={handleExport}
            >
              {isSyncing ? 'Syncing...' : 'Sync Now (Export)'}
            </button>

            {status?.remote_file_exists && (
              <button
                type="button"
                style={{
                  ...buttonStyle,
                  opacity: isSyncing ? 0.6 : 1,
                }}
                disabled={isSyncing}
                onClick={handleImport}
              >
                Import from Sync
              </button>
            )}
          </div>

          {/* Last sync info */}
          {status?.last_sync_at && (
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
              Last synced: {formatDate(status.last_sync_at)}
              {status.last_sync_device && ` from ${status.last_sync_device}`}
            </p>
          )}

          {/* Remote sync info */}
          {preview && (
            <div style={statusBubbleStyle(status?.has_changes ? 'warning' : 'info')}>
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
            <div style={statusBubbleStyle(syncMessageType)}>
              {syncMessage}
            </div>
          )}
        </div>

        {/* Security Warning */}
        <div style={statusBubbleStyle('warning')}>
          <strong>Security Note:</strong> Your sync file contains decrypted vault data. 
          Ensure your sync folder is secured (encrypted drive, trusted sync service, or local network only).
        </div>
      </div>
    </section>
  );
}

export default SyncSettings;
