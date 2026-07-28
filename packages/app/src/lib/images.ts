import { ATTACHMENT_MAX_BYTES, type AttachmentMimeType } from '@vigilo/shared';

/**
 * Preparing a photo before it is uploaded (doc 01 §6).
 *
 * Two jobs. The obvious one is size: a modern phone camera produces 4 to 8 MB
 * per shot, and a worker on mobile data in someone's house should not be
 * sending that.
 *
 * The one that matters more is format. An iPhone set to High Efficiency hands
 * over HEIC, which the server refuses because nothing there can decode it well
 * enough to strip its GPS tags. Safari *can* decode it, so drawing it to a
 * canvas and re-encoding as JPEG turns the problem into a non-event on the one
 * device that has it.
 *
 * The re-encode also drops EXIF, so the coordinates are gone before the file
 * leaves the phone. The server strips again on arrival regardless: a control
 * that only runs on the client is not a control.
 */

/** Enough for a wound photo to be read, small enough to send on 3G. */
const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.85;

export type PreparedFile = {
  blob: Blob;
  filename: string;
  mimeType: AttachmentMimeType;
};

export class FilePrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilePrepareError';
  }
}

function isImage(file: File): boolean {
  return file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
}

function renamed(filename: string, extension: string): string {
  const stem = filename.replace(/\.[^.]+$/, '');
  return `${stem || 'photo'}.${extension}`;
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new FilePrepareError(
      'That image could not be read on this device. On iPhone, Settings, Camera, Formats, Most Compatible will take JPEG photos instead.',
    );
  }
}

/**
 * A PDF is passed through untouched. There is nothing useful to do to it here,
 * and re-encoding a document would be a way to lose part of it.
 */
export async function prepareForUpload(file: File): Promise<PreparedFile> {
  if (!isImage(file)) {
    if (file.type !== 'application/pdf') {
      throw new FilePrepareError('Photos (JPEG, PNG or WebP) and PDF only.');
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      throw new FilePrepareError('Files are limited to 20 MB.');
    }
    return { blob: file, filename: file.name, mimeType: 'application/pdf' };
  }

  const bitmap = await decode(file);

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new FilePrepareError('This browser cannot process images.');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
  });

  if (!blob) throw new FilePrepareError('That photo could not be prepared for upload.');
  if (blob.size > ATTACHMENT_MAX_BYTES) {
    throw new FilePrepareError('That photo is too large even after resizing.');
  }

  return { blob, filename: renamed(file.name, 'jpg'), mimeType: 'image/jpeg' };
}
