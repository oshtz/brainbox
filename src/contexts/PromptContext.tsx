import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import PromptDialog from '../components/PromptDialog/PromptDialog';

export type PromptOptions = {
  title: string;
  message?: React.ReactNode;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  inputType?: 'text' | 'password' | 'url';
  autoComplete?: string;
  required?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
};

type PromptFn = (opts: PromptOptions) => Promise<string | null>;

const PromptContext = createContext<PromptFn | null>(null);

export const PromptProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<{
    open: boolean;
    options: PromptOptions | null;
    resolve?: (val: string | null) => void;
  }>({ open: false, options: null });

  const prompt = useCallback<PromptFn>((opts) => {
    return new Promise<string | null>((resolve) => {
      setState({ open: true, options: opts, resolve });
    });
  }, []);

  const handleClose = useCallback(() => {
    setState((prev) => {
      prev.resolve?.(null);
      return { open: false, options: null };
    });
  }, []);

  const handleConfirm = useCallback((value: string) => {
    setState((prev) => {
      prev.resolve?.(value);
      return { open: false, options: null };
    });
  }, []);

  const ctx = useMemo(() => prompt, [prompt]);

  return (
    <PromptContext.Provider value={ctx}>
      {children}
      <PromptDialog
        isOpen={state.open}
        title={state.options?.title || ''}
        message={state.options?.message}
        label={state.options?.label}
        placeholder={state.options?.placeholder}
        defaultValue={state.options?.defaultValue}
        inputType={state.options?.inputType}
        autoComplete={state.options?.autoComplete}
        required={state.options?.required}
        confirmLabel={state.options?.confirmLabel}
        cancelLabel={state.options?.cancelLabel}
        onConfirm={handleConfirm}
        onCancel={handleClose}
        onClose={handleClose}
      />
    </PromptContext.Provider>
  );
};

export const usePrompt = (): PromptFn => {
  const ctx = useContext(PromptContext);
  if (!ctx) throw new Error('usePrompt must be used within PromptProvider');
  return ctx;
};
