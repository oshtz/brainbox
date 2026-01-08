import React, { createContext, useState, useEffect, useContext } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Context for managing capture hotkey setting
interface HotkeyContextType {
  hotkey: string;
  setHotkey: (key: string) => void;
}

const HotkeyContext = createContext<HotkeyContextType | undefined>(undefined);

export const HotkeyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [hotkey, setHotkeyState] = useState<string>(() => {
    return localStorage.getItem('capture-hotkey') || 'Alt+Shift+B';
  });

  // Sync hotkey with backend when changed
  useEffect(() => {
    invoke('register_capture_hotkey', { hotkey });
  }, [hotkey]);

  const setHotkey = (newKey: string) => {
    setHotkeyState(newKey);
    localStorage.setItem('capture-hotkey', newKey);
  };

  return (
    <HotkeyContext.Provider value={{ hotkey, setHotkey }}>
      {children}
    </HotkeyContext.Provider>
  );
};

export const useHotkey = (): HotkeyContextType => {
  const context = useContext(HotkeyContext);
  if (!context) {
    throw new Error('useHotkey must be used within a HotkeyProvider');
  }
  return context;
};
