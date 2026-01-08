import React, { useEffect, useRef, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import Button from '../Button/Button';
import styles from '../CaptureModal/CaptureModal.module.css';

interface PromptDialogProps {
  isOpen: boolean;
  title: string;
  message?: React.ReactNode;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  inputType?: 'text' | 'password' | 'url';
  autoComplete?: string;
  required?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  onClose: () => void;
}

const PromptDialog: React.FC<PromptDialogProps> = ({
  isOpen,
  title,
  message,
  label = 'Value',
  placeholder,
  defaultValue = '',
  inputType = 'text',
  autoComplete,
  required = false,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  onClose
}) => {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setValue(defaultValue || '');
    setError('');
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [isOpen, defaultValue]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [isOpen, onClose]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (required && value.length === 0) {
      setError('This field is required.');
      return;
    }
    onConfirm(value);
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-dialog-title"
      >
        <div className={styles.header}>
          <h2 id="prompt-dialog-title" className={styles.title}>{title}</h2>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close">
            <XMarkIcon className={styles.closeIcon} />
          </button>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          {message ? (
            <div style={{ color: 'var(--color-text-secondary)', marginBottom: '1rem' }}>
              {message}
            </div>
          ) : null}

          <div className={styles.field}>
            {label && <label htmlFor="prompt-input">{label}</label>}
            <input
              id="prompt-input"
              ref={inputRef}
              className={styles.input}
              type={inputType}
              value={value}
              onChange={(e) => { setValue(e.target.value); if (error) setError(''); }}
              placeholder={placeholder}
              autoComplete={autoComplete}
            />
            {error && <div className={styles.error} role="alert">{error}</div>}
          </div>

          <div className={styles.actions}>
            <Button variant="secondary" type="button" onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button type="submit" data-primary="true">
              {confirmLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PromptDialog;
