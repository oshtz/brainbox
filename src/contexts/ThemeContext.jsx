import React, { createContext, useState, useEffect, useContext } from 'react';

// Create a context for theme management
const ThemeContext = createContext();

// Theme provider component that wraps the app
export const ThemeProvider = ({ children }) => {
  // Initialize theme from localStorage or default to 'light'
  const [theme, setTheme] = useState(() => {
    const savedTheme = localStorage.getItem('brainbox-theme');
    return savedTheme || 'light';
  });

  // Accent color (CSS color string like #RRGGBB)
  const [accent, setAccentState] = useState(() => {
    return localStorage.getItem('brainbox-accent') || '#6366f1';
  });

  // Toggle between light and dark themes
  const toggleTheme = () => {
    setTheme(prevTheme => {
      const newTheme = prevTheme === 'light' ? 'dark' : 'light';
      localStorage.setItem('brainbox-theme', newTheme);
      return newTheme;
    });
  };

  // Helpers to derive hover color and rgb for focus rings
  const hexToRgb = (hex) => {
    const clean = hex.replace('#','');
    const bigint = parseInt(clean.length === 3 ? clean.split('').map(c=>c+c).join('') : clean, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return { r, g, b };
  };
  const lighten = (hex, amount = 0.12) => {
    const { r, g, b } = hexToRgb(hex);
    const lr = Math.min(255, Math.round(r + (255 - r) * amount));
    const lg = Math.min(255, Math.round(g + (255 - g) * amount));
    const lb = Math.min(255, Math.round(b + (255 - b) * amount));
    return `rgb(${lr}, ${lg}, ${lb})`;
  };

  const setAccent = (color) => {
    try {
      localStorage.setItem('brainbox-accent', color);
    } catch {}
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

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, accent, setAccent }}>
      {children}
    </ThemeContext.Provider>
  );
};

// Custom hook for using the theme context
export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
