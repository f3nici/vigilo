import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  EXPORT_INLINE_ROW_LIMIT,
  complianceQuerySchema,
  dailyQuerySchema,
  exportQuerySchema,
  rangeTooLong,
  trendQuerySchema,
  type Role,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  complianceReport,
  dailyReport,
  trendSeries,
  trendableFields,
  type ReportPrincipal,
} from '../services/reports.js';
import { renderDailyReport } from '../services/pdf.js';
import {
  auditExport,
  buildCsv,
  countRows,
  exportDataKey,
  findExport,
  listExports,
  queueExport,
  toExportJob,
} from '../services/exports.js';
import type { FileStore } from '../services/storage.js';
import { recordAudit } from '../services/audit.js';
import { currentPrincipal, requireAuth } from '../middleware/principal.js';
import { HttpError } from '../middleware/errors.js';
import { asyncHandler } from '../middleware/async.js';

/**
 * Reports and exports (doc 04 §11).
 *
 * Scope is not checked here. Every service below resolves it from the
 * principal's own scope, which is the only way a report that spans
 * participants can be right: there is no single participant id in the URL to
 * check, and a route that assembled its own list would be a second access rule.
 *
 * Reading a report is a view of participant data, so it is audited. Doc 07 §4
 * is explicit that views are logged, not only writes, and a report is the
 * broadest view in the product.
 */

function reportPrincipal(req: Request): ReportPrincipal {
  const principal = currentPrincipal(req);
  return {
    userId: principal.user.id,
    role: principal.role,
    deviceId: req.auditActor.deviceId,
    ownParticipantId: principal.user.participantId,
    scope: principal.scope,
    displayName: principal.user.displayName,
  };
}

/** Reports are a desk task. A worker records care; they do not run reports. */
function canReport(role: Role): boolean {
  return role === 'admin' || role === 'team_leader' || role === 'nurse';
}

function requireReporting(req: Request): void {
  if (!canReport(currentPrincipal(req).role)) {
    throw new HttpError('scope_denied', 'Only an admin, team leader or nurse can run reports.');
  }
}

/**
 * A byte-order mark, so Excel opens a UTF-8 CSV as UTF-8.
 *
 * Without it, every name with an accent in it comes out as mojibake in the one
 * program most people will open this file with.
 */
const BOM = '\uFEFF';

function assertRange(from: string, to: string): void {
  if (rangeTooLong(from, to)) {
    throw new HttpError(
      'validation_failed',
      'That is more than a year. Choose a shorter period and run it again.',
    );
  }
}

