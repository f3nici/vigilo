import PDFDocument from 'pdfkit';
import type { Readable } from 'node:stream';
import {
  dayIsEmpty,
  describeIncidentStatus,
  describeMyCheck,
  describeSeverity,
  emptyDayMessage,
  formatTimeOfDay,
  localDateOf,
  myDayTimeline,
  outstandingActions,
  utcToZoned,
  type DailyDose,
  type DailyReport,
  type DailyUnscheduledCheck,
  type DailyWindow,
  type Incident,
  type MyRecords,
} from '@vigilo/shared';

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

    if (
      day.windows.length === 0 &&
      day.unscheduled.length === 0 &&
      day.diary.length === 0 &&
      day.medications.length === 0
    ) {
      doc.font(BODY_ITALIC).fontSize(10).fillColor(MUTED);
      doc.text('Nothing was scheduled and nothing was recorded.');
      doc.moveDown(0.8);
      continue;
    }

    for (const window of day.windows) {
      ensureRoom(doc, 60);
      windowBlock(doc, window, time);
    }

    /*
     * Checks recorded on demand (D89), under their own heading. Kept apart from
     * the scheduled ones because the summary below counts one and not the
     * other, and a reader comparing the two has to be able to see which is
     * which.
     */
    if (day.unscheduled.length > 0) {
      ensureRoom(doc, 50);
      doc.moveDown(0.3);
      doc.font(HEADING).fontSize(10).fillColor(INK).text('Recorded when needed');
      doc.moveDown(0.2);

      for (const check of day.unscheduled) {
        ensureRoom(doc, 44);
        unscheduledBlock(doc, check, time);
      }
    }

    if (day.medications.length > 0) {
      ensureRoom(doc, 50);
      doc.moveDown(0.3);
      doc.font(HEADING).fontSize(10).fillColor(INK).text('Medication');
      doc.moveDown(0.2);

      for (const dose of day.medications) {
        ensureRoom(doc, 44);
        doseBlock(doc, dose, time);
      }
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

/**
 * A check somebody recorded on demand (D89).
 *
 * No span, because nothing asked for it at a particular time, and no status,
 * because there was nothing to be on time for. The time it was recorded is the
 * only time there is.
 */
function unscheduledBlock(
  doc: PDFKit.PDFDocument,
  check: DailyUnscheduledCheck,
  time: (iso: string) => string,
): void {
  doc.font(BODY_BOLD).fontSize(10).fillColor(INK);
  doc.text(`${time(check.recordedAt)}   ${check.templateName}`);

  if (check.values.length > 0) {
    doc.font(BODY).fontSize(10).fillColor(INK);
    for (const value of check.values) {
      doc.text(`${value.label}: ${value.display}`, { indent: 12 });
    }
  }

  const notes = [
    check.recordedByName ? `Recorded by ${check.recordedByName}` : null,
    check.editCount > 0
      ? `edited ${check.editCount === 1 ? 'once' : `${check.editCount} times`}`
      : null,
  ].filter((one): one is string => one !== null);

  if (notes.length > 0) {
    doc.font(LABEL).fontSize(8).fillColor(MUTED);
    doc.text(notes.join(' · '), { indent: 12 });
  }

  doc.moveDown(0.5);
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

/**
 * One medication line (doc 01 §8.1).
 *
 * The status is written in words rather than shown by colour, for the same
 * reason the check blocks are: this gets photocopied, faxed and printed in
 * black and white, and a colour that carries the only meaning does not survive
 * any of that.
 */
function doseBlock(doc: PDFKit.PDFDocument, dose: DailyDose, time: (iso: string) => string): void {
  const when = dose.dueAt === null ? time(dose.administeredAt!) : time(dose.dueAt);
  const label = dose.isPrn ? `${when}  As needed` : when;

  doc.font(BODY_BOLD).fontSize(10).fillColor(INK);
  doc.text(`${label}   ${dose.medicationName} ${dose.dose}   ${dose.statusLabel}`);

  doc.font(BODY).fontSize(10).fillColor(INK);
  if (dose.reason !== null) doc.text(`Given because: ${dose.reason}`, { indent: 12 });
  if (dose.note !== null) doc.text(dose.note, { indent: 12 });
  if (dose.outcome !== null) doc.text(`Outcome: ${dose.outcome}`, { indent: 12 });

  if (!dose.expected && dose.coverageReason !== null) {
    doc.font(BODY_ITALIC).fontSize(9).fillColor(MUTED);
    doc.text(dose.coverageReason, { indent: 12 });
  }

  const notes = [
    dose.recordedByName ? `Signed off by ${dose.recordedByName}` : null,
    dose.administeredAt !== null && dose.dueAt !== null
      ? `given ${time(dose.administeredAt)}`
      : null,
    dose.isLate ? 'late' : null,
    dose.witnessedByName ? `witnessed by ${dose.witnessedByName}` : null,
  ].filter((one): one is string => one !== null);

  if (notes.length > 0) {
    doc.font(LABEL).fontSize(8).fillColor(MUTED);
    doc.text(notes.join(' · '), { indent: 12 });
  }

  doc.moveDown(0.4);
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

  // Outside the figures above, and said so. Nothing asked for these, so they
  // are neither a check done on time nor one that was missed (D89).
  if (total.unscheduled > 0) {
    rows.push(['Recorded when needed, not scheduled', String(total.unscheduled)]);
  }

  const { doseTotal } = report;
  if (doseTotal.expected > 0 || doseTotal.notExpected > 0) {
    rows.push(
      ['Doses due', String(doseTotal.expected)],
      ['Given', String(doseTotal.given)],
      ['Given late', String(doseTotal.givenLate)],
      ['Refused', String(doseTotal.refused)],
      ['Withheld', String(doseTotal.withheld)],
      ['Self-administered', String(doseTotal.selfAdministered)],
      ['Signed off as not required', String(doseTotal.notRequired)],
      ['Missed', String(doseTotal.missed)],
      ['Not scheduled for the team', String(doseTotal.notExpected)],
    );
  }

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

/* --------------------------------------------------------------- incidents */

export type IncidentPdfContext = {
  participantName: string;
  orgName: string;
  timeZone: string;
  generatedAt: string;
  generatedByName: string;
};

/**
 * One incident as a PDF (doc 01 §7.3).
 *
 * The same shape as the daily report: serif body, headings in words rather than
 * colour, and provenance on every page. This one is more likely than any other
 * document here to be read by somebody outside the organisation, so it states
 * the timing gap between the event and its discovery plainly, and it says how
 * many follow-up actions were still outstanding rather than leaving a reader to
 * count them.
 */
export function renderIncident(incident: Incident, context: IncidentPdfContext): Readable {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: `Incident, ${context.participantName}, ${incident.occurredAt.slice(0, 10)}`,
      Author: context.orgName,
      Subject: 'Incident record',
      CreationDate: new Date(context.generatedAt),
    },
  });

  const when = (iso: string) =>
    new Intl.DateTimeFormat('en-AU', {
      timeZone: context.timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));

  doc.font(HEADING).fontSize(18).fillColor(INK).text('Incident record');
  doc.moveDown(0.2);
  doc.font(LABEL).fontSize(10).fillColor(MUTED);
  doc.text(`${context.participantName} · ${context.orgName}`);
  doc.text(`All times ${context.timeZone}`);
  rule(doc);

  const gapMinutes = Math.round(
    (Date.parse(incident.discoveredAt) - Date.parse(incident.occurredAt)) / 60_000,
  );
  const gap =
    gapMinutes < 60 ? `${gapMinutes} minutes later` : `${Math.round(gapMinutes / 60)} hours later`;

  const facts: [string, string][] = [
    ['Status', describeIncidentStatus(incident.status)],
    ['Severity', describeSeverity(incident.severity)],
    ['Occurred', when(incident.occurredAt)],
    ['Discovered', `${when(incident.discoveredAt)} (${gap})`],
    ['Reported by', incident.reportedByName ?? 'Not recorded'],
    [
      'Family notified',
      incident.familyNotifiedAt === null ? 'Not recorded' : when(incident.familyNotifiedAt),
    ],
  ];

  doc.fontSize(10);
  for (const [label, value] of facts) {
    doc.font(BODY).fillColor(INK).text(`${label}: `, { continued: true });
    doc.font(BODY_BOLD).text(value);
  }

  section(doc, 'What happened', incident.detail);
  section(doc, 'What was done straight away', incident.immediateAction);
  if (incident.involved !== null) section(doc, 'Who was involved', incident.involved);
  if (incident.injuries !== null) section(doc, 'Injuries', incident.injuries);

  if (incident.actions.length > 0) {
    ensureRoom(doc, 80);
    rule(doc);
    doc.font(HEADING).fontSize(11).fillColor(INK).text('Follow-up');
    doc.moveDown(0.3);

    for (const action of incident.actions) {
      ensureRoom(doc, 44);
      doc.font(BODY_BOLD).fontSize(10).fillColor(INK).text(action.action);

      const notes = [
        action.assignedToName ? `assigned to ${action.assignedToName}` : 'unassigned',
        action.dueAt ? `due ${when(action.dueAt)}` : null,
        action.completedAt
          ? `done ${when(action.completedAt)}${action.completedByName ? ` by ${action.completedByName}` : ''}`
          : 'not done',
      ].filter((one): one is string => one !== null);

      doc.font(LABEL).fontSize(8).fillColor(MUTED).text(notes.join(' · '), { indent: 12 });
      if (action.note !== null) {
        doc.font(BODY).fontSize(10).fillColor(INK).text(action.note, { indent: 12 });
      }
      doc.moveDown(0.3);
    }
  }

  if (incident.status === 'closed') {
    ensureRoom(doc, 80);
    rule(doc);
    doc.font(HEADING).fontSize(11).fillColor(INK).text('Closure');
    doc.moveDown(0.3);
    doc.font(BODY).fontSize(10).fillColor(INK);
    doc.text(
      `Closed ${incident.closedAt === null ? '' : when(incident.closedAt)}${incident.closedByName ? ` by ${incident.closedByName}` : ''}.`,
    );
    if (incident.closureNotes !== null) {
      doc.moveDown(0.2);
      doc.text(incident.closureNotes);
    }

    const still = outstandingActions(incident.actions);
    if (still > 0) {
      doc.moveDown(0.3);
      doc.font(BODY_BOLD).fontSize(10).fillColor(INK);
      // Stated rather than left to be counted. Closing a review does not
      // finish the work, and a reader deserves to be told.
      doc.text(
        `${still} follow-up ${still === 1 ? 'action was' : 'actions were'} still outstanding when this was closed.`,
      );
    }
  }

  incidentFooters(doc, incident, context);

  doc.end();
  return doc as unknown as Readable;
}

