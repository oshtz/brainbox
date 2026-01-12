/**
 * Sync Manager Hook
 * 
 * Handles:
 * - Checking for remote sync on startup
 * - Triggering sync export on app close (if enabled)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
  vaults_needing_password: VaultPasswordInfo[];
}

interface UseSyncManagerOptions {
  onSyncAvailable?: (preview: SyncPreview) => void;
  onSyncError?: (error: string) => void;
  showToast?: (type: 'info' | 'success' | 'warning' | 'error', message: string) => void;
}

interface UseSyncManagerReturn {
  checkForRemoteSync: () => Promise<SyncPreview | null>;
  triggerExport: (passwords?: Record<number, number[]>) => Promise<boolean>;
  syncStatus: SyncStatus | null;
  isChecking: boolean;
  isSyncing: boolean;
  pendingSync: SyncPreview | null;
  dismissPendingSync: () => void;
}

export function useSyncManager(options: UseSyncManagerOptions = {}): UseSyncManagerReturn {
  const { onSyncAvailable, onSyncError, showToast } = options;
  
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingSync, setPendingSync] = useState<SyncPreview | null>(null);
  
  const hasCheckedStartup = useRef(false);
  const closeListenerSetup = useRef(false);

  // Check for remote sync availability
  const checkForRemoteSync = useCallback(async (): Promise<SyncPreview | null> => {
    setIsChecking(true);
    try {
      // Check if startup sync check is enabled
      const checkEnabled = await invoke<boolean>('is_check_sync_on_startup_enabled');
      if (!checkEnabled) {
        return null;
      }

      const status = await invoke<SyncStatus>('get_sync_status');
      setSyncStatus(status);

      // If sync is enabled and remote file exists with changes
      if (status.sync_enabled && status.remote_file_exists && status.has_changes) {
        const preview = await invoke<SyncPreview | null>('get_sync_preview');
        if (preview) {
          setPendingSync(preview);
          onSyncAvailable?.(preview);
          return preview;
        }
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to check remote sync:', message);
      onSyncError?.(message);
      return null;
    } finally {
      setIsChecking(false);
    }
  }, [onSyncAvailable, onSyncError]);

  // Trigger sync export
  const triggerExport = useCallback(async (passwords?: Record<number, number[]>): Promise<boolean> => {
    setIsSyncing(true);
    try {
      await invoke('sync_export_vaults', { passwords: passwords || {} });
      showToast?.('success', 'Sync export completed');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Sync export failed:', message);
      showToast?.('error', `Sync export failed: ${message}`);
      return false;
    } finally {
      setIsSyncing(false);
    }
  }, [showToast]);

  // Dismiss pending sync notification
  const dismissPendingSync = useCallback(() => {
    setPendingSync(null);
  }, []);

  // Check for sync on startup
  useEffect(() => {
    if (hasCheckedStartup.current) return;
    hasCheckedStartup.current = true;

    // Delay the check slightly to not block app startup
    const timer = setTimeout(() => {
      checkForRemoteSync();
    }, 1500);

    return () => clearTimeout(timer);
  }, [checkForRemoteSync]);

  // Setup window close listener for sync on close
  useEffect(() => {
    if (closeListenerSetup.current) return;
    closeListenerSetup.current = true;

    const setupCloseListener = async () => {
      try {
        const window = getCurrentWindow();
        
        // Listen for close request
        const unlisten = await window.onCloseRequested(async (event) => {
          // Check if sync on close is enabled
          let syncOnCloseEnabled = false;
          try {
            syncOnCloseEnabled = await invoke<boolean>('is_sync_on_close_enabled');
          } catch {
            // If we can't check, don't sync
          }

          if (syncOnCloseEnabled) {
            // Prevent the close temporarily
            event.preventDefault();
            
            try {
              // Try to export (without passwords for password-protected vaults)
              // Users should have unlocked vaults during their session if they want them synced
              await invoke('sync_export_vaults', { passwords: {} });
            } catch (error) {
              console.error('Sync on close failed:', error);
              // Don't block the close even if sync fails
            }

            // Now actually close the window
            await window.close();
          }
          // If sync on close is not enabled, the window will close normally
        });

        // Store unlisten function for cleanup
        return unlisten;
      } catch (error) {
        console.error('Failed to setup close listener:', error);
      }
    };

    let unlisten: (() => void) | undefined;
    setupCloseListener().then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  return {
    checkForRemoteSync,
    triggerExport,
    syncStatus,
    isChecking,
    isSyncing,
    pendingSync,
    dismissPendingSync,
  };
}

export default useSyncManager;
