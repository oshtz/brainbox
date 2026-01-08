import React, { createContext, useContext, useState, ReactNode, useCallback } from 'react';
import { ToastContainer, ToastProps, ToastType } from '../components/Toast/Toast';

interface ToastContextType {
  showToast: (message: string, type?: ToastType, title?: string, duration?: number) => string;
  hideToast: (id: string) => void;
  showSuccess: (message: string, title?: string) => string;
  showError: (message: string, title?: string) => string;
  showWarning: (message: string, title?: string) => string;
  showInfo: (message: string, title?: string) => string;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

interface ToastProviderProps {
  children: ReactNode;
}

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastProps[]>([]);

  const generateId = useCallback(() => {
    return `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  const showToast = useCallback((
    message: string,
    type: ToastType = 'info',
    title?: string,
    duration: number = 5000
  ): string => {
    const id = generateId();
    const newToast: ToastProps = {
      id,
      type,
      message,
      title,
      duration,
      onClose: hideToast
    };

    setToasts(prev => [...prev, newToast]);
    return id;
  }, [generateId]);

  const hideToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const showSuccess = useCallback((message: string, title?: string): string => {
    return showToast(message, 'success', title);
  }, [showToast]);

  const showError = useCallback((message: string, title?: string): string => {
    return showToast(message, 'error', title, 8000); // Longer duration for errors
  }, [showToast]);

  const showWarning = useCallback((message: string, title?: string): string => {
    return showToast(message, 'warning', title, 6000);
  }, [showToast]);

  const showInfo = useCallback((message: string, title?: string): string => {
    return showToast(message, 'info', title);
  }, [showToast]);

  const contextValue: ToastContextType = {
    showToast,
    hideToast,
    showSuccess,
    showError,
    showWarning,
    showInfo
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastContainer toasts={toasts} onClose={hideToast} />
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const context = useContext(ToastContext);
  if (context === undefined) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

// Utility function for handling async operations with toast feedback
export const withToastFeedback = async <T,>(
  operation: () => Promise<T>,
  options: {
    loadingMessage?: string;
    successMessage?: string;
    errorMessage?: string;
    showToast: ToastContextType['showToast'];
    showSuccess: ToastContextType['showSuccess'];
    showError: ToastContextType['showError'];
  }
): Promise<T> => {
  const { loadingMessage, successMessage, errorMessage, showToast, showSuccess, showError } = options;
  
  let loadingToastId: string | undefined;
  
  if (loadingMessage) {
    loadingToastId = showToast(loadingMessage, 'info', undefined, 0); // No auto-dismiss
  }

  try {
    const result = await operation();
    
    if (loadingToastId) {
      // Hide loading toast
      setTimeout(() => {
        // This would need to be implemented in the context
      }, 100);
    }
    
    if (successMessage) {
      showSuccess(successMessage);
    }
    
    return result;
  } catch (error) {
    if (loadingToastId) {
      // Hide loading toast
      setTimeout(() => {
        // This would need to be implemented in the context
      }, 100);
    }
    
    const message = errorMessage || (error instanceof Error ? error.message : 'An error occurred');
    showError(message);
    
    throw error;
  }
};