import { Router, type Request } from 'express';
import { isSelfAccess, myDayQuerySchema, myRecordsQuerySchema } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  myDay,
  myRecords,
  selfAccessToday,
  selfParticipantId,
  type SelfAccessPrincipal,
} from '../services/selfaccess.js';
import { renderMyRecords } from '../services/pdf.js';
import { recordAudit } from '../services/audit.js';
import { currentPrincipal, requireAuth, requireCapability } from '../middleware/principal.js';
import { asyncHandler } from '../middleware/async.js';

/**
 * Participant self-access (doc 04 §11, doc 06 §6).
 *
 * Three read-only screens under `/me`, and nothing takes a participant id.
 * The service reads it off the principal, so there is no id in a path to
 * check, no id in a query string to validate, and no way for one of these
 * routes to serve somebody else's record.
 *
 * Every one of them audits. Doc 07 §4 is explicit that views are logged and
 * not only writes, and a participant reading their own record is a view of
 * participant data like any other. It is also the evidence that the right of
 * access under doc 07 §5 was actually served.
 */

function selfPrincipal(req: Request): SelfAccessPrincipal {
  const principal = currentPrincipal(req);
  return {
    userId: principal.user.id,
    role: principal.role,
    deviceId: req.auditActor.deviceId,
    participantId: principal.user.participantId,
  };
}

export function selfAccessRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  /*
   * Both guards go on each route rather than on the router.
   *
   * A router-level `use` runs for every path that reaches this router, not only
   * the three it declares. When notification preferences also lived under
   * `/me`, guarding here refused a worker's preferences on the way past, and
   * the suite caught it. This router has `/me` to itself now, so the bug cannot
   * happen today, and the guards stay per-route so that adding anything back
   * under `/me` does not quietly reintroduce it.
   */
  const selfOnly = [
    requireAuth(),
    requireCapability(isSelfAccess, 'These screens are for a participant self-access account.'),
  ];

  /**
   * My day.
   *
   * Defaults to today in the org timezone rather than the device's, so a phone
   * with a wrong clock or a participant travelling does not quietly get a
   * different day than the one their support team is looking at.
   */
  router.get(
    '/day',
    selfOnly,
    asyncHandler(async (req, res) => {
      const query = myDayQuerySchema.parse(req.query);
      const principal = selfPrincipal(req);
      const date = query.date ?? (await selfAccessToday(db));

      const result = await myDay(db, keyRing, principal, date);

      await recordAudit(db, {
        action: 'self_access.day',
        actor: req.auditActor,
        entityType: 'participant',
        entityId: selfParticipantId(principal),
        participantId: selfParticipantId(principal),
        metadata: { date },
      });

      res.json(result);
    }),
  );

  /** My records: the same day, over a range they choose. */
  router.get(
    '/records',
    selfOnly,
    asyncHandler(async (req, res) => {
      const query = myRecordsQuerySchema.parse(req.query);
      const principal = selfPrincipal(req);

      const records = await myRecords(db, keyRing, principal, query);
      const today = await selfAccessToday(db);

      await recordAudit(db, {
        action: 'self_access.records',
        actor: req.auditActor,
        entityType: 'participant',
        entityId: selfParticipantId(principal),
        participantId: selfParticipantId(principal),
        metadata: { from: query.from, to: query.to },
      });

      res.json({ records, today });
    }),
  );

  /**
   * My reports: the same record as a PDF, to keep or to hand to somebody.
   *
   * Doc 07 §5 names this as how the right of access is served, which is why it
   * is a document a person can take away rather than a screen they have to be
   * logged in to read.
   */
  router.get(
    '/reports/daily.pdf',
    selfOnly,
    asyncHandler(async (req, res) => {
      const query = myRecordsQuerySchema.parse(req.query);
      const principal = selfPrincipal(req);

      const records = await myRecords(db, keyRing, principal, query);

      await recordAudit(db, {
        action: 'self_access.pdf',
        actor: req.auditActor,
        entityType: 'participant',
        entityId: selfParticipantId(principal),
        participantId: selfParticipantId(principal),
        metadata: { from: query.from, to: query.to, format: 'pdf' },
      });

      const span = query.to === query.from ? query.from : `${query.from}-to-${query.to}`;
      const name = `my-record-${span}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const stream = renderMyRecords(records);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }),
  );

  return router;
}
