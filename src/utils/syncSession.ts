let syncPassphrase = '';

export function setSessionSyncPassphrase(value: string): void {
  syncPassphrase = value;
}

export function getSessionSyncPassphrase(): string {
  return syncPassphrase;
}

export function hasSessionSyncPassphrase(): boolean {
  return syncPassphrase.trim().length > 0;
}
