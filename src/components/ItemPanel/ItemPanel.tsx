import React, { useEffect, useRef, useState } from 'react';
import { XMarkIcon, EllipsisVerticalIcon } from '@heroicons/react/24/outline';
import styles from './ItemPanel.module.css';
import { generateMeshGradientDataURL } from '../../utils/meshGradient';
import { getYouTubeId, youtubeEmbedUrl, isUrl as looksLikeUrl } from '../../utils/urlPreview';
import LinkPreview from '../LinkPreview/LinkPreview';
import { streamGenerate } from '../../utils/ollama';
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
  onSummarizingChange?: (busy: boolean) => void;
}

const ItemPanel: React.FC<Props> = ({ item, vaults, currentVaultId, onClose, onRename, onMove, onUpdateImage, onDelete, onUpdateSummary, onUpdateContent, onSummarizingChange }) => {
  const { getVaultKey } = useVaultPassword();
  const { showError, showWarning } = useToast();
  const promptDialog = usePrompt();
  const [title, setTitle] = useState(item?.title || '');
  const [targetVault, setTargetVault] = useState<string>(currentVaultId || vaults?.[0]?.id || '');
  const isUrl = item?.metadata?.item_type === 'url' || looksLikeUrl(item?.content);
  const contentText: string = (item?.content_preview || item?.content || '').toString();
  const [contentEdit, setContentEdit] = useState<string>(contentText);
  const [savingContent, setSavingContent] = useState(false);
  const [lastSavedContent, setLastSavedContent] = useState<string>(contentText);
  // removed unused hash/copy helpers
  const [isPasting, setIsPasting] = useState(false);
  const [imgMenuOpen, setImgMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [summary, setSummary] = useState<string>(item?.summary || '');
  const [summarizing, setSummarizing] = useState(false);
  const [sumError, setSumError] = useState('');

  // Notify parent when summarizing state changes so it can lock selection
  useEffect(() => {
    try { onSummarizingChange?.(summarizing); } catch {}
  }, [summarizing]);

  // Auto-save title edits when switching items, then sync local UI
  const prevItemRef = React.useRef<{ id?: string | number, title?: string } | null>(null);
  React.useEffect(() => {
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
    const initial = item?.content?.toString() || '';
    setContentEdit(initial);
    setLastSavedContent(initial);
    setSummary(item?.summary || '');
    setSumError('');
    // Auto-generate summary if missing
    if (!item?.summary) {
      // fire and forget to not block UI
      void handleSummarize(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const formatDate = (s?: string) => {
    if (!s) return 'N/A';
    const d = new Date(s);
    if (isNaN(d.getTime())) return 'N/A';
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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
      // Auto-regenerate summary after any content changes
      await handleSummarize(false);
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
    const title = String(item?.title || '').trim();
    const body = looksLikeUrl(contentEdit) ? '' : String(contentEdit || '').trim();
    const url = looksLikeUrl(contentEdit) ? String(contentEdit || '') : '';
    const header = title ? `Title: ${title}\n` : '';
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
    return `${header}${urlLine}${content}${extra}\n\nTask: Provide a concise, helpful summary in plain text.\n- 3 to 6 short bullet-style lines without markdown\n- Clear, neutral tone\n- Include key facts and any actionable items`;
  };

  async function handleSummarize(_manual = true) {
    setSummarizing(true);
    setSumError('');
    // Replace existing summary visually before streaming new one
    setSummary('');
    try {
      const prompt = await buildPrompt();
      let full = '';
      await streamGenerate(prompt, {
        onToken: (t) => { full += t; setSummary(full); },
        onDone: async () => {
          try { await invoke('update_vault_item_summary', { itemId: Number(item?.id), summary: full.trim() }); } catch {}
          try { if (onUpdateSummary) await onUpdateSummary(String(item?.id), full.trim()); } catch {}
        }
      });
      // stop() can be used to cancel if needed later
    } catch (e) {
      setSumError(String(e));
    } finally {
      setSummarizing(false);
    }
  }

  const isConflict = title?.includes('[Conflict]');

  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <input className={styles.titleInput} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => { if (title && title !== item?.title) { onRename(String(item?.id), title); } }} />
          {isConflict && (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              marginLeft: 8,
              padding: '2px 8px',
              borderRadius: 4,
              background: 'rgba(245, 158, 11, 0.15)',
              color: '#f59e0b',
              fontSize: '0.75rem',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}>
              Sync Conflict
            </span>
          )}
        </div>
        <button className={styles.iconButton} aria-label="Close" onClick={onClose}><XMarkIcon className={styles.iconButtonSvg} /></button>
      </div>
      <div className={styles.body}>
        {isConflict && (
          <div style={{
            padding: '12px 16px',
            marginBottom: 16,
            borderRadius: 8,
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            color: 'var(--color-text-secondary)',
            fontSize: '0.9rem',
            lineHeight: 1.5,
          }}>
            <strong style={{ color: '#f59e0b' }}>This item was created during a sync conflict.</strong>
            <br />
            Compare this with the original, then keep the one you want and delete the other. You can rename this item to remove the "[Conflict]" suffix.
          </div>
        )}
        {isUrl ? (
          (() => {
            const yt = getYouTubeId(item?.content);
            if (yt) {
              return (
                <div className={styles.preview}>
                  <div style={{position: 'relative', paddingBottom: '56.25%', height: 0}}>
                    <iframe
                      src={youtubeEmbedUrl(yt)}
                      style={{position: 'absolute', inset: 0, width: '100%', height: '100%', border: '0'}}
                      sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                      allow={'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'}
                      title={'YouTube video'}
                    />
                  </div>
                </div>
              );
            }
            return (
              <div className={styles.preview}>
                <LinkPreview
                  url={String(item?.content)}
                  onImageFound={(img) => {
                    if (!item?.image) {
                      onUpdateImage(String(item?.id), img);
                    }
                  }}
                />
              </div>
            );
          })()
        ) : (
          item?.image ? (
            <div className={styles.previewWrapper}>
              <img className={styles.previewImg} src={item.image} alt="Preview" />
              <div className={styles.menuWrap}>
                <button
                  type="button"
                  className={styles.menuButton}
                  aria-haspopup="true"
                  aria-expanded={imgMenuOpen}
                  aria-label="Image options"
                  title="Image options"
                  onClick={(e) => { e.stopPropagation(); setImgMenuOpen(v => !v); }}
                >
                  <EllipsisVerticalIcon className={styles.menuButtonSvg} />
                </button>
                {imgMenuOpen && (
                  <div className={styles.menu} role="menu" onClick={(e) => e.stopPropagation()}>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                          const dataUrl = reader.result as string;
                          onUpdateImage(String(item?.id), dataUrl);
                          setImgMenuOpen(false);
                        };
                        reader.readAsDataURL(file);
                      }}
                    />
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
                        if (navigator.clipboard && navigator.clipboard.read) {
                          const items = await navigator.clipboard.read();
                          let found = false;
                          for (const ci of items) {
                            for (const type of ci.types) {
                              if (type.startsWith('image/')) {
                                const blob = await ci.getType(type);
                                const reader = new FileReader();
                                reader.onload = () => onUpdateImage(String(item?.id), reader.result as string);
                                reader.readAsDataURL(blob);
                                found = true;
                                break;
                              }
                            }
                            if (found) break;
                          }
                          if (!found) showWarning('Clipboard has no image.');
                        } else {
                          showWarning('Clipboard image read not supported here.');
                        }
                      } catch (e) {
                        showError('Failed to read clipboard.');
                      } finally {
                        setIsPasting(false);
                        setImgMenuOpen(false);
                      }
                    }}>{isPasting ? 'Reading…' : 'Paste from clipboard'}</button>
                    <button className={styles.menuItem} role="menuitem" onClick={() => {
                      const dataUrl = generateMeshGradientDataURL({ width: 640, height: 420 });
                      onUpdateImage(String(item?.id), dataUrl);
                      setImgMenuOpen(false);
                    }}>Randomize mesh gradient</button>
                    {item?.image && (
                      <button className={styles.menuItemDanger} role="menuitem" onClick={() => { onUpdateImage(String(item?.id), null); setImgMenuOpen(false); }}>Remove image</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : null
        )}
        <div style={{ width: '100%' }}>
          <label style={{ display: 'block', fontSize: '0.9rem', color: 'var(--color-text-secondary)', marginBottom: 6 }}>{looksLikeUrl(contentEdit) ? 'URL' : 'Content'}</label>
          {looksLikeUrl(contentEdit) ? (
            <input
              type="url"
              value={contentEdit}
              onChange={(e) => setContentEdit(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void saveContent(); (e.target as HTMLInputElement).blur(); } }}
              onBlur={() => { void saveContent(); }}
              placeholder={'Enter URL…'}
              style={{ width: '100%', height: 40, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text-primary)' }}
            />
          ) : (
            <textarea
              value={contentEdit}
              onChange={(e) => setContentEdit(e.target.value)}
              onBlur={() => { void saveContent(); }}
              placeholder={'Write your note...'}
              style={{ width: '100%', minHeight: 160, resize: 'vertical', padding: 12, borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text-primary)' }}
            />
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className={styles.menuItem} onClick={() => saveContent()} disabled={savingContent}>Save</button>
            {savingContent && <span style={{ color: 'var(--color-text-secondary)', alignSelf: 'center' }}>Saving…</span>}
          </div>
        </div>
        <div className={styles.meta}>
          <div><strong>Type:</strong> {item?.metadata?.item_type || 'N/A'}</div>
          <div><strong>Created:</strong> {formatDate(item?.metadata?.created_at)}</div>
          <div><strong>Updated:</strong> {formatDate(item?.metadata?.updated_at)}</div>
        </div>

        <div style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 8px 0' }}>AI Summary</h3>
          {sumError && <div style={{ color: 'var(--color-danger, #ef4444)', marginBottom: 8 }}>{sumError}</div>}
          {summary ? (
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0, padding: 12, border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-elevated)' }}>{summary}</pre>
          ) : (
            <div style={{ color: 'var(--color-text-secondary)' }}>{summarizing ? 'Summarizing…' : 'No summary yet.'}</div>
          )}
          <div style={{ marginTop: 8 }}>
            <button className={styles.menuItem} onClick={() => handleSummarize(true)} disabled={summarizing}>
              {summarizing ? 'Generating…' : (summary ? 'Regenerate summary' : 'Generate summary')}
            </button>
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        <select className={styles.select} value={targetVault} onChange={(e) => setTargetVault(e.target.value)}>
          {vaults.map(v => (
            <option key={v.id} value={v.id}>{v.title}</option>
          ))}
        </select>
        <button className={styles.primaryBtn} onClick={() => onMove(String(item?.id), targetVault)} disabled={targetVault === currentVaultId}>Move</button>
        <button className={styles.dangerBtn} onClick={() => onDelete(String(item?.id))}>Delete</button>
      </div>
    </aside>
  );
};

export default ItemPanel;
