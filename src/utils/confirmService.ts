import type { ReactNode } from 'react';

export type ConfirmServiceOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
};

type Handler = (opts: ConfirmServiceOptions) => Promise<boolean>;

let handler: Handler | null = null;

export const setConfirmHandler = (h: Handler) => {
  handler = h;
};

export const confirm = (opts: ConfirmServiceOptions): Promise<boolean> => {
  if (!handler) {
    // Fallback: avoid native confirm; default to false to be safe
    console.warn('ConfirmService not initialized; returning false');
    return Promise.resolve(false);
  }
  return handler(opts);
};

