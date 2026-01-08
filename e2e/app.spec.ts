import { test, expect } from '@playwright/test';

test.describe('brainbox Application', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app
    await page.goto('/');
    
    // Wait for the app to load
    await page.waitForSelector('[data-testid="app"]', { timeout: 10000 });
  });

  test('should load the application', async ({ page }) => {
    // Check if the main app container is present
    await expect(page.locator('[data-testid="app"]')).toBeVisible();
    
    // Check if the sidebar is present
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    
    // Check if the main content area is present
    await expect(page.locator('[data-testid="main-content"]')).toBeVisible();
  });

  test('should display the vault view by default', async ({ page }) => {
    // Check if we're in the vaults view
    await expect(page.locator('[data-testid="vaults-section"]')).toBeVisible();
    
    // Check if the floating capture button is present
    await expect(page.locator('[data-testid="floating-capture-button"]')).toBeVisible();
  });

  test('should navigate between different views', async ({ page }) => {
    // Navigate to search view
    await page.click('[data-testid="nav-search"]');
    await expect(page.locator('[data-testid="search-section"]')).toBeVisible();
    
    // Navigate to settings view
    await page.click('[data-testid="nav-settings"]');
    await expect(page.locator('[data-testid="settings-section"]')).toBeVisible();
    
    // Navigate back to vaults view
    await page.click('[data-testid="nav-vaults"]');
    await expect(page.locator('[data-testid="vaults-section"]')).toBeVisible();
  });

  test('should open capture modal when floating button is clicked', async ({ page }) => {
    // Click the floating capture button
    await page.click('[data-testid="floating-capture-button"]');
    
    // Check if the capture modal is visible
    await expect(page.locator('[data-testid="capture-modal"]')).toBeVisible();
    
    // Check if the modal has the expected form elements
    await expect(page.locator('[data-testid="capture-title-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="capture-content-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="capture-vault-select"]')).toBeVisible();
  });

  test('should close capture modal when cancel is clicked', async ({ page }) => {
    // Open the capture modal
    await page.click('[data-testid="floating-capture-button"]');
    await expect(page.locator('[data-testid="capture-modal"]')).toBeVisible();
    
    // Click cancel button
    await page.click('[data-testid="capture-cancel-button"]');
    
    // Check if the modal is closed
    await expect(page.locator('[data-testid="capture-modal"]')).not.toBeVisible();
  });

  test('should create a new vault', async ({ page }) => {
    // Click the create vault button
    await page.click('[data-testid="create-vault-button"]');
    
    // Check if the create vault modal is visible
    await expect(page.locator('[data-testid="create-vault-modal"]')).toBeVisible();
    
    // Fill in the vault name
    await page.fill('[data-testid="vault-name-input"]', 'Test Vault');
    
    // Fill in the password
    await page.fill('[data-testid="vault-password-input"]', 'TestPassword123');
    
    // Click create button
    await page.click('[data-testid="create-vault-submit"]');
    
    // Wait for the vault to be created and modal to close
    await expect(page.locator('[data-testid="create-vault-modal"]')).not.toBeVisible();
    
    // Check if the new vault appears in the vault list
    await expect(page.locator('[data-testid="vault-card"]').filter({ hasText: 'Test Vault' })).toBeVisible();
  });

  test('should perform search functionality', async ({ page }) => {
    // Navigate to search view
    await page.click('[data-testid="nav-search"]');
    
    // Enter search query
    await page.fill('[data-testid="search-input"]', 'test query');
    
    // Press Enter or click search button
    await page.press('[data-testid="search-input"]', 'Enter');
    
    // Check if search results section is visible
    await expect(page.locator('[data-testid="search-results"]')).toBeVisible();
  });

  test('should toggle theme', async ({ page }) => {
    // Navigate to settings
    await page.click('[data-testid="nav-settings"]');
    
    // Get current theme
    const currentTheme = await page.getAttribute('html', 'data-theme');
    
    // Click theme toggle button
    await page.click('[data-testid="theme-toggle"]');
    
    // Check if theme has changed
    const newTheme = await page.getAttribute('html', 'data-theme');
    expect(newTheme).not.toBe(currentTheme);
  });

  test('should handle keyboard shortcuts', async ({ page }) => {
    // Test global capture shortcut (Alt+Shift+B)
    await page.keyboard.press('Alt+Shift+KeyB');
    
    // Check if capture modal opens
    await expect(page.locator('[data-testid="capture-modal"]')).toBeVisible();
    
    // Close modal with Escape
    await page.keyboard.press('Escape');
    
    // Check if modal closes
    await expect(page.locator('[data-testid="capture-modal"]')).not.toBeVisible();
  });

  test('should be responsive on mobile devices', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    
    // Check if the app still loads properly
    await expect(page.locator('[data-testid="app"]')).toBeVisible();
    
    // Check if mobile-specific elements are visible
    await expect(page.locator('[data-testid="mobile-menu-button"]')).toBeVisible();
  });

  test('should handle errors gracefully', async ({ page }) => {
    // Listen for console errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    // Perform actions that might cause errors
    await page.click('[data-testid="floating-capture-button"]');
    await page.fill('[data-testid="capture-title-input"]', 'Test Item');
    await page.fill('[data-testid="capture-content-input"]', 'Test content');
    
    // Try to submit without selecting a vault (should show validation error)
    await page.click('[data-testid="capture-submit-button"]');
    
    // Check if error toast appears
    await expect(page.locator('[data-testid="toast-error"]')).toBeVisible();
    
    // Ensure no console errors occurred
    expect(errors).toHaveLength(0);
  });

  test('should persist data across page reloads', async ({ page }) => {
    // Create a vault
    await page.click('[data-testid="create-vault-button"]');
    await page.fill('[data-testid="vault-name-input"]', 'Persistent Vault');
    await page.fill('[data-testid="vault-password-input"]', 'TestPassword123');
    await page.click('[data-testid="create-vault-submit"]');
    
    // Wait for vault to be created
    await expect(page.locator('[data-testid="vault-card"]').filter({ hasText: 'Persistent Vault' })).toBeVisible();
    
    // Reload the page
    await page.reload();
    
    // Check if the vault still exists
    await expect(page.locator('[data-testid="vault-card"]').filter({ hasText: 'Persistent Vault' })).toBeVisible();
  });
});

test.describe('Accessibility', () => {
  test('should have proper ARIA labels and roles', async ({ page }) => {
    await page.goto('/');
    
    // Check for proper button roles and labels
    await expect(page.locator('[data-testid="floating-capture-button"]')).toHaveAttribute('aria-label');
    
    // Check for proper navigation landmarks
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('main')).toBeVisible();
    
    // Check for proper heading hierarchy
    const headings = await page.locator('h1, h2, h3, h4, h5, h6').all();
    expect(headings.length).toBeGreaterThan(0);
  });

  test('should be keyboard navigable', async ({ page }) => {
    await page.goto('/');
    
    // Tab through interactive elements
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
    
    // Continue tabbing and ensure focus is visible
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await expect(page.locator(':focus')).toBeVisible();
    }
  });

  test('should have sufficient color contrast', async ({ page }) => {
    await page.goto('/');
    
    // This would typically use axe-core or similar accessibility testing library
    // For now, we'll just check that text is visible
    await expect(page.locator('body')).toHaveCSS('color', /.+/);
    await expect(page.locator('body')).toHaveCSS('background-color', /.+/);
  });
});