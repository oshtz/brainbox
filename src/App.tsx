// Import brainbox components
import Button from './components/Button/Button';
import Sidebar from './components/Sidebar/Sidebar';
import Header from './components/Header/Header';
import VaultCard from './components/VaultCard/VaultCard';
import CaptureModal from './components/CaptureModal/CaptureModal';
import SearchBar from './components/SearchBar/SearchBar';
import Settings from './components/Settings/Settings';
import CreateVaultModal from './components/CreateVaultModal/CreateVaultModal';
import BrainyChat from './components/BrainyChat';
import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import Masonry from './components/Masonry/Masonry.tsx';
import { meshGradientForId, generateMeshGradientDataURL } from './utils/meshGradient';
import ItemPanel from './components/ItemPanel/ItemPanel';
import { getYouTubeId, youtubeThumbnailUrl } from './utils/urlPreview';
import { deriveKeyFromPassword, keyToArray } from './utils/crypto';
import { aiService } from './utils/ai/service';
import {
  Vault,
  VaultItem,
  CaptureData,
  ProtocolCapture,
  SearchResult,
  AppView,
  BackendVault,
  BackendVaultItem,
  BackendUrlMetadata,
  BackendSearchResult,
  ItemMetadata,
  CaptureFromProtocolPayload
} from './types';

import styles from './App.module.css';
import Titlebar from './components/Titlebar/Titlebar';
import Library from './components/Library/Library';
import Connections from './components/Connections/Connections';
import ChangeCoverDialog from './components/ChangeCoverDialog/ChangeCoverDialog.jsx';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { useVaultPassword } from './contexts/VaultPasswordContext';
import { useToast } from './contexts/ToastContext';
import { useConfirm } from './contexts/ConfirmContext';
import { usePrompt } from './contexts/PromptContext';
import { useSyncManager } from './utils/useSyncManager';

const getErrorMessage = (err: unknown): string => {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
};

// Transform backend vault item to frontend VaultItem
const transformBackendItem = (item: BackendVaultItem): VaultItem => {
  const rawContent = typeof item.content === 'string' ? item.content : '';
  const isUrl = /^https?:\/\/[^\s]+$/.test(rawContent.trim());
  const meta: ItemMetadata = {
    item_type: isUrl ? 'url' : 'note',
    url: isUrl ? rawContent : undefined,
    created_at: item.created_at,
    updated_at: item.updated_at,
    ...(item.metadata as Partial<ItemMetadata> || {}),
  };

  let cover = item.image ?? undefined;
  if (!cover && isUrl) {
    const yt = getYouTubeId(rawContent);
    if (yt) {
      cover = youtubeThumbnailUrl(yt, 'hq');
      meta.provider = 'youtube';
    }
  }

  return {
    id: item.id?.toString() || '',
    vault_id: item.vault_id?.toString(),
    title: item.title,
    content: rawContent,
    createdAt: new Date(item.created_at),
    updatedAt: new Date(item.updated_at),
    image: cover || meshGradientForId(item.id ?? Math.random(), 640, 420),
    summary: item.summary ?? undefined,
    height: 260,
    metadata: meta,
  };
};

