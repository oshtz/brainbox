import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import ConfirmDialog from '../components/ConfirmDialog/ConfirmDialog';
import { setConfirmHandler } from '../utils/confirmService';

type ConfirmOptions = {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<{
    open: boolean;
    options: ConfirmOptions | null;
    resolve?: (val: boolean) => void;
  }>({ open: false, options: null });

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setState({ open: true, options: opts, resolve });
    });
  }, []);

  const handleClose = useCallback(() => {
    setState((prev) => {
      // If closed via backdrop/escape/close, treat as cancel
      prev.resolve?.(false);
      return { open: false, options: null };
    });
  }, []);

  const handleConfirm = useCallback(() => {
    setState((prev) => {
      prev.resolve?.(true);
      return { open: false, options: null };
    });
  }, []);

  const handleCancel = useCallback(() => {
    setState((prev) => {
      prev.resolve?.(false);
      return { open: false, options: null };
    });
  }, []);

  const ctx = useMemo(() => {
    // Keep the global service in sync
    setConfirmHandler((opts) => confirm(opts));
    return confirm;
  }, [confirm]);

  return (
    <ConfirmContext.Provider value={ctx}>
      {children}
      <ConfirmDialog
        isOpen={state.open}
        title={state.options?.title || ''}
        message={state.options?.message}
        confirmLabel={state.options?.confirmLabel}
        cancelLabel={state.options?.cancelLabel}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        onClose={handleClose}
      />
    </ConfirmContext.Provider>
  );
};

export const useConfirm = (): ConfirmFn => {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
};

// Also register a global, non-hook API for places outside React trees
// no-op additional exports
