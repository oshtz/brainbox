import React, { useEffect, useRef, useState } from 'react';
import { XMarkIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import Button from '../Button/Button';
import { setSessionSyncPassphrase } from '../../utils/syncSession';
import styles from '../CaptureModal/CaptureModal.module.css';

interface VaultPasswordInfo {
  uuid: string;
  name: string;
}

interface SyncPreview {
  device_name: string;
  exported_at: string;
  vault_count: number;
  item_count: number;
  capture_count: number;
  encrypted: boolean;
  needs_sync_passphrase: boolean;
  vaults_needing_password: VaultPasswordInfo[];
}

interface SyncAvailableDialogProps {
  isOpen: boolean;
  preview: SyncPreview;
  isImporting: boolean;
  onImport: (passwords: Record<string, string>, syncPassphrase?: string) => void;
  onDismiss: () => void;
  onClose: () => void;
}

const SyncAvailableDialog: React.FC<SyncAvailableDialogProps> = ({
  isOpen,
  preview,
  isImporting,
  onImport,
  onDismiss,
  onClose,
}) => {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [syncPassphrase, setSyncPassphrase] = useState('');

  // Reset passwords when dialog opens
  useEffect(() => {
    if (isOpen) {
      setPasswords({});
      setSyncPassphrase('');
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isImporting) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [isOpen, isImporting, onClose]);

  if (!isOpen) return null;

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleString();
    } catch {
      return dateStr;
    }
  };

  const handleImport = () => {
    onImport(passwords, syncPassphrase);
  };

  const needsPasswords = preview.vaults_needing_password.length > 0;
  const needsSyncPassphrase = preview.encrypted || preview.needs_sync_passphrase;

  return (
    <div className={styles.overlay} onClick={isImporting ? undefined : onClose}>
      <div
        ref={modalRef}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-dialog-title"
        style={{ maxWidth: 420 }}
      >
        <div className={styles.header}>
          <h2 id="sync-dialog-title" className={styles.title}>
            <ArrowPathIcon style={{ width: 20, height: 20, marginRight: 8, display: 'inline' }} />
            Sync Available
          </h2>
          {!isImporting && (
            <button className={styles.closeButton} onClick={onClose} aria-label="Close">
              <XMarkIcon className={styles.closeIcon} />
            </button>
          )}
        </div>

        <div className={styles.form}>
          <div style={{ color: 'var(--color-text-secondary)', marginBottom: '1rem' }}>
            <p style={{ margin: '0 0 0.5rem 0' }}>
              <strong>
                {preview.needs_sync_passphrase ? 'Encrypted sync file' : preview.device_name}
              </strong> has sync data available:
            </p>
            {preview.needs_sync_passphrase ? (
              <p style={{ margin: '0.5rem 0', fontSize: '0.875rem' }}>
                Enter the sync file passphrase to import it.
              </p>
            ) : (
              <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
                <li>{preview.vault_count} vault{preview.vault_count !== 1 ? 's' : ''}</li>
                <li>{preview.item_count} item{preview.item_count !== 1 ? 's' : ''}</li>
                {preview.capture_count > 0 && (
                  <li>{preview.capture_count} capture{preview.capture_count !== 1 ? 's' : ''}</li>
                )}
              </ul>
            )}
            <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.875rem', opacity: 0.8 }}>
              Exported: {formatDate(preview.exported_at)}
            </p>
          </div>

          {needsSyncPassphrase && (
            <div style={{ marginBottom: '1rem' }}>
              <p style={{ color: 'var(--color-text-secondary)', margin: '0 0 0.5rem 0', fontSize: '0.875rem' }}>
                Sync file passphrase:
              </p>
              <input
                type="password"
                placeholder="Sync file passphrase"
                value={syncPassphrase}
                onChange={(e) => {
                  setSyncPassphrase(e.target.value);
                  setSessionSyncPassphrase(e.target.value);
                }}
                className={styles.input}
                disabled={isImporting}
                autoComplete="new-password"
              />
            </div>
          )}

          {needsPasswords && (
            <div style={{ marginBottom: '1rem' }}>
              <p style={{ color: 'var(--color-text-secondary)', margin: '0 0 0.75rem 0', fontSize: '0.875rem' }}>
                Enter passwords for protected vaults:
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {preview.vaults_needing_password.map((vaultInfo) => (
                  <div key={vaultInfo.uuid} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{
                      flex: '0 0 auto',
                      minWidth: 100,
                      fontSize: '0.875rem',
                      color: 'var(--color-text-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>
                      {vaultInfo.name}
                    </span>
                    <input
                      type="password"
                      placeholder="Password"
                      value={passwords[vaultInfo.uuid] || ''}
                      onChange={(e) => setPasswords({ ...passwords, [vaultInfo.uuid]: e.target.value })}
                      className={styles.input}
                      style={{ flex: 1 }}
                      disabled={isImporting}
                    />
                  </div>
                ))}
              </div>
              <p style={{
                color: 'var(--color-text-tertiary)',
                margin: '0.5rem 0 0 0',
                fontSize: '0.75rem'
              }}>
                Vaults without passwords will be skipped.
              </p>
            </div>
          )}

          <div className={styles.actions}>
            <Button
              variant="secondary"
              type="button"
              onClick={onDismiss}
              disabled={isImporting}
            >
              Later
            </Button>
            <Button
              type="button"
              onClick={handleImport}
              data-primary="true"
              disabled={isImporting || (needsSyncPassphrase && !syncPassphrase.trim())}
            >
              {isImporting ? 'Importing...' : 'Import Now'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SyncAvailableDialog;
