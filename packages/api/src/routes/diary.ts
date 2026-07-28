import express, { Router, type Request } from 'express';
import { z } from 'zod';
import {
  ATTACHMENT_MAX_BYTES,
  addDays,
  canDeleteDiary,
  canEditOthersDiary,
  canManageDiaryCategories,
  canRecordDiary,
  createAttachmentRequestSchema,
  createDiaryCategoryRequestSchema,
  createDiaryEntryRequestSchema,
  diaryQuerySchema,
  localDateOf,
  updateDiaryCategoryRequestSchema,
  updateDiaryEntryRequestSchema,
  zonedTimeToUtc,
  type Role,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  createCategory,
  createDiaryEntry,
  deleteDiaryEntry,
  findDiaryEntry,
  getDiaryEntry,
  listCategories,
  listDiaryEntries,
  listDiaryRevisions,
  participantTimeline,
  updateCategory,
  updateDiaryEntry,
  type DiaryPrincipal,
} from '../services/diary.js';
import {
  createAttachment,
  deleteAttachment,
  findAttachment,
  openAttachment,
  openThumbnail,
  storeContent,
  toAttachment,
} from '../services/attachments.js';
import type { FileStore } from '../services/storage.js';
import { findParticipant } from '../services/participants.js';
import { assertInScope } from '../services/scope.js';
import { getOrgSettings } from '../services/org.js';
import { currentPrincipal, requireAuth, requireCapability } from '../middleware/principal.js';
import { HttpError } from '../middleware/errors.js';
import { asyncHandler } from '../middleware/async.js';

/**
 * Diary and attachments (doc 04 §8 and §9).
 *
 * Same shape as the checks router, and for the same reason: scope is resolved
 * before any capability is considered, so an out-of-scope request answers
 * identically whatever the caller's role and whatever they were about to do.
 */

const idSchema = z.object({ id: z.string().uuid() });

function afterScope(req: Request, can: (role: Role) => boolean, message: string): void {
  if (!can(currentPrincipal(req).role)) {
    throw new HttpError('scope_denied', message);
  }
}

function diaryPrincipal(req: Request): DiaryPrincipal {
  const principal = currentPrincipal(req);
  return {
    userId: principal.user.id,
    role: principal.role,
    deviceId: req.auditActor.deviceId,
    ownParticipantId: principal.user.participantId,
  };
}

const dateRangeSchema = z.object({
  from: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** The participant-scoped half: the diary list, the timeline and uploads. */
export function participantDiaryRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  function scoped(req: Request): string {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    assertInScope(principal.scope, id);
    return id;
  }

  const recordDiary = requireCapability(
    canRecordDiary,
    'A self-access account can read the diary but not write in it.',
  );

  router.get(
    '/:id/diary',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const query = diaryQuerySchema.parse(req.query);
      const org = await getOrgSettings(db);
      res.json({
        entries: await listDiaryEntries(db, keyRing, id, query, diaryPrincipal(req), org.timezone),
        timeZone: org.timezone,
      });
    }),
  );

  router.post(
    '/:id/diary',
    recordDiary,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      await findParticipant(db, id);
      const request = createDiaryEntryRequestSchema.parse(req.body);
      const entry = await createDiaryEntry(
        db,
        keyRing,
        id,
        request,
        diaryPrincipal(req),
        req.auditActor,
      );
      res.status(201).json({ entry });
    }),
  );

  /**
   * The merged timeline (doc 04 §3). Defaults to the last week, which is the
   * span a handover actually covers.
   */
  router.get(
    '/:id/timeline',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const range = dateRangeSchema.parse(req.query);
      const org = await getOrgSettings(db);

      const today = localDateOf(new Date(), org.timezone);
      const fromDate = range.from ?? addDays(today, -6);
      const toDate = range.to ?? today;

      res.json({
        timeZone: org.timezone,
        items: await participantTimeline(
          db,
          keyRing,
          id,
          zonedTimeToUtc(fromDate, 0, org.timezone),
          zonedTimeToUtc(addDays(toDate, 1), 0, org.timezone),
          diaryPrincipal(req),
        ),
      });
    }),
  );

  /**
   * Step one of an upload: the metadata row. The bytes follow on
   * `PUT /attachments/:id/content`, which is what lets a device queue a photo
   * it has not managed to send yet.
   */
  router.post(
    '/:id/attachments',
    recordDiary,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      await findParticipant(db, id);
      const request = createAttachmentRequestSchema.parse(req.body);
      const principal = currentPrincipal(req);
      const attachment = await createAttachment(db, id, request, {
        userId: principal.user.id,
        role: principal.role,
      });
      res.status(201).json({ attachment });
    }),
  );

  return router;
}

