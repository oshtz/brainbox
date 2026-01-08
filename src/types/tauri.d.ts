declare module 'tauri' {
  export function invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  export function listen<T = any>(event: string, handler: (event: T) => void): Promise<() => void>;
}
