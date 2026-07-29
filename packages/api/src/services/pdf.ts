import PDFDocument from 'pdfkit';
import type { Readable } from 'node:stream';
import { formatTimeOfDay, utcToZoned, type DailyReport, type DailyWindow } from '@vigilo/shared';

/**
 * The daily participant report as a PDF (doc 01 §8.1).
 *
 * This is the artefact that leaves the building. It gets printed, filed, and
 * handed to a family or an auditor, so it says who generated it and when, and
 * it accounts for every window in the day including the ones nobody was
 * expected to do.
 *
 * Serif body with sans headings (doc 08 §4), using the Times and Helvetica
 * PDFKit has built in rather than embedding Inter. Embedding would add a
 * megabyte to a container image for a document nobody reads on screen, and the
 * brand rule for reports is a serif body anyway.
 *
 * No colour anywhere carries meaning. A reading is never marked good or bad
 * (CLAUDE.md), and a printed report is the last place to start.
 */

const BODY = 'Times-Roman';
const BODY_BOLD = 'Times-Bold';
const BODY_ITALIC = 'Times-Italic';
const HEADING = 'Helvetica-Bold';
const LABEL = 'Helvetica';

const INK = '#1C1B19';
const MUTED = '#5B5852';
const RULE = '#D8D5CE';

const MARGIN = 48;

export function renderDailyReport(report: DailyReport): Readable {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: `${report.participant.name} ${report.from}${report.to === report.from ? '' : ` to ${report.to}`}`,
      Author: report.orgName,
      Subject: 'Care record',
      CreationDate: new Date(report.generatedAt),
    },
  });

  const time = (iso: string) => formatTimeOfDay(utcToZoned(new Date(iso), report.timeZone).minutes);

  header(doc, report);
  alerts(doc, report);

  for (const day of report.days) {
    ensureRoom(doc, 90);
    dayHeading(doc, day.date, report);

    if (day.windows.length === 0 && day.diary.length === 0) {
      doc.font(BODY_ITALIC).fontSize(10).fillColor(MUTED);
      doc.text('Nothing was scheduled and nothing was recorded.');
      doc.moveDown(0.8);
      continue;
    }

    for (const window of day.windows) {
      ensureRoom(doc, 60);
      windowBlock(doc, window, time);
    }

    if (day.diary.length > 0) {
      ensureRoom(doc, 50);
      doc.moveDown(0.3);
      doc.font(HEADING).fontSize(10).fillColor(INK).text('Diary');
      doc.moveDown(0.2);

      for (const entry of day.diary) {
        ensureRoom(doc, 44);
        doc.font(BODY_BOLD).fontSize(10).fillColor(INK);
        doc.text(`${time(entry.occurredAt)}  ${entry.categoryLabel}`, { continued: false });

        doc.font(BODY).fontSize(10).fillColor(INK);
        doc.text(entry.body, { indent: 12 });

        const notes = [
          entry.recordedByName ? `Recorded by ${entry.recordedByName}` : null,
          entry.editCount > 0
            ? `edited ${entry.editCount === 1 ? 'once' : `${entry.editCount} times`}`
            : null,
          entry.attachmentCount > 0
            ? `${entry.attachmentCount} ${entry.attachmentCount === 1 ? 'photo' : 'photos'} on the record`
            : null,
        ].filter((one): one is string => one !== null);

        if (notes.length > 0) {
          doc.font(LABEL).fontSize(8).fillColor(MUTED);
          doc.text(notes.join(' · '), { indent: 12 });
        }
        doc.moveDown(0.5);
      }
    }
  }

  summary(doc, report);
  footers(doc, report);

  doc.end();
  return doc as unknown as Readable;
}

function header(doc: PDFKit.PDFDocument, report: DailyReport): void {
  doc.font(HEADING).fontSize(18).fillColor(INK);
  doc.text(report.participant.name);

  doc.font(LABEL).fontSize(9).fillColor(MUTED);
  doc.text(
    [
      `Date of birth ${report.participant.dateOfBirth}`,
      `NDIS ${report.participant.ndisNumber}`,
    ].join('   ·   '),
  );

  doc.moveDown(0.4);
  doc.font(HEADING).fontSize(12).fillColor(INK);
  doc.text(
    report.from === report.to
      ? `Care record for ${report.from}`
      : `Care record for ${report.from} to ${report.to}`,
  );

  doc.font(LABEL).fontSize(8).fillColor(MUTED);
  doc.text(`${report.orgName} · all times ${report.timeZone}`);

  rule(doc);
}

/**
 * Alerts sit at the top, as they do on every screen (doc 01 §3).
 *
 * Severity is stated in words rather than by colour: this gets photocopied in
 * black and white, and an allergy that disappears in a photocopy is the kind
 * of thing this document exists to prevent.
 */
function alerts(doc: PDFKit.PDFDocument, report: DailyReport): void {
  if (report.alerts.length === 0) return;

  doc.font(HEADING).fontSize(11).fillColor(INK).text('Alerts');
  doc.moveDown(0.2);

  for (const alert of report.alerts) {
    doc.font(BODY_BOLD).fontSize(10).fillColor(INK);
    doc.text(`${alert.severity.toUpperCase()} · ${alert.kind}`, { continued: true });
    doc.font(BODY).text(`  ${alert.text}`);
  }

  rule(doc);
}

