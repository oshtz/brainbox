import { test, expect } from '@playwright/test';

const fixtureImage =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 640 420%22%3E%3Crect width=%22640%22 height=%22420%22 fill=%22%231f6f68%22/%3E%3Ccircle cx=%22492%22 cy=%22108%22 r=%22124%22 fill=%22%23f6c85f%22/%3E%3Cpath d=%22M0 320 C160 230 300 390 640 250 L640 420 L0 420 Z%22 fill=%22%232d4263%22/%3E%3C/svg%3E';

const populatedFixture = {
  vaults: [
    {
      id: 1,
      name: 'Research Intake - URLs and clipped source notes',
      cover_image: fixtureImage,
      has_password: false,
      created_at: '2026-06-03T08:00:00Z',
      updated_at: '2026-06-03T08:10:00Z',
    },
    {
      id: 2,
      name: 'Product Roadmap / Brainbox Hardening',
      cover_image: fixtureImage,
      has_password: false,
      created_at: '2026-06-03T08:00:00Z',
      updated_at: '2026-06-03T08:10:00Z',
    },
    {
      id: 3,
      name: 'Locked Archive - design references',
      cover_image: fixtureImage,
      has_password: true,
      created_at: '2026-06-03T08:00:00Z',
      updated_at: '2026-06-03T08:10:00Z',
    },
  ],
  itemsByVaultId: {
    '1': [
      {
        id: 101,
        vault_id: 1,
        title: 'Tauri smoke path checklist with launch, capture, search, and shutdown',
        content: 'Create a desktop smoke path that launches the packaged app, creates a vault item, verifies search hydration, and shuts down cleanly.',
        image: fixtureImage,
        summary: 'Desktop smoke path tracks launch, capture, search, and shutdown verification.',
        created_at: '2026-06-03T09:00:00Z',
        updated_at: '2026-06-03T09:05:00Z',
        metadata: { item_type: 'note' },
      },
      {
        id: 102,
        vault_id: 1,
        title: 'Release readiness reference - updater, checksums, and clean machine install',
        content: 'https://example.com/tauri-desktop-smoke',
        image: fixtureImage,
        summary: 'Release reference covering updater, checksums, install, and rollback checks.',
        created_at: '2026-06-03T09:10:00Z',
        updated_at: '2026-06-03T09:12:00Z',
        metadata: { item_type: 'url', url: 'https://example.com/tauri-desktop-smoke' },
      },
      {
        id: 103,
        vault_id: 1,
        title: 'Sync export threat model notes for metadata and passwordless vaults',
        content: 'Sensitive content and summaries are encrypted, but metadata still needs a sharper release posture.',
        image: fixtureImage,
        summary: 'Threat model notes for remaining sync metadata exposure.',
        created_at: '2026-06-03T09:20:00Z',
        updated_at: '2026-06-03T09:25:00Z',
        metadata: { item_type: 'note' },
      },
    ],
    '2': [
      {
        id: 201,
        vault_id: 2,
        title: 'Compact card density QA with a deliberately long title that should wrap instead of clipping',
        content: 'Use fixture-backed E2E to catch clipping, cramped toolbar states, and masonry layout regressions.',
        image: fixtureImage,
        summary: 'Compact card density QA checks wrapping and masonry behavior under real content.',
        created_at: '2026-06-03T10:00:00Z',
        updated_at: '2026-06-03T10:05:00Z',
        metadata: { item_type: 'note' },
      },
      {
        id: 202,
        vault_id: 2,
        title: 'Search result vault hydration regression case',
        content: 'Search results must carry vault ids so opening a result reads the correct encrypted vault.',
        image: fixtureImage,
        summary: 'Regression case for search results with vault-specific hydration.',
        created_at: '2026-06-03T10:10:00Z',
        updated_at: '2026-06-03T10:15:00Z',
        metadata: { item_type: 'note' },
      },
    ],
    '3': [
      {
        id: 301,
        vault_id: 3,
        title: 'Locked vault visual reference card',
        content: 'Locked vault cards must remain readable in compact layouts.',
        image: fixtureImage,
        summary: 'Locked vault fixture card for visual density checks.',
        created_at: '2026-06-03T11:00:00Z',
        updated_at: '2026-06-03T11:05:00Z',
        metadata: { item_type: 'note' },
      },
    ],
  },
  metadataByUrl: {
    'https://example.com/tauri-desktop-smoke': {
      title: 'Tauri desktop smoke test reference',
      description: 'A compact checklist for launch, capture, search, updater, and shutdown QA.',
      image: fixtureImage,
    },
  },
  searchResultsByQuery: {
    compact: [
      {
        id: 201,
        vault_id: 2,
        title: 'Compact card density QA with a deliberately long title that should wrap instead of clipping',
        content_preview: 'Use fixture-backed E2E to catch clipping, cramped toolbar states, and masonry layout regressions.',
        score: 1,
      },
    ],
    sync: [
      {
        id: 103,
        vault_id: 1,
        title: 'Sync export threat model notes for metadata and passwordless vaults',
        content_preview: 'Sensitive content and summaries are encrypted, but metadata still needs a sharper release posture.',
        score: 1,
      },
      {
        id: 202,
        vault_id: 2,
        title: 'Search result vault hydration regression case',
        content_preview: 'Search results must carry vault ids so opening a result reads the correct encrypted vault.',
        score: 0.8,
      },
    ],
  },
};

