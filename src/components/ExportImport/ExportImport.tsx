/**
 * Export/Import Component
 *
 * Provides UI for exporting and importing vault data:
 * - Export selected vaults to JSON
 * - Import vaults from JSON file
 * - Set password for imported vaults
 */

import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useVaultPassword } from '../../contexts/VaultPasswordContext';
import { useToast } from '../../contexts/ToastContext';
import styles from './ExportImport.module.css';

interface Vault {
  id: number;
  name: string;
  has_password?: boolean;
}

interface ExportImportProps {
  onImportComplete?: () => void;
}

export const ExportImport: React.FC<ExportImportProps> = ({ onImportComplete }) => {
  const { getVaultKey } = useVaultPassword();
  const { showSuccess, showError } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [vaults, setVaults] = useState<Vault[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVaults, setSelectedVaults] = useState<Set<number>>(new Set());
  const [isExporting, setIsExporting] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importPassword, setImportPassword] = useState('');
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importData, setImportData] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<{ vaultCount: number; itemCount: number; encrypted: boolean } | null>(null);

  useEffect(() => {
    loadVaults();
  }, []);

  const loadVaults = async () => {
    setLoading(true);
    try {
      const vaultList = await invoke<Vault[]>('list_vaults');
      setVaults(vaultList || []);
    } catch (error) {
      console.error('Failed to load vaults:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleVaultSelection = (vaultId: number) => {
    setSelectedVaults((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(vaultId)) {
        newSet.delete(vaultId);
      } else {
        newSet.add(vaultId);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    setSelectedVaults(new Set(vaults.map((v) => v.id)));
  };

  const selectNone = () => {
    setSelectedVaults(new Set());
  };

  const handleExport = async () => {
    if (selectedVaults.size === 0) {
      showError('Please select at least one vault to export');
      return;
    }
    if (!exportPassphrase.trim()) {
      showError('Enter a backup passphrase');
      return;
    }

    setIsExporting(true);
    try {
      const vaultIds = Array.from(selectedVaults);
      const keys: number[][] = [];

      // Get keys for each selected vault
      for (const vaultId of vaultIds) {
        const vault = vaults.find((v) => v.id === vaultId);
        const key = await getVaultKey(String(vaultId), vault?.name, vault?.has_password);
        keys.push(key);
      }

      // Export vaults
      const jsonData = await invoke<string>('export_vaults', {
        vaultIds,
        keys,
        backupPassphrase: exportPassphrase,
      });

      // Create and download file
      const blob = new Blob([jsonData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `brainbox-backup-${new Date().toISOString().split('T')[0]}.brainbox`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showSuccess(`Exported ${vaultIds.length} vault(s) successfully`);
      setExportPassphrase('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Password is required')) {
        showError(`Export failed: ${message}`);
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);

        // Validate format
        const encrypted = typeof data.ciphertext === 'string' && data.encryption === 'XChaCha20-Poly1305';
        if (!encrypted && (!data.version || !data.vaults || !Array.isArray(data.vaults))) {
          showError('Invalid export file format');
          return;
        }

        const vaultCount = encrypted ? 0 : data.vaults.length;
        const itemCount = encrypted ? 0 : data.vaults.reduce(
          (sum: number, v: { items?: unknown[] }) => sum + (v.items?.length || 0),
          0
        );

        setImportData(content);
        setImportPreview({ vaultCount, itemCount, encrypted });
        setShowImportDialog(true);
      } catch {
        showError('Failed to parse export file');
      }
    };
    reader.readAsText(file);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleImport = async () => {
    if (!importData) return;

    setIsImporting(true);
    try {
      const importedIds = await invoke<number[]>('import_vaults', {
        jsonData: importData,
        backupPassphrase: importPassword,
      });

      showSuccess(`Imported ${importedIds.length} vault(s) successfully`);
      setShowImportDialog(false);
      setImportData(null);
      setImportPreview(null);
      setImportPassword('');
      loadVaults();
      onImportComplete?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showError(`Import failed: ${message}`);
    } finally {
      setIsImporting(false);
    }
  };

  const cancelImport = () => {
    setShowImportDialog(false);
    setImportData(null);
    setImportPreview(null);
    setImportPassword('');
  };

  return (
    <div className={styles.container}>
      {/* Export Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>Export Vaults</span>
          <div className={styles.selectionActions}>
            <button
              type="button"
              onClick={selectAll}
              className={styles.linkButton}
              disabled={loading || vaults.length === 0}
            >
              Select all
            </button>
            <span className={styles.separator}>|</span>
            <button
              type="button"
              onClick={selectNone}
              className={styles.linkButton}
              disabled={loading || selectedVaults.size === 0}
            >
              Select none
            </button>
          </div>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading vaults...</div>
        ) : vaults.length === 0 ? (
          <div className={styles.emptyState}>No vaults to export</div>
        ) : (
          <div className={styles.vaultList}>
            {vaults.map((vault) => (
              <label key={vault.id} className={styles.vaultItem}>
                <input
                  type="checkbox"
                  checked={selectedVaults.has(vault.id)}
                  onChange={() => toggleVaultSelection(vault.id)}
                  className={styles.checkbox}
                />
                <span className={styles.vaultName}>{vault.name}</span>
              </label>
            ))}
          </div>
        )}

        <div className={styles.field}>
          <label htmlFor="export-passphrase" className={styles.fieldLabel}>Backup passphrase</label>
          <input
            id="export-passphrase"
            type="password"
            value={exportPassphrase}
            onChange={(event) => setExportPassphrase(event.target.value)}
            className={styles.input}
            autoComplete="new-password"
            placeholder="Required to restore this backup"
          />
          <span className={styles.fieldHint}>Keep this somewhere safe. brainbox cannot recover it.</span>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            onClick={handleExport}
            className={styles.primaryButton}
            disabled={isExporting || selectedVaults.size === 0 || !exportPassphrase.trim()}
          >
            {isExporting ? 'Exporting...' : `Export ${selectedVaults.size} Vault(s)`}
          </button>
        </div>
      </div>

      {/* Import Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>Import Vaults</span>
        </div>

        <p className={styles.description}>
          Restore a passphrase-encrypted brainbox backup. Legacy JSON exports are accepted for migration.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept=".brainbox,.json,application/json"
          onChange={handleFileSelect}
          className={styles.fileInput}
          id="import-file"
        />
        <label htmlFor="import-file" className={styles.fileLabel}>
          Choose Export File
        </label>
      </div>

      {/* Import Dialog */}
      {showImportDialog && importPreview && (
        <div className={styles.dialogBackdrop} onClick={cancelImport}>
          <div
            className={styles.dialog}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-backup-title"
          >
            <h3 id="import-backup-title" className={styles.dialogTitle}>Import Vaults</h3>

            <div className={styles.previewBox}>
              {importPreview.encrypted ? (
                <div className={styles.previewItem}>Encrypted backup — unlock to inspect and restore.</div>
              ) : null}
              {!importPreview.encrypted && (
                <>
              <div className={styles.previewItem}>
                <span className={styles.previewLabel}>Vaults:</span>
                <span className={styles.previewValue}>{importPreview.vaultCount}</span>
              </div>
              <div className={styles.previewItem}>
                <span className={styles.previewLabel}>Items:</span>
                <span className={styles.previewValue}>{importPreview.itemCount}</span>
              </div>
                </>
              )}
            </div>

            <div className={styles.field}>
              <label htmlFor="import-password" className={styles.fieldLabel}>
                Backup passphrase
              </label>
              <input
                id="import-password"
                type="password"
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                className={styles.input}
                placeholder="Enter the backup passphrase"
                autoComplete="new-password"
              />
              <span className={styles.fieldHint}>
                This decrypts the backup and protects the restored vaults.
              </span>
            </div>

            <div className={styles.dialogActions}>
              <button
                type="button"
                onClick={cancelImport}
                className={styles.cancelButton}
                disabled={isImporting || !importPassword.trim()}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleImport}
                className={styles.primaryButton}
                disabled={isImporting}
              >
                {isImporting ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExportImport;
