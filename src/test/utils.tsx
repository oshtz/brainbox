import React, { ReactElement } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { ThemeProvider } from '../contexts/ThemeContext';
import { ToastProvider } from '../contexts/ToastContext';
import { SearchProvider } from '../components/Search';
import { HotkeyProvider } from '../contexts/HotkeyContext';
import { ConfirmProvider } from '../contexts/ConfirmContext';

// Custom render function that includes all providers
const AllTheProviders = ({ children }: { children: React.ReactNode }) => {
  return (
    <HotkeyProvider>
      <ThemeProvider>
        <ToastProvider>
          <SearchProvider>
            <ConfirmProvider>
              {children}
            </ConfirmProvider>
          </SearchProvider>
        </ToastProvider>
      </ThemeProvider>
    </HotkeyProvider>
  );
};

const customRender = (
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) => render(ui, { wrapper: AllTheProviders, ...options });

// Test data factories
export const createMockVault = (overrides = {}) => ({
  id: '1',
  title: 'Test Vault',
  name: 'Test Vault',
  backgroundImage: 'test-image.jpg',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides
});

export const createMockVaultItem = (overrides = {}) => ({
  id: '1',
  vault_id: '1',
  title: 'Test Item',
  content: 'Test content',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  image: 'test-image.jpg',
  height: 260,
  metadata: {
    item_type: 'note' as const,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  },
  ...overrides
});

export const createMockSearchResult = (overrides = {}) => ({
  id: '1',
  vault_id: '1',
  title: 'Test Search Result',
  content: 'Test search content',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  image: 'test-image.jpg',
  height: 260,
  metadata: {
    item_type: 'note' as const,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  },
  ...overrides
});

// Mock event helpers
export const mockTauriEvent = (eventName: string, payload: any) => ({
  event: eventName,
  payload,
  windowLabel: 'main',
  id: Math.random()
});

// Async test helpers
export const waitForAsync = () => new Promise(resolve => setTimeout(resolve, 0));

export const waitForCondition = async (
  condition: () => boolean,
  timeout = 1000,
  interval = 10
): Promise<void> => {
  const start = Date.now();
  
  while (!condition() && Date.now() - start < timeout) {
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  if (!condition()) {
    throw new Error(`Condition not met within ${timeout}ms`);
  }
};

// Re-export everything from testing-library
export * from '@testing-library/react';
export { customRender as render };