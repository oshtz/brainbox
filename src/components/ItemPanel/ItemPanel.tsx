import React, { useEffect, useRef, useState } from 'react';
import { XMarkIcon, EllipsisVerticalIcon } from '@heroicons/react/24/outline';
import styles from './ItemPanel.module.css';
import { generateMeshGradientDataURL } from '../../utils/meshGradient';
import { getYouTubeId, youtubeEmbedUrl, isUrl as looksLikeUrl } from '../../utils/urlPreview';
import { aiService } from '../../utils/ai';
import { invoke } from '@tauri-apps/api/core';
import { useVaultPassword } from '../../contexts/VaultPasswordContext';
import { useToast } from '../../contexts/ToastContext';
import { usePrompt } from '../../contexts/PromptContext';

type Item = any;

interface Props {
  item: Item;
  vaults: { id: string; title: string; has_password?: boolean }[];
  currentVaultId: string;
  onClose: () => void;
  onRename: (id: string, title: string) => Promise<void> | void;
  onMove: (id: string, targetVaultId: string) => Promise<void> | void;
  onUpdateImage: (id: string, image: string | null) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onUpdateSummary?: (id: string, summary: string) => Promise<void> | void;
  onUpdateContent?: (id: string, content: string) => Promise<void> | void;
  summarizing?: boolean;
  onSummarizingChange?: (id: string, busy: boolean) => void;
  relatedItems?: Item[];
  onSelectRelated?: (item: Item) => void;
}

