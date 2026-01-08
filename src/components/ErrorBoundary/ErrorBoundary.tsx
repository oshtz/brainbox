import { Component, ErrorInfo, ReactNode } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { AppError, ErrorBoundaryState } from '../../types';
import Button from '../Button/Button';
import styles from './ErrorBoundary.module.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: AppError, retry: () => void) => ReactNode;
  onError?: (error: AppError, errorInfo: ErrorInfo) => void;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error: {
        message: error.message,
        code: error.name,
        details: error.stack,
        timestamp: new Date()
      }
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const appError: AppError = {
      message: error.message,
      code: error.name,
      details: { ...errorInfo, stack: error.stack },
      timestamp: new Date()
    };

    console.error('ErrorBoundary caught an error:', appError);
    
    // Call optional error handler
    this.props.onError?.(appError, errorInfo);
    
    // Log to external service if needed
    this.logErrorToService(appError);
  }

  private logErrorToService = (error: AppError): void => {
    // In a real app, you might send this to Sentry, LogRocket, etc.
    try {
      const errorLog = {
        ...error,
        userAgent: navigator.userAgent,
        url: window.location.href,
        timestamp: error.timestamp.toISOString()
      };
      
      // Store in localStorage for now (could be sent to external service)
      const existingLogs = JSON.parse(localStorage.getItem('brainbox-error-logs') || '[]');
      existingLogs.push(errorLog);
      
      // Keep only last 50 errors
      if (existingLogs.length > 50) {
        existingLogs.splice(0, existingLogs.length - 50);
      }
      
      localStorage.setItem('brainbox-error-logs', JSON.stringify(existingLogs));
    } catch (loggingError) {
      console.error('Failed to log error:', loggingError);
    }
  };

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: undefined });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleRetry);
      }

      // Default error UI
      return (
        <div className={styles.errorBoundary}>
          <div className={styles.errorContent}>
            <div className={styles.errorIcon}><ExclamationTriangleIcon className={styles.errorIconSvg} /></div>
            <h2 className={styles.errorTitle}>Something went wrong</h2>
            <p className={styles.errorMessage}>
              {this.state.error.message || 'An unexpected error occurred'}
            </p>
            
            <details className={styles.errorDetails}>
              <summary>Technical Details</summary>
              <pre className={styles.errorStack}>
                {JSON.stringify(this.state.error.details, null, 2)}
              </pre>
            </details>

            <div className={styles.errorActions}>
              <Button onClick={this.handleRetry} variant="primary">
                Try Again
              </Button>
              <Button onClick={this.handleReload} variant="secondary">
                Reload Page
              </Button>
            </div>

            <p className={styles.errorTimestamp}>
              Error occurred at: {this.state.error.timestamp.toLocaleString()}
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;