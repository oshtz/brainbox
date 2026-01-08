import React, { useEffect, useRef } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import styles from '../CaptureModal/CaptureModal.module.css';
import Button from '../Button/Button';

/**
 * A lightweight, app-styled confirmation dialog.
 *
 * Props:
 * - isOpen: boolean — controls visibility
 * - title: string — dialog title
 * - message?: string | React.ReactNode — optional message/body
 * - confirmLabel?: string — default "Confirm"
 * - cancelLabel?: string — default "Cancel"
 * - onConfirm: () => void
 * - onCancel?: () => void
 * - onClose: () => void — called when backdrop/close or cancel
 */
const ConfirmDialog = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  onClose,
}) => {
  const modalRef = useRef(null);

  // Close on Escape, focus default button on open
  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
      if ((e.key === 'Enter' || e.key === 'NumpadEnter') && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        onConfirm?.();
      }
    };

    document.addEventListener('keydown', handleKey, true);
    // Focus the primary action when opened
    const t = setTimeout(() => {
      try {
        const btn = modalRef.current?.querySelector('button[data-primary="true"]');
        btn?.focus();
      } catch {}
    }, 0);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      clearTimeout(t);
    };
  }, [isOpen, onClose, onConfirm]);

  if (!isOpen) return null;

  const handleCancel = () => {
    onCancel?.();
    onClose?.();
  };

  const handleConfirm = () => {
    onConfirm?.();
    onClose?.();
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        ref={modalRef}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <div className={styles.header}>
          <h2 id="confirm-dialog-title" className={styles.title}>{title}</h2>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close"><XMarkIcon className={styles.closeIcon} /></button>
        </div>

        {message ? (
          <div className={styles.form}>
            <div style={{ color: 'var(--color-text-secondary)' }}>
              {message}
            </div>
          </div>
        ) : null}

        <div className={styles.form}>
          <div className={styles.actions}>
            <Button variant="secondary" type="button" onClick={handleCancel}>
              {cancelLabel}
            </Button>
            <Button type="button" onClick={handleConfirm} data-primary="true">
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
