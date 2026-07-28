import sharp from 'sharp';
import { THUMBNAIL_MAX_EDGE, isImageMimeType, type AttachmentMimeType } from '@vigilo/shared';

/**
 * Image handling on the way in (doc 07 §7).
 *
 * A photo taken on a phone carries the time, the camera, and very often the
 * GPS coordinates of the place it was taken, which for this product is a
 * participant's home address sitting inside a file the organisation now holds.
 * Stripping that is not a nicety.
 *
 * The strip is a re-encode rather than a metadata edit. sharp drops all input
 * metadata unless asked to keep it, so decoding the pixels and encoding them
 * again leaves nothing behind: no EXIF, no XMP, no IPTC, no thumbnail block
 * carrying its own copy of the coordinates.
 *
 * Orientation is the one thing worth carrying across. It lives in EXIF, so a
 * naive strip turns every portrait photo on its side. `rotate()` with no
 * argument applies the orientation tag to the pixels first, which is why it
 * survives the loss of the tag itself.
 */

/**
 * Bounds decoding work, so a small file that claims to be enormous cannot turn
 * one upload into a gigabyte of allocation.
 */
const MAX_PIXELS = 50_000_000;

export type ProcessedImage = {
  bytes: Buffer;
  width: number;
  height: number;
};

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

function decoder(bytes: Buffer): sharp.Sharp {
  return sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
}

/**
 * Re-encodes a photo without its metadata, and reports the stored dimensions.
 *
 * The output format matches the input, so a PNG stays a PNG. Converting
 * everything to JPEG would be smaller and would quietly turn a screenshot of a
 * medication chart into a blurry one.
 */
export async function stripMetadata(
  bytes: Buffer,
  mimeType: AttachmentMimeType,
): Promise<ProcessedImage> {
  if (!isImageMimeType(mimeType)) {
    throw new ImageError('That file is not an image');
  }

  try {
    const pipeline = decoder(bytes).rotate();

    const encoded =
      mimeType === 'image/png'
        ? pipeline.png({ compressionLevel: 9 })
        : mimeType === 'image/webp'
          ? pipeline.webp({ quality: 88 })
          : pipeline.jpeg({ quality: 88, mozjpeg: true });

    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height };
  } catch (error) {
    throw new ImageError(
      error instanceof Error && error.message.includes('pixel')
        ? 'That image is too large to process.'
        : 'That image could not be read.',
    );
  }
}

/**
 * A thumbnail for the timeline. Always JPEG, always inside the box.
 *
 * `fit: 'inside'` keeps the whole photo rather than cropping to a square. A
 * cropped thumbnail of a wound or a piece of equipment can leave out the part
 * that mattered, and the row it appears in has space for either shape.
 */
export async function makeThumbnail(bytes: Buffer): Promise<ProcessedImage> {
  try {
    const { data, info } = await decoder(bytes)
      .rotate()
      .resize({
        width: THUMBNAIL_MAX_EDGE,
        height: THUMBNAIL_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return { bytes: data, width: info.width, height: info.height };
  } catch {
    throw new ImageError('A thumbnail could not be made for that image.');
  }
}

/**
 * Whether the decoder agrees with the sniffed type.
 *
 * Magic bytes say what a file starts with. This says the rest of it parses as
 * that format, which is the difference between a JPEG and a JPEG header glued
 * to something else.
 */
export async function readableAs(bytes: Buffer, mimeType: AttachmentMimeType): Promise<boolean> {
  if (!isImageMimeType(mimeType)) return true;
  try {
    const metadata = await decoder(bytes).metadata();
    const format = metadata.format === 'jpg' ? 'jpeg' : metadata.format;
    return `image/${format}` === mimeType;
  } catch {
    return false;
  }
}
