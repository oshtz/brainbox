import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MinusIcon, StopIcon, XMarkIcon } from '@heroicons/react/24/solid';
import { StopIcon as StopIconOutline } from '@heroicons/react/24/outline';
import styles from './Titlebar.module.css';
import wordmark from '../../assets/images/wordmark.png';

export default function Titlebar() {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);
  const isMac = useMemo(() => {
    try {
      return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    // Platform-specific window chrome setup
    if (isMac) {
      // macOS: keep native decorations and use overlay style for stable input/drag
      appWindow.setTitleBarStyle('overlay').catch(() => {});
      try { document.documentElement.classList.add('overlay-titlebar'); } catch {}
    } else {
      // Windows: remove native decorations to avoid duplicate titlebar
      // (custom titlebar remains visible and functional)
      // Requires permission: core:window:allow-set-decorations
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      appWindow.setDecorations(false).catch(() => {});
      try { document.documentElement.classList.remove('overlay-titlebar'); } catch {}
    }
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized);
    appWindow.onResized(async () => {
      setMaximized(await appWindow.isMaximized());
    }).then((u) => (unlisten = u));
    return () => {
      if (unlisten) unlisten();
      if (isMac) {
        try { document.documentElement.classList.remove('overlay-titlebar'); } catch {}
      }
    };
  }, [isMac]);

  const handleMinimize = useCallback(async (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    try {
      // Minimize to tray: hide window instead of standard minimize
      await appWindow.hide();
    } catch (err) {
      console.error('Minimize failed', err);
    }
  }, []);

  const handleMaximize = useCallback(async (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    try {
      await appWindow.toggleMaximize();
      setMaximized(await appWindow.isMaximized());
    } catch (err) {
      console.error('Toggle maximize failed', err);
    }
  }, []);

  const handleClose = useCallback(async (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    try {
      // Close to tray: hide instead of exiting
      await appWindow.hide();
    } catch (err) {
      console.error('Close failed', err);
    }
  }, []);

  const handleDoubleClick = useCallback(() => {
    handleMaximize();
  }, [handleMaximize]);

  // Use Tauri drag regions instead of JS dragging under native overlay

  return (
    <div
      className={styles.titlebar}
      data-tauri-drag-region
      onDoubleClick={isMac ? undefined : handleDoubleClick}
      aria-label="Window title bar"
    >
      {!isMac && (
        <div className={styles.left} data-tauri-drag-region>
          <img src={wordmark} alt="Brainbox" className={styles.wordmark} data-tauri-drag-region />
        </div>
      )}
      <div className={styles.spacer} data-tauri-drag-region />
      {!isMac && (
        <div className={styles.controls} data-tauri-drag-region="false" data-nodrag>
        <button
          type="button"
          className={styles.btn}
          aria-label="Minimize"
          title="Minimize"
          onClick={handleMinimize}
          data-nodrag
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <MinusIcon className={styles.icon} aria-hidden="true" data-tauri-drag-region="false" />
        </button>
        <button
          type="button"
          className={styles.btn}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={handleMaximize}
          data-nodrag
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {maximized ? (
            <StopIconOutline className={styles.icon} aria-hidden="true" data-tauri-drag-region="false" />
          ) : (
            <StopIcon className={styles.icon} aria-hidden="true" data-tauri-drag-region="false" />
          )}
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.close}`}
          aria-label="Close"
          title="Close"
          onClick={handleClose}
          data-nodrag
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <XMarkIcon className={styles.icon} aria-hidden="true" data-tauri-drag-region="false" />
        </button>
        </div>
      )}
    </div>
  );
}
