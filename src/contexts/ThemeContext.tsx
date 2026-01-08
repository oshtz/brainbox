import React, { createContext, useState, useEffect, useContext, ReactNode } from 'react';
import { ThemeContextType, RGB } from '../types';

// Create a context for theme management
const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
  children: ReactNode;
}

// Theme provider component that wraps the app
export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  // Initialize theme from localStorage or default to 'light'
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const savedTheme = localStorage.getItem('brainbox-theme');
    return (savedTheme as 'light' | 'dark') || 'light';
  });

  // Accent color (CSS color string like #RRGGBB)
  const [accent, setAccentState] = useState<string>(() => {
    return localStorage.getItem('brainbox-accent') || '#6366f1';
  });

  // Toggle between light and dark themes
  const toggleTheme = (): void => {
    setTheme(prevTheme => {
      const newTheme = prevTheme === 'light' ? 'dark' : 'light';
      localStorage.setItem('brainbox-theme', newTheme);
      return newTheme;
    });
  };

  // Helpers to derive hover color and rgb for focus rings
  const hexToRgb = (hex: string): RGB => {
    const clean = hex.replace('#','');
    const bigint = parseInt(clean.length === 3 ? clean.split('').map(c=>c+c).join('') : clean, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return { r, g, b };
  };

  const lighten = (hex: string, amount: number = 0.12): string => {
    const { r, g, b } = hexToRgb(hex);
    const lr = Math.min(255, Math.round(r + (255 - r) * amount));
    const lg = Math.min(255, Math.round(g + (255 - g) * amount));
    const lb = Math.min(255, Math.round(b + (255 - b) * amount));
    return `rgb(${lr}, ${lg}, ${lb})`;
  };

  const setAccent = (color: string): void => {
    try {
      localStorage.setItem('brainbox-accent', color);
    } catch (error) {
      console.warn('Failed to save accent color to localStorage:', error);
    }
    setAccentState(color);
  };

  // Update the data-theme attribute on the document element when theme changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Apply accent variables on change
  useEffect(() => {
    const root = document.documentElement;
    const { r, g, b } = hexToRgb(accent);
    root.style.setProperty('--color-primary', accent);
    root.style.setProperty('--color-primary-hover', lighten(accent, 0.16));
    root.style.setProperty('--color-primary-rgb', `${r}, ${g}, ${b}`);
    root.style.setProperty('--color-focus', `rgba(${r}, ${g}, ${b}, 0.35)`);
  }, [accent]);

  const contextValue: ThemeContextType = {
    theme,
    toggleTheme,
    accent,
    setAccent
  };

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
};

// Custom hook for using the theme context
export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};