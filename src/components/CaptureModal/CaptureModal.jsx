import React, { useState, useEffect } from 'react';
import styles from './CaptureModal.module.css';
import Button from '../Button/Button';
import { isUrl as looksLikeUrl, getYouTubeId, youtubeEmbedUrl } from '../../utils/urlPreview';
import LinkPreview from '../LinkPreview/LinkPreview';

const LAST_USED_VAULT_KEY = 'brainbox-last-used-vault-id';

const CaptureModal = ({ isOpen, onClose, onSave, vaults = [], initialTitle = '', initialContent = '' }) => {
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [selectedVault, setSelectedVault] = useState('');
  
  // Use vaults prop for dropdown
  const vaultOptions = vaults;

  // Effect: when modal opens or vaults change, set default vault selection
  useEffect(() => {
    if (!isOpen) return;
    // If only one vault, auto-select it
    if (vaultOptions.length === 1) {
      setSelectedVault(vaultOptions[0].id);
      return;
    }
    // Try to restore last used vault
    const lastUsed = localStorage.getItem(LAST_USED_VAULT_KEY);
    if (lastUsed && vaultOptions.some(v => v.id === lastUsed)) {
      setSelectedVault(lastUsed);
      return;
    }
    // Otherwise, reset selection
    setSelectedVault('');
  }, [isOpen, vaultOptions]);

  // Reset fields when modal opens or initial values change
  useEffect(() => {
    if (isOpen) {
      setTitle(initialTitle);
      setContent(initialContent);
    }
  }, [isOpen, initialTitle, initialContent]);

  // When user selects a vault, persist it
  const handleVaultChange = (e) => {
    setSelectedVault(e.target.value);
    localStorage.setItem(LAST_USED_VAULT_KEY, e.target.value);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({ title, content, vaultId: selectedVault });
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
        aria-labelledby="capture-modal-title"
        data-testid="capture-modal"
      >
        <header className={styles.header}>
          <h2 id="capture-modal-title" className={styles.title}>Quick Capture</h2>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </header>
        
        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="capture-title">Title</label>
            <input
              id="capture-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Give your note a title..."
              required
              className={styles.input}
              data-testid="capture-title-input"
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="capture-content">Content</label>
            <textarea
              id="capture-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="What's on your mind?"
              rows={5}
              className={styles.textarea}
              data-testid="capture-content-input"
            />
            {urlPreview}
          </div>

          <div className={styles.field}>
            <label htmlFor="capture-vault">Save to Vault</label>
            <select
              id="capture-vault"
              value={selectedVault}
              onChange={handleVaultChange}
              required
              className={styles.select}
              data-testid="capture-vault-select"
            >
              <option value="" disabled>Select a vault...</option>
              {vaultOptions.map(vault => (
                <option key={vault.id} value={vault.id}>
                  {vault.title || vault.name}
                </option>
              ))}
            </select>
          </div>
          
          <div className={styles.actions}>
            <Button variant="secondary" type="button" onClick={handleReset} data-testid="capture-cancel-button">
              Reset
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
