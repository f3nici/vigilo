import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFileStore, StorageError, newDataKey } from './storage.js';

/**
 * The attachment volume.
 *
 * Everything here is about the disk rather than the database, which is why it
 * is a unit test with a real temporary directory: the failures worth catching
 * are a file written in the clear and a mount the process cannot write to.
 */
const roots: string[] = [];

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vigilo-store-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe('LocalFileStore', () => {
  it('round-trips a file through its data key', async () => {
    const store = new LocalFileStore(await newRoot());
    const plaintext = Buffer.from('a photo of a wound, more or less');

    const stored = await store.put(plaintext, 'jpg');
    expect(await store.read(stored.path, stored.key)).toEqual(plaintext);
    expect(stored.byteSize).toBe(plaintext.byteLength);
  });

  /** The whole point of the second layer of encryption. */
  it('writes ciphertext, not the file it was given', async () => {
    const root = await newRoot();
    const store = new LocalFileStore(root);
    const plaintext = Buffer.from('sensitive detail about a person');

    const stored = await store.put(plaintext, 'jpg');
    const onDisk = await readFile(path.join(root, stored.path));

    expect(onDisk.includes(plaintext)).toBe(false);
    // Nonce and tag, then the ciphertext.
    expect(onDisk.byteLength).toBe(plaintext.byteLength + 28);
  });

  it('refuses the wrong key rather than returning rubbish', async () => {
    const store = new LocalFileStore(await newRoot());
    const stored = await store.put(Buffer.from('hello'), 'jpg');

    await expect(store.read(stored.path, newDataKey())).rejects.toThrow();
  });

  it('refuses a path outside the volume', async () => {
    const store = new LocalFileStore(await newRoot());
    await expect(store.read('../../etc/passwd', newDataKey())).rejects.toThrow(StorageError);
  });

  it('shares one key between a file and its thumbnail', async () => {
    const store = new LocalFileStore(await newRoot());
    const key = newDataKey();

    const original = await store.putWith(Buffer.from('original'), key, 'jpg');
    const thumbnail = await store.putWith(Buffer.from('thumbnail'), key, 'jpg');

    expect(original.path).not.toBe(thumbnail.path);
    expect(await store.read(thumbnail.path, original.key)).toEqual(Buffer.from('thumbnail'));
  });

  it('removes a file and then reports it gone', async () => {
    const store = new LocalFileStore(await newRoot());
    const stored = await store.put(Buffer.from('gone soon'), 'jpg');

    expect(await store.exists(stored.path)).toBe(true);
    await store.remove(stored.path);
    expect(await store.exists(stored.path)).toBe(false);
  });

  describe('ensureWritable', () => {
    it('creates the volume when it is missing', async () => {
      const root = path.join(await newRoot(), 'nested', 'attachments');
      const store = new LocalFileStore(root);

      await expect(store.ensureWritable()).resolves.toBeUndefined();
      await expect(store.put(Buffer.from('x'), 'jpg')).resolves.toBeDefined();
    });

    /**
     * The failure this exists for. A container running as an unprivileged user
     * against a root-owned mount reads fine and cannot write a byte, and
     * without this check the first sign of it is a 500 on a worker's photo.
     */
    it('fails with the path when the volume cannot be written to', async () => {
      const root = await newRoot();
      await chmod(root, 0o500);

      await expect(new LocalFileStore(root).ensureWritable()).rejects.toThrow(
        new RegExp(`${root}.*not writable`, 's'),
      );
    });
  });
});