function section(doc: PDFKit.PDFDocument, title: string, body: string): void {
  ensureRoom(doc, 70);
  doc.moveDown(0.5);
  doc.font(HEADING).fontSize(11).fillColor(INK).text(title);
  doc.moveDown(0.2);
  doc.font(BODY).fontSize(10).fillColor(INK).text(body);
}

function incidentFooters(
  doc: PDFKit.PDFDocument,
  incident: Incident,
  context: IncidentPdfContext,
): void {
  const range = doc.bufferedPageRange();
  const generated = new Intl.DateTimeFormat('en-AU', {
    timeZone: context.timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(context.generatedAt));

  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    doc.font(LABEL).fontSize(8).fillColor(MUTED);
    doc.text(
      `Incident ${incident.id.slice(0, 8)} · ${context.participantName} · generated ${generated} by ${context.generatedByName} · page ${index + 1} of ${range.count}`,
      MARGIN,
      doc.page.height - MARGIN + 8,
      { width: doc.page.width - MARGIN * 2, align: 'center', lineBreak: false },
    );
  }
}

/* ------------------------------------------------------------ self-access */

/**
 * The participant's own record as a PDF (doc 06 §6, doc 07 §5).
 *
 * Deliberately a different document from `renderDailyReport`, not that one
 * with pieces removed. The staff report accounts for every window in the day
 * including the ones nobody did, because that is what an auditor is reading it
 * for. This one is a person's record of their own days, so it carries what was
 * written down and nothing about whether the team kept to the schedule.
 *
 * It is also the artefact doc 07 §5 names as how the right of access is
 * served, which is why it is a document somebody can keep rather than a screen
 * they have to stay logged in to read.
 */
