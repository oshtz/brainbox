import React, { createContext, useContext, useEffect, useCallback, ReactNode } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useAppState } from './AppStateContext';
import { useToast } from './ToastContext';

// Keyboard shortcut configuration
interface KeyboardShortcut {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  description: string;
  action: () => void;
  preventDefault?: boolean;
  global?: boolean; // Can be triggered from anywhere
}

interface KeyboardContextType {
  shortcuts: KeyboardShortcut[];
  registerShortcut: (shortcut: KeyboardShortcut) => () => void;
  isShortcutActive: (key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }) => boolean;
}

const KeyboardContext = createContext<KeyboardContextType | undefined>(undefined);

interface KeyboardProviderProps {
  children: ReactNode;
}

export const KeyboardProvider: React.FC<KeyboardProviderProps> = ({ children }) => {
  const { state, setCurrentView, openCaptureModal, closeCaptureModal, resetSearch } = useAppState();
  const { showInfo } = useToast();
  const [shortcuts, setShortcuts] = React.useState<KeyboardShortcut[]>([]);

  // Register a new keyboard shortcut
  const registerShortcut = useCallback((shortcut: KeyboardShortcut) => {
    setShortcuts(prev => [...prev, shortcut]);
    
    // Return cleanup function
    return () => {
      setShortcuts(prev => prev.filter(s => s !== shortcut));
    };
  }, []);

  // Check if a shortcut is active
  const isShortcutActive = useCallback((
    key: string, 
    modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }
  ) => {
    return shortcuts.some(shortcut => 
      shortcut.key.toLowerCase() === key.toLowerCase() &&
      !!shortcut.ctrlKey === !!modifiers.ctrl &&
      !!shortcut.altKey === !!modifiers.alt &&
      !!shortcut.shiftKey === !!modifiers.shift &&
      !!shortcut.metaKey === !!modifiers.meta
    );
  }, [shortcuts]);

  // Default application shortcuts
  const defaultShortcuts: KeyboardShortcut[] = [
    // Global shortcuts
    {
      key: 'b',
      altKey: true,
      shiftKey: true,
      description: 'Open capture modal',
      action: openCaptureModal,
      global: true,
      preventDefault: true
    },
    {
      key: 'Escape',
      description: 'Close modals/panels',
      action: () => {
        if (state.isCaptureModalOpen) {
          closeCaptureModal();
        } else if (state.selectedItem) {
          // Close item panel logic would go here
        }
      },
      global: true,
      preventDefault: true
    },
    {
      key: '/',
      ctrlKey: true,
      description: 'Focus search',
      action: () => {
        setCurrentView('search');
        // Focus search input after view change
        setTimeout(() => {
          const searchInput = document.querySelector('[data-testid="search-input"]') as HTMLInputElement;
          if (searchInput) {
            searchInput.focus();
          }
        }, 100);
      },
      global: true,
      preventDefault: true
    },
    {
      key: '?',
      shiftKey: true,
      description: 'Show keyboard shortcuts help',
      action: () => {
        const shortcutsList = shortcuts
          .filter(s => s.global)
          .map(s => {
            const keys = [];
            if (s.ctrlKey) keys.push('Ctrl');
            if (s.altKey) keys.push('Alt');
            if (s.shiftKey) keys.push('Shift');
            if (s.metaKey) keys.push('Cmd');
            keys.push(s.key);
            return `${keys.join('+')} - ${s.description}`;
          })
          .join('\n');
        
        showInfo(`Keyboard Shortcuts:\n${shortcutsList}`, 'Available Shortcuts');
      },
      global: true,
      preventDefault: true
    },
    // Navigation shortcuts
    {
      key: '1',
      ctrlKey: true,
      description: 'Go to Vaults',
      action: () => setCurrentView('vaults'),
      global: true,
      preventDefault: true
    },
    {
      key: '2',
      ctrlKey: true,
      description: 'Go to Search',
      action: () => setCurrentView('search'),
      global: true,
      preventDefault: true
    },
    {
      key: '3',
      ctrlKey: true,
      description: 'Go to Library',
      action: () => setCurrentView('library'),
      global: true,
      preventDefault: true
    },
    {
      key: '4',
      ctrlKey: true,
      description: 'Go to Connections',
      action: () => setCurrentView('connections'),
      global: true,
      preventDefault: true
    },
    {
      key: '5',
      ctrlKey: true,
      description: 'Go to Settings',
      action: () => setCurrentView('settings'),
      global: true,
      preventDefault: true
    },
    // Search shortcuts
    {
      key: 'k',
      ctrlKey: true,
      description: 'Quick search',
      action: () => {
        setCurrentView('search');
        setTimeout(() => {
          const searchInput = document.querySelector('[data-testid="search-input"]') as HTMLInputElement;
          if (searchInput) {
            searchInput.focus();
            searchInput.select();
          }
        }, 100);
      },
      global: true,
      preventDefault: true
    },
    {
      key: 'Escape',
      description: 'Clear search',
      action: () => {
        if (state.currentView === 'search' && state.searchQuery) {
          resetSearch();
        }
      },
      global: false,
      preventDefault: true
    },
    // Item management shortcuts
    {
      key: 'n',
      ctrlKey: true,
      description: 'New item',
      action: openCaptureModal,
      global: true,
      preventDefault: true
    },
    {
      key: 'r',
      ctrlKey: true,
      description: 'Refresh current view',
      action: () => {
        // Refresh logic would depend on current view
        window.location.reload();
      },
      global: true,
      preventDefault: true
    }
  ];

  // Initialize default shortcuts
  useEffect(() => {
    setShortcuts(defaultShortcuts);
  }, [openCaptureModal, closeCaptureModal, setCurrentView, resetSearch, showInfo, state.isCaptureModalOpen, state.selectedItem, state.currentView, state.searchQuery]);

  // Global keyboard event handler
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      const target = event.target as HTMLElement;
      const isInputElement = target.tagName === 'INPUT' || 
                           target.tagName === 'TEXTAREA' || 
                           target.contentEditable === 'true';

      // Find matching shortcut
      const matchingShortcut = shortcuts.find(shortcut => {
        const keyMatch = shortcut.key.toLowerCase() === event.key.toLowerCase();
        const ctrlMatch = !!shortcut.ctrlKey === event.ctrlKey;
        const altMatch = !!shortcut.altKey === event.altKey;
        const shiftMatch = !!shortcut.shiftKey === event.shiftKey;
        const metaMatch = !!shortcut.metaKey === event.metaKey;

        return keyMatch && ctrlMatch && altMatch && shiftMatch && metaMatch;
      });

      if (matchingShortcut) {
        // Only trigger global shortcuts when in input elements
        if (isInputElement && !matchingShortcut.global) {
          return;
        }

        if (matchingShortcut.preventDefault) {
          event.preventDefault();
        }

        matchingShortcut.action();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts]);

  // Focus management for accessibility
  useEffect(() => {
    const handleFocusManagement = () => {
      // Ensure focus is visible
      const focusedElement = document.activeElement;
      if (focusedElement && focusedElement !== document.body) {
        (focusedElement as HTMLElement).style.outline = '2px solid var(--color-focus)';
      }
    };

    document.addEventListener('focusin', handleFocusManagement);
    return () => document.removeEventListener('focusin', handleFocusManagement);
  }, []);

  const contextValue: KeyboardContextType = {
    shortcuts,
    registerShortcut,
    isShortcutActive
  };

  return (
    <KeyboardContext.Provider value={contextValue}>
      {children}
    </KeyboardContext.Provider>
  );
};

