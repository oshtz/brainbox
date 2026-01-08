/**
 * Vault Password Context
 *
 * Manages vault passwords and derived encryption keys for the current session.
 * Keys are cached in memory to avoid re-deriving on every operation.
 * Supports auto-lock timeout for security.
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { deriveKeyFromPassword, keyToArray } from '../utils/crypto';
import { usePrompt } from './PromptContext';

interface VaultPasswordContextType {
  /**
   * Get the derived key for a vault (prompts for password if not cached and vault is password-protected)
   * @param vaultId - The vault ID
   * @param vaultName - Optional display name for the prompt
   * @param hasPassword - Whether the vault is password-protected (false = auto-unlock)
   */
  getVaultKey: (vaultId: string, vaultName?: string, hasPassword?: boolean) => Promise<number[]>;

  /**
   * Check if we have a key cached for a vault
   */
  hasKey: (vaultId: string) => boolean;

  /**
   * Clear the cached key for a vault (e.g., on vault close/lock)
   */
  clearKey: (vaultId: string) => void;

  /**
   * Clear all cached keys
   */
  clearAllKeys: () => void;

  /**
   * Set the password for a vault (used when creating or accessing)
   */
  setVaultPassword: (vaultId: string, password: string) => Promise<number[]>;

  /**
   * Get the list of currently unlocked vault IDs
   */
  getUnlockedVaultIds: () => string[];

  /**
   * Reset the inactivity timer (called on user activity)
   */
  resetInactivityTimer: () => void;
}

const VaultPasswordContext = createContext<VaultPasswordContextType | undefined>(undefined);

interface VaultPasswordProviderProps {
  children: ReactNode;
}

export const VaultPasswordProvider: React.FC<VaultPasswordProviderProps> = ({ children }) => {
  const promptDialog = usePrompt();
  // Store derived keys (as number arrays for Tauri) indexed by vaultId
  const [keys, setKeys] = useState<Map<string, number[]>>(new Map());

  // Store vault passwords temporarily (for re-deriving keys if needed)
  const [, setPasswords] = useState<Map<string, string>>(new Map());

  // Last activity timestamp for inactivity timeout
  const lastActivityRef = useRef<number>(Date.now());

  // Get timeout from localStorage (in minutes, 0 = disabled)
  const getTimeoutMs = useCallback(() => {
    const saved = localStorage.getItem('brainbox-session-timeout');
    const minutes = saved ? parseInt(saved, 10) : 30;
    return minutes > 0 ? minutes * 60 * 1000 : 0;
  }, []);

  // Reset inactivity timer
  const resetInactivityTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  // Auto-lock check effect
  useEffect(() => {
    const checkInactivity = () => {
      const timeoutMs = getTimeoutMs();
      if (timeoutMs === 0 || keys.size === 0) return;

      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= timeoutMs) {
        // Clear all keys due to inactivity
        setKeys(new Map());
        setPasswords(new Map());
      }
    };

    // Check every minute
    const intervalId = setInterval(checkInactivity, 60 * 1000);

    // Listen for user activity
    const handleActivity = () => {
      lastActivityRef.current = Date.now();
    };

    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('keydown', handleActivity);
    window.addEventListener('click', handleActivity);
    window.addEventListener('scroll', handleActivity);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('scroll', handleActivity);
    };
  }, [keys.size, getTimeoutMs]);

  const setVaultPassword = useCallback(async (vaultId: string, password: string) => {
    // Derive key from password
    const keyUint8 = await deriveKeyFromPassword(password, vaultId);
    const keyArray = keyToArray(keyUint8);

    // Store both password and derived key
    setPasswords(prev => new Map(prev).set(vaultId, password));
    setKeys(prev => new Map(prev).set(vaultId, keyArray));
    return keyArray;
  }, []);

  const getVaultKey = useCallback(async (vaultId: string, vaultName?: string, hasPassword?: boolean): Promise<number[]> => {
    // Check if we already have a cached key
    const cachedKey = keys.get(vaultId);
    if (cachedKey) {
      return cachedKey;
    }

    // If vault is not password-protected, auto-derive key with empty password
    if (hasPassword === false) {
      const key = await setVaultPassword(vaultId, '');
      return key;
    }

    // Prompt user for password (for password-protected vaults or when hasPassword is undefined)
    const displayName = vaultName || `Vault ${vaultId}`;
    const password = await promptDialog({
      title: 'Unlock vault',
      message: `Enter the password for "${displayName}".`,
      label: 'Vault password',
      inputType: 'password',
      autoComplete: 'current-password',
      confirmLabel: 'Unlock'
    });

    if (password === null) {
      throw new Error('Password is required to access this vault');
    }

    // Derive and cache the key
    const key = await setVaultPassword(vaultId, password);
    return key;
  }, [keys, setVaultPassword, promptDialog]);

  const hasKey = useCallback((vaultId: string): boolean => {
    return keys.has(vaultId);
  }, [keys]);

  const clearKey = useCallback((vaultId: string) => {
    setKeys(prev => {
      const newMap = new Map(prev);
      newMap.delete(vaultId);
      return newMap;
    });
    setPasswords(prev => {
      const newMap = new Map(prev);
      newMap.delete(vaultId);
      return newMap;
    });
  }, []);

  const clearAllKeys = useCallback(() => {
    setKeys(new Map());
    setPasswords(new Map());
  }, []);

  const getUnlockedVaultIds = useCallback((): string[] => {
    return Array.from(keys.keys());
  }, [keys]);

  const contextValue: VaultPasswordContextType = {
    getVaultKey,
    hasKey,
    clearKey,
    clearAllKeys,
    setVaultPassword,
    getUnlockedVaultIds,
    resetInactivityTimer,
  };

  return (
    <VaultPasswordContext.Provider value={contextValue}>
      {children}
    </VaultPasswordContext.Provider>
  );
};

/**
 * Hook to access vault password management
 */
export const useVaultPassword = (): VaultPasswordContextType => {
  const context = useContext(VaultPasswordContext);
  if (context === undefined) {
    throw new Error('useVaultPassword must be used within a VaultPasswordProvider');
  }
  return context;
};