function dayHeading(doc: PDFKit.PDFDocument, date: string, report: DailyReport): void {
  const weekday = new Intl.DateTimeFormat('en-AU', {
    timeZone: report.timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));

  doc.moveDown(0.4);
  doc.font(HEADING).fontSize(12).fillColor(INK).text(weekday);
  doc.moveDown(0.3);
}

function windowBlock(
  doc: PDFKit.PDFDocument,
  window: DailyWindow,
  time: (iso: string) => string,
): void {
  const span = `${time(window.startsAt)}–${time(window.endsAt)}`;

  doc.font(BODY_BOLD).fontSize(10).fillColor(INK);
  doc.text(`${span}   ${describe(window)}`);

  if (window.values.length > 0) {
    doc.font(BODY).fontSize(10).fillColor(INK);
    for (const value of window.values) {
      doc.text(`${value.label}: ${value.display}`, { indent: 12 });
    }
  }

  if (window.missReason !== null) {
    doc.font(BODY).fontSize(10).fillColor(INK);
    doc.text(`Reason: ${window.missReason.label}`, { indent: 12 });
    if (window.missReason.note) {
      doc.text(window.missReason.note, { indent: 12 });
    }
  }

  if (!window.expected && window.coverageReason !== null) {
    doc.font(BODY_ITALIC).fontSize(9).fillColor(MUTED);
    doc.text(window.coverageReason, { indent: 12 });
  }

  const notes = [
    window.recordedByName ? `Recorded by ${window.recordedByName}` : null,
    window.recordedAt ? `at ${time(window.recordedAt)}` : null,
    window.isLate && window.lateByMinutes !== null ? `late by ${window.lateByMinutes} min` : null,
    window.editCount > 0
      ? `edited ${window.editCount === 1 ? 'once' : `${window.editCount} times`}`
      : null,
  ].filter((one): one is string => one !== null);

  if (notes.length > 0) {
    doc.font(LABEL).fontSize(8).fillColor(MUTED);
    doc.text(notes.join(' · '), { indent: 12 });
  }

  doc.moveDown(0.4);
}

/** Plain words, because this is read on paper by people outside the team. */
function describe(window: DailyWindow): string {
  switch (window.status) {
    case 'complete':
      return window.isLate ? 'Checked, recorded late' : 'Checked';
    case 'partial':
      return 'Partly recorded';
    case 'missed':
      return window.missReason === null ? 'Missed, no reason given' : 'Missed';
    case 'not_expected':
      return 'Not scheduled';
    case 'pending':
      return 'Not yet due';
  }
}

function summary(doc: PDFKit.PDFDocument, report: DailyReport): void {
  ensureRoom(doc, 120);
  rule(doc);

  doc.font(HEADING).fontSize(11).fillColor(INK).text('Summary');
  doc.moveDown(0.3);

  const { total } = report;
  const rows: [string, string][] = [
    ['Checks scheduled', String(total.expected)],
    ['Completed', String(total.completed)],
    ['Completed late', String(total.completedLate)],
    ['Partly recorded', String(total.partial)],
    ['Missed with a reason', String(total.missedWithReason)],
    ['Missed with no reason', String(total.missedWithoutReason)],
    ['Not scheduled', String(total.notExpected)],
  ];

  doc.fontSize(10);
  for (const [label, value] of rows) {
    doc.font(BODY).fillColor(INK).text(label, { continued: true });
    doc.font(BODY_BOLD).text(`   ${value}`);
  }

  doc.moveDown(0.4);
  doc.font(LABEL).fontSize(8).fillColor(MUTED);
  /*
   * Stated in the document rather than left for the reader to work out.
   * Somebody comparing two reports has to know that a period with a lot of
   * family cover is not a period with a lot of missed checks (doc 01 §5.6).
   */
  doc.text(
    'Checks that were not scheduled are listed separately and are not counted as missed. They are shown so the record accounts for the whole period.',
    { width: doc.page.width - MARGIN * 2 },
  );
}

function footers(doc: PDFKit.PDFDocument, report: DailyReport): void {
  const range = doc.bufferedPageRange();
  const generated = new Intl.DateTimeFormat('en-AU', {
    timeZone: report.timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(report.generatedAt));

  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);

    // Who produced this and when, on every page, because pages get separated
    // and a care record with no provenance is not worth much to an auditor.
    doc.font(LABEL).fontSize(8).fillColor(MUTED);
    doc.text(
      `${report.participant.name} · generated ${generated} by ${report.generatedByName} · page ${index + 1} of ${range.count}`,
      MARGIN,
      doc.page.height - MARGIN + 8,
      { width: doc.page.width - MARGIN * 2, align: 'center', lineBreak: false },
    );
  }
}

function rule(doc: PDFKit.PDFDocument): void {
  doc.moveDown(0.5);
  doc
    .strokeColor(RULE)
    .lineWidth(0.5)
    .moveTo(MARGIN, doc.y)
    .lineTo(doc.page.width - MARGIN, doc.y)
    .stroke();
  doc.moveDown(0.5);
}

/** Starts a page rather than splitting a check across two. */
function ensureRoom(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > doc.page.height - MARGIN - 20) doc.addPage();
}
