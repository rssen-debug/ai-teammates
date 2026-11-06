import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * API-key storage.
 *
 * Goal: keys are never written to SQLite, never appear in logs, and never reach
 * the renderer. We encrypt at rest with AES-256-GCM using a key derived from a
 * machine-local secret file with 0600 permissions. This is *not* equivalent to
 * the Windows DPAPI/credential vault; on Windows we prefer DPAPI when the
 * platform module is reachable, and fall back to the encrypted file elsewhere.
 *
 * The honest limitation is documented in SECURITY.md: an attacker who can read
 * the user's files as that user can read the key file. Full-disk encryption and
 * DPAPI are the real protections.
 */

export interface KeychainBackend {
  get(id: string): string | null;
  set(id: string, secret: string): void;
  delete(id: string): void;
  backendName(): string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, { iv: string; tag: string; data: string }>;
}

export class FileVaultKeychain implements KeychainBackend {
  private readonly vaultPath: string;
  private readonly secretPath: string;

  constructor(dataDir: string) {
    this.vaultPath = join(dataDir, 'secrets.vault');
    this.secretPath = join(dataDir, '.vault-key');
  }

  backendName(): string {
    return 'encrypted-file (AES-256-GCM)';
  }

  private masterKey(): Buffer {
    mkdirSync(dirname(this.secretPath), { recursive: true });
    if (!existsSync(this.secretPath)) {
      writeFileSync(this.secretPath, randomBytes(32).toString('base64'), { mode: 0o600 });
      try {
        chmodSync(this.secretPath, 0o600);
      } catch {
        /* chmod is a no-op on some Windows filesystems */
      }
    }
    const raw = readFileSync(this.secretPath, 'utf8').trim();
    // Stretch the stored secret so a leaked file alone is not directly the key.
    return scryptSync(raw, 'studdy-buddy-vault-v1', 32);
  }

  private read(): VaultFile {
    if (!existsSync(this.vaultPath)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.vaultPath, 'utf8')) as VaultFile;
      if (parsed.version !== 1) return { version: 1, entries: {} };
      return parsed;
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private write(vault: VaultFile): void {
    mkdirSync(dirname(this.vaultPath), { recursive: true });
    writeFileSync(this.vaultPath, JSON.stringify(vault), { mode: 0o600 });
    try {
      chmodSync(this.vaultPath, 0o600);
    } catch {
      /* ignore */
    }
  }

  get(id: string): string | null {
    const entry = this.read().entries[id];
    if (!entry) return null;
    try {
      const key = this.masterKey();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]);
      return plain.toString('utf8');
    } catch {
      return null;
    }
  }

  set(id: string, secret: string): void {
    const vault = this.read();
    const key = this.masterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    vault.entries[id] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    this.write(vault);
  }

  delete(id: string): void {
    const vault = this.read();
    delete vault.entries[id];
    this.write(vault);
  }
}

/** In-memory keychain for tests and for the CLI when no data dir is writable. */
export class MemoryKeychain implements KeychainBackend {
  private readonly store = new Map<string, string>();

  backendName(): string {
    return 'memory (non-persistent)';
  }

  get(id: string): string | null {
    return this.store.get(id) ?? null;
  }

  set(id: string, secret: string): void {
    this.store.set(id, secret);
  }

  delete(id: string): void {
    this.store.delete(id);
  }
}

/** Masks a key for display: never shows more than a 4-char tail. */
export function maskKey(secret: string | null): string {
  if (!secret) return 'not set';
  if (secret.length <= 8) return '••••';
  return `••••${secret.slice(-4)}`;
}
