import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { sql } from 'drizzle-orm';
import {
  assign,
  createHarness,
  resetData,
  seedParticipant,
  seedUser,
  signIn,
  VENT_SCHEMA,
  type Harness,
  type SignedIn,
} from './helpers.js';
import { materialiseParticipant } from '../src/services/windows.js';

/**
 * The diary, attachments and the timeline end to end (doc 01 §6, doc 04 §8
 * and §9).
 *
 * The parts worth testing against a real database and a real image codec are
 * the ones that would fail quietly: an encrypted body that turns out to be
 * readable in a dump, a photo whose GPS tags survive the upload, and a
 * participant self-access account seeing an entry marked hidden from them.
 */
describe('diary', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await resetData(h.ownerDb);
  });

  function api(
    session: SignedIn,
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
  ) {
    return request(h.app)
      [method](path)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrfToken);
  }

  type Fixture = {
    admin: SignedIn;
    adminId: string;
    worker: SignedIn;
    workerId: string;
    participantId: string;
    categoryId: string;
  };

  async function setUp(): Promise<Fixture> {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const admin = await signIn(h, adminUser);

    const participantId = await seedParticipant(h.ownerDb, h.keyRing, {
      firstName: 'Alice',
      lastName: 'Smith',
    });

    const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, workerUser.id, participantId);
    const worker = await signIn(h, workerUser);

    const categories = await api(admin, 'get', '/api/v1/diary-categories');
    expect(categories.status).toBe(200);
    const personalCare = (categories.body.categories as { id: string; slug: string }[]).find(
      (one) => one.slug === 'personal_care',
    );

    return {
      admin,
      adminId: adminUser.id,
      worker,
      workerId: workerUser.id,
      participantId,
      categoryId: personalCare!.id,
    };
  }

  function newEntry(categoryId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      categoryId,
      body: 'Assisted with shower, good mood throughout.',
      occurredAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      ...overrides,
    };
  }

  describe('recording', () => {
    it('records an entry and reads it back', async () => {
      const { worker, workerId, participantId, categoryId } = await setUp();

      const created = await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId),
      );

      expect(created.status).toBe(201);
      expect(created.body.entry).toMatchObject({
        participantId,
        categoryLabel: 'Personal care',
        categoryColour: 'sky',
        body: 'Assisted with shower, good mood throughout.',
        recordedBy: workerId,
        visibleToParticipant: true,
        editCount: 0,
      });

      const list = await api(worker, 'get', `/api/v1/participants/${participantId}/diary`);
      expect(list.body.entries).toHaveLength(1);
    });

    /**
     * The reason `occurred_at` exists. A worker writing up the morning at
     * lunchtime produces one record with two different times on it, and both
     * are true.
     */
    it('keeps when it happened separate from when it was written', async () => {
      const { worker, participantId, categoryId } = await setUp();
      const occurredAt = new Date(Date.now() - 4 * 3_600_000).toISOString();

      const created = await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId, { occurredAt }),
      );

      expect(created.body.entry.occurredAt).toBe(occurredAt);
      expect(Date.parse(created.body.entry.recordedAt)).toBeGreaterThan(Date.parse(occurredAt));
    });

    it('refuses an entry about something that has not happened yet', async () => {
      const { worker, participantId, categoryId } = await setUp();

      const response = await api(
        worker,
        'post',
        `/api/v1/participants/${participantId}/diary`,
      ).send(newEntry(categoryId, { occurredAt: new Date(Date.now() + 3_600_000).toISOString() }));

      expect(response.status).toBe(422);
      expect(response.body.error.message).toContain('has not happened yet');
    });

    /** A replayed outbox must not write the shift up twice. */
    it('is idempotent by the id the device supplied', async () => {
      const { worker, participantId, categoryId } = await setUp();
      const entry = newEntry(categoryId);

      await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(entry);
      const replay = await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        entry,
      );

      expect(replay.status).toBe(201);
      const list = await api(worker, 'get', `/api/v1/participants/${participantId}/diary`);
      expect(list.body.entries).toHaveLength(1);
    });

    it('stores the body encrypted', async () => {
      const { worker, participantId, categoryId } = await setUp();
      await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId, { body: 'Very sensitive detail about Alice.' }),
      );

      const rows = await h.ownerDb.execute<{ leaked: string }>(
        sql`select count(*)::text as leaked from diary_entries
            where encode(body_enc, 'escape') like '%sensitive%'`,
      );
      expect(rows[0]!.leaked).toBe('0');
    });

    it('refuses a category that is not one of the options', async () => {
      const { worker, participantId } = await setUp();
      const response = await api(
        worker,
        'post',
        `/api/v1/participants/${participantId}/diary`,
      ).send(newEntry(randomUUID()));

      expect(response.status).toBe(422);
    });
  });

  describe('visibility', () => {
    /**
     * Staff-controlled, per entry. Hiding an entry from the person it is about
     * does not hide it from the team supporting them, which is why only the
     * self-access account is filtered.
     */
    it('hides an entry marked not visible from the participant only', async () => {
      const { worker, participantId, categoryId } = await setUp();

      await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId, { body: 'Visible one.' }),
      );
      await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId, { body: 'Hidden one.', visibleToParticipant: false }),
      );

      const selfUser = await seedUser(h.ownerDb, h.keyRing, {
        role: 'participant',
        participantId,
      });
      const self = await signIn(h, selfUser);

      const staffView = await api(worker, 'get', `/api/v1/participants/${participantId}/diary`);
      expect(staffView.body.entries).toHaveLength(2);

      const selfView = await api(self, 'get', `/api/v1/participants/${participantId}/diary`);
      expect(selfView.body.entries).toHaveLength(1);
      expect(selfView.body.entries[0].body).toBe('Visible one.');
    });

    it('does not let a self-access account write in its own diary', async () => {
      const { participantId, categoryId } = await setUp();
      const selfUser = await seedUser(h.ownerDb, h.keyRing, {
        role: 'participant',
        participantId,
      });
      const self = await signIn(h, selfUser);

      const response = await api(self, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId),
      );
      expect(response.status).toBe(403);
    });
  });

  describe('editing', () => {
    it('preserves the original and records who changed what', async () => {
      const { worker, workerId, participantId, categoryId } = await setUp();

      const created = await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId, { body: 'Shower at 8am.' }),
      );
      const entryId = created.body.entry.id as string;

      const edited = await api(worker, 'patch', `/api/v1/diary-entries/${entryId}`).send({
        body: 'Shower at 8:30am, not 8am.',
        reason: 'Wrong time',
      });

      expect(edited.status).toBe(200);
      expect(edited.body.entry.editCount).toBe(1);
      expect(edited.body.entry.editedAt).not.toBeNull();

      const history = await api(worker, 'get', `/api/v1/diary-entries/${entryId}/revisions`);
      expect(history.body.revisions).toHaveLength(1);
      expect(history.body.revisions[0]).toMatchObject({
        field: 'body',
        oldValue: 'Shower at 8am.',
        newValue: 'Shower at 8:30am, not 8am.',
        changedBy: workerId,
        reason: 'Wrong time',
      });
    });

    it('records one revision per field that actually changed', async () => {
      const { admin, worker, participantId, categoryId } = await setUp();

      const categories = await api(admin, 'get', '/api/v1/diary-categories');
      const behaviour = (categories.body.categories as { id: string; slug: string }[]).find(
        (one) => one.slug === 'behaviour',
      )!;

      const created = await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId),
      );
      const entryId = created.body.entry.id as string;

      await api(worker, 'patch', `/api/v1/diary-entries/${entryId}`).send({
        categoryId: behaviour.id,
        visibleToParticipant: false,
      });

      const history = await api(worker, 'get', `/api/v1/diary-entries/${entryId}/revisions`);
      expect(
        (history.body.revisions as { field: string }[]).map((one) => one.field).sort(),
      ).toEqual(['category', 'visibility']);
    });

    /** Saving a form nobody changed is not an edit. */
    it('writes nothing when the values are unchanged', async () => {
      const { worker, participantId, categoryId } = await setUp();
      const entry = newEntry(categoryId);

      const created = await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        entry,
      );
      const entryId = created.body.entry.id as string;

      const edited = await api(worker, 'patch', `/api/v1/diary-entries/${entryId}`).send({
        body: entry.body,
      });

      expect(edited.body.entry.editCount).toBe(0);
      const history = await api(worker, 'get', `/api/v1/diary-entries/${entryId}/revisions`);
      expect(history.body.revisions).toHaveLength(0);
    });

    it("stops a worker changing someone else's entry", async () => {
      const { worker, participantId, categoryId } = await setUp();

      const created = await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId),
      );
      const entryId = created.body.entry.id as string;

      const otherUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      await assign(h.ownerDb, otherUser.id, participantId);
      const other = await signIn(h, otherUser);

      const response = await api(other, 'patch', `/api/v1/diary-entries/${entryId}`).send({
        body: 'Something else entirely.',
      });
      expect(response.status).toBe(403);
    });
  });

  describe('deleting', () => {
    it('is admin only, soft, and hides the entry from everyone else', async () => {
      const { admin, worker, participantId, categoryId } = await setUp();

      const created = await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId),
      );
      const entryId = created.body.entry.id as string;

      const refused = await api(worker, 'delete', `/api/v1/diary-entries/${entryId}`);
      expect(refused.status).toBe(403);

      const deleted = await api(admin, 'delete', `/api/v1/diary-entries/${entryId}`);
      expect(deleted.status).toBe(204);

      const workerView = await api(worker, 'get', `/api/v1/participants/${participantId}/diary`);
      expect(workerView.body.entries).toHaveLength(0);

      // The row is still there. Retention applies to a deleted entry exactly
      // as it applies to a live one.
      const rows = await h.ownerDb.execute<{ count: string }>(
        sql`select count(*)::text as count from diary_entries where deleted_at is not null`,
      );
      expect(rows[0]!.count).toBe('1');
    });
  });

  describe('scope', () => {
    it('refuses the diary of a participant the caller is not assigned to', async () => {
      const { worker } = await setUp();
      const other = await seedParticipant(h.ownerDb, h.keyRing, { lastName: 'Nobody' });

      const response = await api(worker, 'get', `/api/v1/participants/${other}/diary`);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('scope_denied');
    });
  });

  describe('search', () => {
    it('matches a fragment inside an encrypted body', async () => {
      const { worker, participantId, categoryId } = await setUp();

      await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId, { body: 'Had a seizure just after lunch.' }),
      );
      await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId, { body: 'Went to the shops.' }),
      );

      const hit = await api(
        worker,
        'get',
        `/api/v1/participants/${participantId}/diary?search=seiz`,
      );
      expect(hit.body.entries).toHaveLength(1);

      const miss = await api(
        worker,
        'get',
        `/api/v1/participants/${participantId}/diary?search=swimming`,
      );
      expect(miss.body.entries).toHaveLength(0);
    });
  });

  describe('categories', () => {
    it('ships with the set from doc 01 §6', async () => {
      const { worker } = await setUp();
      const response = await api(worker, 'get', '/api/v1/diary-categories');
      expect((response.body.categories as { slug: string }[]).map((one) => one.slug)).toEqual([
        'personal_care',
        'behaviour',
        'activity',
        'medical',
        'communication',
        'family_contact',
        'equipment',
        'other',
      ]);
    });

    it('is admin only to change', async () => {
      const { admin, worker } = await setUp();

      const refused = await api(worker, 'post', '/api/v1/diary-categories').send({
        slug: 'transport',
        label: 'Transport',
        colour: 'teal',
      });
      expect(refused.status).toBe(403);

      const created = await api(admin, 'post', '/api/v1/diary-categories').send({
        slug: 'transport',
        label: 'Transport',
        colour: 'teal',
        sortOrder: 90,
      });
      expect(created.status).toBe(201);
    });

    /** Deactivated, never deleted, so a past entry keeps its filing. */
    it('deactivates rather than removing', async () => {
      const { admin, worker, participantId, categoryId } = await setUp();

      await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send(
        newEntry(categoryId),
      );
      await api(admin, 'patch', `/api/v1/diary-categories/${categoryId}`).send({ active: false });

      const list = await api(worker, 'get', '/api/v1/diary-categories');
      expect((list.body.categories as { slug: string }[]).map((one) => one.slug)).not.toContain(
        'personal_care',
      );

      const entries = await api(worker, 'get', `/api/v1/participants/${participantId}/diary`);
      expect(entries.body.entries[0].categoryLabel).toBe('Personal care');
    });
  });
});

