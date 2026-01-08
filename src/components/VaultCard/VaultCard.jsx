import React, { useState } from 'react';
import { EllipsisVerticalIcon } from '@heroicons/react/24/outline';
import styles from './VaultCard.module.css';

const VaultCard = ({
  title,
  backgroundImage,
  color = '#f0f0f0',
  children,
  priceTag,
  onClick,
  onDelete,
  onRename,
  onChangeCover,
  onChangePassword
}) => {
  const cardStyle = backgroundImage 
    ? { backgroundImage: `url(${backgroundImage})` }
    : { backgroundColor: color };

  const [menuOpen, setMenuOpen] = useState(false);
  const toggleMenu = (e) => { e.stopPropagation(); setMenuOpen(o => !o); };
  const closeMenu = (e) => { e?.stopPropagation?.(); setMenuOpen(false); };

  return (
    <div
      className={styles.card}
      style={cardStyle}
      onClick={onClick}
      tabIndex={0}
      role="button"
      aria-label={`Open vault ${title}`}
      onKeyPress={e => { if (e.key === 'Enter' || e.key === ' ') { onClick?.(); } }}
      data-testid="vault-card"
    >
      {priceTag && (
        <span className={styles.priceTag}>{priceTag}</span>
      )}
      {/* menu moved to footer */}
      <div className={styles.content}>
        {/* Remove top title; keep space for custom children if needed */}
        {children && <div className={styles.body}>{children}</div>}
      </div>
      <div className={styles.footer}>
        <span className={styles.label}>{title}</span>
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
