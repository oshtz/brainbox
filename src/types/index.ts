// Core application types
export interface Vault {
  id: string;
  title: string;
  name?: string;
  color?: string;
  backgroundImage?: string;
  cover_image?: string;
  children?: React.ReactNode;
  priceTag?: string;
  created_at?: string;
  updated_at?: string;
  /** Whether the vault is password-protected. False means no password required. */
  has_password?: boolean;
}

export interface VaultItem {
  id: string;
  vault_id?: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  image?: string;
  summary?: string;
  height?: number;
  metadata: ItemMetadata;
  created_at?: string;
  updated_at?: string;
}

export interface ItemMetadata {
  item_type: 'url' | 'note';
  url?: string;
  created_at?: string;
  updated_at?: string;
  preview_title?: string;
  preview_description?: string;
  preview_image?: string;
  provider?: string;
}

export interface CaptureData {
  title: string;
  content: string;
  vaultId: string;
}

export interface ProtocolCapture {
  title: string;
  url: string;
}

export interface SearchResult {
  id: string;
  vault_id: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  image?: string;
  summary?: string;
  height: number;
  metadata: ItemMetadata;
}

// Theme types
export interface ThemeContextType {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  accent: string;
  setAccent: (color: string) => void;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

// Component prop types
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
}

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  className?: string;
}

// App view types
export type AppView = 'vaults' | 'search' | 'settings' | 'library' | 'connections';

// Error types
export interface AppError {
  message: string;
  code?: string;
  details?: unknown;
  timestamp: Date;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error?: AppError;
}

// Utility types
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

// Tauri backend response types (snake_case from Rust)
export interface BackendVault {
  id: number;
  name: string;
  cover_image?: string | null;
  has_password?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface BackendVaultItem {
  id: number;
  vault_id: number;
  title: string;
  content: string;
  image?: string | null;
  summary?: string | null;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface BackendUrlMetadata {
  title?: string;
  description?: string;
  image?: string;
}

export interface BackendSearchResult {
  id: number;
  vault_id: number;
  title: string;
  content: string;
  score?: number;
}

// Tauri event payload types
export interface CaptureFromProtocolPayload {
  title?: string;
  url?: string;
}