/** Real bytes through a real codec, because that is what the risk is about. */
async function photoWithGps(): Promise<Buffer> {
  return sharp({
    create: { width: 600, height: 400, channels: 3, background: '#5b8fa8' },
  })
    .withExif({
      IFD0: { Copyright: 'Vigilo test', Make: 'TestPhone' },
      GPS: { GPSLatitudeRef: 'S', GPSLongitudeRef: 'E' },
    })
    .jpeg()
    .toBuffer();
}

describe('attachments', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await resetData(h.ownerDb);
  });

  function api(
    session: SignedIn,
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
  ) {
    return request(h.app)
      [method](path)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrfToken);
  }

  async function setUp() {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const admin = await signIn(h, adminUser);
    const participantId = await seedParticipant(h.ownerDb, h.keyRing);

    const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, workerUser.id, participantId);
    const worker = await signIn(h, workerUser);

    const categories = await api(admin, 'get', '/api/v1/diary-categories');
    const categoryId = (categories.body.categories as { id: string; slug: string }[]).find(
      (one) => one.slug === 'personal_care',
    )!.id;

    return { admin, worker, participantId, categoryId };
  }

  /** The two-step upload: the row, then the bytes. */
  async function upload(
    session: SignedIn,
    participantId: string,
    bytes: Buffer,
    options: { mimeType?: string; filename?: string } = {},
  ) {
    const id = randomUUID();
    const created = await api(
      session,
      'post',
      `/api/v1/participants/${participantId}/attachments`,
    ).send({
      id,
      ownerType: 'diary_entry',
      filename: options.filename ?? 'wound.jpg',
      mimeType: options.mimeType ?? 'image/jpeg',
      byteSize: bytes.byteLength,
    });

    const content = await api(session, 'put', `/api/v1/attachments/${id}/content`)
      .set('Content-Type', 'application/octet-stream')
      .send(bytes);

    return { id, created, content };
  }

  it('takes a photo and reports its dimensions', async () => {
    const { worker, participantId } = await setUp();
    const { created, content } = await upload(worker, participantId, await photoWithGps());

    expect(created.status).toBe(201);
    expect(created.body.attachment.uploadState).toBe('pending');
    expect(content.status).toBe(200);
    expect(content.body.attachment).toMatchObject({
      uploadState: 'complete',
      width: 600,
      height: 400,
      isImage: true,
    });
  });

  /**
   * The control this whole path exists for. A phone photo carries the place it
   * was taken, and for this product that place is someone's home.
   */
  it('strips EXIF and GPS from a photo on the way in', async () => {
    const { worker, participantId } = await setUp();
    const original = await photoWithGps();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const { id } = await upload(worker, participantId, original);

    const downloaded = await api(worker, 'get', `/api/v1/attachments/${id}`).buffer(true);
    const metadata = await sharp(downloaded.body as Buffer).metadata();

    expect(metadata.exif).toBeUndefined();
    expect(metadata.width).toBe(600);
  });

  it('never writes the plaintext to the volume', async () => {
    const { worker, participantId } = await setUp();
    const original = await photoWithGps();
    await upload(worker, participantId, original);

    const files = await allFiles(h.attachmentDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const stored = await readFile(file);
      // Not the plaintext, and not even a readable JPEG header.
      expect(stored.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
      expect(stored.includes(original.subarray(0, 64))).toBe(false);
    }
  });

  it('refuses a file that is not what it says it is', async () => {
    const { worker, participantId } = await setUp();
    const notAnImage = Buffer.from('MZ  this is a program', 'binary');

    const { content } = await upload(worker, participantId, notAnImage);
    expect(content.status).toBe(422);
    expect(content.body.error.message).toContain('cannot be attached');
  });

  it('refuses a PDF uploaded as a photo', async () => {
    const { worker, participantId } = await setUp();
    const pdf = Buffer.from('%PDF-1.7\nnot really a pdf either');

    const { content } = await upload(worker, participantId, pdf, { mimeType: 'image/jpeg' });
    expect(content.status).toBe(422);
    expect(content.body.error.message).toContain('application/pdf');
  });

  it('refuses HEIC with something the worker can act on', async () => {
    const { worker, participantId } = await setUp();
    const heic = Buffer.alloc(64);
    heic.write('ftyp', 4, 'ascii');
    heic.write('heic', 8, 'ascii');

    const { content } = await upload(worker, participantId, heic);
    expect(content.status).toBe(422);
    expect(content.body.error.message).toContain('Most Compatible');
  });

  it('refuses a type outside the allow-list before any bytes arrive', async () => {
    const { worker, participantId } = await setUp();

    const response = await api(
      worker,
      'post',
      `/api/v1/participants/${participantId}/attachments`,
    ).send({
      id: randomUUID(),
      ownerType: 'diary_entry',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      byteSize: 10,
    });

    expect(response.status).toBe(422);
  });

  it('makes a thumbnail on first request and keeps it', async () => {
    const { worker, participantId } = await setUp();
    const { id } = await upload(worker, participantId, await photoWithGps());

    const first = await api(worker, 'get', `/api/v1/attachments/${id}/thumb`).buffer(true);
    expect(first.status).toBe(200);
    const metadata = await sharp(first.body as Buffer).metadata();
    expect(Math.max(metadata.width!, metadata.height!)).toBe(320);

    const rows = await h.ownerDb.execute<{ thumbnail_path: string | null }>(
      sql`select thumbnail_path from attachments where id = ${id}`,
    );
    expect(rows[0]!.thumbnail_path).not.toBeNull();

    const second = await api(worker, 'get', `/api/v1/attachments/${id}/thumb`).buffer(true);
    expect(second.status).toBe(200);
  });

  it('serves a download as an attachment, never inline', async () => {
    const { worker, participantId } = await setUp();
    const { id } = await upload(worker, participantId, await photoWithGps());

    const response = await api(worker, 'get', `/api/v1/attachments/${id}`).buffer(true);
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses a download to someone out of scope', async () => {
    const { worker, participantId } = await setUp();
    const { id } = await upload(worker, participantId, await photoWithGps());

    const outsiderUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const outsider = await signIn(h, outsiderUser);

    const response = await api(outsider, 'get', `/api/v1/attachments/${id}`);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('scope_denied');
  });

  it('attaches to a diary entry and comes back with it', async () => {
    const { worker, participantId, categoryId } = await setUp();
    const { id } = await upload(worker, participantId, await photoWithGps());

    const created = await api(worker, 'post', `/api/v1/participants/${participantId}/diary`).send({
      id: randomUUID(),
      categoryId,
      body: 'Pressure area, photographed.',
      occurredAt: new Date().toISOString(),
      attachmentIds: [id],
    });

    expect(created.status).toBe(201);
    expect(created.body.entry.attachments).toHaveLength(1);
    expect(created.body.entry.attachments[0]).toMatchObject({ id, isImage: true });
  });

  /** The shape a scope escape would take here. */
  it('refuses to move an attachment onto another participant record', async () => {
    const { worker, participantId, categoryId } = await setUp();
    const { id } = await upload(worker, participantId, await photoWithGps());

    const otherParticipant = await seedParticipant(h.ownerDb, h.keyRing, { lastName: 'Other' });
    const otherWorker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, otherWorker.id, otherParticipant);
    const other = await signIn(h, otherWorker);

    const response = await api(
      other,
      'post',
      `/api/v1/participants/${otherParticipant}/diary`,
    ).send({
      id: randomUUID(),
      categoryId,
      body: 'Trying to borrow a photo.',
      occurredAt: new Date().toISOString(),
      attachmentIds: [id],
    });

    expect(response.status).toBe(403);
  });

  it('audits the upload and the download without recording the filename', async () => {
    const { worker, participantId } = await setUp();
    const { id } = await upload(worker, participantId, await photoWithGps(), {
      filename: 'alice-smith-wound.jpg',
    });
    await api(worker, 'get', `/api/v1/attachments/${id}`).buffer(true);

    const rows = await h.ownerDb.execute<{ action: string; metadata: Record<string, unknown> }>(
      sql`select action, metadata from audit_log where action like 'attachment.%' order by id`,
    );

    expect(rows.map((row) => row.action)).toEqual(['attachment.upload', 'attachment.download']);
    expect(JSON.stringify(rows)).not.toContain('alice-smith');
  });
});

