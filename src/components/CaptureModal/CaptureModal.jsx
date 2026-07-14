import React, { useState, useEffect, useRef } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import styles from './CaptureModal.module.css';
import Button from '../Button/Button';
import { isUrl as looksLikeUrl, getYouTubeId, youtubeEmbedUrl } from '../../utils/urlPreview';
import LinkPreview from '../LinkPreview/LinkPreview';

const LAST_USED_VAULT_KEY = 'brainbox-last-used-vault-id';

const deriveTitle = (content) => {
  const trimmed = content.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.replace(/^www\./, '');
    } catch {}
  }
  return trimmed.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) || 'Untitled note';
};

const CaptureModal = ({ isOpen, onClose, onSave, vaults = [], initialVaultId = '', initialTitle = '', initialContent = '' }) => {
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [selectedVault, setSelectedVault] = useState('');
  const contentRef = useRef(null);
  
  // Use vaults prop for dropdown
  const vaultOptions = vaults;

  // Effect: when modal opens or vaults change, set default vault selection
  useEffect(() => {
    if (!isOpen) return;
    if (initialVaultId && vaultOptions.some(v => v.id === initialVaultId)) {
      setSelectedVault(initialVaultId);
      return;
    }
    // Try to restore last used vault
    const lastUsed = localStorage.getItem(LAST_USED_VAULT_KEY);
    if (lastUsed && vaultOptions.some(v => v.id === lastUsed)) {
      setSelectedVault(lastUsed);
      return;
    }
    const inbox = vaultOptions.find(v => (v.title || v.name || '').toLowerCase() === 'inbox');
    setSelectedVault(inbox?.id || vaultOptions[0]?.id || '');
  }, [isOpen, initialVaultId, vaultOptions]);

  // Reset fields when modal opens or initial values change
  useEffect(() => {
    if (isOpen) {
      setTitle(initialTitle);
      setContent(initialContent);
      requestAnimationFrame(() => contentRef.current?.focus());
    }
  }, [isOpen, initialTitle, initialContent]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [isOpen, onClose]);

  // When user selects a vault, persist it
  const handleVaultChange = (e) => {
    setSelectedVault(e.target.value);
    localStorage.setItem(LAST_USED_VAULT_KEY, e.target.value);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const finalTitle = title.trim() || deriveTitle(content);
    onSave({ title: finalTitle, content: content.trim(), vaultId: selectedVault });
    handleReset();
    onClose();
  };

  const handleReset = () => {
    setTitle('');
    setContent('');
    setSelectedVault('');
  };

  if (!isOpen) return null;

  const urlPreview = looksLikeUrl(content) ? (
    <div style={{marginTop: '8px'}}>
      {(() => {
        const yt = getYouTubeId(content);
        if (yt) {
          return (
            <div style={{position: 'relative', paddingBottom: '56.25%', height: 0, borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--color-border)'}}>
              <iframe
                src={youtubeEmbedUrl(yt)}
                style={{position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0}}
                sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                allow={'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'}
                title={'YouTube video'}
              />
            </div>
          );
        }
        return <LinkPreview url={content} compact />;
      })()}
    </div>
  ) : null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="capture-modal-title"
        aria-describedby="capture-modal-description"
        data-testid="capture-modal"
      >
        <header className={styles.header}>
          <div>
            <h2 id="capture-modal-title" className={styles.title}>Quick capture</h2>
            <p id="capture-modal-description" className={styles.description}>Paste a thought or link. The title is optional.</p>
          </div>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close">
            <XMarkIcon className={styles.closeIcon} />
          </button>
        </header>
        
        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="capture-content">Note or link</label>
            <textarea
              ref={contentRef}
              id="capture-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Paste anything or start typing…"
              rows={4}
              required
              aria-keyshortcuts="Control+Enter Meta+Enter"
              className={styles.textarea}
              data-testid="capture-content-input"
            />
            {urlPreview}
          </div>

          <details className={styles.details}>
            <summary>Title and destination</summary>
            <div className={styles.field}>
              <label htmlFor="capture-title">Title <span className={styles.optional}>(optional)</span></label>
              <input
                id="capture-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={deriveTitle(content)}
                className={styles.input}
                data-testid="capture-title-input"
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="capture-vault">Save to vault</label>
              <select
                id="capture-vault"
                value={selectedVault}
                onChange={handleVaultChange}
                required
                className={styles.select}
                data-testid="capture-vault-select"
              >
                {vaultOptions.map(vault => (
                  <option key={vault.id} value={vault.id}>
                    {vault.title || vault.name}
                  </option>
                ))}
              </select>
            </div>
          </details>
          
          <div className={styles.actions}>
            <Button variant="secondary" type="button" onClick={onClose} data-testid="capture-cancel-button">
              Cancel
            </Button>
            <Button type="submit" data-testid="capture-submit-button">
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CaptureModal;
