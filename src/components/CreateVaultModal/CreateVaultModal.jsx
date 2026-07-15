import React, { useEffect, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import Button from '../Button/Button';
import styles from '../CaptureModal/CaptureModal.module.css'; // Reuse modal styles

const CreateVaultModal = ({ isOpen, onClose, onCreate, initialName = '' }) => {
  const [name, setName] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setName(initialName);
    const handleKey = (event) => {
      if (event.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [isOpen, initialName]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Vault name is required');
      return;
    }
    if (hasPassword && !password) {
      setError('Password is required when protection is enabled');
      return;
    }
    setError('');
    onCreate({
      name: name.trim(),
      password: hasPassword ? password : '',
      has_password: hasPassword
    });
    setName('');
    setPassword('');
    setHasPassword(false);
    onClose();
  };

  const handleClose = () => {
    setName('');
    setPassword('');
    setHasPassword(false);
    setError('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div
        className={`${styles.modal} ${styles.createVaultModal}`}
        data-testid="create-vault-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-vault-title"
        aria-describedby="create-vault-description"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={`${styles.header} ${styles.createVaultHeader}`}>
          <div>
            <h2 id="create-vault-title" className={`${styles.title} ${styles.createVaultTitle}`}>Create a vault</h2>
            <p id="create-vault-description" className={styles.description}>Keep related notes and links together.</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={handleClose} aria-label="Close"><XMarkIcon className={styles.closeIcon} /></button>
        </div>
        <form className={`${styles.form} ${styles.createVaultForm}`} onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label htmlFor="vault-name">Name</label>
            <input
              id="vault-name"
              type="text"
              className={styles.input}
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              required
              placeholder="e.g. Research"
              data-testid="vault-name-input"
              aria-invalid={error && !name.trim() ? 'true' : undefined}
            />
          </div>
          <label className={styles.passwordOption} htmlFor="vault-has-password">
            <span className={styles.passwordOptionCopy}>
              <span className={styles.passwordOptionTitle}>Password protection</span>
              <span className={styles.passwordOptionDescription}>Require a password to open this vault.</span>
            </span>
            <input
              id="vault-has-password"
              type="checkbox"
              className={styles.switch}
              checked={hasPassword}
              onChange={e => setHasPassword(e.target.checked)}
              data-testid="vault-has-password-checkbox"
            />
          </label>
          {hasPassword && (
            <div className={styles.field}>
              <label htmlFor="vault-password">Password</label>
              <input
                id="vault-password"
                type="password"
                className={styles.input}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Choose a password"
                autoComplete="new-password"
                data-testid="vault-password-input"
                aria-invalid={error && !password ? 'true' : undefined}
              />
            </div>
          )}
          {error && <div className={styles.error} role="alert">{error}</div>}
          <div className={styles.actions}>
            <Button variant="ghost" type="button" onClick={handleClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" data-testid="create-vault-submit">
              Create vault
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateVaultModal;
