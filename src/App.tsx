import { useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import Sidebar from './components/Sidebar/Sidebar';
import CaptureModal from './components/CaptureModal/CaptureModal';
import Settings from './components/Settings/Settings';
import CreateVaultModal from './components/CreateVaultModal/CreateVaultModal';
import BrainyChat from './components/BrainyChat';
import Library from './components/Library/Library';
import { useVaultPassword } from './contexts/VaultPasswordContext';
import { useToast } from './contexts/ToastContext';
import { aiService } from './utils/ai/service';
import { isTauriRuntime } from './utils/tauriRuntime';
import { listE2EVaults } from './utils/e2eFixtures';
import {
  BackendVault,
  BackendVaultItem,
  CaptureData,
  CaptureFromProtocolPayload,
  ProtocolCapture,
  Vault,
} from './types';
import styles from './App.module.css';

type AppView = 'library' | 'brainy' | 'settings';

type FolderSyncResult = {
  state: string;
  data_changed: boolean;
  vaults_needing_password: Array<{ uuid: string; name: string }>;
};

type FolderSyncStatus = { state: string };

const transformVault = (vault: BackendVault): Vault => ({
  id: String(vault.id),
  uuid: vault.uuid || undefined,
  title: vault.name || '',
  has_password: vault.has_password,
  created_at: vault.created_at,
  updated_at: vault.updated_at,
});

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function App() {
  const { getVaultKey, getVaultPasswords, setVaultPassword } = useVaultPassword();
  const { showError, showSuccess } = useToast();
  const [currentView, setCurrentView] = useState<AppView>('library');
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [isLoadingVaults, setIsLoadingVaults] = useState(true);
  const [selectedVaultId, setSelectedVaultId] = useState('all');
  const [isCaptureOpen, setIsCaptureOpen] = useState(false);
  const [isCreateVaultOpen, setIsCreateVaultOpen] = useState(false);
  const [protocolCapture, setProtocolCapture] = useState<ProtocolCapture | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<string | null>(null);
  const [isBrainyOpen, setIsBrainyOpen] = useState(false);
  const [brainyMode, setBrainyMode] = useState<'sidebar' | 'full'>(aiService.getBrainyMode());
  const [libraryRefreshToken, setLibraryRefreshToken] = useState(0);
  // ponytail: jobs survive in-app navigation, not restarts; move them to Rust if restart recovery becomes necessary.
  const [summarizingItemIds, setSummarizingItemIds] = useState<Set<string>>(() => new Set());
  const inboxCreationRef = useRef<Promise<Vault> | null>(null);
  const folderSyncInFlightRef = useRef(false);

  const fetchVaults = async () => {
    setIsLoadingVaults(true);
    try {
      const result = isTauriRuntime()
        ? await invoke<BackendVault[]>('list_vaults')
        : listE2EVaults();
      const nextVaults = result.map(transformVault);
      setVaults(nextVaults);
      return nextVaults;
    } catch (error) {
      console.error('Failed to fetch vaults:', error);
      showError('Failed to fetch vaults.');
      return null;
    } finally {
      setIsLoadingVaults(false);
    }
  };

  const createVault = async (name: string, password: string, hasPassword?: boolean) => {
    const result = await invoke<BackendVault>('create_vault', {
      name,
      password,
      hasPassword,
    });
    const vault = transformVault(result);
    await setVaultPassword(vault.id, password || '');
    setVaults((current) => current.some(({ id }) => id === vault.id) ? current : [...current, vault]);
    await emit('vaults-changed');
    return vault;
  };

  const openCapture = async (capture: ProtocolCapture | null = null) => {
    setProtocolCapture(capture);
    const availableVaults = isLoadingVaults ? await fetchVaults() : vaults;
    if (availableVaults === null) {
      setProtocolCapture(null);
      return;
    }

    if (availableVaults.length === 0) {
      try {
        if (!inboxCreationRef.current) {
          inboxCreationRef.current = createVault('Inbox', '', false)
            .finally(() => { inboxCreationRef.current = null; });
        }
        const inbox = await inboxCreationRef.current;
        setSelectedVaultId(inbox.id);
      } catch (error) {
        console.error('Failed to create Inbox:', error);
        showError(`Failed to create Inbox: ${errorMessage(error)}`);
        setProtocolCapture(null);
        return;
      }
    }

    setIsCaptureOpen(true);
  };

  const handleCaptureSave = async (capture: CaptureData) => {
    if (!capture.vaultId) {
      showError('Choose a vault before saving.');
      return;
    }

    try {
      const vault = vaults.find((candidate) => candidate.id === capture.vaultId);
      const key = await getVaultKey(capture.vaultId, vault?.title, vault?.has_password);
      await invoke<BackendVaultItem>('add_vault_item', {
        vaultId: Number(capture.vaultId),
        title: capture.title,
        content: capture.content,
        metadata: /^https?:\/\/[^\s]+$/.test(capture.content.trim())
          ? { item_type: 'url', url: capture.content.trim() }
          : {},
        key,
      });
      await emit('items-changed', { type: 'create', vaultId: capture.vaultId });
      setLibraryRefreshToken((token) => token + 1);
      showSuccess(`Saved "${capture.title}".`);
    } catch (error) {
      console.error('Failed to save item:', error);
      showError('Failed to save item.');
    }
  };

  const handleCreateVault = async ({
    name,
    password,
    has_password,
  }: {
    name: string;
    password: string;
    has_password?: boolean;
  }) => {
    try {
      await createVault(name, password, has_password);
    } catch (error) {
      showError(`Failed to create vault: ${errorMessage(error)}`);
    }
  };

  const navigate = (view: AppView) => {
    setCurrentView(view);
    if (view !== 'brainy') setIsBrainyOpen(false);
  };

  const openBrainy = () => {
    if (brainyMode === 'full') {
      setCurrentView('brainy');
      return;
    }
    setIsBrainyOpen((open) => !open);
  };

  useEffect(() => {
    fetchVaults();
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const unlisteners: Array<() => void> = [];

    const runFolderSync = async () => {
      if (cancelled || folderSyncInFlightRef.current) return;
      folderSyncInFlightRef.current = true;
      try {
        const status = await invoke<FolderSyncStatus>('get_folder_sync_status');
        if (!['changes_waiting', 'up_to_date'].includes(status.state)) return;
        const backendVaults = await invoke<BackendVault[]>('list_vaults');
        const cached = getVaultPasswords();
        const passwordsByVaultUuid: Record<string, string> = {};
        for (const vault of backendVaults) {
          const password = cached.get(String(vault.id));
          if (vault.uuid && password !== undefined) passwordsByVaultUuid[vault.uuid] = password;
        }
        const result = await invoke<FolderSyncResult>('run_folder_sync', { passwordsByVaultUuid });
        window.dispatchEvent(new CustomEvent('brainbox:folder-sync-result', { detail: result }));
        if (result.data_changed) {
          await fetchVaults();
          setLibraryRefreshToken((token) => token + 1);
          await Promise.all([
            emit('vaults-changed'),
            emit('items-changed', { type: 'sync' }),
          ]);
        }
      } catch (error) {
        console.warn('Folder sync paused:', error);
      } finally {
        folderSyncInFlightRef.current = false;
      }
    };

    const scheduleFolderSync = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void runFolderSync(); }, 2000);
    };
    const startupTimer = setTimeout(() => { void runFolderSync(); }, 1200);
    const interval = setInterval(() => { void runFolderSync(); }, 30_000);
    window.addEventListener('focus', runFolderSync);
    window.addEventListener('brainbox:data-changed', scheduleFolderSync);
    const rememberUnlisten = (unlisten: () => void) => {
      if (cancelled) unlisten();
      else unlisteners.push(unlisten);
    };
    listen('items-changed', scheduleFolderSync).then(rememberUnlisten);
    listen('vaults-changed', scheduleFolderSync).then(rememberUnlisten);

    return () => {
      cancelled = true;
      clearTimeout(startupTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(interval);
      window.removeEventListener('focus', runFolderSync);
      window.removeEventListener('brainbox:data-changed', scheduleFolderSync);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [getVaultPasswords]);

  useEffect(() => {
    const handler = (event: Event) => {
      const mode = (event as CustomEvent).detail as 'sidebar' | 'full' | undefined;
      setBrainyMode(mode || aiService.getBrainyMode());
    };
    window.addEventListener('brainy-mode-changed', handler);
    return () => window.removeEventListener('brainy-mode-changed', handler);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlisteners: Array<() => void> = [];

    listen('capture-hotkey-pressed', () => openCapture()).then((unlisten) => unlisteners.push(unlisten));
    listen('vaults-changed', fetchVaults).then((unlisten) => unlisteners.push(unlisten));
    listen<CaptureFromProtocolPayload>('capture-from-protocol', ({ payload }) => {
      openCapture({ title: payload?.title || '', url: payload?.url || '', selection: payload?.selection || '' });
    }).then((unlisten) => unlisteners.push(unlisten));
    listen<string>('tauri://protocol', ({ payload }) => {
      if (!payload?.startsWith('brainbox://capture?')) return;
      const params = new URLSearchParams(payload.split('?')[1]);
      openCapture({ title: params.get('title') || '', url: params.get('url') || '' });
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => unlisteners.forEach((unlisten) => unlisten());
  }, [vaults]);

  const vaultProps = vaults.map(({ id, title, has_password }) => ({ id, title, has_password }));
  const title = currentView === 'settings' ? 'Settings' : currentView === 'brainy' ? 'brainy' : 'Library';

  return (
    <>
      <div className={styles.app} data-testid="app">
        <Sidebar
          title={title}
          backgroundJobCount={summarizingItemIds.size}
          currentView={currentView}
          onLibraryClick={() => navigate('library')}
          onSettingsClick={() => navigate('settings')}
          onCreateNote={() => { void openCapture(); }}
        />

        <div className={styles.workspaceBody}>
          <main className={styles.main} data-testid="main-content">
            <div className={`${styles.content} ${currentView === 'library' ? styles.libraryContent : ''}`}>
              {currentView === 'settings' ? (
                <Settings
                  scrollToSection={settingsTarget}
                  onScrollComplete={() => setSettingsTarget(null)}
                  onSyncDataChange={() => {
                    fetchVaults();
                    setLibraryRefreshToken((token) => token + 1);
                  }}
                />
              ) : currentView === 'brainy' ? (
                <div className={styles.brainyFullPage}>
                  <BrainyChat
                    vaults={vaultProps}
                    currentVaultId={selectedVaultId === 'all' ? undefined : selectedVaultId}
                    variant="page"
                    onClose={() => navigate('library')}
                    onOpenSettings={() => {
                      setSettingsTarget('ai-settings');
                      navigate('settings');
                    }}
                    onDataChange={() => {
                      fetchVaults();
                      setLibraryRefreshToken((token) => token + 1);
                      window.dispatchEvent(new Event('brainbox:data-changed'));
                    }}
                  />
                </div>
              ) : (
                <Library
                  vaults={vaultProps}
                  loadingVaults={isLoadingVaults}
                  selectedVaultId={selectedVaultId}
                  onVaultChange={setSelectedVaultId}
                  onCreateNote={() => { void openCapture(); }}
                  onCreateVault={() => setIsCreateVaultOpen(true)}
                  onOpenBrainy={openBrainy}
                  brainyOpen={isBrainyOpen && brainyMode === 'sidebar'}
                  onCloseBrainy={() => setIsBrainyOpen(false)}
                  brainyPanel={(
                    <BrainyChat
                      vaults={vaultProps}
                      currentVaultId={selectedVaultId === 'all' ? undefined : selectedVaultId}
                      onClose={() => setIsBrainyOpen(false)}
                      onOpenSettings={() => {
                        setSettingsTarget('ai-settings');
                        navigate('settings');
                      }}
                      onDataChange={() => {
                        fetchVaults();
                        setLibraryRefreshToken((token) => token + 1);
                        window.dispatchEvent(new Event('brainbox:data-changed'));
                      }}
                    />
                  )}
                  summarizingItemIds={summarizingItemIds}
                  onSummarizingChange={(id, busy) => setSummarizingItemIds((current) => {
                    const next = new Set(current);
                    busy ? next.add(id) : next.delete(id);
                    return next;
                  })}
                  refreshToken={libraryRefreshToken}
                />
              )}
            </div>
          </main>
        </div>
      </div>

      <CreateVaultModal
        isOpen={isCreateVaultOpen}
        onClose={() => setIsCreateVaultOpen(false)}
        onCreate={handleCreateVault}
      />
      <CaptureModal
        isOpen={isCaptureOpen}
        onClose={() => {
          setIsCaptureOpen(false);
          setProtocolCapture(null);
        }}
        onSave={handleCaptureSave}
        vaults={vaultProps}
        initialVaultId={selectedVaultId === 'all' ? '' : selectedVaultId}
        initialTitle={protocolCapture?.title || ''}
        initialContent={protocolCapture?.selection
          ? `${protocolCapture.selection}${protocolCapture.url ? `\n\nSource: ${protocolCapture.url}` : ''}`
          : protocolCapture?.url || ''}
      />
    </>
  );
}

export default App;