async function expectEmptyStateInContentFrame(page, testId: string) {
  const metrics = await page.evaluate((id) => {
    const main = document.querySelector('[data-testid="main-content"]')?.getBoundingClientRect();
    const empty = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
    if (!main || !empty) return null;

    return {
      centerDelta: Math.abs((empty.left + empty.width / 2) - (main.left + main.width / 2)),
      topOffset: empty.top - main.top,
    };
  }, testId);

  expect(metrics).toBeTruthy();
  expect(metrics!.centerDelta).toBeLessThanOrEqual(3);
  expect(metrics!.topOffset).toBeGreaterThanOrEqual(48);
}

test.describe('brainbox app shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
  });

  test('loads the empty vault workspace without backend failure noise', async ({ page }) => {
    await expect(page.getByTestId('app-navigation')).toBeVisible();
    await expect(page.getByTestId('main-content')).toBeVisible();
    await expect(page.getByTestId('vaults-section')).toBeVisible();
    await expect(page.getByTestId('vault-empty-state')).toBeVisible();
    await expect(page.getByText('Create your first vault')).toBeVisible();
    await expectEmptyStateInContentFrame(page, 'vault-empty-state');
    await expect(page.getByText('Failed to fetch vaults.')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('navigates to search and exposes the search input', async ({ page }) => {
    await page.getByTestId('nav-search').click();
    await expect(page.getByTestId('search-section')).toBeVisible();
    await expect(page.getByTestId('search-idle-state')).toBeVisible();
    await expectEmptyStateInContentFrame(page, 'search-idle-state');
    await expect(page.getByTestId('search-input')).toBeVisible();
    await expect(page.getByTestId('search-input')).toHaveAttribute(
      'placeholder',
      'Search your knowledge vaults...'
    );
  });

  test('opens and closes the quick capture modal', async ({ page }) => {
    await page.getByTestId('floating-capture-button').click();
    await expect(page.getByTestId('capture-modal')).toBeVisible();
    await expect(page.getByTestId('capture-title-input')).toBeVisible();
    await expect(page.getByTestId('capture-content-input')).toBeVisible();
    await expect(page.getByTestId('capture-vault-select')).toBeVisible();

    await page.getByTestId('capture-modal').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('capture-modal')).toHaveCount(0);
  });

  test('opens create vault modal and validates required name locally', async ({ page }) => {
    await page.getByTestId('create-vault-button').click();
    await expect(page.getByTestId('create-vault-modal')).toBeVisible();
    await expect(page.getByTestId('vault-name-input')).toBeVisible();

    await page.getByTestId('create-vault-submit').click();
    await expect(page.getByTestId('create-vault-modal')).toBeVisible();
  });

  test('toggles theme', async ({ page }) => {
    const currentTheme = await page.locator('html').getAttribute('data-theme');

    await page.getByTestId('theme-toggle').click();

    await expect
      .poll(() => page.locator('html').getAttribute('data-theme'))
      .not.toBe(currentTheme);
  });
});

test.describe('brainbox populated workspace fixture', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((fixture) => {
      (window as any).__BRAINBOX_E2E_FIXTURE__ = fixture;
    }, populatedFixture);

    await page.goto('/?fixture=e2e');
    await expect(page.getByTestId('app')).toBeVisible();
  });

  test('renders populated vaults and opens a note item without layout clipping', async ({ page }) => {
    await expect(page.getByTestId('vault-card')).toHaveCount(3);
    await expect(page.getByRole('button', { name: /Open vault Research Intake/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Open vault Product Roadmap/ })).toBeVisible();

    await page.getByRole('button', { name: /Open vault Research Intake/ }).click();

    await expect(page.getByRole('button', { name: 'Research Intake - URLs and clipped source notes' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Open item / })).toHaveCount(3);
    await expect(page.getByRole('button', { name: /Open item Tauri smoke path checklist/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Open item Release readiness reference/ })).toBeVisible();

    await page.getByRole('button', { name: /Open item Tauri smoke path checklist/ }).click();

    await expect(page.getByTestId('item-panel')).toBeVisible();
    await expect(page.getByTestId('item-panel').locator('input').first()).toHaveValue(/Tauri smoke path checklist/);
    await expect(page.getByText('Desktop smoke path tracks launch')).toBeVisible();
  });

  test('searches populated fixture data and opens the result from its source vault', async ({ page }) => {
    await page.getByTestId('nav-search').click();
    await page.getByTestId('search-input').fill('compact');
    await page.getByTestId('search-input').press('Enter');

    await expect(page.getByTestId('search-results')).toBeVisible();
    await expect(page.getByText('Results for "compact"')).toBeVisible();
    await expect(page.getByTestId('masonry-card')).toHaveCount(1);
    await expect(page.getByText('Compact card density QA')).toBeVisible();

    await page.getByRole('button', { name: /Open item Compact card density QA/ }).click();

    await expect(page.getByTestId('item-panel')).toBeVisible();
    await expect(page.getByTestId('item-panel').locator('input').first()).toHaveValue(/Compact card density QA/);
    await expect(page.getByText('Compact card density QA checks wrapping')).toBeVisible();
  });
});
