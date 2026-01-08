/**
 * Change Password Dialog Component
 *
 * A dialog for changing vault passwords with:
 * - Current password verification (for password-protected vaults)
 * - Option to add/remove password protection
 * - New password with confirmation
 * - Password strength indicator
 * - Progress indicator for large vaults
 */

import React, { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { useVaultPassword } from '../../contexts/VaultPasswordContext';
import { useToast } from '../../contexts/ToastContext';
import { deriveKeyFromPassword, keyToArray } from '../../utils/crypto';
import styles from './ChangePasswordDialog.module.css';

interface Vault {
  id: number;
  name: string;
  has_password?: boolean;
}

interface ChangePasswordDialogProps {
  vault: Vault;
  onClose: () => void;
  onSuccess?: () => void;
}

type PasswordStrength = 'weak' | 'fair' | 'good' | 'strong';

function getPasswordStrength(password: string): PasswordStrength {
  if (!password || password.length < 4) return 'weak';

  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;

  if (score <= 1) return 'weak';
  if (score <= 2) return 'fair';
  if (score <= 3) return 'good';
  return 'strong';
}

export const ChangePasswordDialog: React.FC<ChangePasswordDialogProps> = ({
  vault,
  onClose,
  onSuccess,
}) => {
  const { setVaultPassword, clearKey } = useVaultPassword();
  const { showSuccess } = useToast();

  const hasExistingPassword = vault.has_password !== false;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [enablePassword, setEnablePassword] = useState(hasExistingPassword);
  const [isChanging, setIsChanging] = useState(false);
  const [error, setError] = useState('');

  const passwordStrength = getPasswordStrength(newPassword);
  const passwordsMatch = newPassword === confirmPassword;

  // Validation logic
  const canSubmit = (() => {
    if (isChanging) return false;

    // If vault has password, current password is required
    if (hasExistingPassword && !currentPassword) return false;

    // If enabling password protection, new password is required
    if (enablePassword) {
      if (!newPassword || !confirmPassword || !passwordsMatch) return false;
    }

    return true;
  })();

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (enablePassword && !passwordsMatch) {
      setError('New passwords do not match');
      return;
    }

    if (enablePassword && newPassword.length < 4) {
      setError('New password must be at least 4 characters');
      return;
    }

    setIsChanging(true);

    try {
      // Derive old key from current password (empty string for password-less vaults)
      const oldPassword = hasExistingPassword ? currentPassword : '';
      const oldKeyUint8 = await deriveKeyFromPassword(oldPassword, String(vault.id));
      const oldKey = keyToArray(oldKeyUint8);

      // New password is either the new password or empty string to remove protection
      const newPwd = enablePassword ? newPassword : '';

      // Call the backend to change the password
      await invoke('change_vault_password', {
        vaultId: vault.id,
        oldKey,
        newPassword: newPwd,
        newHasPassword: enablePassword,
      });

      // Clear the old cached key
      clearKey(String(vault.id));

      // Cache the new key
      await setVaultPassword(String(vault.id), newPwd);

      if (enablePassword) {
        showSuccess(`Password ${hasExistingPassword ? 'changed' : 'added'} for "${vault.name}"`);
      } else {
        showSuccess(`Password protection removed from "${vault.name}"`);
      }

      onSuccess?.();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Invalid password') || message.includes('Decryption failed')) {
        setError('Current password is incorrect');
      } else {
        setError(`Failed to change password: ${message}`);
      }
    } finally {
      setIsChanging(false);
    }
  }, [vault, currentPassword, newPassword, confirmPassword, passwordsMatch, enablePassword, hasExistingPassword, clearKey, setVaultPassword, showSuccess, onSuccess, onClose]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isChanging) {
      onClose();
    }
  };

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.dialog} role="dialog" aria-labelledby="change-password-title">
        <header className={styles.header}>
          <h2 id="change-password-title" className={styles.title}>
            {hasExistingPassword ? 'Change Password' : 'Add Password Protection'}
          </h2>
          <p className={styles.subtitle}>
            {hasExistingPassword
              ? <>Manage password protection for <strong>{vault.name}</strong></>
              : <>Add password protection to <strong>{vault.name}</strong></>
            }
          </p>
        </header>

        <form onSubmit={handleSubmit} className={styles.form}>
          {hasExistingPassword && (
            <>
              <div className={styles.field}>
                <label htmlFor="current-password" className={styles.label}>
                  Current Password
                </label>
                <input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className={styles.input}
                  autoComplete="current-password"
                  autoFocus
                  disabled={isChanging}
                />
              </div>

              <div className={styles.divider} />

              <div className={styles.field} style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
                <input
                  id="enable-password"
                  type="checkbox"
                  checked={enablePassword}
                  onChange={(e) => setEnablePassword(e.target.checked)}
                  disabled={isChanging}
                  style={{ width: 'auto', margin: 0 }}
                />
                <label htmlFor="enable-password" style={{ margin: 0 }}>
                  Keep password protection
                </label>
              </div>
            </>
          )}

          {enablePassword && (
            <>
              <div className={styles.field}>
                <label htmlFor="new-password" className={styles.label}>
                  {hasExistingPassword ? 'New Password' : 'Password'}
                </label>
                <input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={styles.input}
                  autoComplete="new-password"
                  autoFocus={!hasExistingPassword}
                  disabled={isChanging}
                />
                {newPassword && (
                  <div className={styles.strengthContainer}>
                    <div className={`${styles.strengthBar} ${styles[passwordStrength]}`}>
                      <div className={styles.strengthFill} />
                    </div>
                    <span className={`${styles.strengthLabel} ${styles[passwordStrength]}`}>
                      {passwordStrength.charAt(0).toUpperCase() + passwordStrength.slice(1)}
                    </span>
                  </div>
                )}
              </div>

              <div className={styles.field}>
                <label htmlFor="confirm-password" className={styles.label}>
                  Confirm Password
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={`${styles.input} ${confirmPassword && !passwordsMatch ? styles.inputError : ''}`}
                  autoComplete="new-password"
                  disabled={isChanging}
                />
                {confirmPassword && !passwordsMatch && (
                  <span className={styles.fieldError}>Passwords do not match</span>
                )}
              </div>
            </>
          )}

          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}

          <div className={styles.warning}>
            <ExclamationTriangleIcon className={styles.warningIcon} aria-hidden="true" />
            <p>
              {enablePassword
                ? 'This will re-encrypt all items in this vault. Make sure you remember your password - there is no way to recover it if forgotten.'
                : 'This will remove password protection. Anyone with access to this device will be able to view the vault contents.'}
            </p>
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              onClick={onClose}
              className={styles.cancelButton}
              disabled={isChanging}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.submitButton}
              disabled={!canSubmit}
            >
              {isChanging
                ? 'Saving...'
                : enablePassword
                  ? (hasExistingPassword ? 'Change Password' : 'Add Password')
                  : 'Remove Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ChangePasswordDialog;
