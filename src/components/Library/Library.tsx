import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Masonry from '../Masonry/Masonry';
import ItemPanel from '../ItemPanel/ItemPanel';
import styles from './Library.module.css';
import { meshGradientForId } from '../../utils/meshGradient';
import { getYouTubeId, youtubeThumbnailUrl } from '../../utils/urlPreview';
import { useVaultPassword } from '../../contexts/VaultPasswordContext';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { BackendVaultItem, BackendUrlMetadata, ItemMetadata } from '../../types';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import { listE2EItems } from '../../utils/e2eFixtures';

type Vault = { id: string; title: string; has_password?: boolean };

type LibraryItem = {
  id: string;
  vault_id: string;
  title: string;
  content: string;
  image: string;
  createdAt: Date;
  updatedAt: Date;
  height: number;
  metadata: ItemMetadata;
  summary?: string;
};

interface Props {
  vaults: Vault[];
  loadingVaults?: boolean;
  selectedVaultId: string;
  onVaultChange: (vaultId: string) => void;
  onCreateNote: () => void;
  onCreateVault: () => void;
  refreshToken?: number;
}

const Library: React.FC<Props> = ({
  vaults,
  loadingVaults = false,
  selectedVaultId,
  onVaultChange,
  onCreateNote,
  onCreateVault,
  refreshToken = 0,
}) => {
  const { getVaultKey } = useVaultPassword();
  const { showError, showSuccess } = useToast();
  const confirmDialog = useConfirm();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<LibraryItem | null>(null);
  const [isItemBusy, setIsItemBusy] = useState(false);
  const [typeFilter, setTypeFilter] = useState<'all' | 'note' | 'url'>('all');
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'created'>('updated');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (vaults.length === 0) {
      setItems([]);
      return;
    }

    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const groups = await Promise.all(vaults.map(async (vault) => {
          try {
            const result = isTauriRuntime()
              ? await getVaultKey(vault.id, vault.title, vault.has_password)
                .then((key) => invoke<BackendVaultItem[]>('list_vault_items', { vaultId: Number(vault.id), key }))
              : listE2EItems(vault.id);

            return result.map((item): LibraryItem => {
              const content = typeof item.content === 'string' ? item.content : '';
              const isUrl = /^https?:\/\/[^\s]+$/.test(content.trim());
              const metadata: ItemMetadata = {
                item_type: isUrl ? 'url' : 'note',
                url: isUrl ? content : undefined,
                created_at: item.created_at,
                updated_at: item.updated_at,
                ...(item.metadata as Partial<ItemMetadata> || {}),
              };
              const youtubeId = isUrl ? getYouTubeId(content) : null;
              if (youtubeId) metadata.provider = 'youtube';

              return {
                id: String(item.id),
                vault_id: vault.id,
                title: item.title,
                content,
                createdAt: new Date(item.created_at),
                updatedAt: new Date(item.updated_at),
                image: item.image || (youtubeId ? youtubeThumbnailUrl(youtubeId, 'hq') : meshGradientForId(item.id, 640, 420)),
                summary: item.summary ?? undefined,
                height: 260,
                metadata,
              };
            });
          } catch {
            return [];
          }
        }));

        if (!alive) return;
        const nextItems = groups.flat().sort((a, b) => +b.updatedAt - +a.updatedAt);
        setItems(nextItems);

        if (!isTauriRuntime()) return;
        nextItems
          .filter((item) => item.metadata.item_type === 'url' && item.metadata.provider !== 'youtube')
          .forEach(async (item) => {
            try {
              const metadata = await invoke<BackendUrlMetadata>('fetch_url_metadata', { url: item.content });
              if (!alive) return;
              setItems((current) => current.map((candidate) => candidate.id === item.id ? {
                ...candidate,
                metadata: {
                  ...candidate.metadata,
                  preview_title: metadata?.title,
                  preview_description: metadata?.description,
                  preview_image: metadata?.image,
                },
              } : candidate));
            } catch {}
          });
      } finally {
        if (alive) setLoading(false);
      }
    };

    load();
    return () => { alive = false; };
  }, [vaults, getVaultKey, refreshToken]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const visibleItems = useMemo(() => {
    let result = items.slice();
    if (typeFilter !== 'all') result = result.filter((item) => item.metadata.item_type === typeFilter);
    if (selectedVaultId !== 'all') result = result.filter((item) => item.vault_id === selectedVaultId);
    if (query.trim()) {
      const needle = query.trim().toLowerCase();
      result = result.filter((item) => `${item.title} ${item.content} ${item.summary || ''}`.toLowerCase().includes(needle));
    }
    result.sort((a, b) => sortBy === 'updated' ? +b.updatedAt - +a.updatedAt : +b.createdAt - +a.createdAt);
    return result;
  }, [items, query, selectedVaultId, sortBy, typeFilter]);

  const selectedVault = vaults.find((vault) => vault.id === selectedVaultId);
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

  return (
    <section className={styles.wrap} data-testid="library-section">
      <header className={styles.heading}>
        <div>
          <h1>Library</h1>
          <p>{selectedVault ? selectedVault.title : 'Everything you have saved, in one place.'}</p>
        </div>
        <button type="button" className={styles.textButton} onClick={onCreateVault} data-testid="create-vault-button">
          New vault
        </button>
      </header>

      <div className={styles.toolbar}>
        <label className={styles.searchBox}>
          <span className={styles.srOnly}>Search notes and links</span>
          <input
            ref={searchRef}
            className={styles.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes and links"
            data-testid="library-search-input"
          />
          <kbd>{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
        </label>

        <div className={styles.segmented} role="group" aria-label="Type filter">
          {(['all', 'note', 'url'] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              className={typeFilter === filter ? styles.active : ''}
              aria-pressed={typeFilter === filter}
              onClick={() => setTypeFilter(filter)}
            >
              {filter === 'all' ? 'All' : filter === 'note' ? 'Notes' : 'Links'}
            </button>
          ))}
        </div>

        <select className={styles.select} value={selectedVaultId} onChange={(event) => onVaultChange(event.target.value)} aria-label="Filter by vault">
          <option value="all">All vaults</option>
          {vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.title}</option>)}
        </select>

        <select className={styles.select} value={sortBy} onChange={(event) => setSortBy(event.target.value as 'updated' | 'created')} aria-label="Sort order">
          <option value="updated">Recently updated</option>
          <option value="created">Recently created</option>
        </select>

        <div className={styles.hint} aria-live="polite">{loading ? 'Loading…' : `${visibleItems.length} items`}</div>
      </div>

      {visibleItems.length === 0 ? (
        <div className={styles.empty} data-testid="library-empty-state">
          {loading || loadingVaults ? (
            'Loading…'
          ) : vaults.length === 0 ? (
            <>
              <h2>Create your Inbox</h2>
              <p>Start with one vault. You can organize more later.</p>
              <button type="button" className={styles.primaryButton} onClick={onCreateVault}>Create Inbox</button>
            </>
          ) : query || typeFilter !== 'all' ? (
            <>
              <h2>No matches</h2>
              <p>Try a shorter search or clear a filter.</p>
            </>
          ) : (
            <>
              <h2>Nothing here yet</h2>
              <p>Capture a thought or paste a link to get started.</p>
              <button type="button" className={styles.primaryButton} onClick={onCreateNote}>New note</button>
            </>
          )}
        </div>
      ) : (
        <Masonry
          data={visibleItems}
          selectedId={selectedItem?.id}
          actionsMode="menu"
          onCardClick={(item) => {
            if (!isItemBusy || !selectedItem) setSelectedItem(item as LibraryItem);
          }}
          onDeleteItem={async (item) => {
            const id = String(item?.id || '');
            if (!id || !await confirmDialog({ title: 'Delete item?', message: 'This will remove the item from your vault.', confirmLabel: 'Delete' })) return;
            try {
              await invoke('delete_vault_item', { itemId: Number(id) });
              setItems((current) => current.filter((candidate) => candidate.id !== id));
              showSuccess('Item deleted.');
            } catch (error) {
              console.error('Failed to delete item:', error);
              showError('Failed to delete item.');
            }
          }}
        />
      )}

      {selectedItem && (
        <ItemPanel
          item={selectedItem}
          currentVaultId={selectedItem.vault_id}
          vaults={vaults}
          onClose={() => { setSelectedItem(null); setIsItemBusy(false); }}
          onUpdateContent={async (id, content) => {
            const url = /^https?:\/\/[^\s]+$/.test(content.trim());
            const update = (item: LibraryItem) => item.id === String(id) ? {
              ...item,
              content,
              metadata: { ...item.metadata, item_type: url ? 'url' as const : 'note' as const, url: url ? content : undefined },
            } : item;
            setItems((current) => current.map(update));
            setSelectedItem((current) => current ? update(current) : current);
          }}
          onUpdateSummary={async (id, summary) => {
            setItems((current) => current.map((item) => item.id === String(id) ? { ...item, summary } : item));
            setSelectedItem((current) => current?.id === String(id) ? { ...current, summary } : current);
          }}
          onSummarizingChange={setIsItemBusy}
          onRename={async (id, title) => {
            try {
              await invoke('update_vault_item_title', { itemId: Number(id), title });
              setItems((current) => current.map((item) => item.id === String(id) ? { ...item, title } : item));
              setSelectedItem((current) => current?.id === String(id) ? { ...current, title } : current);
            } catch { showError('Failed to rename item.'); }
          }}
          onMove={async (id, targetVaultId) => {
            try {
              const sourceVault = vaults.find((vault) => vault.id === selectedItem.vault_id);
              const targetVault = vaults.find((vault) => vault.id === targetVaultId);
              if (!sourceVault || !targetVault) throw new Error('Vault not found');
              const [sourceKey, targetKey] = await Promise.all([
                getVaultKey(sourceVault.id, sourceVault.title, sourceVault.has_password),
                getVaultKey(targetVault.id, targetVault.title, targetVault.has_password),
              ]);
              await invoke('move_vault_item', { itemId: Number(id), targetVaultId: Number(targetVaultId), sourceKey, targetKey });
              setItems((current) => current.map((item) => item.id === String(id) ? { ...item, vault_id: targetVaultId } : item));
              setSelectedItem((current) => current?.id === String(id) ? { ...current, vault_id: targetVaultId } : current);
            } catch { showError('Failed to move item.'); }
          }}
          onUpdateImage={async (id, image) => {
            try {
              await invoke('update_vault_item_image', { itemId: Number(id), image });
              setItems((current) => current.map((item) => item.id === String(id) ? { ...item, image: image || item.image } : item));
              setSelectedItem((current) => current?.id === String(id) ? { ...current, image: image || current.image } : current);
            } catch { showError('Failed to update image.'); }
          }}
          onDelete={async (id) => {
            if (!await confirmDialog({ title: 'Delete item?', message: 'This will remove the item from your vault.', confirmLabel: 'Delete' })) return;
            try {
              await invoke('delete_vault_item', { itemId: Number(id) });
              setItems((current) => current.filter((item) => item.id !== String(id)));
              setSelectedItem(null);
              showSuccess('Item deleted.');
            } catch { showError('Failed to delete item.'); }
          }}
        />
      )}
    </section>
  );
};

export default Library;
