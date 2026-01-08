/**
 * Key Management UI Component
 *
 * Provides a UI for managing vault encryption keys:
 * - View currently unlocked vaults
 * - Lock individual or all vaults
 * - Configure session timeout
 */

import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { InformationCircleIcon, LockClosedIcon, LockOpenIcon } from '@heroicons/react/24/outline';
import { useVaultPassword } from '../../contexts/VaultPasswordContext';
import styles from './KeyManagement.module.css';

interface Vault {
  id: number;
  name: string;
  description?: string;
  has_password?: boolean;
}

interface KeyManagementProps {
  onVaultLocked?: (vaultId: string) => void;
}

export const KeyManagement: React.FC<KeyManagementProps> = ({ onVaultLocked }) => {
  const { hasKey, clearKey, clearAllKeys } = useVaultPassword();
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionTimeout, setSessionTimeout] = useState(() => {
    const saved = localStorage.getItem('brainbox-session-timeout');
    return saved ? parseInt(saved, 10) : 30; // Default 30 minutes
  });

  useEffect(() => {
    loadVaults();
  }, []);

  useEffect(() => {
    localStorage.setItem('brainbox-session-timeout', String(sessionTimeout));
  }, [sessionTimeout]);

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

  // Password-protected vaults that are currently unlocked
  const unlockedVaults = vaults.filter((v) => v.has_password !== false && hasKey(String(v.id)));
  // Password-protected vaults that are currently locked
  const lockedVaults = vaults.filter((v) => v.has_password !== false && !hasKey(String(v.id)));
  // Vaults without password protection (always accessible)
  const passwordlessVaults = vaults.filter((v) => v.has_password === false);

  const handleLockVault = (vaultId: string, _vaultName: string) => {
    clearKey(vaultId);
    onVaultLocked?.(vaultId);
  };

  const handleLockAll = () => {
    clearAllKeys();
    unlockedVaults.forEach((v) => onVaultLocked?.(String(v.id)));
  };

  const timeoutOptions = [
    { value: 5, label: '5 minutes' },
    { value: 15, label: '15 minutes' },
    { value: 30, label: '30 minutes' },
    { value: 60, label: '1 hour' },
    { value: 120, label: '2 hours' },
    { value: 0, label: 'Never (session only)' },
  ];

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>Unlocked Vaults</span>
          <span className={styles.badge}>
            {unlockedVaults.length} of {unlockedVaults.length + lockedVaults.length}
          </span>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading vaults...</div>
        ) : unlockedVaults.length === 0 ? (
          <div className={styles.emptyState}>
            <LockClosedIcon className={styles.lockIcon} aria-hidden="true" />
            <p>No vaults are currently unlocked</p>
            <p className={styles.muted}>
              Unlock a vault by opening it and entering your password
            </p>
          </div>
        ) : (
          <div className={styles.vaultList}>
            {unlockedVaults.map((vault) => (
              <div key={vault.id} className={styles.vaultItem}>
                <div className={styles.vaultInfo}>
                  <LockOpenIcon className={styles.vaultIcon} aria-hidden="true" />
                  <div className={styles.vaultDetails}>
                    <span className={styles.vaultName}>{vault.name}</span>
                    <span className={styles.vaultId}>ID: {vault.id}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className={styles.lockButton}
                  onClick={() => handleLockVault(String(vault.id), vault.name)}
                  aria-label={`Lock vault ${vault.name}`}
                >
                  Lock
                </button>
              </div>
            ))}
          </div>
        )}

        {unlockedVaults.length > 0 && (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.lockAllButton}
              onClick={handleLockAll}
            >
              Lock All Vaults
            </button>
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>Locked Vaults</span>
          <span className={styles.badgeMuted}>{lockedVaults.length}</span>
        </div>

        {lockedVaults.length === 0 ? (
          <div className={styles.emptyStateMuted}>
            All vaults are unlocked
          </div>
        ) : (
          <div className={styles.lockedList}>
            {lockedVaults.map((vault) => (
              <div key={vault.id} className={styles.lockedItem}>
                <LockClosedIcon className={styles.lockedIcon} aria-hidden="true" />
                <span className={styles.lockedName}>{vault.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {passwordlessVaults.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionLabel}>Vaults Without Password</span>
            <span className={styles.badgeMuted}>{passwordlessVaults.length}</span>
          </div>

          <div className={styles.lockedList}>
            {passwordlessVaults.map((vault) => (
              <div key={vault.id} className={styles.lockedItem}>
                <LockOpenIcon className={styles.lockedIcon} aria-hidden="true" />
                <span className={styles.lockedName}>{vault.name}</span>
                <span className={styles.muted} style={{ marginLeft: 'auto', fontSize: '12px' }}>Always accessible</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>Session Settings</span>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingLabel}>Auto-lock timeout</span>
            <span className={styles.settingDescription}>
              Automatically lock vaults after a period of inactivity
            </span>
          </div>
          <select
            value={sessionTimeout}
            onChange={(e) => setSessionTimeout(parseInt(e.target.value, 10))}
            className={styles.select}
            aria-label="Session timeout"
          >
            {timeoutOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.infoBox}>
          <InformationCircleIcon className={styles.infoIcon} aria-hidden="true" />
          <p>
            Encryption keys are stored in memory only. Closing brainbox or
            locking a vault will clear the keys. For maximum security, lock
            your vaults when not in use.
          </p>
        </div>
      </div>
    </div>
  );
};

export default KeyManagement;