describe('the timeline', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await resetData(h.ownerDb);
  });

  function api(
    session: SignedIn,
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
  ) {
    return request(h.app)
      [method](path)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrfToken);
  }

  /**
   * The Phase 4 acceptance test: a day's checks and diary in one list, newest
   * first, with the photo on the entry it belongs to.
   */
  it('shows a day of checks and diary together', async () => {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const admin = await signIn(h, adminUser);

    const participant = await api(admin, 'post', '/api/v1/participants').send({
      firstName: 'Alice',
      lastName: 'Smith',
      dateOfBirth: '1994-03-02',
      ndisNumber: '431234567',
    });
    const participantId = participant.body.participant.id as string;

    const template = await api(admin, 'post', '/api/v1/check-templates').send({
      name: 'Vent observations',
    });
    const versionId = template.body.template.draftVersion.id as string;
    await api(admin, 'patch', `/api/v1/check-template-versions/${versionId}`).send({
      schema: VENT_SCHEMA,
    });
    await api(admin, 'post', `/api/v1/check-template-versions/${versionId}/publish`).send({});

    const today = new Date();
    const isoToday = today.toISOString().slice(0, 10);

    const schedule = await api(
      admin,
      'post',
      `/api/v1/participants/${participantId}/schedules`,
    ).send({
      name: 'Vent observations',
      templateId: template.body.template.id,
      activeFrom: isoToday,
      segments: [
        {
          label: 'All day',
          windowMinutes: 120,
          anchorTime: '00:00',
          appliesFromTime: '00:00',
          appliesToTime: '00:00',
        },
      ],
    });

    expect(schedule.status).toBe(201);

    await materialiseParticipant(h.ownerDb, participantId, isoToday, isoToday);

    const categories = await api(admin, 'get', '/api/v1/diary-categories');
    const categoryId = (categories.body.categories as { id: string; slug: string }[]).find(
      (one) => one.slug === 'personal_care',
    )!.id;

    await api(admin, 'post', `/api/v1/participants/${participantId}/diary`).send({
      id: randomUUID(),
      categoryId,
      body: 'Assisted with shower, good mood throughout.',
      occurredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    const timeline = await api(admin, 'get', `/api/v1/participants/${participantId}/timeline`);

    expect(timeline.status).toBe(200);
    const kinds = (timeline.body.items as { kind: string }[]).map((item) => item.kind);
    expect(kinds).toContain('check');
    expect(kinds).toContain('diary');

    // Newest first, which is what a handover is read in.
    const times = (timeline.body.items as { at: string }[]).map((item) => Date.parse(item.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

async function allFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await allFiles(full)));
    else found.push(full);
  }
  return found;
}
