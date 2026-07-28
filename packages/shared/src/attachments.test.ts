import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_BYTES,
  attachmentProblem,
  createAttachmentRequestSchema,
  formatByteSize,
  sanitiseFilename,
  sniffMimeType,
  thumbnailSize,
} from './attachments.js';

function header(...bytes: number[]): Uint8Array {
  const out = new Uint8Array(64);
  out.set(bytes, 0);
  return out;
}

/** ASCII markers at fixed offsets, which is how container formats identify. */
function marked(...parts: [number, string][]): Uint8Array {
  const out = new Uint8Array(64);
  for (const [offset, text] of parts) {
    for (let index = 0; index < text.length; index += 1) {
      out[offset + index] = text.charCodeAt(index);
    }
  }
  return out;
}

const JPEG = header(0xff, 0xd8, 0xff, 0xe0);
const PNG = header(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PDF = marked([0, '%PDF-1.7']);
const WEBP = marked([0, 'RIFF'], [8, 'WEBP']);
const HEIC = marked([4, 'ftyp'], [8, 'heic']);

describe('sniffMimeType', () => {
  it('recognises the formats that are stored', () => {
    expect(sniffMimeType(JPEG)).toBe('image/jpeg');
    expect(sniffMimeType(PNG)).toBe('image/png');
    expect(sniffMimeType(PDF)).toBe('application/pdf');
    expect(sniffMimeType(WEBP)).toBe('image/webp');
  });

  /** Told apart from "unknown" so the worker can be told what to change. */
  it('recognises HEIC specifically', () => {
    expect(sniffMimeType(HEIC)).toBe('heic');
  });

  it('calls anything else unknown', () => {
    expect(sniffMimeType(header(0x4d, 0x5a))).toBe('unknown');
    expect(sniffMimeType(new Uint8Array(0))).toBe('unknown');
    expect(sniffMimeType(header(0xff))).toBe('unknown');
  });
});

describe('attachmentProblem', () => {
  it('accepts a file whose bytes match what it claims to be', () => {
    expect(attachmentProblem('image/jpeg', JPEG, 1024)).toBeNull();
    expect(attachmentProblem('application/pdf', PDF, 1024)).toBeNull();
  });

  /** The declared type is a claim. A mismatch is a broken client or a probe. */
  it('refuses a file that is not what it says it is', () => {
    const problem = attachmentProblem('image/jpeg', PDF, 1024);
    expect(problem).toContain('image/jpeg');
    expect(problem).toContain('application/pdf');
  });

  it('refuses an executable dressed as a photo', () => {
    expect(attachmentProblem('image/png', header(0x4d, 0x5a, 0x90), 1024)).toContain(
      'cannot be attached',
    );
  });

  it('tells an iPhone user what to change', () => {
    expect(attachmentProblem('image/jpeg', HEIC, 1024)).toContain('Most Compatible');
  });

  it('enforces the size cap and refuses an empty file', () => {
    expect(attachmentProblem('image/jpeg', JPEG, ATTACHMENT_MAX_BYTES + 1)).toContain('20 MB');
    expect(attachmentProblem('image/jpeg', JPEG, 0)).toContain('empty');
  });

  /** Size is checked before the bytes, so a huge upload is refused cheaply. */
  it('checks the size before it looks at the contents', () => {
    expect(attachmentProblem('image/jpeg', new Uint8Array(0), ATTACHMENT_MAX_BYTES + 1)).toContain(
      '20 MB',
    );
  });
});

describe('sanitiseFilename', () => {
  it('drops the path and keeps the name', () => {
    expect(sanitiseFilename('/etc/passwd', 'image/jpeg')).toBe('passwd.jpg');
    expect(sanitiseFilename('C:\\Users\\bob\\wound.jpeg', 'image/jpeg')).toBe('wound.jpg');
    expect(sanitiseFilename('../../../secret.png', 'image/png')).toBe('secret.png');
  });

  /** The extension comes from the sniffed type, so a double extension dies. */
  it('rebuilds the extension from the real type', () => {
    expect(sanitiseFilename('photo.jpg.exe', 'image/jpeg')).toBe('photo.jpg.jpg');
    expect(sanitiseFilename('report.pdf', 'application/pdf')).toBe('report.pdf');
    expect(sanitiseFilename('note.txt', 'image/png')).toBe('note.png');
  });

  it('strips control characters and header-breaking punctuation', () => {
    expect(sanitiseFilename('wo\u000dund\u000a.jpg', 'image/jpeg')).toBe('wound.jpg');
    expect(sanitiseFilename('a"b|c?.png', 'image/png')).toBe('abc.png');
  });

  it('always produces a usable name', () => {
    expect(sanitiseFilename('.....', 'image/jpeg')).toBe('attachment.jpg');
    expect(sanitiseFilename('.jpg', 'image/jpeg')).toBe('attachment.jpg');
    expect(sanitiseFilename('x'.repeat(300), 'image/png')).toBe(`${'x'.repeat(80)}.png`);
  });
});

describe('thumbnailSize', () => {
  it('fits the longest edge in the box and keeps the aspect ratio', () => {
    expect(thumbnailSize(4000, 3000)).toEqual({ width: 320, height: 240 });
    expect(thumbnailSize(3000, 4000)).toEqual({ width: 240, height: 320 });
  });

  it('leaves a small image alone rather than blowing it up', () => {
    expect(thumbnailSize(100, 80)).toEqual({ width: 100, height: 80 });
  });

  it('never rounds an edge away to nothing', () => {
    expect(thumbnailSize(10_000, 20).height).toBe(1);
  });
});

describe('createAttachmentRequestSchema', () => {
  it('refuses a type outside the allow-list, HEIC included', () => {
    const base = {
      id: '018f2b4c-0000-7000-8000-000000000001',
      ownerType: 'diary_entry' as const,
      filename: 'photo.heic',
      byteSize: 1024,
    };
    expect(
      createAttachmentRequestSchema.safeParse({ ...base, mimeType: 'image/heic' }).success,
    ).toBe(false);
    expect(
      createAttachmentRequestSchema.safeParse({ ...base, mimeType: 'image/jpeg' }).success,
    ).toBe(true);
  });

  it('refuses anything over the cap before a byte is read', () => {
    const result = createAttachmentRequestSchema.safeParse({
      id: '018f2b4c-0000-7000-8000-000000000001',
      ownerType: 'diary_entry',
      filename: 'huge.jpg',
      mimeType: 'image/jpeg',
      byteSize: ATTACHMENT_MAX_BYTES + 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('formatByteSize', () => {
  it('reads the way a person would say it', () => {
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(2048)).toBe('2 KB');
    expect(formatByteSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