export function reportRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  /** The day on screen. Same data the PDF renders from. */
  router.get(
    '/daily',
    asyncHandler(async (req, res) => {
      requireReporting(req);
      const query = dailyQuerySchema.parse(req.query);
      assertRange(query.from, query.to);

      const principal = reportPrincipal(req);
      const report = await dailyReport(db, keyRing, principal, query);

      await recordAudit(db, {
        action: 'report.daily',
        actor: req.auditActor,
        entityType: 'participant',
        entityId: query.participantId,
        participantId: query.participantId,
        metadata: { from: query.from, to: query.to, format: 'json' },
      });

      res.json({ report });
    }),
  );

  /**
   * The same report as a PDF, streamed.
   *
   * A separate audit action from the JSON one on purpose: a PDF is a file that
   * leaves the system and gets emailed, printed and filed, and an auditor
   * asking "who produced this document" wants a different answer from "who
   * looked at this screen".
   */
  router.get(
    '/daily.pdf',
    asyncHandler(async (req, res) => {
      requireReporting(req);
      const query = dailyQuerySchema.parse(req.query);
      assertRange(query.from, query.to);

      const principal = reportPrincipal(req);
      const report = await dailyReport(db, keyRing, principal, query);

      await recordAudit(db, {
        action: 'report.daily_pdf',
        actor: req.auditActor,
        entityType: 'participant',
        entityId: query.participantId,
        participantId: query.participantId,
        metadata: { from: query.from, to: query.to, format: 'pdf' },
      });

      const name = `vigilo-${report.participant.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${query.from}${query.to === query.from ? '' : `-to-${query.to}`}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const stream = renderDailyReport(report);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }),
  );

  router.get(
    '/trends',
    asyncHandler(async (req, res) => {
      requireReporting(req);
      const query = trendQuerySchema.parse(req.query);
      assertRange(query.from, query.to);

      const principal = reportPrincipal(req);
      const series = await trendSeries(db, principal, query);

      await recordAudit(db, {
        action: 'report.trend',
        actor: req.auditActor,
        entityType: 'participant',
        entityId: query.participantId,
        participantId: query.participantId,
        metadata: { fieldKey: query.fieldKey, from: query.from, to: query.to },
      });

      res.json({ series });
    }),
  );

  /** Which numeric fields this participant actually has readings for. */
  router.get(
    '/trend-fields',
    asyncHandler(async (req, res) => {
      requireReporting(req);
      const { participantId } = z.object({ participantId: z.string().uuid() }).parse(req.query);
      res.json({ fields: await trendableFields(db, reportPrincipal(req), participantId) });
    }),
  );

  router.get(
    '/compliance',
    asyncHandler(async (req, res) => {
      requireReporting(req);
      const query = complianceQuerySchema.parse(req.query);
      assertRange(query.from, query.to);

      const principal = reportPrincipal(req);
      const report = await complianceReport(db, keyRing, principal, query, query.groupBy);

      await recordAudit(db, {
        action: 'report.compliance',
        actor: req.auditActor,
        entityType: 'report',
        participantId: query.participantId ?? null,
        metadata: {
          from: query.from,
          to: query.to,
          groupBy: query.groupBy,
          participantId: query.participantId ?? 'all in scope',
          userId: query.userId ?? 'everyone',
        },
      });

      res.json({ report });
    }),
  );

  return router;
}

/**
 * CSV exports (doc 01 §8.4).
 *
 * Admin only, unlike the reports above. A CSV is the whole record in a file
 * that can be emailed anywhere, and a team leader who needs the numbers has
 * the compliance report.
 */
export function exportRoutes(db: Database, keyRing: KeyRing, store: FileStore): Router {
  const router = Router();

  router.use(requireAuth());

  function requireAdmin(req: Request): void {
    if (currentPrincipal(req).role !== 'admin') {
      throw new HttpError('scope_denied', 'Only an admin can export records.');
    }
  }

  /**
   * Small exports come straight back; large ones become a job.
   *
   * The row count decides, not the date range, because a month for one
   * participant and a month for forty are very different files.
   */
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      requireAdmin(req);
      const query = exportQuerySchema.parse(req.body);
      assertRange(query.from, query.to);

      const principal = currentPrincipal(req);
      const context = { userId: principal.user.id, scope: principal.scope };

      const rowCount = await countRows(db, context, query);

      if (rowCount > EXPORT_INLINE_ROW_LIMIT) {
        const job = await queueExport(db, context, query);
        await auditExport(db, req.auditActor, query, rowCount, 'job');
        res.status(202).json({ job, rowCount });
        return;
      }

      const { csv } = await buildCsv(db, keyRing, context, query);
      await auditExport(db, req.auditActor, query, rowCount, 'inline');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vigilo-${query.kind}-${query.from}-to-${query.to}.csv"`,
      );
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(`${BOM}${csv}`);
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      requireAdmin(req);
      res.json({ jobs: await listExports(db, currentPrincipal(req).user.id) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      requireAdmin(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const row = await findExport(db, id, currentPrincipal(req).user.id);
      res.json({ job: toExportJob(row) });
    }),
  );

  router.get(
    '/:id/download',
    asyncHandler(async (req, res) => {
      requireAdmin(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const row = await findExport(db, id, currentPrincipal(req).user.id);

      if (row.status !== 'ready' || row.storagePath === null) {
        throw new HttpError('conflict', 'That export is not ready yet.');
      }

      await recordAudit(db, {
        action: 'export.download',
        actor: req.auditActor,
        entityType: 'export',
        entityId: row.id,
        participantId: row.participantId,
        metadata: { kind: row.kind, rowCount: row.rowCount ?? 0 },
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vigilo-${row.kind}-${row.fromDate}-to-${row.toDate}.csv"`,
      );
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const stream = await store.stream(row.storagePath, exportDataKey(keyRing, row));
      stream.on('error', () => res.destroy());
      res.write(BOM);
      stream.pipe(res);
    }),
  );

  return router;
}