function App() {
  // Vault password management
  const { getVaultKey, setVaultPassword, clearKey } = useVaultPassword();
  const { showSuccess, showError, showInfo, showWarning } = useToast();
  const confirmDialog = useConfirm();
  const promptDialog = usePrompt();

  // Sync manager for startup check and sync on close
  useSyncManager({
    onSyncAvailable: (preview) => {
      // Show a persistent info toast about available sync
      showInfo(
        `Sync available from ${preview.device_name}: ${preview.vault_count} vaults, ${preview.item_count} items. Go to Settings > Sync to import.`,
        'Sync Available'
      );
    },
    onSyncError: (error) => {
      console.error('Sync check error:', error);
    },
    showToast: (type, message) => {
      if (type === 'success') showSuccess(message);
      else if (type === 'error') showError(message);
      else if (type === 'warning') showWarning(message);
      else showInfo(message);
    },
  });

  // State for the capture modal
  const [isCaptureModalOpen, setIsCaptureModalOpen] = useState<boolean>(false);
  // State for the create vault modal
  const [isCreateVaultModalOpen, setIsCreateVaultModalOpen] = useState<boolean>(false);
  // Current view state (vaults or search)
  const [currentView, setCurrentView] = useState<AppView>('vaults');
  // Search query state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [pendingOpenItemId, setPendingOpenItemId] = useState<string | null>(null);
  const [searchSelectedItem, setSearchSelectedItem] = useState<VaultItem | null>(null);
  const [searchCards, setSearchCards] = useState<SearchResult[]>([]);
  // Vaults state
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [isLoadingVaults, setIsLoadingVaults] = useState<boolean>(false);
  // Add selectedVaultId state
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);

  // Add state for vault items and selected item for slide-in panel
  const [vaultItems, setVaultItems] = useState<VaultItem[]>([]);
  const [isLoadingVaultItems, setIsLoadingVaultItems] = useState<boolean>(false);
  const [selectedItem, setSelectedItem] = useState<VaultItem | null>(null);
  // When item panel is generating summary, lock selecting other items
  const [isItemBusy, setIsItemBusy] = useState<boolean>(false);

  // Add state for protocol capture
  const [protocolCapture, setProtocolCapture] = useState<ProtocolCapture | null>(null);
  // State for change cover dialog
  const [coverVault, setCoverVault] = useState<{ id: string; title: string } | null>(null);
  // State for change password dialog
  const [changePasswordVault, setChangePasswordVault] = useState<{ id: number; name: string; has_password?: boolean } | null>(null);
  // State for settings scroll target (e.g., 'ai-settings')
  const [settingsScrollTarget, setSettingsScrollTarget] = useState<string | null>(null);
  // State for brainy chat panel
  const [isBrainyChatOpen, setIsBrainyChatOpen] = useState<boolean>(false);
  const [brainyMode, setBrainyMode] = useState<'sidebar' | 'full'>(aiService.getBrainyMode());
  // State for conflict filter in vault view
  const [showConflictsOnly, setShowConflictsOnly] = useState<boolean>(false);
  const skeletonCards = Array.from({ length: 8 }, (_, i) => i);
  const isDetailOpen = Boolean(selectedItem || searchSelectedItem);

  // Compute conflict count and filtered items
  const conflictItems = vaultItems.filter(item => item.title?.includes('[Conflict]'));
  const hasConflicts = conflictItems.length > 0;
  const displayedVaultItems = showConflictsOnly ? conflictItems : vaultItems;

  // Change cover handlers
  const handleCoverFromUrl = async (vaultId: string, url: string) => {
    try {
      await invoke('update_vault_cover', { vaultId: Number(vaultId), coverImage: url });
      await fetchVaults();
      try { emit('vaults-changed'); } catch {}
    } catch (e) {
      console.error(e);
      showError('Failed to update cover image.');
    }
  };
  const handleCoverMesh = async (vaultId: string) => {
    try {
      const dataUrl = generateMeshGradientDataURL({ seed: `${vaultId}-${Date.now()}`, width: 640, height: 420 });
      await invoke('update_vault_cover', { vaultId: Number(vaultId), coverImage: dataUrl });
      await fetchVaults();
      try { emit('vaults-changed'); } catch {}
    } catch (e) {
      console.error(e);
      showError('Failed to update cover image.');
    }
  };
  const handleCoverFromFile = async (vaultId: string, dataUrl: string) => {
    try {
      await invoke('update_vault_cover', { vaultId: Number(vaultId), coverImage: dataUrl });
      await fetchVaults();
      try { emit('vaults-changed'); } catch {}
    } catch (e) {
      console.error(e);
      showError('Failed to update cover image.');
    }
  };
  const handleCoverClear = async (vaultId: string) => {
    try {
      await invoke('update_vault_cover', { vaultId: Number(vaultId), coverImage: null });
      await fetchVaults();
      try { emit('vaults-changed'); } catch {}
    } catch (e) {
      console.error(e);
      showError('Failed to clear cover image.');
    }
  };

  // Fetch vaults from backend
  const fetchVaults = async () => {
    setIsLoadingVaults(true);
    try {
      const result = await invoke<BackendVault[]>('list_vaults');
      // Map backend vaults to UI vault objects
      setVaults(
        result.map((v) => {
          const idStr = v.id?.toString() || '';
          return {
            id: idStr,
            title: v.name || '',
            backgroundImage: v.cover_image || meshGradientForId(idStr, 640, 420),
            has_password: v.has_password,
          };
        })
      );
    } catch (err) {
      console.error('Failed to fetch vaults:', err);
      showError('Failed to fetch vaults.');
    } finally {
      setIsLoadingVaults(false);
    }
  };

  // (file picker helper removed; handled by ChangeCoverDialog component)

  // (legacy change cover flow removed)

  // Fetch vault items when a vault is selected
  useEffect(() => {
    if (!selectedVaultId) {
      setVaultItems([]);
      return;
    }

    // Abort flag to prevent stale effect runs from updating state (React 18 StrictMode)
    let cancelled = false;

    setIsLoadingVaultItems(true);

    // Get vault info for password handling
    const vault = vaults.find(v => v.id === selectedVaultId);
    const vaultName = vault?.title;
    const hasPassword = vault?.has_password;

    getVaultKey(selectedVaultId, vaultName, hasPassword)
      .then(key => invoke<BackendVaultItem[]>('list_vault_items', { vaultId: Number(selectedVaultId), key }))
      .then((result) => {
        if (cancelled) return;
        setVaultItems(result.map(transformBackendItem));

        // Prefetch URL metadata for non-YouTube links to enrich previews
        const urlItems = result.filter((item) => {
          const rawContent = typeof item.content === 'string' ? item.content : '';
          const isUrl = /^https?:\/\/[^\s]+$/.test(rawContent.trim());
          const yt = isUrl ? getYouTubeId(rawContent) : null;
          return isUrl && !yt;
        });
        urlItems.forEach(async (it) => {
          if (cancelled) return;
          const url = typeof it.content === 'string' ? it.content : '';
          try {
            const meta = await invoke<BackendUrlMetadata>('fetch_url_metadata', { url });
            if (cancelled) return;
            setVaultItems(prev => prev.map(p => {
              if (String(p.id) !== String(it.id)) return p;
              return {
                ...p,
                metadata: {
                  ...p.metadata,
                  preview_title: meta?.title,
                  preview_description: meta?.description,
                  preview_image: meta?.image,
                },
              };
            }));
          } catch (_) {}
        });

        // If we navigated here to open a specific item, select it now
        if (pendingOpenItemId) {
          const found = result.find((r) => String(r.id) === String(pendingOpenItemId));
          if (found) {
            setSelectedItem(transformBackendItem(found));
            setPendingOpenItemId(null);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = getErrorMessage(err);
        if (/password is required/i.test(message)) {
          setVaultItems([]);
          setSelectedVaultId(null);
          return;
        }
        if (/invalid password/i.test(message) || /decryption failed/i.test(message)) {
          if (selectedVaultId) {
            clearKey(selectedVaultId);
          }
          setVaultItems([]);
          setSelectedVaultId(null);
          showError(`Incorrect password for "${vaultName || 'this vault'}".`);
          return;
        }
        setVaultItems([]);
        console.error('Failed to fetch vault items:', err);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingVaultItems(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedVaultId, vaults, getVaultKey, clearKey, showError]);

  // Function to handle saving captured content
  const handleCaptureSave = async (captureData: CaptureData) => {
    try {
      // Check content field for URLs
      const isUrl = typeof captureData.content === 'string' &&
                   /^https?:\/\/[^\s]+$/.test(captureData.content.trim());

      // Get vault info for password handling
      const vault = vaults.find(v => v.id === captureData.vaultId);
      const key = await getVaultKey(captureData.vaultId, vault?.title, vault?.has_password);

      const result = await invoke<BackendVaultItem>('add_vault_item', {
        vaultId: Number(captureData.vaultId),
        title: captureData.title,
        content: captureData.content,
        metadata: isUrl ? {
          item_type: 'url',
          url: captureData.content
        } : {},
        key,
      });

      // Index for search
      import('./utils/searchIndexer').then(({ addToIndex }) => {
        addToIndex({
          id: result.id?.toString() || undefined,
          title: result.title,
          content: captureData.content,
          itemType: isUrl ? 'url' : 'note',
          createdAt: new Date(result.created_at),
          updatedAt: new Date(result.updated_at),
          path: undefined,
          tags: [],
        });
      });

      // Refresh vault items if we're viewing the target vault
      if (selectedVaultId === captureData.vaultId) {
        setVaultItems([]);
        setIsLoadingVaultItems(true);
        invoke<BackendVaultItem[]>('list_vault_items', { vaultId: Number(selectedVaultId), key })
          .then((items) => {
            setVaultItems(items.map(transformBackendItem));

            // Prefetch metadata for non-YouTube URLs
            const urlItems = items.filter((item) => {
              const rawContent = typeof item.content === 'string' ? item.content : '';
              const isUrlContent = /^https?:\/\/[^\s]+$/.test(rawContent.trim());
              const yt = isUrlContent ? getYouTubeId(rawContent) : null;
              return isUrlContent && !yt;
            });
            urlItems.forEach(async (it) => {
              const url = typeof it.content === 'string' ? it.content : '';
              try {
                const meta = await invoke<BackendUrlMetadata>('fetch_url_metadata', { url });
                setVaultItems(prev => prev.map(p => {
                  if (String(p.id) !== String(it.id)) return p;
                  return {
                    ...p,
                    metadata: {
                      ...p.metadata,
                      preview_title: meta?.title,
                      preview_description: meta?.description,
                      preview_image: meta?.image,
                    },
                  };
                }));
              } catch (_) {}
            });
          })
          .finally(() => setIsLoadingVaultItems(false));
      }
      try { emit('items-changed', { type: 'create', vaultId: String(captureData.vaultId) }); } catch {}
      showSuccess(`Saved "${captureData.title}" to vault.`);
    } catch (err) {
      console.error('Failed to save item:', err);
      showError('Failed to save item.');
    }
  };

  // Function to handle search
  const handleSearch = (query: string) => {
    setSearchQuery(query);
    setIsSearching(true);
    invoke<BackendSearchResult[]>('search', { query, limit: 50 })
      .then((results) => {
        setSearchSelectedItem(null);
        setSearchCards([]);
        // Build cards for results by fetching full items
        Promise.all((results || []).map(async (r) => {
          try {
            // Get vault key (items from different vaults may appear in search)
            const vault = vaults.find(v => v.id === String(r.vault_id));
            const key = await getVaultKey(String(r.vault_id || r.id), vault?.title, vault?.has_password);
            const it = await invoke<BackendVaultItem>('get_vault_item', { itemId: Number(r.id), key });
            const transformed = transformBackendItem(it);
            const card: SearchResult = {
              ...transformed,
              vault_id: String(it.vault_id),
              height: 260,
            };
            // Enrich metadata for non-YouTube URLs
            const rawContent = typeof it.content === 'string' ? it.content : '';
            const isUrl = /^https?:\/\/[^\s]+$/.test(rawContent.trim());
            const yt = isUrl ? getYouTubeId(rawContent) : null;
            if (isUrl && !yt) {
              try {
                const m = await invoke<BackendUrlMetadata>('fetch_url_metadata', { url: rawContent });
                card.metadata.preview_title = m?.title;
                card.metadata.preview_description = m?.description;
                card.metadata.preview_image = m?.image;
              } catch {}
            }
            return card;
          } catch {
            return null;
          }
        })).then((cards) => {
          setSearchCards(cards.filter((c): c is SearchResult => c !== null));
        });
      })
      .catch((err) => {
        console.error('Search failed', err);
        setSearchCards([]);
      })
      .finally(() => setIsSearching(false));
  };

  // Handle navigation between views
  const handleNavigation = (view: AppView | undefined) => {
    setCurrentView(view ?? 'vaults');
    // Reset search when navigating to vaults
    if (view === 'vaults' || view === undefined) {
      setSearchQuery('');
    }
  };

  useEffect(() => {
    // Listen for the global shortcut event from backend
    let unlisten: (() => void) | undefined;
    listen('capture-hotkey-pressed', () => {
      setIsCaptureModalOpen(true);
    }).then((fn: () => void) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    fetchVaults();
    
    // Check for updates on app startup (silent check)
    const checkForUpdatesOnStartup = async () => {
      try {
        const result = await invoke('check_for_updates');
        if (result) {
          // Update available - users can check manually in settings
        }
      } catch (e) {
        // Silent failure - don't bother the user on startup
      }
    };
    
    // Check for updates after a short delay to not block app startup
    setTimeout(checkForUpdatesOnStartup, 3000);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as 'sidebar' | 'full' | undefined;
      setBrainyMode(detail || aiService.getBrainyMode());
    };
    window.addEventListener('brainy-mode-changed', handler);
    return () => window.removeEventListener('brainy-mode-changed', handler);
  }, []);

  useEffect(() => {
    if (brainyMode === 'full' && isBrainyChatOpen) {
      setIsBrainyChatOpen(false);
    }
  }, [brainyMode, isBrainyChatOpen]);

  // Refresh vault list when other parts of the app change vaults
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('vaults-changed', () => {
      fetchVaults();
    }).then((fn: () => void) => {
      unlisten = fn;
    });
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Listen for protocol events from Tauri (now using capture-from-protocol event)
  useEffect(() => {
    let unlistenCapture: (() => void) | undefined;
    let unlistenProtocol: (() => void) | undefined;

    // Existing: Listen for backend event
    listen<CaptureFromProtocolPayload>('capture-from-protocol', (event) => {
      if (event?.payload && typeof event.payload === 'object') {
        setProtocolCapture({
          title: event.payload.title || '',
          url: event.payload.url || '',
        });
        setIsCaptureModalOpen(true);
      }
    }).then((fn) => {
      unlistenCapture = fn;
    });

    // NEW: Listen for tauri://protocol event (when app is already running)
    listen<string>('tauri://protocol', (event) => {
      const url = event.payload;
      if (url && url.startsWith('brainbox://capture?')) {
        // Parse query params from the URL
        const params = new URLSearchParams(url.split('?')[1]);
        setProtocolCapture({
          title: params.get('title') || '',
          url: params.get('url') || '',
        });
        setIsCaptureModalOpen(true);
      }
    }).then((fn) => {
      unlistenProtocol = fn;
    });

    return () => {
      if (unlistenCapture) unlistenCapture();
      if (unlistenProtocol) unlistenProtocol();
    };
  }, []);

  // Helper to fetch items for the currently selected vault
  const fetchItemsForSelectedVault = async () => {
    if (!selectedVaultId) {
      setVaultItems([]);
      return;
    }
    setIsLoadingVaultItems(true);

    try {
      // Get vault info for password handling
      const vault = vaults.find(v => v.id === selectedVaultId);
      const key = await getVaultKey(selectedVaultId, vault?.title, vault?.has_password);
      const result = await invoke<BackendVaultItem[]>('list_vault_items', { vaultId: Number(selectedVaultId), key });

      setVaultItems(result.map(transformBackendItem));

      const urlItems = result.filter((item) => {
        const rawContent = typeof item.content === 'string' ? item.content : '';
        const isUrl = /^https?:\/\/[^\s]+$/.test(rawContent.trim());
        const yt = isUrl ? getYouTubeId(rawContent) : null;
        return isUrl && !yt;
      });

      urlItems.forEach(async (it) => {
        const url = typeof it.content === 'string' ? it.content : '';
        try {
          const meta = await invoke<BackendUrlMetadata>('fetch_url_metadata', { url });
          setVaultItems(prev => prev.map(p => {
            if (String(p.id) !== String(it.id)) return p;
            return {
              ...p,
              metadata: {
                ...p.metadata,
                preview_title: meta?.title,
                preview_description: meta?.description,
                preview_image: meta?.image,
              },
            };
          }));
        } catch (_) {}
      });
    } catch (err) {
      setVaultItems([]);
      console.error('Failed to fetch vault items:', err);
    } finally {
      setIsLoadingVaultItems(false);
    }
  };

  // Listen for global item changes (e.g., brainy actions) and refresh current vault items
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('items-changed', () => {
      fetchItemsForSelectedVault();
    }).then((fn: () => void) => {
      unlisten = fn;
    });
    return () => { if (unlisten) unlisten(); };
  }, [selectedVaultId]);

  return (
    <>
      <Titlebar />
      <div className={`${styles.app} ${isDetailOpen ? styles.appNudged : ''}`} data-testid="app">
      <Sidebar
        onCaptureClick={() => setIsCaptureModalOpen(true)}
        onExploreClick={() => handleNavigation('search')}
        onKnowledgeClick={handleNavigation}
        onSettingsClick={() => handleNavigation('settings')}
        onBrainyClick={() => setIsBrainyChatOpen(v => !v)}
        currentView={currentView}
        isBrainyOpen={isBrainyChatOpen}
        brainyMode={brainyMode}
      />

      <main className={styles.main} data-testid="main-content">
        <Header
          title={
            currentView === 'vaults' && selectedVaultId
              ? vaults.find(v => v.id === selectedVaultId)?.title || 'Vault'
              : currentView === 'vaults' ? "Knowledge" :
                currentView === 'search' ? "Explore Knowledge" :
                currentView === 'library' ? "Library" :
                currentView === 'connections' ? "Connections" :
                "Settings"
          }
          onCreateNote={() => setIsCaptureModalOpen(true)}
          onCreateVault={() => setIsCreateVaultModalOpen(true)}
          showVaultButton={currentView === 'vaults' && !selectedVaultId}
        />
        
        <div className={styles.content}>
          {currentView === 'settings' ? (
            <Settings scrollToSection={settingsScrollTarget} onScrollComplete={() => setSettingsScrollTarget(null)} />
          ) : currentView === 'search' ? (
            <div className={styles.searchContainer} data-testid="search-section">
              <SearchBar onSearch={handleSearch} />
              
              {searchQuery && (
                <div className={styles.searchResults} data-testid="search-results">
                  <h2 className={styles.searchResultsTitle}>
                    Results for "{searchQuery}"
                  </h2>
                  {isSearching ? (
                    <div className={styles.skeletonGrid} aria-busy="true">
                      {skeletonCards.map((key) => (
                        <div key={`search-skel-${key}`} className={styles.skeletonCard} />
                      ))}
                    </div>
                  ) : searchCards.length === 0 ? (
                    <div className={styles.emptyState}>
                      <h3 className={styles.emptyStateTitle}>No results yet</h3>
                      <p className={styles.emptyStateBody}>Try a different keyword, or search by a shorter phrase.</p>
                    </div>
                  ) : (
                    <div style={{ marginTop: 8 }}>
                      <Masonry
                        data={searchCards.map(card => ({
                          ...card,
                          image: card.image || '',
                          height: card.height || 260
                        }))}
                        alwaysShowOverlay
                        actionsMode="menu"
                        selectedId={searchSelectedItem?.id}
                        onCardClick={(item) => {
                          if (isItemBusy && searchSelectedItem) { return; }
                          const searchItem = searchCards.find(c => c.id === item.id);
                          if (searchItem) setSearchSelectedItem(searchItem);
                        }}
                        onDeleteItem={async (item) => {
                          if (!item?.id) return;
                          const confirmed = await confirmDialog({
                            title: 'Delete item?',
                            message: 'This will remove the item from your vault.',
                            confirmLabel: 'Delete'
                          });
                          if (!confirmed) return;
                          try {
                            await Promise.all([
                              invoke('delete_vault_item', { itemId: Number(item.id) }),
                              invoke('delete_document', { id: String(item.id) }).catch(() => {})
                            ]);
                            setSearchCards((prev) => prev.filter(i => String(i.id) !== String(item.id)));
                            setSearchSelectedItem((cur) => cur && String(cur.id) === String(item.id) ? null : cur);
                            try { emit('items-changed', { type: 'delete', itemId: String(item.id) }); } catch {}
                            showSuccess('Item deleted.');
                          } catch (err) {
                            console.error('Failed to delete', err);
                            showError('Failed to delete item.');
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
              )}

              {searchSelectedItem && (
                <div style={{ marginTop: 16 }}>
                  <ItemPanel
                    item={searchSelectedItem}
                    currentVaultId={String(searchSelectedItem?.vault_id || '')}
                    vaults={vaults.map(v => ({ id: v.id, title: v.title, has_password: v.has_password }))}
                    onClose={() => { setSearchSelectedItem(null); setIsItemBusy(false); }}
                    onUpdateContent={async (id, content) => {
                      const urlish = /^https?:\/\/[^\s]+$/.test(String(content).trim());
                      setSearchSelectedItem((cur) => cur && cur.id === id ? { ...cur, content, metadata: { ...cur.metadata, item_type: urlish ? 'url' : 'note', url: urlish ? content : undefined } } : cur);
                      setSearchCards((prev) => prev.map(c => String(c.id) === String(id) ? { ...c, content, metadata: { ...c.metadata, item_type: urlish ? 'url' : 'note', url: urlish ? content : undefined } } : c));
                      try { emit('items-changed', { type: 'edit', itemId: String(id) }); } catch {}
                    }}
                    onUpdateSummary={async (id, summary) => {
                      setSearchSelectedItem((cur) => cur && cur.id === id ? { ...cur, summary } : cur);
                      setSearchCards((prev) => prev.map(c => String(c.id) === String(id) ? { ...c, summary } : c));
                      try { emit('items-changed', { type: 'summarize', itemId: String(id) }); } catch {}
                    }}
                    onSummarizingChange={(busy) => setIsItemBusy(busy)}
                    onRename={async (id, newTitle) => {
                      try {
                        await invoke('update_vault_item_title', { itemId: Number(id), title: newTitle });
                        setSearchSelectedItem((cur) => cur && cur.id === id ? { ...cur, title: newTitle } : cur);
                        setSearchCards((prev) => prev.map(c => String(c.id) === String(id) ? { ...c, title: newTitle } : c));
                        try { emit('items-changed', { type: 'rename', itemId: String(id) }); } catch {}
                      } catch (e) {
                        console.error(e);
                        showError('Failed to rename item.');
                      }
                    }}
                    onMove={async (id, targetVaultId) => {
                      try {
                        await invoke('move_vault_item', { itemId: Number(id), targetVaultId: Number(targetVaultId) });
                        setSearchSelectedItem((cur) => cur && cur.id === id ? { ...cur, vault_id: targetVaultId, metadata: { ...cur.metadata, vault_id: targetVaultId } } : cur);
                        try { emit('items-changed', { type: 'move', itemId: String(id), toVaultId: String(targetVaultId) }); } catch {}
                      } catch (e) {
                        console.error(e);
                        showError('Failed to move item.');
                      }
                    }}
                    onUpdateImage={async (id, image) => {
                      try {
                        await invoke('update_vault_item_image', { itemId: Number(id), image });
                        setSearchSelectedItem((cur) => cur && cur.id === id ? { ...cur, image: image ?? undefined } : cur);
                        setSearchCards((prev) => prev.map(c => String(c.id) === String(id) ? { ...c, image: image ?? undefined } : c));
                        try { emit('items-changed', { type: 'image', itemId: String(id) }); } catch {}
                      } catch (e) {
                        console.error(e);
                        showError('Failed to update image.');
                      }
                    }}
                    onDelete={async (id) => {
                      try {
                        const confirmed = await confirmDialog({
                          title: 'Delete item?',
                          message: 'This will remove the item from your vault.',
                          confirmLabel: 'Delete'
                        });
                        if (!confirmed) return;
                        await Promise.all([
                          invoke('delete_vault_item', { itemId: Number(id) }),
                          invoke('delete_document', { id: String(id) }).catch(() => {})
                        ]);
                        setSearchSelectedItem(null);
                        setSearchCards((prev) => prev.filter(c => String(c.id) !== String(id)));
                        try { emit('items-changed', { type: 'delete', itemId: String(id) }); } catch {}
                        showSuccess('Item deleted.');
                      } catch (e) {
                        console.error(e);
                        showError('Failed to delete item.');
                      }
                    }}
                  />
                </div>
              )}
            </div>
          ) : currentView === 'library' ? (
            <Library vaults={vaults.map(v => ({ id: v.id, title: v.title }))} />
          ) : currentView === 'connections' ? (
            <Connections onOpenAISettings={() => {
              setSettingsScrollTarget('ai-settings');
              setCurrentView('settings');
            }} />
          ) : currentView === 'vaults' && selectedVaultId ? (
            <section className={styles.vaults}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                <Button variant="ghost" onClick={() => { setSelectedVaultId(null); setShowConflictsOnly(false); }} aria-label="Back to vaults">
                  ← Back to vaults
                </Button>
                {hasConflicts && (
                  <Button
                    variant={showConflictsOnly ? 'secondary' : 'ghost'}
                    onClick={() => setShowConflictsOnly(!showConflictsOnly)}
                    style={{
                      background: showConflictsOnly ? 'rgba(245, 158, 11, 0.15)' : undefined,
                      border: showConflictsOnly ? '1px solid #f59e0b' : undefined,
                      color: showConflictsOnly ? '#f59e0b' : undefined,
                    }}
                  >
                    {showConflictsOnly ? 'Show All Items' : `View Conflicts (${conflictItems.length})`}
                  </Button>
                )}
              </div>
              <div style={{padding: '0 0 2rem 0'}}>
                {isLoadingVaultItems ? (
                  <div className={styles.skeletonGrid} aria-busy="true">
                    {skeletonCards.map((key) => (
                      <div key={`vault-skel-${key}`} className={styles.skeletonCard} />
                    ))}
                  </div>
                ) : displayedVaultItems.length === 0 ? (
                  <div className={styles.emptyState}>
                    <h3 className={styles.emptyStateTitle}>{showConflictsOnly ? 'No conflicts' : 'No items yet'}</h3>
                    <p className={styles.emptyStateBody}>
                      {showConflictsOnly
                        ? 'All sync conflicts have been resolved.'
                        : 'Capture a note or link to start building this vault.'}
                    </p>
                    <div className={styles.emptyStateActions}>
                      {showConflictsOnly ? (
                        <Button onClick={() => setShowConflictsOnly(false)}>Show All Items</Button>
                      ) : (
                        <Button onClick={() => setIsCaptureModalOpen(true)}>Create note</Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <Masonry
                    data={displayedVaultItems.map(item => ({
                      ...item,
                      image: item.image || '',
                      height: item.height || 260
                    }))}
                    actionsMode="menu"
                    selectedId={selectedItem?.id}
                    onCardClick={(item) => {
                      if (isItemBusy && selectedItem) { return; }
                      const vaultItem = vaultItems.find(v => v.id === item.id);
                      if (vaultItem) setSelectedItem(vaultItem);
                    }}
                    onDeleteItem={async (item) => {
                      if (!item?.id) return;
                      const confirmed = await confirmDialog({
                        title: 'Delete item?',
                        message: 'This will remove the item from your vault.',
                        confirmLabel: 'Delete'
                      });
                      if (!confirmed) return;
                      try {
                        await Promise.all([
                          invoke('delete_vault_item', { itemId: Number(item.id) }),
                          // best-effort: remove from search index if present
                          invoke('delete_document', { id: String(item.id) }).catch(() => {})
                        ]);
                        setVaultItems((prev) => prev.filter(i => i.id !== item.id));
                        if (selectedItem?.id === item.id) setSelectedItem(null);
                        try { emit('items-changed', { type: 'delete', itemId: String(item.id) }); } catch {}
                        showSuccess('Item deleted.');
                      } catch (err) {
                        console.error('Failed to delete', err);
                        showError('Failed to delete item.');
                      }
                    }}
                    onMoveItem={(item, direction) => {
                      setVaultItems((prev) => {
                        const idx = prev.findIndex(i => i.id === item.id);
                        if (idx === -1) return prev;
                        const newArr = [...prev];
                        const swapWith = direction === 'up' ? idx - 1 : idx + 1;
                        if (swapWith < 0 || swapWith >= newArr.length) return prev;
                        [newArr[idx], newArr[swapWith]] = [newArr[swapWith], newArr[idx]];
                        // Persist ordering to backend (best-effort)
                        const orderedIds = newArr.map(i => Number(i.id));
                        if (selectedVaultId) {
                          invoke('update_vault_items_order', { vaultId: Number(selectedVaultId), orderedIds })
                            .catch(err => console.warn('Failed to persist order', err));
                        }
                        return newArr;
                      });
                    }}
                  />
                )}
              </div>
              {/* Slide-in panel for item details */}
              {selectedItem && (
                  <ItemPanel
                    item={selectedItem}
                    currentVaultId={selectedVaultId!}
                    vaults={vaults.map(v => ({ id: v.id, title: v.title, has_password: v.has_password }))}
                  onClose={() => { setSelectedItem(null); setIsItemBusy(false); }}
                    onUpdateContent={async (id, content) => {
                      const urlish = /^https?:\/\/[^\s]+$/.test(String(content).trim());
                      setVaultItems((prev) => prev.map(i => i.id === id ? { ...i, content, metadata: { ...i.metadata, item_type: urlish ? 'url' : 'note', url: urlish ? content : undefined } } : i));
                      setSelectedItem((cur) => cur && cur.id === id ? { ...cur, content, metadata: { ...cur.metadata, item_type: urlish ? 'url' : 'note', url: urlish ? content : undefined } } : cur);
                      try { emit('items-changed', { type: 'edit', itemId: String(id) }); } catch {}
                    }}
                  onUpdateSummary={async (id, summary) => {
                    setVaultItems((prev) => prev.map(i => i.id === id ? { ...i, summary } : i));
                    setSelectedItem((cur) => cur && cur.id === id ? { ...cur, summary } : cur);
                    try { emit('items-changed', { type: 'summarize', itemId: String(id) }); } catch {}
                  }}
                  onSummarizingChange={(busy) => setIsItemBusy(busy)}
                  onRename={async (id, newTitle) => {
                    try {
                      await invoke('update_vault_item_title', { itemId: Number(id), title: newTitle });
                      setVaultItems((prev) => prev.map(i => i.id === id ? { ...i, title: newTitle } : i));
                      setSelectedItem((cur) => cur && cur.id === id ? { ...cur, title: newTitle } : cur);
                      try { emit('items-changed', { type: 'rename', itemId: String(id) }); } catch {}
                    } catch (e) {
                      console.error(e);
                      showError('Failed to rename item.');
                    }
                  }}
                  onMove={async (id, targetVaultId) => {
                    try {
                      await invoke('move_vault_item', { itemId: Number(id), targetVaultId: Number(targetVaultId) });
                      setVaultItems((prev) => prev.filter(i => i.id !== id));
                      setSelectedItem(null);
                      try { emit('items-changed', { type: 'move', itemId: String(id), toVaultId: String(targetVaultId) }); } catch {}
                    } catch (e) {
                      console.error(e);
                      showError('Failed to move item.');
                    }
                  }}
                  onUpdateImage={async (id, image) => {
                    try {
                      await invoke('update_vault_item_image', { itemId: Number(id), image });
                      setVaultItems((prev) => prev.map(i => i.id === id ? { ...i, image: image ?? undefined } : i));
                      setSelectedItem((cur) => cur && cur.id === id ? { ...cur, image: image ?? undefined } : cur);
                      try { emit('items-changed', { type: 'image', itemId: String(id) }); } catch {}
                    } catch (e) {
                      console.error(e);
                      showError('Failed to update image.');
                    }
                  }}
                  onDelete={async (id) => {
                    try {
                      const confirmed = await confirmDialog({
                        title: 'Delete item?',
                        message: 'This will remove the item from your vault.',
                        confirmLabel: 'Delete'
                      });
                      if (!confirmed) return;
                      await Promise.all([
                        invoke('delete_vault_item', { itemId: Number(id) }),
                        invoke('delete_document', { id: String(id) }).catch(() => {})
                      ]);
                      setVaultItems(prev => prev.filter(i => i.id !== id));
                      setSelectedItem(null);
                      try { emit('items-changed', { type: 'delete', itemId: String(id) }); } catch {}
                      showSuccess('Item deleted.');
                    } catch (e) {
                      console.error(e);
                      showError('Failed to delete item.');
                    }
                  }}
                />
              )}
            </section>
          ) : (
            <section className={styles.vaults} data-testid="vaults-section">
              {isLoadingVaults && vaults.length === 0 ? (
                <div className={styles.skeletonGrid} aria-busy="true">
                  {skeletonCards.map((key) => (
                    <div key={`vault-grid-skel-${key}`} className={styles.skeletonCard} />
                  ))}
                </div>
              ) : vaults.length === 0 ? (
                <div className={styles.emptyState}>
                  <h3 className={styles.emptyStateTitle}>Create your first vault</h3>
                  <p className={styles.emptyStateBody}>Vaults keep your notes and links organized. Start with a name and optional password.</p>
                  <div className={styles.emptyStateActions}>
                    <Button onClick={() => setIsCreateVaultModalOpen(true)}>New vault</Button>
                  </div>
                </div>
              ) : (
                <div className={styles.grid}>
                  {vaults.map(vault => (
                    <VaultCard 
                      key={vault.id}
                      title={vault.title}
                      backgroundImage={vault.backgroundImage}
                      color={vault.color}
                      priceTag={vault.priceTag}
                      onClick={() => setSelectedVaultId(vault.id)}
                    onRename={async () => {
                      const newName = await promptDialog({
                        title: 'Rename vault',
                        label: 'Vault name',
                        defaultValue: vault.title,
                        confirmLabel: 'Rename'
                      });
                      if (newName === null) return;
                      const trimmed = newName.trim();
                      if (!trimmed || trimmed === vault.title) return;
                      try {
                        await invoke('rename_vault', { vaultId: Number(vault.id), name: trimmed });
                        await fetchVaults();
                        try { emit('vaults-changed'); } catch {}
                      } catch (e) {
                          console.error(e);
                          showError('Failed to rename vault.');
                        }
                      }}
                      onChangeCover={() => setCoverVault({ id: vault.id, title: vault.title })}
                      onChangePassword={() => setChangePasswordVault({ id: Number(vault.id), name: vault.title, has_password: vault.has_password })}
                    onDelete={async () => {
                      const confirmed = await confirmDialog({
                        title: `Delete vault "${vault.title}"?`,
                        message: 'This will remove all items inside.',
                        confirmLabel: 'Delete'
                      });
                      if (!confirmed) return;
                      const password = await promptDialog({
                        title: 'Confirm vault deletion',
                        message: `Enter the password for "${vault.title}". Leave it blank if there is no password.`,
                        label: 'Vault password',
                        inputType: 'password',
                        autoComplete: 'current-password',
                        confirmLabel: 'Delete vault'
                      });
                      if (password === null) return;
                      try {
                        const keyUint8 = await deriveKeyFromPassword(password, vault.id);
                        const key = keyToArray(keyUint8);
                        await invoke('verify_vault_password', { vaultId: Number(vault.id), key });
                      } catch (err) {
                        console.error('Password verification failed', err);
                        const msg = getErrorMessage(err);
                        const allowForce = await confirmDialog({
                          title: 'Password could not be verified',
                          message: 'This vault may have been created with an older version. Delete it anyway?',
                          confirmLabel: 'Delete anyway',
                          cancelLabel: 'Cancel'
                        });
                        if (!allowForce) {
                          if (/invalid password/i.test(msg)) {
                            showError('Incorrect password.');
                          } else {
                            showError('Failed to verify vault password.');
                          }
                          return;
                        }
                      }
                      try {
                        await invoke('delete_vault', { vaultId: Number(vault.id) });
                        if (selectedVaultId === vault.id) {
                          setSelectedVaultId(null);
                        }
                          await fetchVaults();
                          try { emit('vaults-changed'); } catch {}
                          showSuccess('Vault deleted.');
                        } catch (e) {
                          console.error(e);
                          showError('Failed to delete vault.');
                        }
                      }}
                    >
                      {vault.children}
                    </VaultCard>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </main>

      {/* brainy Chat Panel */}
      {isBrainyChatOpen && brainyMode === 'sidebar' && (
        <div className={styles.brainyChatPanel}>
          <BrainyChat
            vaults={vaults.map(v => ({ id: v.id, title: v.title, has_password: v.has_password }))}
            currentVaultId={selectedVaultId || undefined}
            onClose={() => setIsBrainyChatOpen(false)}
            onOpenSettings={() => {
              setSettingsScrollTarget('ai-settings');
              setCurrentView('settings');
            }}
            onDataChange={() => {
              // Refresh data when brainy makes changes
              fetchVaults();
              if (selectedVaultId) {
                fetchItemsForSelectedVault();
              }
            }}
          />
        </div>
      )}
      {/* Create Vault Modal */}
      <CreateVaultModal
        isOpen={isCreateVaultModalOpen}
        onClose={() => setIsCreateVaultModalOpen(false)}
        onCreate={async ({ name, password, has_password }: { name: string; password: string; has_password?: boolean }) => {
          try {
            const result = await invoke<BackendVault>('create_vault', { name, password, hasPassword: has_password });
            const vaultId = String(result.id);

            // Store the password for this vault session (empty string for password-less vaults)
            await setVaultPassword(vaultId, password || '');

            await fetchVaults(); // Refresh vault list
          } catch (err) {
            showError(`Failed to create vault: ${getErrorMessage(err)}`);
          }
        }}
      />
      </div>
      {/* Capture modal with live URL preview */}
      <CaptureModal
        isOpen={isCaptureModalOpen}
        onClose={() => { setIsCaptureModalOpen(false); setProtocolCapture(null); }}
        onSave={handleCaptureSave}
        vaults={vaults.map(v => ({ id: v.id, title: v.title }))}
        initialTitle={protocolCapture?.title || ''}
        initialContent={protocolCapture?.url || ''}
      />
      {/* Change Cover dialog */}
      <ChangeCoverDialog
        isOpen={!!coverVault}
        onClose={() => setCoverVault(null)}
        vaultTitle={coverVault?.title}
        onPickUrl={(url: string) => { if (!coverVault) return; handleCoverFromUrl(coverVault.id, url); setCoverVault(null); }}
        onPickMesh={() => { if (!coverVault) return; handleCoverMesh(coverVault.id); setCoverVault(null); }}
        onPickFile={(dataUrl: string) => { if (!coverVault) return; handleCoverFromFile(coverVault.id, dataUrl); setCoverVault(null); }}
        onClear={() => { if (!coverVault) return; handleCoverClear(coverVault.id); setCoverVault(null); }}
      />
      {/* Change Password dialog */}
      {changePasswordVault && (
        <ChangePasswordDialog
          vault={changePasswordVault}
          onClose={() => setChangePasswordVault(null)}
          onSuccess={() => {
            clearKey(String(changePasswordVault.id));
            fetchVaults(); // Refresh vault list to update has_password
          }}
        />
      )}
    </>
  );
}

export default App;
