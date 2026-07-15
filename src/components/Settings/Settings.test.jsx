import React from 'react';
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from '../../test/utils';
import { mockInvoke } from '../../test/setup';
import Settings from './Settings';

vi.mock('../AISettings', () => ({ AISettings: () => <div>AI settings</div> }));
vi.mock('../ExportImport', () => ({ ExportImport: () => <div>Backup settings</div> }));
vi.mock('../KeyManagement', () => ({ KeyManagement: () => <div>Security settings</div> }));
vi.mock('../FolderSync/FolderSync', () => ({ FolderSync: () => <div>Folder sync settings</div> }));

describe('Settings section targets', () => {
  let animationFrameCallback;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockResolvedValue('1.2.0');
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      animationFrameCallback = callback;
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test.each([
    ['ai-settings', 'AI', 'ai-settings'],
    ['update-settings', 'General', 'update-settings'],
    ['sync-settings', 'Privacy & Data', 'sync-settings'],
  ])('opens %s in its new parent section', async (section, tab, targetId) => {
    const onScrollComplete = vi.fn();
    render(<Settings scrollToSection={section} onScrollComplete={onScrollComplete} />);

    act(() => vi.advanceTimersByTime(100));

    const panel = screen.getByRole('tabpanel');
    const target = document.getElementById(targetId);
    expect(target).toBeTruthy();
    Object.defineProperty(panel, 'scrollTop', { configurable: true, writable: true, value: 0 });
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ top: 20 });
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 120 });

    await act(async () => animationFrameCallback(0));

    expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    expect(panel.scrollTop).toBe(100);
    expect(onScrollComplete).toHaveBeenCalledOnce();
  });
});
