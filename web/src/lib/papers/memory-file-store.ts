/**
 * In-memory FileStore (issue 10-papers-upload-browse).
 *
 * This is the FAKE the issue asks for: every test that touches an upload uses
 * it, so no test ever writes a real file, calls Supabase Storage or holds a
 * real key (web/CLAUDE.md).
 *
 * It is a real implementation of the interface, not a mock: it stores bytes,
 * refuses a path it already has (Supabase Storage does the same with
 * `x-upsert: false`), and hands back a URL shaped like any other.
 */
import type { FileStore } from './types';
import { SIGNED_URL_SECONDS } from './types';

export interface MemoryFileStore extends FileStore {
  /** The paths that were stored, in the order they arrived. */
  paths(): string[];
  /** The bytes at one path, or undefined. */
  read(path: string): Uint8Array | undefined;
  /** Make the next upload fail once, to test the unhappy path. */
  failNext(): void;
}

export function createMemoryFileStore(): MemoryFileStore {
  const files = new Map<string, Uint8Array>();
  let failOnce = false;

  return {
    isConfigured() {
      return true;
    },

    async upload({ path, bytes }) {
      if (failOnce) {
        failOnce = false;
        throw new Error('memory store was told to fail');
      }
      if (files.has(path)) throw new Error('memory store already has ' + path);
      files.set(path, bytes);
    },

    async signedUrl(path: string, expiresInSeconds = SIGNED_URL_SECONDS) {
      if (!files.has(path)) return null;
      return `memory://${path}?signed=${expiresInSeconds}`;
    },

    paths() {
      return [...files.keys()];
    },

    read(path: string) {
      return files.get(path);
    },

    failNext() {
      failOnce = true;
    },
  };
}
