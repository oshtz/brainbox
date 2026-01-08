import React, { useEffect, useMemo, useState } from 'react';
import Masonry from '../Masonry/Masonry';
import ItemPanel from '../ItemPanel/ItemPanel';
import styles from './Library.module.css';
import { invoke } from '@tauri-apps/api/core';
import { meshGradientForId } from '../../utils/meshGradient';
import { getYouTubeId, youtubeThumbnailUrl } from '../../utils/urlPreview';
import { useVaultPassword } from '../../contexts/VaultPasswordContext';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { BackendVaultItem, BackendUrlMetadata, ItemMetadata } from '../../types';

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
}

const Library: React.FC<Props> = ({ vaults }) => {
  const { getVaultKey } = useVaultPassword();
  const { showError, showSuccess } = useToast();
  const confirmDialog = useConfirm();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<LibraryItem | null>(null);
  const [isItemBusy, setIsItemBusy] = useState(false);

  const [typeFilter, setTypeFilter] = useState<'all' | 'note' | 'url'>('all');
  const [vaultFilter, setVaultFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'created'>('updated');

  // Load all items across vaults
  useEffect(() => {
    if (!vaults || vaults.length === 0) {
      setItems([]);
      return;
    }
    let alive = true;
    const run = async () => {
      setLoading(true);
      try {
        const arrays = await Promise.all(
          vaults.map(async (v) => {
            try {
              const key = await getVaultKey(v.id, v.title, v.has_password);
              const result = await invoke<BackendVaultItem[]>('list_vault_items', { vaultId: Number(v.id), key });
              return (result || []).map((it): LibraryItem => {
                const rawContent = typeof it.content === 'string' ? it.content : '';
                const isUrl = /^https?:\/\/[^\s]+$/.test(rawContent.trim());
                const meta: ItemMetadata = {
                  item_type: isUrl ? 'url' : 'note',
                  url: isUrl ? rawContent : undefined,
                  created_at: it.created_at,
                  updated_at: it.updated_at,
                  ...(it.metadata as Partial<ItemMetadata> || {}),
                };
                let cover = it.image ?? undefined;
                const yt = isUrl ? getYouTubeId(rawContent) : null;
                if (!cover && yt) {
                  cover = youtubeThumbnailUrl(yt, 'hq');
                  meta.provider = 'youtube';
                }
                return {
                  id: String(it.id),
                  vault_id: String(v.id),
                  title: it.title,
                  content: rawContent,
                  createdAt: new Date(it.created_at),
                  updatedAt: new Date(it.updated_at),
                  image: cover || meshGradientForId(it.id ?? Math.random(), 640, 420),
                  summary: it.summary ?? undefined,
                  height: 260,
                  metadata: meta,
                };
              });
            } catch (_) {
              return [] as LibraryItem[];
            }
          })
        );
        if (!alive) return;
        const flat = arrays.flat();
        // Enrich non-YouTube URLs with preview metadata
        setItems(flat.sort((a, b) => +b.updatedAt - +a.updatedAt));
        flat.filter((it) => it.metadata?.item_type === 'url' && it.metadata?.provider !== 'youtube').forEach(async (it) => {
          try {
            const meta = await invoke<BackendUrlMetadata>('fetch_url_metadata', { url: it.content });
            if (!alive) return;
            setItems((prev) => prev.map(p => p.id === it.id ? ({
              ...p,
              metadata: {
                ...p.metadata,
                preview_title: meta?.title || p.metadata?.preview_title,
                preview_description: meta?.description || p.metadata?.preview_description,
                preview_image: meta?.image || p.metadata?.preview_image,
              }
            }) : p));
          } catch { /* ignore */ }
        });
      } finally {
        if (alive) setLoading(false);
      }
    };
    run();
    return () => { alive = false; };
  }, [vaults]);

  const visible = useMemo(() => {
    let list = items.slice();
    if (typeFilter !== 'all') list = list.filter((i) => i.metadata?.item_type === typeFilter);
    if (vaultFilter !== 'all') list = list.filter((i) => i.vault_id === vaultFilter);
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      list = list.filter((i) => (i.title || '').toLowerCase().includes(s) || (i.content || '').toLowerCase().includes(s));
    }
    list.sort((a, b) => sortBy === 'updated' ? (+b.updatedAt - +a.updatedAt) : (+b.createdAt - +a.createdAt));
    return list;
  }, [items, typeFilter, vaultFilter, q, sortBy]);

  const vaultOptions = useMemo(() => [{ id: 'all', title: 'All vaults' }, ...vaults], [vaults]);

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <div className={styles.segmented} role="tablist" aria-label="Type filter">
          <button className={typeFilter === 'all' ? styles.active : ''} role="tab" aria-selected={typeFilter==='all'} onClick={() => setTypeFilter('all')}>All</button>
          <button className={typeFilter === 'note' ? styles.active : ''} role="tab" aria-selected={typeFilter==='note'} onClick={() => setTypeFilter('note')}>Notes</button>
          <button className={typeFilter === 'url' ? styles.active : ''} role="tab" aria-selected={typeFilter==='url'} onClick={() => setTypeFilter('url')}>Links</button>
        </div>

        <select className={styles.select} value={vaultFilter} onChange={(e) => setVaultFilter(e.target.value)} aria-label="Filter by vault">
          {vaultOptions.map((v) => (
            <option key={v.id} value={v.id}>{v.title}</option>
          ))}
        </select>

        <select className={styles.select} value={sortBy} onChange={(e) => setSortBy(e.target.value as 'updated' | 'created')} aria-label="Sort order">
          <option value="updated">Recent (updated)</option>
          <option value="created">Recent (created)</option>
        </select>

        <input className={styles.search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by title or content" aria-label="Filter items" />

        <div className={styles.hint}>{loading ? 'Loading…' : `${visible.length} items`}</div>
      </div>

      {visible.length === 0 ? (
        <div className={styles.empty}>{loading ? 'Loading…' : 'No items match the current filters.'}</div>
      ) : (
        <Masonry
          data={visible}
          selectedId={selectedItem?.id}
          actionsMode="menu"
          onCardClick={(it) => { if (isItemBusy && selectedItem) return; setSelectedItem(it as LibraryItem); }}
          onDeleteItem={async (it) => {
            const id = String(it?.id || '');
            if (!id) return;
            const confirmed = await confirmDialog({
              title: 'Delete item?',
              message: 'This will remove the item from your vault.',
              confirmLabel: 'Delete'
            });
            if (!confirmed) return;
            try {
              await Promise.all([
                invoke('delete_vault_item', { itemId: Number(id) }),
                invoke('delete_document', { id }).catch(() => {})
              ]);
              setItems(prev => prev.filter(p => String(p.id) !== id));
              showSuccess('Item deleted.');
            } catch (err) {
              console.error('Failed to delete', err);
              showError('Failed to delete item.');
            }
          }}
        />
      )}

      {selectedItem && (
        <div style={{ marginTop: 16 }}>
          <ItemPanel
            item={selectedItem}
            currentVaultId={String(selectedItem?.vault_id || '')}
            vaults={vaults.map(v => ({ id: v.id, title: v.title, has_password: v.has_password }))}
            onClose={() => { setSelectedItem(null); setIsItemBusy(false); }}
            onUpdateContent={async (id, content) => {
              const urlish = /^https?:\/\/[^\s]+$/.test(String(content).trim());
              setSelectedItem(cur => cur && String(cur.id) === String(id) ? { ...cur, content, metadata: { ...cur.metadata, item_type: urlish ? 'url' : 'note', url: urlish ? content : undefined } } : cur);
              setItems(prev => prev.map(c => String(c.id) === String(id) ? { ...c, content, metadata: { ...c.metadata, item_type: urlish ? 'url' : 'note', url: urlish ? content : undefined } } : c));
            }}
            onUpdateSummary={async (id, summary) => {
              setSelectedItem(cur => cur && String(cur.id) === String(id) ? { ...cur, summary } : cur);
              setItems(prev => prev.map(c => String(c.id) === String(id) ? { ...c, summary } : c));
            }}
            onSummarizingChange={(busy) => setIsItemBusy(busy)}
            onRename={async (id, newTitle) => {
              try {
                await invoke('update_vault_item_title', { itemId: Number(id), title: newTitle });
                setSelectedItem(cur => cur && String(cur.id) === String(id) ? { ...cur, title: newTitle } : cur);
                setItems(prev => prev.map(c => String(c.id) === String(id) ? { ...c, title: newTitle } : c));
              } catch (e) {
                console.error(e);
                showError('Failed to rename item.');
              }
            }}
            onMove={async (id, targetVaultId) => {
              try {
                await invoke('move_vault_item', { itemId: Number(id), targetVaultId: Number(targetVaultId) });
                setSelectedItem(cur => cur && String(cur.id) === String(id) ? { ...cur, vault_id: targetVaultId } : cur);
                setItems(prev => prev.map(c => String(c.id) === String(id) ? { ...c, vault_id: targetVaultId } : c));
              } catch (e) {
                console.error(e);
                showError('Failed to move item.');
              }
            }}
            onUpdateImage={async (id, image) => {
              try {
                await invoke('update_vault_item_image', { itemId: Number(id), image });
                setSelectedItem(cur => cur && String(cur.id) === String(id) ? { ...cur, image: image ?? cur.image } : cur);
                setItems(prev => prev.map(c => String(c.id) === String(id) ? { ...c, image: image ?? c.image } : c));
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
                setSelectedItem(null);
                setItems(prev => prev.filter(c => String(c.id) !== String(id)));
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
  );
};

export default Library;
