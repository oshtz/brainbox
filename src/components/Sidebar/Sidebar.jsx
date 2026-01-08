import React from 'react';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  BookOpenIcon,
  Cog6ToothIcon,
  SunIcon,
  MoonIcon,
  SparklesIcon
} from '@heroicons/react/24/outline';
import styles from './Sidebar.module.css';
import { useTheme } from '../../contexts/ThemeContext';
import logoLockup from '../../assets/images/logomark.png';
import logoLockupDark from '../../assets/images/logomark-dark.png';
import logoIconB from '../../assets/images/icon-b.png';

const Sidebar = ({
  onCaptureClick,
  onExploreClick,
  onKnowledgeClick,
  onSettingsClick,
  onBrainyClick,
  currentView = 'vaults',
  isBrainyOpen = false,
  brainyMode = 'sidebar'
}) => {
  const { theme, toggleTheme } = useTheme();
  const [isExpanded, setIsExpanded] = React.useState(false);

  // Load persisted state on mount
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem('sidebarExpanded');
      if (stored !== null) {
        setIsExpanded(stored === 'true');
      }
    } catch (_) {
      // ignore storage errors
    }
  }, []);

  // Persist state on change
  React.useEffect(() => {
    try {
      localStorage.setItem('sidebarExpanded', String(isExpanded));
    } catch (_) {
      // ignore storage errors
    }
  }, [isExpanded]);

  const toggleExpanded = () => setIsExpanded(v => !v);
  const isBrainyFull = brainyMode === 'full';
  const brainyActive = isBrainyFull ? currentView === 'connections' : isBrainyOpen;
  const handleBrainyNav = () => {
    if (isBrainyFull) {
      onKnowledgeClick && onKnowledgeClick('connections');
      return;
    }
    onBrainyClick && onBrainyClick();
  };
  
  return (
    <aside className={`${styles.sidebar} ${isExpanded ? styles.expanded : ''}`} aria-expanded={isExpanded} data-testid="sidebar">
      <button
        className={styles.toggleButton}
        onClick={toggleExpanded}
        aria-label={isExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
        title={isExpanded ? 'Collapse' : 'Expand'}
      >
        {isExpanded ? <ChevronLeftIcon className={styles.toggleIcon} /> : <ChevronRightIcon className={styles.toggleIcon} />}
      </button>
      <div className={styles.logo}>
        {isExpanded ? (
          <img
            src={theme === 'dark' ? logoLockupDark : logoLockup}
            className={styles.logoImg}
            alt="Brainbox"
          />
        ) : (
          <img src={logoIconB} className={styles.logoImgSmall} alt="Brainbox" />
        )}
      </div>
      <nav className={styles.nav}>
        <ul>
          <li className={currentView === 'vaults' ? styles.active : ''}>
            <button
              className={styles.navButton}
              onClick={() => onKnowledgeClick && onKnowledgeClick('vaults')}
              aria-label="View knowledge vaults"
              data-testid="nav-vaults"
            >
              <FolderIcon className={styles.navIcon} aria-hidden="true" />
              <span className={styles.label}>Knowledge</span>
            </button>
          </li>
          <li className={currentView === 'search' ? styles.active : ''}>
            <button
              className={styles.navButton}
              onClick={onExploreClick}
              aria-label="Explore and search"
              data-testid="nav-search"
            >
              <MagnifyingGlassIcon className={styles.navIcon} aria-hidden="true" />
              <span className={styles.label}>Explore</span>
            </button>
          </li>
          <li className={currentView === 'library' ? styles.active : ''}>
            <button 
              className={styles.navButton}
              onClick={() => onKnowledgeClick && onKnowledgeClick('library')}
              aria-label="Open library"
            >
              <BookOpenIcon className={styles.navIcon} aria-hidden="true" />
              <span className={styles.label}>Library</span>
            </button>
          </li>
          <li className={brainyActive ? styles.active : ''}>
            <button
              className={styles.navButton}
              onClick={handleBrainyNav}
              aria-label={isBrainyFull ? 'Open brainy' : 'Open brainy AI assistant'}
              data-testid="nav-brainy"
            >
              <SparklesIcon className={styles.navIcon} aria-hidden="true" />
              <span className={styles.label}>brainy</span>
            </button>
          </li>
          <li className={currentView === 'settings' ? styles.active : ''}>
            <button
              className={styles.navButton}
              onClick={onSettingsClick}
              aria-label="Open settings"
              data-testid="nav-settings"
            >
              <Cog6ToothIcon className={styles.navIcon} aria-hidden="true" />
              <span className={styles.label}>Settings</span>
            </button>
          </li>
        </ul>
      </nav>
      <div className={styles.themeToggle}>
        <button
          className={styles.iconButton}
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
          data-testid="theme-toggle"
        >
          {theme === 'light' ? (
            <MoonIcon className={styles.themeIcon} aria-hidden="true" />
          ) : (
            <SunIcon className={styles.themeIcon} aria-hidden="true" />
          )}
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
