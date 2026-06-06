import React, { useState } from 'react';
import { EllipsisVerticalIcon } from '@heroicons/react/24/outline';
import styles from './VaultCard.module.css';

const VaultCard = ({
  title,
  backgroundImage,
  color = '#f0f0f0',
  children,
  priceTag,
  locked = false,
  updatedAt,
  onClick,
  onDelete,
  onRename,
  onChangeCover,
  onChangePassword
}) => {
  const thumbnailStyle = backgroundImage
    ? { backgroundImage: `url(${backgroundImage})` }
    : { backgroundColor: color };
  const initial = typeof title === 'string' && title.trim().length > 0 ? title.trim()[0].toUpperCase() : 'V';
  const updatedLabel = updatedAt ? `Updated ${new Date(updatedAt).toLocaleDateString()}` : 'Vault';

  const [menuOpen, setMenuOpen] = useState(false);
  const toggleMenu = (e) => { e.stopPropagation(); setMenuOpen(o => !o); };
  const closeMenu = (e) => { e?.stopPropagation?.(); setMenuOpen(false); };

  return (
    <div
      className={styles.card}
      onClick={onClick}
      tabIndex={0}
      role="button"
      aria-label={`Open vault ${title}`}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
      data-testid="vault-card"
    >
      {priceTag && (
        <span className={styles.priceTag}>{priceTag}</span>
      )}
      <div className={styles.thumbnail} style={thumbnailStyle} aria-hidden="true">
        <span className={styles.initial}>{initial}</span>
      </div>
      <div className={styles.content}>
        <div className={styles.titleRow}>
          <span className={styles.label} title={title}>{title}</span>
        </div>
        <div className={styles.metaRow}>
          <span className={`${styles.statusDot} ${locked ? styles.locked : ''}`} />
          <span>{locked ? 'Protected' : 'Open'}</span>
          <span className={styles.metaDivider}>/</span>
          <span>{updatedLabel}</span>
        </div>
        {children && <div className={styles.body}>{children}</div>}
      </div>
      <div className={styles.actions}>
        {(onDelete || onRename || onChangeCover || onChangePassword) && (
          <div className={styles.menuWrap}>
            <button
              type="button"
              className={styles.menuButton}
              aria-haspopup="true"
              aria-expanded={menuOpen}
              aria-label={`Vault options for ${title}`}
              title="Vault options"
              onClick={toggleMenu}
            >
              <EllipsisVerticalIcon className={styles.menuIcon} />
            </button>
            {menuOpen && (
              <div className={styles.menu} role="menu" onClick={(e) => e.stopPropagation()}>
                {onRename && (
                  <button className={styles.menuItem} role="menuitem" onClick={(e) => { e.stopPropagation(); closeMenu(e); onRename?.(); }}>Rename</button>
                )}
                {onChangeCover && (
                  <button className={styles.menuItem} role="menuitem" onClick={(e) => { e.stopPropagation(); closeMenu(e); onChangeCover?.(); }}>Change cover image</button>
                )}
                {onChangePassword && (
                  <button className={styles.menuItem} role="menuitem" onClick={(e) => { e.stopPropagation(); closeMenu(e); onChangePassword?.(); }}>Change password</button>
                )}
                {onDelete && (
                  <button className={styles.menuItemDanger} role="menuitem" onClick={(e) => { e.stopPropagation(); closeMenu(e); onDelete?.(); }}>Delete</button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default VaultCard;
