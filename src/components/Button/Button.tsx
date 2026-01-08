import React from 'react';
import { ButtonProps } from '../../types';
import styles from './Button.module.css';

const Button: React.FC<ButtonProps> = ({ 
  children, 
  onClick, 
  variant = 'primary', 
  size = 'md',
  type = 'button',
  loading = false,
  disabled = false,
  className = '',
  ...props 
}) => {
  // Combine base style with variant and size styles
  const buttonClasses = [
    styles.button,
    styles[variant] || styles.primary,
    styles[size] || styles.md,
    loading && styles.loading,
    className
  ].filter(Boolean).join(' ');

  return (
    <button
      type={type}
      className={buttonClasses}
      onClick={onClick}
      disabled={disabled || loading}
      aria-disabled={disabled || loading ? 'true' : 'false'}
      {...props}
    >
      {loading ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : null}
      <span className={loading ? styles.loadingText : undefined}>
        {children}
      </span>
    </button>
  );
};

export default Button;