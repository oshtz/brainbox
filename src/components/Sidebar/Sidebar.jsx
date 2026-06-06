import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  FolderIcon,
  MagnifyingGlassIcon,
  BookOpenIcon,
  Cog6ToothIcon,
  SunIcon,
  MoonIcon,
  SparklesIcon,
  PlusIcon,
  StopIcon as StopIconOutline
} from '@heroicons/react/24/outline';
import { MinusIcon, StopIcon, XMarkIcon } from '@heroicons/react/24/solid';
import styles from './Sidebar.module.css';
import { useTheme } from '../../contexts/ThemeContext';

const Sidebar = ({
  title = 'Knowledge',
  onExploreClick,
  onKnowledgeClick,
  onSettingsClick,
  onBrainyClick,
  onCreateVault,
  onCreateNote,
  showVaultButton = false,
  showNoteButton = true,
  currentView = 'vaults',
  isBrainyOpen = false,
  brainyMode = 'sidebar'
}) => {
  const { theme, toggleTheme } = useTheme();
  const appWindow = useMemo(() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  }, []);
  const [maximized, setMaximized] = useState(false);
  const isMac = useMemo(() => {
    try {
      return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
    } catch {
      return false;
    }
  }, []);
  const isBrainyFull = brainyMode === 'full';
  const brainyActive = isBrainyFull ? currentView === 'connections' : isBrainyOpen;

  useEffect(() => {
    if (!appWindow) {
      return;
    }

    if (isMac) {
      appWindow.setTitleBarStyle('overlay').catch(() => {});
      try { document.documentElement.classList.add('overlay-titlebar'); } catch {}
    } else {
      appWindow.setDecorations(false).catch(() => {});
      try { document.documentElement.classList.remove('overlay-titlebar'); } catch {}
    }

    let unlisten;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    appWindow.onResized(async () => {
      setMaximized(await appWindow.isMaximized());
    }).then((u) => (unlisten = u)).catch(() => {});

    return () => {
      if (unlisten) unlisten();
      if (isMac) {
        try { document.documentElement.classList.remove('overlay-titlebar'); } catch {}
      }
    };
  }, [appWindow, isMac]);

  const handleMinimize = useCallback(async (event) => {
    event?.stopPropagation();
    if (!appWindow) return;
    try {
      await appWindow.hide();
    } catch (err) {
      console.error('Minimize failed', err);
    }
  }, [appWindow]);

  const handleMaximize = useCallback(async (event) => {
    event?.stopPropagation();
    if (!appWindow) return;
    try {
      await appWindow.toggleMaximize();
      setMaximized(await appWindow.isMaximized());
    } catch (err) {
      console.error('Toggle maximize failed', err);
    }
  }, [appWindow]);

  const handleClose = useCallback(async (event) => {
    event?.stopPropagation();
    if (!appWindow) return;
    try {
      await appWindow.hide();
    } catch (err) {
      console.error('Close failed', err);
    }
  }, [appWindow]);

  const handleDoubleClick = useCallback(() => {
    if (!isMac) {
      handleMaximize();
    }
  }, [handleMaximize, isMac]);

  const handleBrainyNav = () => {
    if (isBrainyFull) {
      onKnowledgeClick && onKnowledgeClick('connections');
      return;
    }
    onBrainyClick && onBrainyClick();
  };

  const navItems = [
    {
      id: 'vaults',
      label: 'Knowledge',
      shortLabel: 'Vaults',
      icon: FolderIcon,
      active: currentView === 'vaults',
      onClick: () => onKnowledgeClick && onKnowledgeClick('vaults'),
      testId: 'nav-vaults',
      ariaLabel: 'View knowledge vaults',
    },
    {
      id: 'search',
      label: 'Explore',
      shortLabel: 'Search',
      icon: MagnifyingGlassIcon,
      active: currentView === 'search',
      onClick: onExploreClick,
      testId: 'nav-search',
      ariaLabel: 'Explore and search',
    },
    {
      id: 'library',
      label: 'Library',
      shortLabel: 'Library',
      icon: BookOpenIcon,
      active: currentView === 'library',
      onClick: () => onKnowledgeClick && onKnowledgeClick('library'),
      ariaLabel: 'Open library',
    },
    {
      id: 'brainy',
      label: 'brainy',
      shortLabel: 'brainy',
      icon: SparklesIcon,
      active: brainyActive,
      onClick: handleBrainyNav,
      testId: 'nav-brainy',
      ariaLabel: isBrainyFull ? 'Open brainy' : 'Open brainy AI assistant',
    },
    {
      id: 'settings',
      label: 'Settings',
      shortLabel: 'Settings',
      icon: Cog6ToothIcon,
      active: currentView === 'settings',
      onClick: onSettingsClick,
      testId: 'nav-settings',
      ariaLabel: 'Open settings',
    },
  ];
  
  return (
    <header
      className={styles.navigation}
      data-testid="app-navigation"
      data-tauri-drag-region
      onDoubleClick={handleDoubleClick}
      aria-label="Window title bar"
    >
      <div className={styles.brandArea} data-tauri-drag-region>
        <span className={styles.brand} data-tauri-drag-region>brainbox</span>
        <span className={styles.viewTitle} data-tauri-drag-region>{title}</span>
      </div>

      <nav className={styles.nav} aria-label="Primary navigation">
        <ul className={styles.navList}>
          {navItems.map(({ id, label, shortLabel, icon: Icon, active, onClick, testId, ariaLabel }) => (
            <li key={id} className={active ? styles.active : ''}>
              <button
                type="button"
                className={styles.navButton}
                onClick={onClick}
                aria-label={ariaLabel}
                aria-current={active ? 'page' : undefined}
                data-testid={testId}
                data-nodrag
                data-tauri-drag-region="false"
              >
                <Icon className={styles.navIcon} aria-hidden="true" />
                <span className={styles.label}>
                  <span className={styles.fullLabel}>{label}</span>
                  <span className={styles.shortLabel}>{shortLabel}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className={styles.actions} data-tauri-drag-region="false" data-nodrag>
        {showNoteButton && (
          <button
            type="button"
            className={styles.primaryButton}
            onClick={onCreateNote}
            data-testid="floating-capture-button"
            data-nodrag
            data-tauri-drag-region="false"
          >
            <PlusIcon className={styles.actionIcon} aria-hidden="true" />
            <span>New note</span>
          </button>
        )}

        {showVaultButton && (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onCreateVault}
            data-testid="create-vault-button"
            data-nodrag
            data-tauri-drag-region="false"
          >
            <PlusIcon className={styles.actionIcon} aria-hidden="true" />
            <span>New vault</span>
          </button>
        )}

        <button
          className={styles.iconButton}
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
          data-testid="theme-toggle"
          data-nodrag
          data-tauri-drag-region="false"
        >
          {theme === 'light' ? (
            <MoonIcon className={styles.themeIcon} aria-hidden="true" />
          ) : (
            <SunIcon className={styles.themeIcon} aria-hidden="true" />
          )}
        </button>

        {!isMac && (
          <div className={styles.windowControls} data-tauri-drag-region="false" data-nodrag>
            <button
              type="button"
              className={styles.windowButton}
              aria-label="Minimize"
              title="Minimize"
              onClick={handleMinimize}
              onDoubleClick={(event) => event.stopPropagation()}
              data-nodrag
              data-tauri-drag-region="false"
            >
              <MinusIcon className={styles.windowIcon} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.windowButton}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              title={maximized ? 'Restore' : 'Maximize'}
              onClick={handleMaximize}
              onDoubleClick={(event) => event.stopPropagation()}
              data-nodrag
              data-tauri-drag-region="false"
            >
              {maximized ? (
                <StopIconOutline className={styles.windowIcon} aria-hidden="true" />
              ) : (
                <StopIcon className={styles.windowIcon} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className={`${styles.windowButton} ${styles.closeButton}`}
              aria-label="Close"
              title="Close"
              onClick={handleClose}
              onDoubleClick={(event) => event.stopPropagation()}
              data-nodrag
              data-tauri-drag-region="false"
            >
              <XMarkIcon className={styles.windowIcon} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
};

export default Sidebar;
