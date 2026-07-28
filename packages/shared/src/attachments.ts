import { z } from 'zod';

/**
 * Attachments (doc 03 §8, doc 04 §9, doc 07 §7).
 *
 * A worker photographs a pressure area or a piece of equipment and it lands on
 * a diary entry. Everything here is about the two ways that goes wrong: a file
 * that is not what it says it is, and a photo that quietly carries the
 * participant's home address in its GPS tags.
 *
 * The rules that follow from that:
 *
 * - **The declared type is a claim, not a fact.** The first bytes decide, and a
 *   mismatch is refused.
 * - **The extension is rebuilt from the sniffed type**, so `photo.jpg.exe`
 *   cannot survive a round trip.
 * - **Nothing is served statically.** Files go through the API with a scope
 *   check on every request, which is enforced in the route, not here.
 */

/** Doc 03 §8 and A12. Twenty megabytes, images and PDF only. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The formats stored.
 *
 * **HEIC is not one of them**, though doc 03 §8 lists it. Nothing available
 * server-side can decode HEIC to strip its EXIF, and storing an iPhone photo
 * with its GPS tags intact would break the control in doc 07 §7 that says
 * exactly the opposite. The app converts to JPEG in the browser before upload,
 * where Safari can decode it, so an iPhone user never meets this limit. The
 * refusal is the backstop for anything that bypasses the app.
 */
export const attachmentMimeTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export const attachmentMimeTypeSchema = z.enum(attachmentMimeTypes);
export type AttachmentMimeType = z.infer<typeof attachmentMimeTypeSchema>;

export const attachmentOwnerTypes = ['diary_entry', 'incident', 'participant_photo'] as const;
export const attachmentOwnerTypeSchema = z.enum(attachmentOwnerTypes);
export type AttachmentOwnerType = z.infer<typeof attachmentOwnerTypeSchema>;

export const attachmentUploadStates = ['pending', 'complete', 'failed'] as const;
export const attachmentUploadStateSchema = z.enum(attachmentUploadStates);
export type AttachmentUploadState = z.infer<typeof attachmentUploadStateSchema>;

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

const extensions: Record<AttachmentMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function extensionFor(mimeType: AttachmentMimeType): string {
  return extensions[mimeType];
}

/**
 * What the bytes actually are.
 *
 * `heic` is detected on purpose, separately from "unknown", so the worker whose
 * phone is set to High Efficiency gets told what is wrong rather than a flat
 * refusal they cannot act on.
 */
export type SniffedType = AttachmentMimeType | 'heic' | 'unknown';

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1']);

/** Only the first few dozen bytes are needed, so a header slice is enough. */
export function sniffMimeType(bytes: Uint8Array): SniffedType {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(bytes, 4, 4) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8, 4))) return 'heic';
  return 'unknown';
}

/**
 * The message a user sees when their file is refused, or null when it is fine.
 *
 * `declared` is what the browser said. It has to agree with the bytes: a PDF
 * uploaded as `image/jpeg` is either a broken client or someone probing, and
 * neither is worth storing.
 */
export function attachmentProblem(
  declared: string,
  bytes: Uint8Array,
  byteSize: number,
): string | null {
  if (byteSize <= 0) return 'That file is empty.';
  if (byteSize > ATTACHMENT_MAX_BYTES) {
    const megabytes = Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024);
    return `Files are limited to ${megabytes} MB.`;
  }

  const sniffed = sniffMimeType(bytes);

  if (sniffed === 'heic') {
    return 'That photo is in HEIC format, which cannot be stored. On iPhone, Settings, Camera, Formats, Most Compatible will take JPEG photos instead.';
  }
  if (sniffed === 'unknown') {
    return 'That file type cannot be attached. Photos (JPEG, PNG or WebP) and PDF only.';
  }
  if (sniffed !== declared) {
    return `That file says it is ${declared} but its contents are ${sniffed}. Attach the original file.`;
  }

  return null;
}

/**
 * A filename safe to store and safe to send back in a header.
 *
 * Path separators, control characters and leading dots go. The extension is
 * taken from the sniffed type rather than from the name, so what comes back out
 * is described by what it actually is.
 */
export function sanitiseFilename(filename: string, mimeType: AttachmentMimeType): string {
  const base = filename
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .trim();

  // Extension first, then leading dots, so a name that is nothing but an
  // extension (".jpg") is left with no stem rather than a stem of "jpg".
  const withoutExtension = base
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  const stem = withoutExtension === '' ? 'attachment' : withoutExtension;
  return `${stem}.${extensionFor(mimeType)}`;
}

export const createAttachmentRequestSchema = z
  .object({
    id: z.string().uuid(),
    ownerType: attachmentOwnerTypeSchema,
    /** Null until the diary entry it belongs to has been created. */
    ownerId: z.string().uuid().nullable().default(null),
    filename: z.string().trim().min(1).max(255),
    mimeType: attachmentMimeTypeSchema,
    byteSize: z.number().int().min(1).max(ATTACHMENT_MAX_BYTES),
  })
  .strict();

export type CreateAttachmentRequest = z.infer<typeof createAttachmentRequestSchema>;

export const attachmentSchema = z.object({
  id: z.string(),
  participantId: z.string(),
  ownerType: attachmentOwnerTypeSchema,
  ownerId: z.string().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  isImage: z.boolean(),
  uploadState: attachmentUploadStateSchema,
  uploadedBy: z.string().nullable(),
  createdAt: z.string(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * Thumbnails are a fixed box, not a per-request size.
 *
 * A caller-supplied width is an invitation to generate a thousand renders of
 * the same photo, and the only place a thumbnail appears is a timeline row.
 */
export const THUMBNAIL_MAX_EDGE = 320;

/** The longest edge fits the box; anything already smaller is left alone. */
export function thumbnailSize(
  width: number,
  height: number,
  maxEdge = THUMBNAIL_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Human-readable size for the attachment row. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
