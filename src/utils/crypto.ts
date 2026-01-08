/**
 * Cryptographic utilities for brainbox
 *
 * This module provides secure key derivation from passwords using PBKDF2.
 * Keys are derived on-demand and never stored in memory longer than necessary.
 */

/**
 * Derives a 32-byte encryption key from a password using PBKDF2-SHA256
 *
 * @param password - The user's password
 * @param salt - Optional salt (defaults to vault ID as salt for deterministic key generation)
 * @param iterations - Number of PBKDF2 iterations (default: 100,000 for security)
 * @returns Promise resolving to a 32-byte Uint8Array suitable for XChaCha20-Poly1305
 *
 * @example
 * const key = await deriveKeyFromPassword('mySecurePassword', 'vault-123');
 * // Use key for encryption/decryption, then clear from memory
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: string = 'brainbox-default-salt',
  iterations: number = 100000
): Promise<Uint8Array> {
  // Encode password and salt as UTF-8
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  const saltBuffer = encoder.encode(salt);

  // Import password as CryptoKey for PBKDF2
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  // Derive 256 bits (32 bytes) using PBKDF2-SHA256
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256 // 256 bits = 32 bytes
  );

  // Convert ArrayBuffer to Uint8Array
  return new Uint8Array(derivedBits);
}

/**
 * Converts a Uint8Array to a regular number array for Tauri invoke calls
 *
 * @param key - The encryption key as Uint8Array
 * @returns Array of numbers
 */
export function keyToArray(key: Uint8Array): number[] {
  return Array.from(key);
}

/**
 * Validates that a key is exactly 32 bytes
 *
 * @param key - The key to validate
 * @throws Error if key is not 32 bytes
 */
export function validateKey(key: Uint8Array | number[]): void {
  if (key.length !== 32) {
    throw new Error(`Invalid key length: expected 32 bytes, got ${key.length}`);
  }
}

/**
 * Generates a cryptographically secure random salt
 *
 * @param length - Length of salt in bytes (default: 16)
 * @returns Hex-encoded salt string
 */
export function generateSalt(length: number = 16): string {
  const saltArray = new Uint8Array(length);
  crypto.getRandomValues(saltArray);
  return Array.from(saltArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Session-based key cache to avoid re-deriving keys for the same vault
 * Keys are stored in memory only for the current session
 *
 * WARNING: Keys are stored in plain memory. For production use, consider:
 * - Encrypting cached keys with a master key
 * - Implementing automatic cache expiration
 * - Clearing cache on inactivity
 */
class KeyCache {
  private cache: Map<string, { key: Uint8Array; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  /**
   * Gets a cached key or derives a new one
   */
  async getOrDerive(vaultId: string, password: string): Promise<Uint8Array> {
    const cacheKey = `${vaultId}:${password}`;
    const cached = this.cache.get(cacheKey);

    // Check if cached key is still valid
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.key;
    }

    // Derive new key
    const key = await deriveKeyFromPassword(password, vaultId);
    this.cache.set(cacheKey, { key, timestamp: Date.now() });

    return key;
  }

  /**
   * Clears a specific vault's key from cache
   */
  clear(vaultId: string, password?: string): void {
    if (password) {
      this.cache.delete(`${vaultId}:${password}`);
    } else {
      // Clear all keys for this vault
      const keysToDelete: string[] = [];
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${vaultId}:`)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(k => this.cache.delete(k));
    }
  }

  /**
   * Clears all cached keys
   */
  clearAll(): void {
    this.cache.clear();
  }

  /**
   * Removes expired keys from cache
   */
  pruneExpired(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp >= this.CACHE_TTL) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(k => this.cache.delete(k));
  }
}

// Export singleton instance
export const keyCache = new KeyCache();

// Auto-prune expired keys every 5 minutes
if (typeof window !== 'undefined') {
  setInterval(() => keyCache.pruneExpired(), 5 * 60 * 1000);
}
