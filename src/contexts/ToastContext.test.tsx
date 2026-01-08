import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, configure } from '@testing-library/react';
import { useState } from 'react';
import { ToastProvider, useToast } from './ToastContext';
import styles from '../components/Toast/Toast.module.css';

// Configure testing-library to work with fake timers
configure({
  asyncUtilTimeout: 5000,
});

// Helper to advance timers within act
const advanceTimersAndWait = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    // Let React process state updates
    await Promise.resolve();
  });
};

// Test component to use the toast context
const TestComponent = () => {
  const { showToast, showSuccess, showError, showWarning, showInfo, hideToast } = useToast();

  return (
    <div>
      <button onClick={() => showToast('Test message')}>Show Toast</button>
      <button onClick={() => showSuccess('Success message')}>Show Success</button>
      <button onClick={() => showError('Error message')}>Show Error</button>
      <button onClick={() => showWarning('Warning message')}>Show Warning</button>
      <button onClick={() => showInfo('Info message')}>Show Info</button>
      <button onClick={() => hideToast('test-id')}>Hide Toast</button>
    </div>
  );
};

describe('ToastContext', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('provides toast functions', () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    expect(screen.getByText('Show Toast')).toBeInTheDocument();
    expect(screen.getByText('Show Success')).toBeInTheDocument();
    expect(screen.getByText('Show Error')).toBeInTheDocument();
    expect(screen.getByText('Show Warning')).toBeInTheDocument();
    expect(screen.getByText('Show Info')).toBeInTheDocument();
  });

  it('throws error when used outside provider', () => {
    // Suppress console.error for this test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    expect(() => {
      render(<TestComponent />);
    }).toThrow('useToast must be used within a ToastProvider');
    
    consoleSpy.mockRestore();
  });

  it('shows toast when showToast is called', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    const showButton = screen.getByText('Show Toast');

    await act(async () => {
      showButton.click();
    });

    // Advance past entrance animation delay
    await advanceTimersAndWait(50);

    expect(screen.getByText('Test message')).toBeInTheDocument();
  });

  it('shows success toast', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    const showButton = screen.getByText('Show Success');

    await act(async () => {
      showButton.click();
    });

    await advanceTimersAndWait(50);

    expect(screen.getByText('Success message')).toBeInTheDocument();

    // Check for success styling
    const toast = screen.getByText('Success message').closest(`.${styles.toast}`);
    expect(toast).toHaveClass(styles.success);
  });

  it('shows error toast with longer duration', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    const showButton = screen.getByText('Show Error');

    await act(async () => {
      showButton.click();
    });

    await advanceTimersAndWait(50);

    expect(screen.getByText('Error message')).toBeInTheDocument();

    // Check for error styling
    const toast = screen.getByText('Error message').closest(`.${styles.toast}`);
    expect(toast).toHaveClass(styles.error);
  });

  it('shows warning toast', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    const showButton = screen.getByText('Show Warning');

    await act(async () => {
      showButton.click();
    });

    await advanceTimersAndWait(50);

    expect(screen.getByText('Warning message')).toBeInTheDocument();

    const toast = screen.getByText('Warning message').closest(`.${styles.toast}`);
    expect(toast).toHaveClass(styles.warning);
  });

  it('shows info toast', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    const showButton = screen.getByText('Show Info');

    await act(async () => {
      showButton.click();
    });

    await advanceTimersAndWait(50);

    expect(screen.getByText('Info message')).toBeInTheDocument();

    const toast = screen.getByText('Info message').closest(`.${styles.toast}`);
    expect(toast).toHaveClass(styles.info);
  });

  it('auto-dismisses toasts after duration', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    const showButton = screen.getByText('Show Toast');

    await act(async () => {
      showButton.click();
    });

    await advanceTimersAndWait(50);

    expect(screen.getByText('Test message')).toBeInTheDocument();

    // Fast-forward time to trigger auto-dismiss (5000ms duration + 300ms exit animation)
    await advanceTimersAndWait(5300);

    expect(screen.queryByText('Test message')).not.toBeInTheDocument();
  });

  it('allows manual dismissal via close button', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    const showButton = screen.getByText('Show Toast');

    await act(async () => {
      showButton.click();
    });

    await advanceTimersAndWait(50);

    expect(screen.getByText('Test message')).toBeInTheDocument();

    const closeButton = screen.getByLabelText('Close notification');

    await act(async () => {
      closeButton.click();
    });

    // Wait for exit animation
    await advanceTimersAndWait(300);

    expect(screen.queryByText('Test message')).not.toBeInTheDocument();
  });

  it('supports multiple toasts simultaneously', async () => {
    render(
      <ToastProvider>
        <TestComponent />
      </ToastProvider>
    );

    await act(async () => {
      screen.getByText('Show Success').click();
      screen.getByText('Show Error').click();
      screen.getByText('Show Warning').click();
    });

    await advanceTimersAndWait(50);

    expect(screen.getByText('Success message')).toBeInTheDocument();
    expect(screen.getByText('Error message')).toBeInTheDocument();
    expect(screen.getByText('Warning message')).toBeInTheDocument();
  });

  it('generates unique IDs for toasts', async () => {
    const TestComponentWithIds = () => {
      const { showToast } = useToast();
      const [ids, setIds] = useState<string[]>([]);

      const handleShow = () => {
        const id = showToast('Test message');
        setIds(prev => [...prev, id]);
      };

      return (
        <div>
          <button onClick={handleShow}>Show Toast</button>
          <div data-testid="ids">{ids.join(',')}</div>
        </div>
      );
    };

    render(
      <ToastProvider>
        <TestComponentWithIds />
      </ToastProvider>
    );

    const showButton = screen.getByText('Show Toast');
    
    act(() => {
      showButton.click();
      showButton.click();
    });

    const idsElement = screen.getByTestId('ids');
    const ids = idsElement.textContent?.split(',') || [];
    
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^toast-\d+-[a-z0-9]+$/);
  });

  describe('Toast Component', () => {
    it('displays title when provided', async () => {
      const TestWithTitle = () => {
        const { showSuccess } = useToast();
        return (
          <button onClick={() => showSuccess('Message', 'Success Title')}>
            Show Success with Title
          </button>
        );
      };

      render(
        <ToastProvider>
          <TestWithTitle />
        </ToastProvider>
      );

      await act(async () => {
        screen.getByText('Show Success with Title').click();
      });

      await advanceTimersAndWait(50);

      expect(screen.getByText('Success Title')).toBeInTheDocument();
      expect(screen.getByText('Message')).toBeInTheDocument();
    });

    it('shows correct icons for different types', async () => {
      render(
        <ToastProvider>
          <TestComponent />
        </ToastProvider>
      );

      await act(async () => {
        screen.getByText('Show Success').click();
      });

      await advanceTimersAndWait(50);

      const toast = screen.getByText('Success message').closest(`.${styles.toast}`);
      const icon = toast?.querySelector(`.${styles.icon}`);
      // Icon contains an SVG element (Heroicons)
      expect(icon?.querySelector('svg')).toBeInTheDocument();
    });

    it('applies entrance and exit animations', async () => {
      render(
        <ToastProvider>
          <TestComponent />
        </ToastProvider>
      );

      await act(async () => {
        screen.getByText('Show Toast').click();
      });

      await advanceTimersAndWait(50);

      const toast = screen.getByText('Test message').closest(`.${styles.toast}`);
      expect(toast).toHaveClass(styles.visible);

      const closeButton = screen.getByLabelText('Close notification');

      await act(async () => {
        closeButton.click();
      });

      // The toast should now have exiting class
      const exitingToast = screen.getByText('Test message').closest(`.${styles.toast}`);
      expect(exitingToast).toHaveClass(styles.exiting);
    });
  });
});