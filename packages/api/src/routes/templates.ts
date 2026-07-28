import { Router } from 'express';
import { z } from 'zod';
import {
  canManageTemplates,
  createTemplateRequestSchema,
  updateTemplateRequestSchema,
  updateVersionRequestSchema,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  createDraftVersion,
  createTemplate,
  getTemplate,
  getVersion,
  listTemplates,
  listVersions,
  previewPublish,
  publishVersion,
  updateDraftSchema,
  updateTemplate,
} from '../services/templates.js';
import { currentPrincipal, requireAuth, requireCapability } from '../middleware/principal.js';
import { asyncHandler } from '../middleware/async.js';

const idSchema = z.object({ id: z.string().uuid() });

/**
 * Check templates (doc 04 §5).
 *
 * Templates are not per-participant, so there is no scope check here. Anyone
 * signed in may read them, because a worker's device needs the field set to
 * render a form; only admins and nurses may change them.
 */
export function templateRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth());

  const manageTemplates = requireCapability(
    canManageTemplates,
    'Only an admin or a nurse can change check forms.',
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const includeRetired = req.query.includeRetired === 'true';
      res.json({ templates: await listTemplates(db, { includeRetired }) });
    }),
  );

  router.post(
    '/',
    manageTemplates,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const request = createTemplateRequestSchema.parse(req.body);
      const template = await createTemplate(db, request, principal.user.id, req.auditActor);
      res.status(201).json({ template });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = idSchema.parse(req.params);
      res.json({ template: await getTemplate(db, id) });
    }),
  );

  router.patch(
    '/:id',
    manageTemplates,
    asyncHandler(async (req, res) => {
      const { id } = idSchema.parse(req.params);
      const request = updateTemplateRequestSchema.parse(req.body);
      res.json({ template: await updateTemplate(db, id, request, req.auditActor) });
    }),
  );

  router.get(
    '/:id/versions',
    asyncHandler(async (req, res) => {
      const { id } = idSchema.parse(req.params);
      res.json({ versions: await listVersions(db, id) });
    }),
  );

  /** Starts a draft from the current published version. */
  router.post(
    '/:id/versions',
    manageTemplates,
    asyncHandler(async (req, res) => {
      const { id } = idSchema.parse(req.params);
      res.status(201).json({ version: await createDraftVersion(db, id, req.auditActor) });
    }),
  );

  return router;
}

/**
 * Version routes sit at their own path because a version id is enough to
 * identify one (doc 04 §5), and a device rendering a historical entry has the
 * version id without knowing which template it came from.
 */
export function templateVersionRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth());

  const manageTemplates = requireCapability(
    canManageTemplates,
    'Only an admin or a nurse can change check forms.',
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = idSchema.parse(req.params);
      res.json({ version: await getVersion(db, id) });
    }),
  );

  router.patch(
    '/:id',
    manageTemplates,
    asyncHandler(async (req, res) => {
      const { id } = idSchema.parse(req.params);
      const request = updateVersionRequestSchema.parse(req.body);
      res.json({ version: await updateDraftSchema(db, id, request.schema, req.auditActor) });
    }),
  );

  /** The diff and any blocking problems, before the irreversible step. */
  router.get(
    '/:id/publish-preview',
    manageTemplates,
    asyncHandler(async (req, res) => {
      const { id } = idSchema.parse(req.params);
      res.json(await previewPublish(db, id));
    }),
  );

  router.post(
    '/:id/publish',
    manageTemplates,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { id } = idSchema.parse(req.params);
      res.json({ version: await publishVersion(db, id, principal.user.id, req.auditActor) });
    }),
  );

  return router;
}
