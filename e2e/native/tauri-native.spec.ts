import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test.describe.configure({ mode: 'serial' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const execFileAsync = promisify(execFile);

type NativeApp = {
  browser: Browser;
  dataDir: string;
  page: Page;
  port: number;
  process: ChildProcessWithoutNullStreams;
  runDir: string;
};

let app: NativeApp | null = null;

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a TCP port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(
  action: () => Promise<T>,
  options: { message: string; timeoutMs?: number; intervalMs?: number }
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(`${options.message}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

function resolveTauriExecutable(): string {
  if (process.env.BRAINBOX_TAURI_QA_EXE) {
    return process.env.BRAINBOX_TAURI_QA_EXE;
  }

  const exeName = process.platform === 'win32' ? 'brainbox.exe' : 'brainbox';
  return path.join(repoRoot, 'src-tauri', 'target', 'debug', exeName);
}

async function connectToNativePage(port: number): Promise<{ browser: Browser; page: Page }> {
  return waitFor(async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url().includes('localhost:17341') || candidate.url().includes('127.0.0.1:17341')) ?? pages[0];
    if (!page) {
      await browser.close();
      throw new Error('No WebView page exposed over CDP');
    }
    await page.waitForSelector('[data-testid="app"]', { timeout: 5_000 });
    return { browser, page };
  }, { message: 'Timed out connecting Playwright to the Tauri WebView2 page', timeoutMs: 45_000 });
}

async function launchNativeApp(runDir: string, dataDir: string): Promise<NativeApp> {
  const exe = resolveTauriExecutable();
  if (!fs.existsSync(exe)) {
    throw new Error(`Tauri debug executable not found at ${exe}. Run pnpm tauri build --debug --no-bundle --ci first.`);
  }

  const port = await getAvailablePort();
  const child = spawn(exe, {
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      BRAINBOX_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });

  const stdout = fs.createWriteStream(path.join(runDir, 'brainbox.stdout.log'), { flags: 'a' });
  const stderr = fs.createWriteStream(path.join(runDir, 'brainbox.stderr.log'), { flags: 'a' });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  const { browser, page } = await connectToNativePage(port);
  await page.bringToFront();

  return { browser, dataDir, page, port, process: child, runDir };
}

async function startNativeApp(): Promise<NativeApp> {
  test.skip(process.platform !== 'win32', 'Native Playwright QA currently targets Windows WebView2 CDP.');

  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainbox-tauri-native-qa-'));
  const dataDir = path.join(runDir, 'profile');
  await fsp.mkdir(dataDir, { recursive: true });
  return launchNativeApp(runDir, dataDir);
}

async function stopNativeProcess(nativeApp: NativeApp | null) {
  if (!nativeApp) return;

  await nativeApp.browser.close().catch(() => {});

  if (!nativeApp.process.killed) {
    nativeApp.process.kill();
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    nativeApp.process.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function relaunchNativeApp(nativeApp: NativeApp): Promise<NativeApp> {
  const { dataDir, runDir } = nativeApp;
  await stopNativeProcess(nativeApp);
  return launchNativeApp(runDir, dataDir);
}

async function stopNativeApp(nativeApp: NativeApp | null) {
  if (!nativeApp) return;

  await stopNativeProcess(nativeApp);

  if (!process.env.BRAINBOX_KEEP_TAURI_QA_DATA) {
    await fsp.rm(nativeApp.runDir, { recursive: true, force: true });
  }
}

async function resizeNativeWindow(page: Page, width: number, height: number) {
  if (process.platform === 'win32') {
    const pid = app?.process.pid;
    if (!pid) throw new Error('Native app process is not running');
    const command = `
      Add-Type -TypeDefinition @'
      using System;
      using System.Runtime.InteropServices;
      public class BrainboxNativeQaWindow {
        [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
      }
'@ -ErrorAction SilentlyContinue;
      $p = Get-Process -Id ${pid} -ErrorAction Stop;
      if ($p.MainWindowHandle -eq 0) { throw "brainbox main window handle is not ready"; }
      [BrainboxNativeQaWindow]::MoveWindow($p.MainWindowHandle, 80, 50, ${width}, ${height}, $true) | Out-Null;
      [BrainboxNativeQaWindow]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;
    `;
    await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]);
  } else {
    await page.setViewportSize({ width, height });
  }
  await page.waitForTimeout(450);
}

async function visibleBox(locator: ReturnType<Page['locator']>) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  return box!;
}

async function closeBrainyIfOpen(page: Page) {
  const brainy = page.getByTestId('brainy-chat');
  if (!(await brainy.isVisible().catch(() => false))) return;

  await page.keyboard.press('Escape');
  if (await brainy.isVisible().catch(() => false)) {
    await brainy.getByRole('button', { name: 'Close' }).click({ force: true });
  }
  await expect(brainy).toHaveCount(0);
}

test.beforeAll(async () => {
  app = await startNativeApp();
});

test.afterAll(async () => {
  await stopNativeApp(app);
  app = null;
});

test.beforeEach(async () => {
  expect(app).toBeTruthy();
  await app!.page.bringToFront();
  await closeBrainyIfOpen(app!.page);
});

test('native first capture creates one Inbox, recalls offline, and persists across relaunch', async ({}, testInfo) => {
  let page = app!.page;
  await resizeNativeWindow(page, 1115, 768);
  await expect(page.getByTestId('library-empty-state')).toBeVisible();
  await expect(page.getByLabel('Filter by vault')).toHaveCount(0);

  await page.context().setOffline(true);
  expect(await page.evaluate(async () => {
    try {
      await fetch('https://example.com/', { cache: 'no-store' });
      return false;
    } catch {
      return true;
    }
  })).toBe(true);

  try {
    await page.getByTestId('floating-capture-button').dblclick();
    await expect(page.getByTestId('capture-modal')).toBeVisible();
    const destinations = page.getByTestId('capture-vault-select').getByRole('option');
    await expect(destinations).toHaveCount(1);
    await expect(destinations).toHaveText('Inbox');

    await page.getByTestId('capture-content-input').fill('Offline capture cedar atlas recall persists');
    await page.getByTestId('capture-content-input').press('Control+Enter');
    await expect(page.getByTestId('capture-modal')).toHaveCount(0);

    const capturedCard = page.getByTestId('masonry-card').filter({ hasText: 'Offline capture cedar atlas recall persists' });
    await expect(capturedCard.locator('.masonry-note-preview')).toBeVisible();
    await expect(capturedCard.locator('.masonry-note-title')).toHaveCount(0);
    await page.getByTestId('library-search-input').fill('atlas offline');
    await expect(capturedCard).toBeVisible();
    await expect.poll(() => capturedCard.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(220);

    await testInfo.attach('native-first-capture-offline', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    app = await relaunchNativeApp(app!);
    page = app.page;
    await page.context().setOffline(true);
    await expect(page.getByTestId('app')).toBeVisible();
    await page.getByLabel('Filter by vault').click();
    await expect(page.getByRole('menuitemradio', { name: 'Inbox' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('library-search-input').fill('atlas offline');
    await expect(page.getByTestId('masonry-card').filter({ hasText: 'Offline capture cedar atlas recall persists' })).toBeVisible();
  } finally {
    await app?.page.context().setOffline(false).catch(() => {});
  }
});

test('native localhost bookmarklet captures selected text as a sourced note', async ({}, testInfo) => {
  let page = app!.page;
  await resizeNativeWindow(page, 1115, 768);
  await page.getByTestId('library-search-input').fill('');

  const selectedText = 'Bookmarklet constellation passage stays searchable across relaunch';
  const sourceUrl = 'http://127.0.0.1:17341/';
  const sourceBrowser = await chromium.launch();
  try {
    const sourcePage = await sourceBrowser.newPage();
    await sourcePage.goto(sourceUrl);
    await sourcePage.evaluate((text) => {
      document.title = 'Bookmarklet selection source';
      const passage = document.createElement('p');
      passage.textContent = text;
      document.body.appendChild(passage);
      const range = document.createRange();
      range.selectNodeContents(passage);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, selectedText);

    const bookmarklet = (await fsp.readFile(path.join(repoRoot, 'examples', 'bookmarklet-direct.js'), 'utf8'))
      .trim()
      .replace(/^javascript:/, '');
    await sourcePage.evaluate(bookmarklet);

    await expect(page.getByTestId('capture-modal')).toBeVisible();
    await expect(page.getByTestId('capture-title-input')).toHaveValue('Bookmarklet selection source');
    await expect(page.getByTestId('capture-content-input')).toHaveValue(`${selectedText}\n\nSource: ${sourceUrl}`);
    await expect(page.getByTestId('capture-vault-select')).toHaveValue('1');
    await page.getByTestId('capture-content-input').press('Control+Enter');
    await expect(page.getByTestId('capture-modal')).toHaveCount(0);
  } finally {
    await sourceBrowser.close();
  }

  const capturedCard = page.getByTestId('masonry-card').filter({ hasText: selectedText });
  await expect(capturedCard).toBeVisible();
  await expect(capturedCard).not.toContainText(sourceUrl);
  await capturedCard.getByRole('button', { name: /Open item/ }).click();
  await expect(page.getByRole('link', { name: 'Open source ↗' })).toHaveAttribute('href', sourceUrl);
  await expect(page.getByRole('button', { name: 'Edit content' })).not.toContainText('Source:');
  await page.getByRole('button', { name: 'Close item details' }).click();

  await page.getByTestId('library-search-input').fill('constellation bookmarklet');
  await expect(capturedCard).toBeVisible();
  await testInfo.attach('native-bookmarklet-selection', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  app = await relaunchNativeApp(app!);
  page = app.page;
  await expect.poll(() => page.getByTestId('masonry-card').count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.getByTestId('library-search-input').fill('constellation bookmarklet');
  await expect(page.getByTestId('masonry-card').filter({ hasText: selectedText })).toBeVisible();
});

test('native Library and Settings share the same content frame at desktop size', async ({}, testInfo) => {
  const page = app!.page;
  await resizeNativeWindow(page, 1115, 768);
  await page.getByTestId('library-search-input').fill('');
  expect(['#202020', '#eeeeee']).toContain(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()));
  expect(Math.round((await visibleBox(page.getByTestId('app-navigation'))).y)).toBeLessThanOrEqual(1);

  const toolbarHeights = await Promise.all([
    page.getByRole('group', { name: 'Type filter' }),
    page.getByLabel('Filter by vault'),
    page.getByLabel('Sort order'),
    page.getByRole('group', { name: 'Card size' }),
  ].map((control) => control.evaluate((element) => element.getBoundingClientRect().height)));
  expect(Math.max(...toolbarHeights) - Math.min(...toolbarHeights)).toBeLessThanOrEqual(1);

  await page.getByLabel('Sort order').click();
  await expect(page.getByRole('menu', { name: 'Sort order options' })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: 'Recently created' })).toBeVisible();
  await page.keyboard.press('Escape');

  const scrollOwnership = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="library-main"]') as HTMLElement;
    const scroll = document.querySelector('[data-testid="library-scroll-area"]') as HTMLElement;
    return { main: getComputedStyle(main).overflowY, content: getComputedStyle(scroll).overflowY };
  });
  expect(scrollOwnership).toEqual({ main: 'hidden', content: 'auto' });

  const libraryScroll = page.getByTestId('library-scroll-area');
  await resizeNativeWindow(page, 780, 360);
  expect(await libraryScroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const idleScrollbar = await libraryScroll.evaluate((element) => getComputedStyle(element).getPropertyValue('scrollbar-color'));
  await libraryScroll.hover();
  await expect.poll(() => libraryScroll.evaluate((element) => getComputedStyle(element).getPropertyValue('scrollbar-color'))).not.toBe(idleScrollbar);
  await page.getByTestId('library-search-input').hover();
  await expect.poll(() => libraryScroll.evaluate((element) => getComputedStyle(element).getPropertyValue('scrollbar-color'))).toBe(idleScrollbar);
  await resizeNativeWindow(page, 1115, 768);

  const card = page.getByTestId('masonry-card').first();
  const smallerCards = page.getByRole('button', { name: 'Show smaller cards' });
  const largerCards = page.getByRole('button', { name: 'Show larger cards' });
  const zoomOut = await smallerCards.isEnabled();
  const widthBeforeZoom = await card.evaluate((element) => element.getBoundingClientRect().width);
  await (zoomOut ? smallerCards : largerCards).click();
  await expect.poll(() => card.evaluate(
    (element, before) => Math.abs(element.getBoundingClientRect().width - before),
    widthBeforeZoom,
  )).toBeGreaterThan(20);
  await (zoomOut ? largerCards : smallerCards).click();

  const sections: Array<{ name: string; open: () => Promise<void>; locator: ReturnType<Page['locator']> }> = [
    {
      name: 'Library',
      open: async () => page.getByTestId('nav-library').click(),
      locator: page.getByRole('heading', { name: 'Library', exact: true }).locator('xpath=ancestor::header[1]'),
    },
    {
      name: 'Settings',
      open: async () => page.getByTestId('nav-settings').click(),
      locator: page.getByRole('heading', { name: 'Settings', exact: true }).locator('xpath=ancestor::header[1]'),
    },
  ];

  await expect(page.getByTestId('nav-vaults')).toHaveCount(0);
  await expect(page.getByTestId('nav-search')).toHaveCount(0);

  const leftEdges: Record<string, number> = {};

  for (const section of sections) {
    await section.open();
    const box = await visibleBox(section.locator);
    leftEdges[section.name] = Math.round(box.x);
    await testInfo.attach(`native-${section.name.toLowerCase()}-desktop`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  }

  const baseline = leftEdges.Library;
  for (const [name, x] of Object.entries(leftEdges)) {
    expect.soft(Math.abs(x - baseline), `${name} left edge (${x}) should align with Library (${baseline})`).toBeLessThanOrEqual(2);
  }

  const settingsTitle = page.getByRole('heading', { name: 'Settings' });
  const captureTab = page.getByRole('tab', { name: /Capture/ });
  await captureTab.click();
  const settingsPanel = page.getByRole('tabpanel');
  const fixedTops = await Promise.all([
    settingsTitle.evaluate((element) => element.getBoundingClientRect().top),
    captureTab.evaluate((element) => element.getBoundingClientRect().top),
  ]);
  await settingsPanel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => settingsPanel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(Math.abs((await settingsTitle.evaluate((element) => element.getBoundingClientRect().top)) - fixedTops[0])).toBeLessThanOrEqual(1);
  expect(Math.abs((await captureTab.evaluate((element) => element.getBoundingClientRect().top)) - fixedTops[1])).toBeLessThanOrEqual(1);
});

test('native Brainy drawer opens and remains usable in a narrow Tauri window', async ({}, testInfo) => {
  const page = app!.page;
  await resizeNativeWindow(page, 430, 820);

  await expect(page.getByTestId('nav-brainy')).toHaveCount(0);
  await page.getByTestId('nav-library').click();
  await page.getByTestId('library-brainy-button').click();
  await expect(page.getByTestId('brainy-chat')).toBeVisible();
  await expect(page.getByText('What should we work on?')).toBeVisible();
  await expect(page.getByPlaceholder(/Ask brainy|Configure AI provider in Settings first/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'List all my vaults' })).toBeVisible();
  await page.waitForTimeout(250);

  await testInfo.attach('native-brainy-narrow', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('native Settings selector replaces tabs in a narrow Tauri window', async ({}, testInfo) => {
  const page = app!.page;
  await resizeNativeWindow(page, 430, 820);

  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-section')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Settings sections' })).toBeHidden();
  const sectionSelect = page.getByLabel('Settings section', { exact: true });
  await expect(sectionSelect).toBeVisible();
  await expect(sectionSelect).toHaveValue('general');
  expect(await sectionSelect.locator('option').allTextContents()).toEqual([
    'General',
    'Capture',
    'AI',
    'Privacy & Data',
  ]);
  await sectionSelect.selectOption('capture');
  await expect(page.getByText('Capture tools')).toBeVisible();
  expect(await page.getByTestId('settings-section').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

  await testInfo.attach('native-settings-narrow', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('native wrong-password attempt keeps a protected vault locked', async () => {
  const page = app!.page;
  await resizeNativeWindow(page, 1115, 768);
  await page.getByTestId('nav-library').click();

  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('vault-name-input').fill('Protected QA Vault');
  await page.getByTestId('vault-has-password-checkbox').check();
  await page.getByTestId('vault-password-input').fill('correct-password');
  await page.getByTestId('create-vault-submit').click();
  await page.getByTestId('floating-capture-button').click();
  await expect(page.getByTestId('capture-vault-select').getByRole('option', { name: 'Protected QA Vault' })).toHaveCount(1);
  await page.getByText('Title and destination').click();
  await page.getByTestId('capture-vault-select').selectOption({ label: 'Protected QA Vault' });
  await page.getByTestId('capture-content-input').fill('Protected QA secret');
  await page.getByTestId('capture-submit-button').click();
  await expect(page.getByTestId('masonry-card').filter({ hasText: 'Protected QA secret' })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('app')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Unlock vault' })).toBeVisible();
  await page.getByLabel('Vault password').fill('wrong-password');
  await page.getByRole('button', { name: 'Unlock' }).click();

  await expect(page.getByRole('dialog', { name: 'Unlock vault' })).toHaveCount(0);
  await expect(page.getByTestId('library-section')).toBeVisible();
  await page.getByLabel('Filter by vault').click();
  await expect(page.getByRole('menuitemradio', { name: 'Protected QA Vault' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Protected QA secret')).toHaveCount(0);
  await expect(page.getByTestId('masonry-card').filter({ hasText: 'Offline capture cedar atlas recall persists' })).toBeVisible();
  await expect(page.getByText('0 items')).toHaveCount(0);
  await expect(page.getByText('What should we work on?')).toHaveCount(0);
});