export function renderMyRecords(records: MyRecords): Readable {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: `My record ${records.from}${records.to === records.from ? '' : ` to ${records.to}`}`,
      Author: records.orgName,
      Subject: 'My care record',
      CreationDate: new Date(records.generatedAt),
    },
  });

  const time = (iso: string) =>
    formatTimeOfDay(utcToZoned(new Date(iso), records.timeZone).minutes);
  const today = localDateOf(new Date(records.generatedAt), records.timeZone);

  // Larger than the staff report throughout. This is read by the person it is
  // about, sometimes with a support worker, sometimes at arm's length.
  doc.font(HEADING).fontSize(20).fillColor(INK).text('My record');
  doc.moveDown(0.3);
  doc.font(BODY).fontSize(12).fillColor(INK).text(records.participantName);
  doc.font(LABEL).fontSize(10).fillColor(MUTED).text(records.orgName);
  rule(doc);
  doc.moveDown(0.6);

  for (const day of records.days) {
    ensureRoom(doc, 90);
    doc.moveDown(0.4);
    doc.font(HEADING).fontSize(14).fillColor(INK).text(longDate(day.date, records.timeZone));
    doc.moveDown(0.3);

    if (dayIsEmpty(day)) {
      doc.font(BODY_ITALIC).fontSize(11).fillColor(MUTED);
      doc.text(emptyDayMessage(day.date, today));
      doc.moveDown(0.6);
      continue;
    }

    // One list, oldest first, from the same function the screen orders by.
    for (const item of myDayTimeline(day)) {
      ensureRoom(doc, 60);
      doc.font(BODY_BOLD).fontSize(11).fillColor(INK);

      if (item.kind === 'check') {
        doc.text(`${time(item.at)}  ${describeMyCheck(item.check)}`);

        doc.font(BODY).fontSize(11).fillColor(INK);
        for (const value of item.check.values) {
          doc.text(`${value.label}: ${value.display}`, { indent: 14 });
        }
        doc.moveDown(0.5);
        continue;
      }

      const entry = item.entry;
      doc.text(`${time(item.at)}  ${entry.categoryLabel}`);

      doc.font(BODY).fontSize(11).fillColor(INK);
      doc.text(entry.body, { indent: 14 });

      const notes = [
        entry.recordedByName === null ? null : `Written by ${entry.recordedByName}`,
        entry.edited ? 'edited since it was written' : null,
        // Named rather than printed. A photo does not survive a photocopier,
        // and the person can open it on the screen this file came from.
        entry.photos.length > 0
          ? `${entry.photos.length} ${entry.photos.length === 1 ? 'photo is' : 'photos are'} on this entry`
          : null,
      ].filter((one): one is string => one !== null);

      if (notes.length > 0) {
        doc.font(LABEL).fontSize(9).fillColor(MUTED);
        doc.text(notes.join(' · '), { indent: 14 });
      }
      doc.moveDown(0.5);
    }
  }

  myRecordsFooters(doc, records);

  doc.end();
  return doc as unknown as Readable;
}

function longDate(date: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
}

function myRecordsFooters(doc: PDFKit.PDFDocument, records: MyRecords): void {
  const range = doc.bufferedPageRange();
  const generated = new Intl.DateTimeFormat('en-AU', {
    timeZone: records.timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(records.generatedAt));

  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    doc.font(LABEL).fontSize(8).fillColor(MUTED);
    // No "generated by": nobody generated this for them, they asked for it.
    doc.text(
      `${records.participantName} · ${generated} · page ${index + 1} of ${range.count}`,
      MARGIN,
      doc.page.height - MARGIN + 8,
      { width: doc.page.width - MARGIN * 2, align: 'center', lineBreak: false },
    );
  }
}
