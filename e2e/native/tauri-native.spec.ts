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
    const page = pages.find((candidate) => candidate.url().includes('localhost:17340') || candidate.url().includes('127.0.0.1:17340')) ?? pages[0];
    if (!page) {
      await browser.close();
      throw new Error('No WebView page exposed over CDP');
    }
    await page.waitForSelector('[data-testid="app"]', { timeout: 5_000 });
    return { browser, page };
  }, { message: 'Timed out connecting Playwright to the Tauri WebView2 page', timeoutMs: 45_000 });
}

async function startNativeApp(): Promise<NativeApp> {
  test.skip(process.platform !== 'win32', 'Native Playwright QA currently targets Windows WebView2 CDP.');

  const exe = resolveTauriExecutable();
  if (!fs.existsSync(exe)) {
    throw new Error(`Tauri debug executable not found at ${exe}. Run pnpm tauri build --debug --no-bundle --ci first.`);
  }

  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainbox-tauri-native-qa-'));
  const dataDir = path.join(runDir, 'profile');
  await fsp.mkdir(dataDir, { recursive: true });
  const port = await getAvailablePort();

  const child = spawn(exe, {
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      BRAINBOX_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });

  const stdout = fs.createWriteStream(path.join(runDir, 'brainbox.stdout.log'));
  const stderr = fs.createWriteStream(path.join(runDir, 'brainbox.stderr.log'));
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  const { browser, page } = await connectToNativePage(port);
  await page.bringToFront();

  return { browser, dataDir, page, port, process: child, runDir };
}

async function stopNativeApp(nativeApp: NativeApp | null) {
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

  await brainy.getByRole('button', { name: 'Close' }).click();
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

test('native top-level tabs share the same content frame at desktop size', async ({}, testInfo) => {
  const page = app!.page;
  await resizeNativeWindow(page, 1115, 768);

  const sections: Array<{ name: string; open: () => Promise<void>; locator: ReturnType<Page['locator']> }> = [
    {
      name: 'Knowledge',
      open: async () => page.getByTestId('nav-vaults').click(),
      locator: page.getByTestId('vaults-section'),
    },
    {
      name: 'Explore',
      open: async () => page.getByTestId('nav-search').click(),
      locator: page.getByTestId('search-section'),
    },
    {
      name: 'Library',
      open: async () => page.getByTestId('nav-library').click(),
      locator: page.getByTestId('library-section'),
    },
    {
      name: 'Settings',
      open: async () => page.getByTestId('nav-settings').click(),
      locator: page.getByTestId('settings-section'),
    },
  ];

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

  const baseline = leftEdges.Knowledge;
  for (const [name, x] of Object.entries(leftEdges)) {
    expect.soft(Math.abs(x - baseline), `${name} left edge (${x}) should align with Knowledge (${baseline})`).toBeLessThanOrEqual(2);
  }
});

test('native Brainy drawer opens and remains usable in a narrow Tauri window', async ({}, testInfo) => {
  const page = app!.page;
  await resizeNativeWindow(page, 430, 820);

  await page.getByTestId('nav-brainy').click();
  await expect(page.getByTestId('brainy-chat')).toBeVisible();
  await expect(page.getByText('What should we work on?')).toBeVisible();
  await expect(page.getByPlaceholder('Configure AI provider in Settings first')).toBeVisible();
  await expect(page.getByRole('button', { name: 'List all my vaults' })).toBeVisible();

  await testInfo.attach('native-brainy-narrow', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('native Settings tabs fit in a narrow Tauri window', async ({}, testInfo) => {
  const page = app!.page;
  await resizeNativeWindow(page, 430, 820);

  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-section')).toBeVisible();
  await expect(page.getByRole('tab', { name: /Capture/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Appearance/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Updates/ })).toBeVisible();
  await expect(page.getByText('Capture tools')).toBeVisible();

  await testInfo.attach('native-settings-narrow', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('native wrong-password attempt keeps a protected vault locked', async () => {
  const page = app!.page;
  await resizeNativeWindow(page, 1115, 768);
  await page.getByTestId('nav-vaults').click();

  await page.getByTestId('create-vault-button').click();
  await page.getByTestId('vault-name-input').fill('Protected QA Vault');
  await page.getByTestId('vault-has-password-checkbox').check();
  await page.getByTestId('vault-password-input').fill('correct-password');
  await page.getByTestId('create-vault-submit').click();
  await expect(page.getByRole('button', { name: /Open vault Protected QA Vault/ })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('app')).toBeVisible();
  await page.getByRole('button', { name: /Open vault Protected QA Vault/ }).click();
  await expect(page.getByRole('dialog', { name: 'Unlock vault' })).toBeVisible();
  await page.getByLabel('Vault password').fill('wrong-password');
  await page.getByRole('button', { name: 'Unlock' }).click();

  await expect(page.getByTestId('toast-error')).toContainText('Incorrect password');
  await expect(page.getByTestId('vaults-section')).toBeVisible();
  await expect(page.getByRole('button', { name: /Open vault Protected QA Vault/ })).toBeVisible();
  await expect(page.getByText('What should we work on?')).toHaveCount(0);
});
