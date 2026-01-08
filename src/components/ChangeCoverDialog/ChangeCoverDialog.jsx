import React, { useRef, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import styles from '../CaptureModal/CaptureModal.module.css';
import Button from '../Button/Button';

/**
 * ChangeCoverDialog: lets the user pick a new cover image
 * Options:
 * - Image from URL
 * - Randomized mesh gradient
 * - Image from disk
 * - Clear
 */
const ChangeCoverDialog = ({
  isOpen,
  onClose,
  vaultTitle,
  onPickUrl,
  onPickMesh,
  onPickFile,
  onClear,
}) => {
  const [url, setUrl] = useState('');
  const fileInputRef = useRef(null);

  if (!isOpen) return null;

  const handleFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : null;
      if (dataUrl) onPickFile?.(dataUrl);
      onClose?.();
    };
    reader.readAsDataURL(file);
  };

  const applyUrl = () => {
    const clean = url.trim();
    if (!clean) return;
    onPickUrl?.(clean);
    onClose?.();
  };

  const applyMesh = () => {
    onPickMesh?.();
    onClose?.();
  };

  const applyClear = () => {
    onClear?.();
    onClose?.();
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-cover-title"
      >
        <div className={styles.header}>
          <h2 id="change-cover-title" className={styles.title}>Change Cover{vaultTitle ? ` — ${vaultTitle}` : ''}</h2>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close"><XMarkIcon className={styles.closeIcon} /></button>
        </div>

        <div className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="cover-url">Image from URL</label>
            <input
              id="cover-url"
              className={styles.input}
              type="text"
              placeholder="https://example.com/image.jpg"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div className={styles.actions}>
              <Button type="button" onClick={applyUrl} disabled={!url.trim()}>Apply URL</Button>
            </div>
          </div>

          <div className={styles.field}>
            <label>Randomized mesh gradient</label>
            <div className={styles.actions}>
              <Button type="button" onClick={applyMesh}>Generate</Button>
            </div>
          </div>

          <div className={styles.field}>
            <label>Image from disk</label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <div className={styles.actions}>
              <Button type="button" onClick={handleFileClick}>Choose File…</Button>
            </div>
          </div>

          <div className={styles.field}>
            <label>Clear cover</label>
            <div className={styles.actions}>
              <Button type="button" variant="secondary" onClick={applyClear}>Clear</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChangeCoverDialog;

