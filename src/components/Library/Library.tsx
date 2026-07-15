import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Masonry from '../Masonry/Masonry';
import ItemPanel from '../ItemPanel/ItemPanel';
import styles from './Library.module.css';
import { getYouTubeId, youtubeThumbnailUrl } from '../../utils/urlPreview';
import { useVaultPassword } from '../../contexts/VaultPasswordContext';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { BackendVaultItem, BackendUrlMetadata, ItemMetadata } from '../../types';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import { listE2EItems } from '../../utils/e2eFixtures';
import { rediscoverItems, relatedItems as getRelatedItems } from '../../utils/serendipity';
import { CheckIcon, ChevronDownIcon, MinusIcon, PlusIcon } from '@heroicons/react/24/outline';

const CARD_SIZES = [0, 1, 2] as const;
const CARD_SIZE_KEY = 'brainbox-library-card-size';

type Vault = { id: string; title: string; has_password?: boolean };
type ToolbarOption = { value: string; label: string };

const ToolbarSelect = ({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string;
  value: string;
  options: ToolbarOption[];
  onChange: (value: string) => void;
  className?: string;
}) => {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndexRef = useRef(0);
  const menuId = React.useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const setMenuOpen = (next: boolean) => {
    openRef.current = next;
    if (next) activeIndexRef.current = selectedIndex;
    setOpen(next);
  };

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndexRef.current]?.focus());
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', closeOutside);
    };
  }, [open, selectedIndex]);

  const moveFocus = (direction: number) => {
    const current = optionRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    const start = current >= 0 ? current : activeIndexRef.current;
    const next = (start + direction + options.length) % options.length;
    activeIndexRef.current = next;
    const focusNext = () => optionRefs.current[next]?.focus();
    focusNext();
    if (!optionRefs.current[next]) window.requestAnimationFrame(focusNext);
  };

  return (
    <div
      ref={rootRef}
      className={`${styles.toolbarSelect} ${className}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
      }}
      onKeyDown={(event) => {
        if (!openRef.current && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          setMenuOpen(true);
          return;
        }
        if (!openRef.current) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          setMenuOpen(false);
          buttonRef.current?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(event.key === 'ArrowDown' ? 1 : -1);
        } else if ((event.key === 'Enter' || event.key === ' ') && event.target === buttonRef.current) {
          event.preventDefault();
          onChange(options[activeIndexRef.current].value);
          setMenuOpen(false);
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          activeIndexRef.current = event.key === 'Home' ? 0 : options.length - 1;
          optionRefs.current[activeIndexRef.current]?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.toolbarSelectTrigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setMenuOpen(!openRef.current)}
      >
        <span>{options[selectedIndex]?.label}</span>
        <ChevronDownIcon className={styles.toolbarSelectChevron} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className={styles.toolbarSelectMenu} role="menu" aria-label={`${label} options`}>
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => { optionRefs.current[index] = element; }}
              type="button"
              className={styles.toolbarSelectOption}
              role="menuitemradio"
              aria-checked={option.value === value}
              onClick={() => {
                onChange(option.value);
                setMenuOpen(false);
                buttonRef.current?.focus();
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <CheckIcon className={styles.toolbarSelectCheck} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

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
  onOpenBrainy: () => void;
  brainyOpen?: boolean;
  brainyPanel?: React.ReactNode;
  onCloseBrainy?: () => void;
  summarizingItemIds: ReadonlySet<string>;
  onSummarizingChange: (id: string, busy: boolean) => void;
  refreshToken?: number;
}

const Library: React.FC<Props> = ({
  vaults,
  loadingVaults = false,
  selectedVaultId,
  onVaultChange,
  onCreateNote,
  onCreateVault,
  onOpenBrainy,
  brainyOpen = false,
  brainyPanel,
  onCloseBrainy,
  summarizingItemIds,
  onSummarizingChange,
  refreshToken = 0,
}) => {
  const { getVaultKey } = useVaultPassword();
  const { showError, showSuccess } = useToast();
  const confirmDialog = useConfirm();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<LibraryItem | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | 'note' | 'url'>('all');
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'created'>('updated');
  const [cardSize, setCardSize] = useState<number>(() => {
    const stored = localStorage.getItem(CARD_SIZE_KEY);
    const saved = Number(stored);
    return stored !== null && CARD_SIZES.includes(saved as (typeof CARD_SIZES)[number]) ? saved : 1;
  });
  const [rediscoverOffset, setRediscoverOffset] = useState(0);
  const [rediscoverHidden, setRediscoverHidden] = useState(false);
  const [rediscoverHiding, setRediscoverHiding] = useState(false);
  const [rediscoverPrevious, setRediscoverPrevious] = useState<LibraryItem[]>([]);
  const [rediscoverAnimating, setRediscoverAnimating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const rememberedScrollTopRef = useRef(0);
  const triggerItemIdRef = useRef<string | null>(null);
  const restoreItemIdRef = useRef<string | null>(null);

  const openItem = (item: LibraryItem) => {
    if (!selectedItem) rememberedScrollTopRef.current = scrollAreaRef.current?.scrollTop || 0;
    triggerItemIdRef.current = item.id;
    onCloseBrainy?.();
    setSelectedItem(item);
  };

  const closeItem = () => {
    restoreItemIdRef.current = triggerItemIdRef.current;
    setSelectedItem(null);
  };

  useLayoutEffect(() => {
    const itemId = restoreItemIdRef.current;
    const scrollArea = scrollAreaRef.current;
    const wrap = wrapRef.current;
    if (selectedItem || !itemId || !scrollArea || !wrap) return;

    const restore = () => {
      const target = scrollArea.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"] .masonry-card-bg`);
      if (!target) return false;
      target.focus({ preventScroll: true });
      scrollArea.scrollTop = rememberedScrollTopRef.current;
      return Math.abs(scrollArea.scrollTop - rememberedScrollTopRef.current) <= 1;
    };
    const finish = () => {
      if (!restore()) return false;
      restoreItemIdRef.current = null;
      return true;
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === wrap && event.propertyName === 'grid-template-columns') finish();
    };

    wrap.addEventListener('transitionend', onTransitionEnd);
    let frame = 0;
    let attempts = 0;
    const restoreWhenReady = () => {
      if (finish() || attempts >= 120) return;
      attempts += 1;
      frame = window.requestAnimationFrame(restoreWhenReady);
    };
    restoreWhenReady();
    return () => {
      wrap.removeEventListener('transitionend', onTransitionEnd);
      window.cancelAnimationFrame(frame);
    };
  }, [selectedItem]);

  useEffect(() => {
    if (!selectedItem && !brainyOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      selectedItem ? closeItem() : onCloseBrainy?.();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [brainyOpen, selectedItem]);

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
                image: item.image || (youtubeId ? youtubeThumbnailUrl(youtubeId, 'hq') : ''),
                summary: item.summary ?? undefined,
                height: isUrl ? 240 : Math.max(190, Math.min(340, 180 + Math.round(content.length / 2))),
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

  useEffect(() => {
    localStorage.setItem(CARD_SIZE_KEY, String(cardSize));
  }, [cardSize]);

  const visibleItems = useMemo(() => {
    let result = items.slice();
    if (typeFilter !== 'all') result = result.filter((item) => item.metadata.item_type === typeFilter);
    if (selectedVaultId !== 'all') result = result.filter((item) => item.vault_id === selectedVaultId);
    if (query.trim()) {
      const terms = query.trim().toLowerCase().split(/\s+/);
      const vaultTitles = new Map(vaults.map((vault) => [vault.id, vault.title]));
      // ponytail: items are already loaded for the grid; wire Tantivy when measured library size makes this scan slow.
      result = result.filter((item) => {
        const haystack = [
          item.title,
          item.content,
          item.summary || '',
          item.metadata.url || '',
          vaultTitles.get(item.vault_id) || '',
        ].join(' ').toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }
    result.sort((a, b) => sortBy === 'updated' ? +b.updatedAt - +a.updatedAt : +b.createdAt - +a.createdAt);
    return result;
  }, [items, query, selectedVaultId, sortBy, typeFilter, vaults]);

  const rediscovered = useMemo(() => query.trim() || rediscoverHidden
    ? []
    : rediscoverItems(visibleItems, Math.floor(Date.now() / 86_400_000), rediscoverOffset),
  [query, rediscoverHidden, rediscoverOffset, visibleItems]);
  const related = useMemo(() => selectedItem ? getRelatedItems(items, selectedItem) : [], [items, selectedItem]);
  const reviewItems = selectedItem && visibleItems.some((item) => item.id === selectedItem.id) ? visibleItems : items;
  const reviewIndex = selectedItem ? reviewItems.findIndex((item) => item.id === selectedItem.id) : -1;

  useEffect(() => {
    if (!rediscoverAnimating) return;
    const timeout = window.setTimeout(() => {
      setRediscoverAnimating(false);
      setRediscoverPrevious([]);
    }, 260);
    return () => window.clearTimeout(timeout);
  }, [rediscoverAnimating, rediscoverOffset]);

  const selectedVault = vaults.find((vault) => vault.id === selectedVaultId);
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

  return (
    <section ref={wrapRef} className={`${styles.wrap} ${selectedItem || brainyOpen ? styles.inspectorOpen : ''}`} data-testid="library-section">
      <div className={styles.libraryMain} data-testid="library-main">
      <div className={styles.libraryInner}>
      <div className={styles.commandArea}>
        <header className={styles.heading}>
          <div className={styles.headingCopy}>
            <img className={styles.headingIcon} src="/BBX-Icon.svg" alt="" aria-hidden="true" draggable={false} />
            <div>
              <h1>Library</h1>
              <p>{selectedVault ? selectedVault.title : 'Your private collection of notes, links, and ideas.'}</p>
            </div>
          </div>
          <div className={styles.headingActions}>
            {items.length > 0 && (
              <button type="button" className={styles.textButton} onClick={() => { setSelectedItem(null); onOpenBrainy(); }} data-testid="library-brainy-button">
                Ask brainy
              </button>
            )}
            <button type="button" className={styles.textButton} onClick={onCreateVault} data-testid="create-vault-button">
              New vault
            </button>
          </div>
        </header>

        <div className={styles.commandBar}>
        <label className={styles.searchBox}>
          <span className={styles.srOnly}>Search notes and links</span>
          <input
            ref={searchRef}
            className={styles.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search everything you saved"
            data-testid="library-search-input"
          />
          <kbd>{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
        </label>

        {items.length > 0 && (
          <div className={styles.filterRow}>
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

            <ToolbarSelect
              label="Filter by vault"
              value={selectedVaultId}
              options={[{ value: 'all', label: 'All vaults' }, ...vaults.map((vault) => ({ value: vault.id, label: vault.title }))]}
              onChange={onVaultChange}
            />

            <ToolbarSelect
              label="Sort order"
              value={sortBy}
              options={[
                { value: 'updated', label: 'Recently updated' },
                { value: 'created', label: 'Recently created' },
              ]}
              onChange={(next) => setSortBy(next as 'updated' | 'created')}
              className={styles.sortSelect}
            />

            <div className={`${styles.segmented} ${styles.zoomControls}`} role="group" aria-label="Card size">
              <button
                type="button"
                aria-label="Show smaller cards"
                disabled={cardSize === 0}
                onClick={() => setCardSize(CARD_SIZES[cardSize - 1])}
              >
                <MinusIcon className={styles.zoomIcon} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Show larger cards"
                disabled={cardSize === CARD_SIZES.length - 1}
                onClick={() => setCardSize(CARD_SIZES[cardSize + 1])}
              >
                <PlusIcon className={styles.zoomIcon} aria-hidden="true" />
              </button>
              <span className={styles.srOnly} aria-live="polite">Card size {cardSize + 1} of {CARD_SIZES.length}</span>
            </div>

            <div className={styles.hint} aria-live="polite">{loading ? 'Loading…' : `${visibleItems.length} items`}</div>
          </div>
        )}
        </div>
      </div>

      <div ref={scrollAreaRef} className={styles.scrollArea} data-testid="library-scroll-area">
      {rediscovered.length > 0 && (
        <section
          className={`${styles.rediscover} ${rediscoverHiding ? styles.rediscoverHiding : ''}`}
          data-testid="rediscover-shelf"
          data-hiding={rediscoverHiding || undefined}
          aria-labelledby="rediscover-title"
          onTransitionEnd={(event) => {
            if (rediscoverHiding && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') setRediscoverHidden(true);
          }}
        >
          <div className={styles.rediscoverInner}>
          <div className={styles.rediscoverHeader}>
            <div>
              <h2 id="rediscover-title">Rediscover</h2>
              <p>A few things worth another look.</p>
            </div>
            <div className={styles.rediscoverActions}>
              <button type="button" onClick={() => { setRediscoverPrevious(rediscovered); setRediscoverAnimating(true); setRediscoverOffset((offset) => offset + 3); }}>Shuffle</button>
              <button type="button" onClick={() => setRediscoverHiding(true)}>Hide</button>
            </div>
          </div>
          <div className={styles.rediscoverGridWrap}>
          {(rediscoverAnimating && rediscoverPrevious.length > 0
            ? [
                { key: `leaving-${rediscoverOffset}`, items: rediscoverPrevious, className: styles.rediscoverGridLeaving, phase: 'leaving' },
                { key: `entering-${rediscoverOffset}`, items: rediscovered, className: styles.rediscoverGridEntering, phase: 'entering' },
              ]
            : [{ key: `current-${rediscoverOffset}`, items: rediscovered, className: '', phase: 'current' }]
          ).map((layer) => (
          <div key={layer.key} className={`${styles.rediscoverGrid} ${layer.className}`} data-phase={layer.phase}>
            {layer.items.map((item) => {
              const image = item.metadata.preview_image || item.image;
              const excerpt = item.metadata.preview_description || item.summary || item.content;
              return (
                <button key={item.id} type="button" className={styles.rediscoverCard} onClick={() => openItem(item)}>
                  {image && <img src={image} alt="" />}
                  <span className={styles.rediscoverCardBody}>
                    <small>{item.metadata.item_type === 'url' ? 'Link' : 'Note'} · {item.updatedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>
                    <strong>{item.title}</strong>
                    {excerpt && <span>{excerpt}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          ))}
          </div>
          </div>
        </section>
      )}

      {visibleItems.length === 0 ? (
        <div className={styles.empty} data-testid="library-empty-state">
          {loading || loadingVaults ? (
            'Loading…'
          ) : vaults.length === 0 ? (
            <>
              <h2>Start with anything</h2>
              <p>Drop in a thought or paste a link. Brainbox keeps it local and ready to find.</p>
              <button type="button" className={styles.primaryButton} onClick={onCreateNote}>Capture your first item</button>
            </>
          ) : query || typeFilter !== 'all' ? (
            <>
              <h2>No matches</h2>
              <p>Try a shorter search or clear a filter.</p>
            </>
          ) : (
            <>
              <h2>Your Inbox is quiet</h2>
              <p>Capture a thought or paste a link to give it something to remember.</p>
              <button type="button" className={styles.primaryButton} onClick={onCreateNote}>New note</button>
            </>
          )}
        </div>
      ) : (
        <Masonry
          data={visibleItems}
          columnAdjustment={1 - cardSize}
          preferSummary={Boolean(query.trim())}
          selectedId={selectedItem?.id}
          actionsMode="menu"
          onCardClick={(item) => openItem(item as LibraryItem)}
          onOpenExternal={(item) => {
            const url = item.metadata?.url || item.content;
            if (url) window.open(url, '_blank');
          }}
          onCopyItem={async (item) => {
            const isUrl = item.metadata?.item_type === 'url';
            const value = isUrl ? item.metadata?.url || item.content : item.content || item.title;
            if (!value) return;
            try {
              await navigator.clipboard.writeText(value);
              showSuccess(isUrl ? 'Link copied.' : 'Content copied.');
            } catch {
              showError('Failed to copy item.');
            }
          }}
          onDeleteItem={async (item) => {
            const id = String(item?.id || '');
            if (!id || !await confirmDialog({ title: 'Delete item?', message: 'This will remove the item from your vault.', confirmLabel: 'Delete' })) return;
            try {
              await invoke('delete_vault_item', { itemId: Number(id) });
              window.dispatchEvent(new Event('brainbox:data-changed'));
              setItems((current) => current.filter((candidate) => candidate.id !== id));
              showSuccess('Item deleted.');
            } catch (error) {
              console.error('Failed to delete item:', error);
              showError('Failed to delete item.');
            }
          }}
        />
      )}
      </div>
        </div>
      </div>

      {(brainyOpen || selectedItem) && (
        <div className={styles.contextRail} data-testid="context-rail">
        {brainyOpen ? brainyPanel : selectedItem && (
        <ItemPanel
          item={selectedItem}
          relatedItems={related}
          onSelectRelated={(item) => openItem(item as LibraryItem)}
          position={reviewIndex >= 0 ? reviewIndex + 1 : undefined}
          total={reviewIndex >= 0 ? reviewItems.length : undefined}
          onPrevious={reviewIndex > 0 ? () => openItem(reviewItems[reviewIndex - 1]) : undefined}
          onNext={reviewIndex >= 0 && reviewIndex < reviewItems.length - 1 ? () => openItem(reviewItems[reviewIndex + 1]) : undefined}
          currentVaultId={selectedItem.vault_id}
          vaults={vaults}
          onClose={closeItem}
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
          summarizing={summarizingItemIds.has(selectedItem.id)}
          onSummarizingChange={onSummarizingChange}
          onRename={async (id, title) => {
            try {
              await invoke('update_vault_item_title', { itemId: Number(id), title });
              window.dispatchEvent(new Event('brainbox:data-changed'));
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
              window.dispatchEvent(new Event('brainbox:data-changed'));
              setItems((current) => current.map((item) => item.id === String(id) ? { ...item, vault_id: targetVaultId } : item));
              setSelectedItem((current) => current?.id === String(id) ? { ...current, vault_id: targetVaultId } : current);
            } catch { showError('Failed to move item.'); }
          }}
          onUpdateImage={async (id, image) => {
            try {
              await invoke('update_vault_item_image', { itemId: Number(id), image });
              window.dispatchEvent(new Event('brainbox:data-changed'));
              setItems((current) => current.map((item) => item.id === String(id) ? { ...item, image: image || item.image } : item));
              setSelectedItem((current) => current?.id === String(id) ? { ...current, image: image || current.image } : current);
            } catch { showError('Failed to update image.'); }
          }}
          onDelete={async (id) => {
            if (!await confirmDialog({ title: 'Delete item?', message: 'This will remove the item from your vault.', confirmLabel: 'Delete' })) return;
            try {
              await invoke('delete_vault_item', { itemId: Number(id) });
              window.dispatchEvent(new Event('brainbox:data-changed'));
              setItems((current) => current.filter((item) => item.id !== String(id)));
              setSelectedItem(null);
              showSuccess('Item deleted.');
            } catch { showError('Failed to delete item.'); }
          }}
        />
        )}
        </div>
      )}
    </section>
  );
};

export default Library;
