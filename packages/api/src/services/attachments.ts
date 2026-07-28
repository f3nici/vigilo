import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  attachmentProblem,
  extensionFor,
  isImageMimeType,
  sanitiseFilename,
  type Attachment,
  type AttachmentMimeType,
  type AttachmentSummary,
  type CreateAttachmentRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { attachments, type AttachmentRow } from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptField, encryptField } from '../crypto/fields.js';
import { makeThumbnail, readableAs, stripMetadata, ImageError } from './images.js';
import { newDataKey, type FileStore } from './storage.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Attachments (doc 03 §8, doc 04 §9, doc 07 §7).
 *
 * Two steps, deliberately. `create` writes the metadata row, `storeContent`
 * takes the bytes. That split is what lets an offline device queue a photo it
 * has not managed to upload yet, and it is why `upload_state` exists: a row in
 * `pending` is a known gap rather than a mystery.
 *
 * The bytes are never trusted. What the browser declared, what the file starts
 * with and what the decoder can actually read all have to agree before
 * anything is written, and an image is re-encoded on the way in so nothing of
 * its metadata survives.
 */

const KEY_COLUMN = 'attachments.encryption_key_enc';

export type AttachmentPrincipal = {
  userId: string;
  role: string;
};

export function toAttachmentSummary(row: AttachmentRow): AttachmentSummary {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    isImage: isImageMimeType(row.mimeType),
    uploadState: row.uploadState,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAttachment(row: AttachmentRow): Attachment {
  return {
    ...toAttachmentSummary(row),
    participantId: row.participantId,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    uploadedBy: row.uploadedBy,
  };
}

export async function findAttachment(db: Database, id: string): Promise<AttachmentRow> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!row || row.deletedAt !== null) {
    throw new HttpError('not_found', 'That attachment does not exist.');
  }
  return row;
}

/** Summaries for a set of owners, which is how a diary list gets its photos. */
export async function attachmentsForOwners(
  db: Database,
  ownerType: 'diary_entry' | 'incident' | 'participant_photo',
  ownerIds: readonly string[],
): Promise<Map<string, AttachmentSummary[]>> {
  const grouped = new Map<string, AttachmentSummary[]>();
  if (ownerIds.length === 0) return grouped;

  const rows = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.ownerType, ownerType),
        inArray(attachments.ownerId, [...ownerIds]),
        isNull(attachments.deletedAt),
      ),
    );

  for (const row of rows) {
    if (row.ownerId === null) continue;
    const list = grouped.get(row.ownerId) ?? [];
    list.push(toAttachmentSummary(row));
    grouped.set(row.ownerId, list);
  }

  for (const list of grouped.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return grouped;
}

/**
 * Step one: the metadata row.
 *
 * The filename is rebuilt from the declared type here and rebuilt again from
 * the sniffed type once the bytes arrive, because at this point the declared
 * type is still only a claim.
 */
export async function createAttachment(
  db: Database,
  participantId: string,
  request: CreateAttachmentRequest,
  principal: AttachmentPrincipal,
): Promise<Attachment> {
  const [existing] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, request.id))
    .limit(1);

  // Replaying the create from a drained outbox must not make a second row.
  if (existing) {
    if (existing.participantId !== participantId) {
      throw new HttpError('conflict', 'That attachment belongs to a different participant.');
    }
    return toAttachment(existing);
  }

  const [row] = await db
    .insert(attachments)
    .values({
      id: request.id,
      ownerType: request.ownerType,
      ownerId: request.ownerId,
      participantId,
      filename: sanitiseFilename(request.filename, request.mimeType),
      mimeType: request.mimeType,
      byteSize: request.byteSize,
      uploadedBy: principal.userId,
      uploadState: 'pending',
    })
    .returning();

  return toAttachment(row!);
}

/**
 * Step two: the bytes.
 *
 * Everything that can refuse the file refuses it here, before a byte reaches
 * the volume. In order: the size, the magic bytes against the declared type,
 * the decoder against both, and then the re-encode that strips the metadata.
 */
export async function storeContent(
  db: Database,
  keyRing: KeyRing,
  store: FileStore,
  attachmentId: string,
  bytes: Buffer,
  actor: AuditActor,
): Promise<Attachment> {
  const row = await findAttachment(db, attachmentId);

  if (row.uploadState === 'complete') {
    throw new HttpError('conflict', 'That attachment has already been uploaded.');
  }

  const declared = row.mimeType as AttachmentMimeType;
  const problem = attachmentProblem(declared, bytes, bytes.byteLength);
  if (problem !== null) {
    await db
      .update(attachments)
      .set({ uploadState: 'failed', updatedAt: new Date() })
      .where(eq(attachments.id, attachmentId));
    throw new HttpError('validation_failed', problem);
  }

  if (!(await readableAs(bytes, declared))) {
    await db
      .update(attachments)
      .set({ uploadState: 'failed', updatedAt: new Date() })
      .where(eq(attachments.id, attachmentId));
    throw new HttpError(
      'validation_failed',
      'That image could not be read. Try attaching it again.',
    );
  }

  let stored = bytes;
  let width: number | null = null;
  let height: number | null = null;

  if (isImageMimeType(declared)) {
    try {
      const processed = await stripMetadata(bytes, declared);
      stored = processed.bytes;
      width = processed.width;
      height = processed.height;
    } catch (error) {
      await db
        .update(attachments)
        .set({ uploadState: 'failed', updatedAt: new Date() })
        .where(eq(attachments.id, attachmentId));
      throw new HttpError(
        'validation_failed',
        error instanceof ImageError ? error.message : 'That image could not be processed.',
      );
    }
  }

  const key = newDataKey();
  const file = await store.putWith(stored, key, extensionFor(declared));

  const [updated] = await db
    .update(attachments)
    .set({
      filename: sanitiseFilename(row.filename, declared),
      storagePath: file.path,
      encryptionKeyEnc: encryptField(keyRing, KEY_COLUMN, key.toString('base64')),
      byteSize: file.byteSize,
      sha256: createHash('sha256').update(stored).digest('hex'),
      width,
      height,
      uploadState: 'complete',
      updatedAt: new Date(),
    })
    .where(eq(attachments.id, attachmentId))
    .returning();

  await recordAudit(db, {
    action: 'attachment.upload',
    actor,
    entityType: 'attachment',
    entityId: attachmentId,
    participantId: row.participantId,
    // The type and the size. Never the filename: people name photos after the
    // person in them.
    metadata: {
      mimeType: declared,
      byteSize: file.byteSize,
      strippedMetadata: isImageMimeType(declared),
    },
  });

  return toAttachment(updated!);
}

