import React from 'react';
import styles from './Header.module.css';
import SplitText from '../SplitText/SplitText';

const Header = ({ title = 'All Vaults', onCreateVault, onCreateNote, showVaultButton = false }) => {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>
        <SplitText
          key={title}
          text={title}
          className={styles.title}
          delay={50}
          animationFrom={{ opacity: 0, transform: 'translate3d(0,40px,0)' }}
          animationTo={{ opacity: 1, transform: 'translate3d(0,0,0)' }}
          easing={(t) => t}
          threshold={0.2}
          rootMargin="-50px"
        />
      </h1>
      
      {/* Top bar tabs removed: Library, Vaults, Connections */}
      
      <div className={styles.actions}>
        {/* Primary action - Create Note */}
        <button className={styles.primaryButton} onClick={onCreateNote} data-testid="floating-capture-button">
          <span className={styles.icon}>+</span>
          <span>NEW NOTE</span>
        </button>

        {/* Secondary action - Create Vault (only show in knowledge tab) */}
        {showVaultButton && (
          <button className={styles.secondaryButton} onClick={onCreateVault} data-testid="create-vault-button">
            <span className={styles.icon}>+</span>
            <span>NEW VAULT</span>
          </button>
        )}
      </div>
    </header>
  );
};

export default Header;
