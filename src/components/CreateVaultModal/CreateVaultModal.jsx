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
        className={styles.modal}
        data-testid="create-vault-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-vault-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="create-vault-title" className={styles.title}>Create vault</h2>
          <button className={styles.closeButton} onClick={handleClose} aria-label="Close"><XMarkIcon className={styles.closeIcon} /></button>
        </div>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label htmlFor="vault-name">Vault Name</label>
            <input
              id="vault-name"
              type="text"
              className={styles.input}
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              required
              placeholder="Enter vault name"
              data-testid="vault-name-input"
            />
          </div>
          <div className={styles.field} style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
            <input
              id="vault-has-password"
              type="checkbox"
              checked={hasPassword}
              onChange={e => setHasPassword(e.target.checked)}
              data-testid="vault-has-password-checkbox"
              style={{ width: 'auto', margin: 0 }}
            />
            <label htmlFor="vault-has-password" style={{ margin: 0 }}>
              Protect with password
            </label>
          </div>
          {hasPassword && (
            <div className={styles.field}>
              <label htmlFor="vault-password">Password</label>
              <input
                id="vault-password"
                type="password"
                className={styles.input}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter password"
                data-testid="vault-password-input"
              />
            </div>
          )}
          {error && <div className={styles.error} role="alert">{error}</div>}
          <div className={styles.actions}>
            <Button variant="secondary" type="button" onClick={handleClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" data-testid="create-vault-submit">
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateVaultModal;