function dataKeyOf(keyRing: KeyRing, row: AttachmentRow): Buffer {
  if (row.encryptionKeyEnc === null) {
    throw new HttpError('not_found', 'That attachment has no stored file yet.');
  }
  return Buffer.from(decryptField(keyRing, KEY_COLUMN, row.encryptionKeyEnc), 'base64');
}

/**
 * The download. The route has already checked scope; this only opens the file.
 *
 * Every download is audited, because "who has seen the photo of this person"
 * is the same question as "who has read this record" and deserves the same
 * answer (doc 07 §4).
 */
export async function openAttachment(
  db: Database,
  keyRing: KeyRing,
  store: FileStore,
  row: AttachmentRow,
  actor: AuditActor,
): Promise<Readable> {
  if (row.storagePath === null || row.uploadState !== 'complete') {
    throw new HttpError('not_found', 'That attachment has not finished uploading.');
  }

  await recordAudit(db, {
    action: 'attachment.download',
    actor,
    entityType: 'attachment',
    entityId: row.id,
    participantId: row.participantId,
  });

  return store.stream(row.storagePath, dataKeyOf(keyRing, row));
}

/**
 * The thumbnail, rendered on first request and kept (doc 04 §9).
 *
 * It shares the file's data key rather than getting its own. It is a derived
 * view of the same bytes, so a key that opens one and not the other would be a
 * distinction with nothing behind it.
 *
 * Not audited. A timeline showing twenty photos would write twenty rows for
 * one look at a screen, and the full-size download beside it is the access
 * that matters.
 */
export async function openThumbnail(
  db: Database,
  keyRing: KeyRing,
  store: FileStore,
  row: AttachmentRow,
): Promise<Readable> {
  if (!isImageMimeType(row.mimeType)) {
    throw new HttpError('not_found', 'That attachment is not an image.');
  }
  if (row.storagePath === null || row.uploadState !== 'complete') {
    throw new HttpError('not_found', 'That attachment has not finished uploading.');
  }

  const key = dataKeyOf(keyRing, row);

  if (row.thumbnailPath !== null && (await store.exists(row.thumbnailPath))) {
    return store.stream(row.thumbnailPath, key);
  }

  const original = await store.read(row.storagePath, key);
  const thumbnail = await makeThumbnail(original);
  const file = await store.putWith(thumbnail.bytes, key, 'jpg');

  await db
    .update(attachments)
    .set({ thumbnailPath: file.path, updatedAt: new Date() })
    .where(eq(attachments.id, row.id));

  return store.stream(file.path, key);
}

/**
 * Soft delete (doc 04 §9). The row and the bytes both stay: retention applies
 * to an attachment exactly as it applies to the entry it hangs off.
 */
export async function deleteAttachment(
  db: Database,
  attachmentId: string,
  actor: AuditActor,
): Promise<void> {
  const row = await findAttachment(db, attachmentId);

  await db
    .update(attachments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(attachments.id, attachmentId));

  await recordAudit(db, {
    action: 'attachment.delete',
    actor,
    entityType: 'attachment',
    entityId: attachmentId,
    participantId: row.participantId,
  });
}

/** Binds a set of uploaded files to the entry they were attached to. */
export async function claimAttachments(
  db: Database,
  ownerType: 'diary_entry',
  ownerId: string,
  participantId: string,
  attachmentIds: readonly string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;

  const rows = await db
    .select()
    .from(attachments)
    .where(and(inArray(attachments.id, [...attachmentIds]), isNull(attachments.deletedAt)));

  for (const row of rows) {
    // An attachment uploaded against one participant cannot be moved onto
    // another's record, which is the shape a scope escape would take here.
    if (row.participantId !== participantId) {
      throw new HttpError('scope_denied', 'That attachment belongs to a different participant.');
    }
    if (row.ownerId !== null && row.ownerId !== ownerId) {
      throw new HttpError('conflict', 'That attachment is already on another entry.');
    }
  }

  await db
    .update(attachments)
    .set({ ownerType, ownerId, updatedAt: new Date() })
    .where(inArray(attachments.id, [...attachmentIds]));
}