/** Entries addressed by their own id, once the caller has one. */
export function diaryEntryRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  /**
   * Loads the entry, checks scope, then checks capability. The entry has to be
   * read first to learn which participant it belongs to, which is exactly the
   * case `afterScope` exists for.
   */
  async function scopedEntry(req: Request) {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    const row = await findDiaryEntry(db, id);
    assertInScope(principal.scope, row.participantId);
    return row;
  }

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = await scopedEntry(req);
      res.json({ entry: await getDiaryEntry(db, keyRing, row.id, diaryPrincipal(req)) });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = await scopedEntry(req);
      const principal = diaryPrincipal(req);

      afterScope(req, canRecordDiary, 'A self-access account cannot change diary entries.');
      if (row.recordedBy !== principal.userId) {
        afterScope(
          req,
          canEditOthersDiary,
          "Only a team leader, nurse or admin can change someone else's diary entry.",
        );
      }

      const request = updateDiaryEntryRequestSchema.parse(req.body);
      const entry = await updateDiaryEntry(db, keyRing, row.id, request, principal, req.auditActor);
      res.json({ entry });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = await scopedEntry(req);
      afterScope(req, canDeleteDiary, 'Only an admin can delete a diary entry.');
      await deleteDiaryEntry(db, row.id, diaryPrincipal(req), req.auditActor);
      res.status(204).end();
    }),
  );

  router.get(
    '/:id/revisions',
    asyncHandler(async (req, res) => {
      const row = await scopedEntry(req);
      afterScope(req, canRecordDiary, 'A self-access account cannot see the edit history.');
      res.json({ revisions: await listDiaryRevisions(db, keyRing, row.id) });
    }),
  );

  return router;
}

/**
 * Attachment bytes.
 *
 * Content arrives as a raw body rather than multipart. It is one file per
 * request against a row that already exists, so the multipart envelope would
 * carry nothing the URL does not, and this leaves the door open for the
 * `Content-Range` resumption doc 04 §9 wants without a parser in the way.
 */
export function attachmentRoutes(db: Database, keyRing: KeyRing, store: FileStore): Router {
  const router = Router();

  router.use(requireAuth());

  async function scopedAttachment(req: Request) {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    const row = await findAttachment(db, id);
    assertInScope(principal.scope, row.participantId);
    return row;
  }

  router.put(
    '/:id/content',
    express.raw({ type: '*/*', limit: ATTACHMENT_MAX_BYTES }),
    asyncHandler(async (req, res) => {
      const row = await scopedAttachment(req);
      afterScope(req, canRecordDiary, 'A self-access account cannot upload files.');

      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const attachment = await storeContent(db, keyRing, store, row.id, bytes, req.auditActor);
      res.json({ attachment });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = await scopedAttachment(req);
      const stream = await openAttachment(db, keyRing, store, row, req.auditActor);

      // Never inline. A file served inline runs in the origin's context, and
      // an origin that holds a session cookie is not one to render an upload in
      // (doc 07 §7).
      res.setHeader('Content-Type', row.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');

      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }),
  );

  router.get(
    '/:id/thumb',
    asyncHandler(async (req, res) => {
      const row = await scopedAttachment(req);
      const stream = await openThumbnail(db, keyRing, store, row);

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');

      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }),
  );

  router.get(
    '/:id/meta',
    asyncHandler(async (req, res) => {
      res.json({ attachment: toAttachment(await scopedAttachment(req)) });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = await scopedAttachment(req);
      afterScope(req, canRecordDiary, 'A self-access account cannot delete files.');
      await deleteAttachment(db, row.id, req.auditActor);
      res.status(204).end();
    }),
  );

  return router;
}

/** Category admin (doc 06 §5). Read by anyone signed in, written by an admin. */
export function diaryCategoryRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth());

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const includeInactive =
        req.query.includeInactive === 'true' &&
        canManageDiaryCategories(currentPrincipal(req).role);
      res.json({ categories: await listCategories(db, { includeInactive }) });
    }),
  );

  const manage = requireCapability(
    canManageDiaryCategories,
    'Only an admin can change diary categories.',
  );

  router.post(
    '/',
    manage,
    asyncHandler(async (req, res) => {
      const request = createDiaryCategoryRequestSchema.parse(req.body);
      res.status(201).json({ category: await createCategory(db, request, req.auditActor) });
    }),
  );

  router.patch(
    '/:id',
    manage,
    asyncHandler(async (req, res) => {
      const { id } = idSchema.parse(req.params);
      const request = updateDiaryCategoryRequestSchema.parse(req.body);
      res.json({ category: await updateCategory(db, id, request, req.auditActor) });
    }),
  );

  return router;
}