const ItemPanel: React.FC<Props> = ({ item, vaults, currentVaultId, onClose, onRename, onMove, onUpdateImage, onDelete, onUpdateSummary, onUpdateContent, summarizing = false, onSummarizingChange, relatedItems = [], onSelectRelated }) => {
  const { getVaultKey } = useVaultPassword();
  const { showError, showSuccess, showWarning } = useToast();
  const promptDialog = usePrompt();
  const [title, setTitle] = useState(item?.title || '');
  const [targetVault, setTargetVault] = useState<string>(currentVaultId || vaults?.[0]?.id || '');
  const isUrl = item?.metadata?.item_type === 'url' || looksLikeUrl(item?.content);
  const contentText: string = (item?.content_preview || item?.content || '').toString();
  const [contentEdit, setContentEdit] = useState<string>(contentText);
  const [savingContent, setSavingContent] = useState(false);
  const [lastSavedContent, setLastSavedContent] = useState<string>(contentText);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingContent, setEditingContent] = useState(false);
  const [isPasting, setIsPasting] = useState(false);
  const [imgMenuOpen, setImgMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [summary, setSummary] = useState<string>(item?.summary || '');
  const [sumError, setSumError] = useState('');
  const activeItemIdRef = useRef(String(item?.id));
  const [aiStatus, setAIStatus] = useState(() => {
    const type = aiService.getActiveProviderType();
    return { name: aiService.getProviderConfig(type).name, configured: aiService.isConfigured() };
  });

  useEffect(() => {
    const refresh = () => {
      const type = aiService.getActiveProviderType();
      setAIStatus({ name: aiService.getProviderConfig(type).name, configured: aiService.isConfigured() });
    };
    window.addEventListener('ai-settings-changed', refresh);
    return () => window.removeEventListener('ai-settings-changed', refresh);
  }, []);

  // Auto-save title edits when switching items, then sync local UI
  const prevItemRef = React.useRef<{ id?: string | number, title?: string } | null>(null);
  React.useEffect(() => {
    const itemId = String(item?.id);
    activeItemIdRef.current = itemId;
    const prev = prevItemRef.current;
    if (prev && prev.id != null) {
      const prevId = String(prev.id);
      const prevOriginalTitle = String(prev.title || '');
      const currentEditedTitle = String(title || '');
      if (currentEditedTitle.trim() && currentEditedTitle !== prevOriginalTitle) {
        try { onRename(prevId, currentEditedTitle); } catch (_) {}
      }
    }
    prevItemRef.current = { id: item?.id, title: item?.title };
    setTitle(item?.title || '');
    setTargetVault(currentVaultId || vaults?.[0]?.id || '');
    setImgMenuOpen(false);
    setIsPasting(false);
    setEditingTitle(false);
    setEditingContent(false);
    const initial = item?.content?.toString() || '';
    setContentEdit(initial);
    setLastSavedContent(initial);
    setSummary(item?.summary || '');
    setSumError('');
    return () => {
      if (activeItemIdRef.current === itemId) activeItemIdRef.current = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const formatDate = (s?: string) => {
    if (!s) return 'N/A';
    const d = new Date(s);
    if (isNaN(d.getTime())) return 'N/A';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  // copy helper removed (unused)

  const saveContent = async () => {
    const newText = contentEdit ?? '';
    if (newText === lastSavedContent) return;
    try {
      setSavingContent(true);
      // Get vault info for password handling
      const vault = vaults.find(v => v.id === currentVaultId);
      const key = await getVaultKey(currentVaultId, vault?.title, vault?.has_password);
      await invoke('update_vault_item_content', { itemId: Number(item?.id), content: newText, key });
      if (onUpdateContent) { try { await onUpdateContent(String(item?.id), newText); } catch {} }
      setLastSavedContent(newText);
    } finally {
      setSavingContent(false);
    }
  };

  // Debounce saves while typing
  useEffect(() => {
    if (contentEdit === lastSavedContent) return;
    const t = setTimeout(() => { if (!savingContent) { void saveContent(); } }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentEdit]);

  const buildPrompt = async () => {
    const itemTitle = String(title || item?.title || '').trim();
    const body = looksLikeUrl(contentEdit) ? '' : String(contentEdit || '').trim();
    const url = looksLikeUrl(contentEdit) ? String(contentEdit || '') : '';
    const header = itemTitle ? `Title: ${itemTitle}\n` : '';
    const urlLine = url ? `Source URL: ${url}\n` : '';
    let extra = '';
    if (url && !body) {
      try {
        const [pageText, yt] = await Promise.all([
          invoke<string>('fetch_url_text', { url }).catch(() => ''),
          invoke<null | string>('fetch_youtube_transcript', { url }).then((t:any)=>t||'').catch(()=>''),
        ]);
        const pageSnippet = pageText ? `\n\nPage extract (truncated):\n${pageText.slice(0, 5000)}` : '';
        const ytSnippet = yt ? `\n\nYouTube transcript (truncated):\n${(yt as string).slice(0, 8000)}` : '';
        extra = pageSnippet + ytSnippet;
      } catch {}
    }
    const content = body ? `Content:\n${body}` : '';
    return `${header}${urlLine}${content}${extra}\n\nTask: Write a concise, retrieval-friendly brief in plain text.\n- Start with one direct sentence explaining what this is and why it matters.\n- Add 2 to 4 short lines with concrete facts, decisions, dates, names, or actions.\n- End with "Topics: ..." and 5 to 8 concise entities, aliases, or useful search synonyms.\n- Preserve source-specific terminology; do not repeat the title or URL, and avoid generic filler.\n- If the source lacks enough evidence, say so rather than inventing details.\n- Do not number or bullet the output.`;
  };

  async function handleSummarize() {
    if (!aiService.isConfigured()) {
      setSumError('Configure the selected AI provider in Settings first.');
      return;
    }
    const itemId = String(item?.id);
    const itemTitle = String(title || item?.title || 'Untitled');
    onSummarizingChange?.(itemId, true);
    setSumError('');
    try {
      const prompt = await buildPrompt();
      const nextSummary = (await aiService.generate({
        prompt,
        system: 'Summarize saved items accurately. Return concise plain text only.',
        temperature: 0.2,
      })).trim();
      if (!nextSummary) throw new Error('The AI provider returned an empty summary.');
      if (activeItemIdRef.current === itemId) setSummary(nextSummary);
      try { await invoke('update_vault_item_summary', { itemId: Number(itemId), summary: nextSummary }); } catch {}
      try { if (onUpdateSummary) await onUpdateSummary(itemId, nextSummary); } catch {}
      if (activeItemIdRef.current !== itemId) showSuccess(`Summary ready for "${itemTitle}".`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (activeItemIdRef.current === itemId) setSumError(message);
      else showError(`Could not summarize "${itemTitle}": ${message}`);
    } finally {
      onSummarizingChange?.(itemId, false);
    }
  }

  const isConflict = title?.includes('[Conflict]');
  const contentIsUrl = looksLikeUrl(contentEdit);
  const contentDirty = contentEdit !== lastSavedContent;
  const host = (() => { try { return new URL(contentEdit).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const youtubeId = isUrl ? getYouTubeId(contentEdit) : null;

  return (
    <aside className={styles.panel} data-testid="item-panel" aria-label="Item details">
      <div className={styles.header}>
        <span className={styles.panelKind}>{isUrl ? 'Link' : 'Note'}</span>
        <div className={styles.headerActions}>
          <div className={styles.menuWrap}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => onUpdateImage(String(item?.id), reader.result as string);
                reader.readAsDataURL(file);
                setImgMenuOpen(false);
              }}
            />
            <button type="button" className={styles.iconButton} aria-haspopup="menu" aria-expanded={imgMenuOpen} aria-label="More actions" onClick={() => setImgMenuOpen(v => !v)}>
              <EllipsisVerticalIcon className={styles.iconButtonSvg} />
            </button>
            {imgMenuOpen && (
              <div className={styles.menu} role="menu">
                <button className={styles.menuItem} role="menuitem" onClick={() => fileInputRef.current?.click()}>Upload image…</button>
                <button className={styles.menuItem} role="menuitem" onClick={async () => {
                  const url = await promptDialog({
                    title: 'Use image URL',
                    message: 'Paste a direct image link to use as the cover.',
                    label: 'Image URL',
                    inputType: 'url',
                    placeholder: 'https://example.com/image.jpg',
                    confirmLabel: 'Use image'
                  });
                  if (!url) return;
                  try { new URL(url); } catch { showWarning('Invalid URL.'); return; }
                  onUpdateImage(String(item?.id), url);
                  setImgMenuOpen(false);
                }}>From URL…</button>
                <button className={styles.menuItem} role="menuitem" onClick={async () => {
                  try {
                    setIsPasting(true);
                    if (navigator.clipboard?.read) {
                      const clipboardItems = await navigator.clipboard.read();
                      let found = false;
                      for (const clipboardItem of clipboardItems) {
                        const type = clipboardItem.types.find(value => value.startsWith('image/'));
                        if (!type) continue;
                        const blob = await clipboardItem.getType(type);
                        const reader = new FileReader();
                        reader.onload = () => onUpdateImage(String(item?.id), reader.result as string);
                        reader.readAsDataURL(blob);
                        found = true;
                        break;
                      }
                      if (!found) showWarning('Clipboard has no image.');
                    } else {
                      showWarning('Clipboard image read not supported here.');
                    }
                  } catch {
                    showError('Failed to read clipboard.');
                  } finally {
                    setIsPasting(false);
                    setImgMenuOpen(false);
                  }
                }}>{isPasting ? 'Reading…' : 'Paste from clipboard'}</button>
                <button className={styles.menuItem} role="menuitem" onClick={() => {
                  onUpdateImage(String(item?.id), generateMeshGradientDataURL({ width: 640, height: 420 }));
                  setImgMenuOpen(false);
                }}>Randomize mesh gradient</button>
                {item?.image && <button className={styles.menuItem} role="menuitem" onClick={() => { onUpdateImage(String(item?.id), null); setImgMenuOpen(false); }}>Remove image</button>}
                <div className={styles.menuDivider} />
                <button className={styles.menuItemDanger} role="menuitem" onClick={() => { setImgMenuOpen(false); onDelete(String(item?.id)); }}>Delete item</button>
              </div>
            )}
          </div>
          <button className={styles.iconButton} aria-label="Close item details" onClick={onClose}><XMarkIcon className={styles.iconButtonSvg} /></button>
        </div>
      </div>
      <div className={styles.body} data-testid="item-panel-scroll">
        {youtubeId ? (
          <div className={styles.previewVideo}>
            <iframe
              src={youtubeEmbedUrl(youtubeId)}
              sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              title="YouTube video"
            />
          </div>
        ) : item?.image ? (
          <div className={styles.previewWrapper}>
            <img className={styles.previewImg} src={item.image} alt={`${title || 'Item'} preview`} />
          </div>
        ) : null}

        <div className={styles.contentStack}>
          <section className={styles.identity}>
            {editingTitle ? (
              <input
                autoFocus
                className={styles.titleInput}
                aria-label="Item title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => { setEditingTitle(false); if (title && title !== item?.title) onRename(String(item?.id), title); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') { setTitle(item?.title || ''); setEditingTitle(false); }
                }}
              />
            ) : (
              <button type="button" className={styles.titleDisplay} aria-label="Edit item title" onClick={() => setEditingTitle(true)}>{title || 'Untitled'}</button>
            )}
            {isConflict && <span className={styles.conflictBadge}>Sync conflict</span>}
            {isUrl && (
              <div className={styles.linkIdentity}>
                <span>{host}</span>
                <a href={contentEdit} onClick={(e) => { e.preventDefault(); window.open(contentEdit, '_blank'); }}>Open link ↗</a>
              </div>
            )}
          </section>

          {isConflict && (
            <div className={styles.conflictNotice}>
              <strong>This item was created during a sync conflict.</strong>
              <span>Compare it with the original, then keep the version you want.</span>
            </div>
          )}

          <section className={styles.summarySection} aria-busy={summarizing}>
            <div className={styles.summaryHeader}>
              <div>
                <h2>AI summary</h2>
                <span className={styles.providerStatus}>{aiStatus.name}{aiStatus.configured ? '' : ' · setup needed'}</span>
              </div>
              <button className={styles.summaryButton} onClick={handleSummarize} disabled={summarizing || !aiStatus.configured}>
                {summarizing ? 'Generating…' : summary ? 'Refresh' : 'Generate'}
              </button>
            </div>
            {sumError && <p className={styles.summaryError} role="alert">{sumError}</p>}
            {summarizing && !summary ? (
              <div className={styles.summarySkeleton} aria-label="Generating summary"><span /><span /><span /></div>
            ) : summary ? (
              <div className={styles.summaryText}>{summary}</div>
            ) : (
              <p className={styles.summaryEmpty}>{aiStatus.configured ? 'No summary yet.' : `Set up ${aiStatus.name} in Settings to generate one.`}</p>
            )}
          </section>

          <section className={`${styles.fieldSection} ${contentIsUrl ? styles.urlSection : ''}`}>
          <div className={styles.sectionHeading}>
            <label className={styles.sectionLabel} htmlFor={`item-content-${item?.id}`}>{contentIsUrl ? 'URL' : 'Content'}</label>
            <span className={styles.saveState} aria-live="polite">{savingContent ? 'Saving…' : contentDirty ? 'Unsaved' : ''}</span>
          </div>
          {editingContent && contentIsUrl ? (
            <input
              autoFocus
              id={`item-content-${item?.id}`}
              type="url"
              className={styles.contentInput}
              value={contentEdit}
              onChange={(e) => setContentEdit(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void saveContent(); (e.target as HTMLInputElement).blur(); } }}
              onBlur={() => { void saveContent(); setEditingContent(false); }}
              placeholder={'Enter URL…'}
            />
          ) : editingContent ? (
            <textarea
              autoFocus
              id={`item-content-${item?.id}`}
              className={`${styles.contentInput} ${styles.contentTextarea}`}
              value={contentEdit}
              onChange={(e) => setContentEdit(e.target.value)}
              onBlur={() => { void saveContent(); setEditingContent(false); }}
              placeholder={'Write your note...'}
            />
          ) : (
            <button type="button" className={`${styles.contentDisplay} ${contentEdit ? '' : styles.contentDisplayEmpty}`} aria-label={contentIsUrl ? 'Edit URL' : 'Edit content'} onClick={() => setEditingContent(true)}>
              {contentEdit || (contentIsUrl ? 'Add URL' : 'Add content')}
            </button>
          )}
        </section>

        <dl className={styles.meta}>
          <div><dt>Type</dt><dd>{item?.metadata?.item_type === 'url' ? 'Link' : 'Note'}</dd></div>
          <div><dt>Created</dt><dd>{formatDate(item?.metadata?.created_at)}</dd></div>
          <div><dt>Updated</dt><dd>{formatDate(item?.metadata?.updated_at)}</dd></div>
        </dl>

        {relatedItems.length > 0 && (
          <section className={styles.relatedSection} aria-labelledby="related-items-title">
            <h2 id="related-items-title">Related</h2>
            <div className={styles.relatedList}>
              {relatedItems.map((related) => (
                <button key={related.id} type="button" onClick={() => onSelectRelated?.(related)} aria-label={`Open related item ${related.title}`}>
                  <small>{related.metadata?.item_type === 'url' ? 'Link' : 'Note'}</small>
                  <strong>{related.title}</strong>
                  <span>{related.summary || related.metadata?.preview_description || related.content}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        </div>
      </div>
      <div className={styles.footer}>
        <select className={styles.select} aria-label="Move item to vault" value={targetVault} onChange={(e) => setTargetVault(e.target.value)}>
          {vaults.map(v => (
            <option key={v.id} value={v.id}>{v.title}</option>
          ))}
        </select>
        <button className={styles.primaryBtn} onClick={() => onMove(String(item?.id), targetVault)} disabled={targetVault === currentVaultId}>Move</button>
      </div>
    </aside>
  );
};

export default ItemPanel;
