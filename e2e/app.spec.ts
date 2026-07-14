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
        image: null,
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

  test('opens the empty Library with a clear Inbox path', async ({ page }) => {
    await expect(page.getByTestId('app-navigation')).toBeVisible();
    await expect(page.getByTestId('main-content')).toBeVisible();
    await expect(page.getByTestId('library-section')).toBeVisible();
    await expect(page.getByTestId('library-empty-state')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Start with anything' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Capture your first item' })).toBeVisible();
    await expectEmptyStateInContentFrame(page, 'library-empty-state');
    await expect(page.getByText('Failed to fetch vaults.')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('uses one Library navigation surface', async ({ page }) => {
    await expect(page.getByTestId('nav-library')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('nav-brainy')).toHaveCount(0);
    await expect(page.getByTestId('library-brainy-button')).toHaveCount(0);
    await expect(page.getByTestId('nav-search')).toHaveCount(0);
    await expect(page.getByTestId('nav-vaults')).toHaveCount(0);
    await expect(page.getByTestId('library-search-input')).toBeVisible();
    await expect(page.getByText('Ctrl K')).toBeVisible();
  });

  test('keeps organization controls out of the empty state', async ({ page }) => {
    await expect(page.getByRole('group', { name: 'Type filter' })).toHaveCount(0);
    await expect(page.getByLabel('Filter by vault')).toHaveCount(0);
    await expect(page.getByLabel('Sort order')).toHaveCount(0);
    await expect(page.getByText('0 items')).toHaveCount(0);
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
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim())).toBe('#202020');

    await page.getByTestId('theme-toggle').click();

    await expect
      .poll(() => page.locator('html').getAttribute('data-theme'))
      .not.toBe(currentTheme);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim())).toBe('#eeeeee');
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

  test('renders the combined Library and opens a note item', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^Open item / })).toHaveCount(6);
    await expect(page.getByRole('button', { name: /Open item Tauri smoke path checklist/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Open item Release readiness reference/ })).toBeVisible();

    const rediscover = page.getByTestId('rediscover-shelf');
    await expect(rediscover).toBeVisible();
    await expect(rediscover.locator('button').filter({ hasNotText: /Shuffle|Hide/ })).toHaveCount(3);
    const firstRediscoverSet = await rediscover.locator('button').filter({ hasNotText: /Shuffle|Hide/ }).allTextContents();
    await rediscover.getByRole('button', { name: 'Shuffle' }).click();
    await expect(rediscover.locator('[data-phase="leaving"]')).toHaveCount(1);
    await expect(rediscover.locator('[data-phase="entering"]')).toHaveCount(1);
    await expect.poll(() => rediscover.locator('button').filter({ hasNotText: /Shuffle|Hide/ }).allTextContents()).not.toEqual(firstRediscoverSet);
    await expect(rediscover.locator('[data-phase="current"]')).toBeVisible();
    await rediscover.getByRole('button', { name: 'Hide' }).click();
    await expect(rediscover).toHaveAttribute('data-hiding', 'true');
    await expect(rediscover).toHaveCount(0);

    await page.getByRole('button', { name: /Open item Tauri smoke path checklist/ }).click();

    await expect(page.getByTestId('item-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit item title' })).toContainText('Tauri smoke path checklist');
    await page.getByRole('button', { name: 'Edit item title' }).click();
    await expect(page.getByRole('textbox', { name: 'Item title' })).toHaveValue(/^Tauri smoke path checklist/);
    await page.getByRole('textbox', { name: 'Item title' }).press('Escape');
    await expect(page.getByText('Desktop smoke path tracks launch')).toBeVisible();
    await page.getByRole('button', { name: 'Edit content' }).click();
    await expect(page.getByRole('textbox', { name: 'Content' })).toHaveValue(/^Create a desktop smoke path/);
    await page.getByRole('textbox', { name: 'Content' }).press('Tab');
    await expect(page.getByRole('heading', { name: 'AI summary' })).toBeVisible();
    await expect(page.getByText('Ollama · setup needed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    await expect(page.getByLabel('Move item to vault')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete item' })).toHaveCount(0);
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete item' })).toBeVisible();
    await page.getByRole('button', { name: 'More actions' }).click();

    const dock = await page.evaluate(() => {
      const main = document.querySelector('[data-testid="library-main"]') as HTMLElement;
      const panel = document.querySelector('[data-testid="item-panel"]') as HTMLElement;
      const library = document.querySelector('[data-testid="library-section"]') as HTMLElement;
      const app = document.querySelector('[data-testid="app"]') as HTMLElement;
      const mainBox = main.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      const appBox = app.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        appWidth: appBox.width,
        appHeight: appBox.height,
        mainDisplay: getComputedStyle(main).display,
        edgeDelta: Math.abs(mainBox.right - panelBox.left),
        panelPosition: getComputedStyle(panel).position,
        panelBackground: getComputedStyle(panel).backgroundColor,
        panelWidth: panelBox.width,
        libraryWidth: library.getBoundingClientRect().width,
      };
    });
    expect(dock.panelPosition).not.toBe('fixed');
    expect(dock.panelBackground).toMatch(/^rgb\(/);
    expect(dock.appWidth).toBe(dock.viewportWidth);
    expect(dock.appHeight).toBe(dock.viewportHeight);
    expect(Math.abs(dock.libraryWidth - dock.appWidth)).toBeLessThanOrEqual(1);
    if (dock.viewportWidth > 760) {
      expect(dock.mainDisplay).not.toBe('none');
      await expect.poll(() => page.evaluate(() => {
        const main = document.querySelector('[data-testid="library-main"]')!.getBoundingClientRect();
        const panel = document.querySelector('[data-testid="item-panel"]')!.getBoundingClientRect();
        return Math.abs(main.right - panel.left);
      })).toBeLessThanOrEqual(1);
    } else {
      expect(dock.mainDisplay).toBe('none');
      expect(Math.abs(dock.panelWidth - dock.libraryWidth)).toBeLessThanOrEqual(1);
    }

    await expect(page.getByRole('heading', { name: 'Related' })).toBeVisible();
    await page.getByRole('button', { name: /Open related item Release readiness reference/ }).click();
    await expect(page.getByRole('button', { name: 'Edit item title' })).toContainText('Release readiness reference');
    await expect(page.getByTestId('item-panel-scroll')).toHaveCSS('overflow-y', 'auto');
    await expect(page.getByTestId('item-panel-scroll')).toHaveCSS('scrollbar-width', 'thin');
    await expect(page.getByTestId('item-panel-scroll')).toHaveCSS('mask-image', /linear-gradient/);
    await expect(page.getByRole('button', { name: 'Edit URL' })).toHaveCSS('white-space', 'nowrap');
  });

  test('opens item actions from every supported trigger', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'Mobile Chrome';
    const noteCard = page.locator('[data-item-id="101"]');
    if (isMobile) await noteCard.getByRole('button', { name: 'Card actions' }).click();
    else await noteCard.click({ button: 'right' });

    const menu = page.getByRole('menu', { name: 'Item actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Open details' })).toBeFocused();
    await expect(menu.getByRole('menuitem', { name: 'Copy content' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Open link' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    const linkCard = page.locator('[data-item-id="102"]');
    const link = linkCard.getByRole('button', { name: /Open item Release readiness reference/ });
    if (isMobile) await linkCard.getByRole('button', { name: 'Card actions' }).click();
    else {
      await link.focus();
      await page.keyboard.press('Shift+F10');
    }
    await expect(menu.getByRole('menuitem', { name: 'Open link' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Delete item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete item?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('navigates cards by keyboard and restores the Library position', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 620 });
    const scroll = page.getByTestId('library-scroll-area');
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const cards = page.locator('.masonry-card-bg[data-masonry-focusable]');
    await cards.nth(4).focus();
    await page.keyboard.press('ArrowRight');
    await expect(cards.nth(5)).toBeFocused();
    const scrollTop = await scroll.evaluate((element) => element.scrollTop);

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('item-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('item-panel')).toHaveCount(0);
    await expect(cards.nth(5)).toBeFocused();
    await expect.poll(() => scroll.evaluate((element, expected) => Math.abs(element.scrollTop - expected), scrollTop)).toBeLessThanOrEqual(1);
  });

  test('renders notes without images as readable text cards', async ({ page }) => {
    await expect(page.locator('[data-item-id="101"] .masonry-note-preview')).toBeVisible();
    await expect(page.locator('[data-item-id="101"] .masonry-note-text')).toContainText('Create a desktop smoke path');
    const compactHeight = await page.locator('[data-item-id="201"]').evaluate((element) => element.getBoundingClientRect().height);
    const detailedHeight = await page.locator('[data-item-id="101"]').evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(detailedHeight - compactHeight)).toBeGreaterThan(10);
  });

  test('keeps page controls fixed while content scrolls and persists grid zoom', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 620 });

    const libraryScroll = page.getByTestId('library-scroll-area');
    await expect(libraryScroll).toHaveCSS('mask-image', /linear-gradient/);
    const search = page.getByTestId('library-search-input');
    const searchTop = await search.evaluate((element) => element.getBoundingClientRect().top);
    await libraryScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => libraryScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(Math.abs((await search.evaluate((element) => element.getBoundingClientRect().top)) - searchTop)).toBeLessThanOrEqual(1);
    await libraryScroll.evaluate((element) => { element.scrollTop = 0; });

    const firstCard = page.getByTestId('masonry-card').first();
    await expect.poll(() => firstCard.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(300);
    const defaultWidth = await firstCard.evaluate((element) => element.getBoundingClientRect().width);
    await page.getByRole('button', { name: 'Show smaller cards' }).click();
    await expect.poll(() => firstCard.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(defaultWidth);
    await expect(page.getByRole('button', { name: 'Show smaller cards' })).toBeDisabled();
    const compactWidth = await firstCard.evaluate((element) => element.getBoundingClientRect().width);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Show smaller cards' })).toBeDisabled();
    await expect.poll(() => page.getByTestId('masonry-card').first().evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(defaultWidth);
    await page.getByRole('button', { name: 'Show larger cards' }).click();
    await expect.poll(() => page.getByTestId('masonry-card').first().evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(compactWidth);

    await page.getByTestId('nav-settings').click();
    const settingsTitle = page.getByRole('heading', { name: 'Settings' });
    const captureTab = page.getByRole('tab', { name: /Capture/ });
    const panel = page.getByRole('tabpanel');
    await expect(panel).toHaveCSS('mask-image', /linear-gradient/);
    const fixedTops = await Promise.all([
      settingsTitle.evaluate((element) => element.getBoundingClientRect().top),
      captureTab.evaluate((element) => element.getBoundingClientRect().top),
    ]);
    await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(Math.abs((await settingsTitle.evaluate((element) => element.getBoundingClientRect().top)) - fixedTops[0])).toBeLessThanOrEqual(1);
    expect(Math.abs((await captureTab.evaluate((element) => element.getBoundingClientRect().top)) - fixedTops[1])).toBeLessThanOrEqual(1);
  });

  test('renders bookmarks as one full-width card surface', async ({ page }) => {
    const card = page.locator('[data-item-id="102"]');
    await expect.poll(() => card.evaluate((element) => {
      const cardWidth = element.getBoundingClientRect().width;
      const mediaWidth = element.querySelector('.mlp-media')!.getBoundingClientRect().width;
      return cardWidth ? mediaWidth / cardWidth : 0;
    })).toBeGreaterThan(0.98);

    const metrics = await card.evaluate((element) => {
      const card = element.getBoundingClientRect();
      const preview = element.querySelector('.masonry-link-preview')!.getBoundingClientRect();
      return {
        leftInset: preview.left - card.left,
        rightInset: card.right - preview.right,
        topInset: preview.top - card.top,
      };
    });
    expect(Math.abs(metrics.leftInset)).toBeLessThanOrEqual(2);
    expect(Math.abs(metrics.rightInset)).toBeLessThanOrEqual(2);
    expect(Math.abs(metrics.topInset)).toBeLessThanOrEqual(2);

    await expect.poll(() => page.locator('[data-item-id="201"]').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return Math.abs(box.width / box.height - 4 / 3);
    })).toBeLessThan(0.03);

    const supportsHover = await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches);
    const body = card.locator('.mlp-body');
    const title = card.locator('.mlp-title');
    await expect(title).not.toBeEmpty();
    if (supportsHover) {
      await expect(body).toHaveCSS('opacity', '0');
      await card.locator('.masonry-card-bg').focus();
      await expect(body).toHaveCSS('opacity', '1');
    } else {
      await expect(body).toHaveCSS('opacity', '1');
    }
  });

  test('keeps brainy contextual to a populated Library', async ({ page }) => {
    await expect(page.getByTestId('nav-brainy')).toHaveCount(0);
    await expect(page.getByTestId('library-brainy-button')).toBeVisible();
    await page.getByTestId('library-brainy-button').click();
    await expect(page.getByTestId('brainy-chat')).toBeVisible();
  });

  test('keeps cards readable when brainy narrows the Library canvas', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.getByTestId('library-brainy-button').click();
    await expect(page.getByTestId('brainy-chat')).toBeVisible();

    await expect.poll(() => page.getByTestId('masonry-card').first().evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThanOrEqual(220);
  });

  test('keeps full-page brainy on a focused reading column', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('brainbox-ai-settings', JSON.stringify({ brainyMode: 'full' })));
    await page.reload();
    await page.getByTestId('library-brainy-button').click();

    const composer = page.getByPlaceholder('Configure AI provider in Settings first').locator('..');
    await expect(composer).toBeVisible();
    const metrics = await composer.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const main = document.querySelector('[data-testid="main-content"]')!.getBoundingClientRect();
      return {
        width: box.width,
        centerDelta: Math.abs((box.left + box.width / 2) - (main.left + main.width / 2)),
      };
    });
    expect(metrics.width).toBeLessThanOrEqual(800);
    expect(metrics.centerDelta).toBeLessThanOrEqual(4);
  });

  test('searches and scopes populated data inside the Library', async ({ page }) => {
    await page.getByTestId('library-search-input').fill('hydration roadmap');
    await expect(page.getByTestId('rediscover-shelf')).toHaveCount(0);
    await expect(page.locator('[data-item-id="202"]')).toBeVisible();
    await expect(page.locator('[data-item-id="201"]')).toHaveCount(0);

    await page.getByTestId('library-search-input').fill('rollback');
    await expect(page.locator('[data-item-id="102"]')).toBeVisible();
    await expect(page.locator('[data-item-id="102"] .mlp-desc')).toContainText('rollback checks');
    await expect(page.locator('[data-item-id="101"]')).toHaveCount(0);

    await page.getByTestId('library-search-input').fill('');
    await expect(page.getByTestId('rediscover-shelf')).toBeVisible();
    await page.getByLabel('Filter by vault').selectOption('1');
    await expect(page.getByTestId('masonry-card')).toHaveCount(3);
  });

  test('filters notes and links without heuristic categories', async ({ page }) => {
    await page.getByRole('button', { name: 'Links' }).click();
    await expect(page.getByTestId('masonry-card')).toHaveCount(1);
    await page.getByRole('button', { name: 'Notes' }).click();
    await expect(page.getByTestId('masonry-card')).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Quotes' })).toHaveCount(0);
  });

  test('captures content first and keeps overrides available', async ({ page }) => {
    await page.getByTestId('floating-capture-button').click();
    await expect(page.getByTestId('capture-modal')).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByTestId('capture-content-input')).toBeFocused();
    await page.getByTestId('capture-content-input').fill('A title derived from the first line\nMore detail');
    await page.getByText('Title and destination').click();
    await expect(page.getByTestId('capture-title-input')).toHaveAttribute('placeholder', 'A title derived from the first line');
    await expect(page.getByTestId('capture-vault-select')).not.toHaveValue('');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('capture-modal')).toHaveCount(0);
  });
});