export const useKeyboard = (): KeyboardContextType => {
  const context = useContext(KeyboardContext);
  if (context === undefined) {
    throw new Error('useKeyboard must be used within a KeyboardProvider');
  }
  return context;
};

// Hook for registering component-specific shortcuts
export const useKeyboardShortcut = (shortcut: Omit<KeyboardShortcut, 'action'>, action: () => void) => {
  const { registerShortcut } = useKeyboard();

  useEffect(() => {
    const cleanup = registerShortcut({ ...shortcut, action });
    return cleanup;
  }, [registerShortcut, action, shortcut.key, shortcut.ctrlKey, shortcut.altKey, shortcut.shiftKey, shortcut.metaKey]);
};

// Component for displaying keyboard shortcuts help
export const KeyboardShortcutsHelp: React.FC<{ visible: boolean; onClose: () => void }> = ({ visible, onClose }) => {
  const { shortcuts } = useKeyboard();

  if (!visible) return null;

  const globalShortcuts = shortcuts.filter(s => s.global);

  return (
    <div className="keyboard-shortcuts-help" style={{
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--border-radius-lg)',
      padding: 'var(--space-lg)',
      maxWidth: '500px',
      maxHeight: '70vh',
      overflow: 'auto',
      zIndex: 1000,
      boxShadow: 'var(--shadow-lg)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-md)' }}>
        <h2>Keyboard Shortcuts</h2>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32 }}>
          <XMarkIcon style={{ width: 20, height: 20 }} />
        </button>
      </div>
      
      <div style={{ display: 'grid', gap: 'var(--space-sm)' }}>
        {globalShortcuts.map((shortcut, index) => {
          const keys = [];
          if (shortcut.ctrlKey) keys.push('Ctrl');
          if (shortcut.altKey) keys.push('Alt');
          if (shortcut.shiftKey) keys.push('Shift');
          if (shortcut.metaKey) keys.push('Cmd');
          keys.push(shortcut.key);

          return (
            <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{shortcut.description}</span>
              <kbd style={{
                background: 'var(--color-background)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--border-radius-sm)',
                padding: '2px 6px',
                fontSize: '0.8rem',
                fontFamily: 'monospace'
              }}>
                {keys.join(' + ')}
              </kbd>
            </div>
          );
        })}
      </div>
    </div>
  );
};