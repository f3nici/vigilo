/**
 * Presentation helpers. Nothing here decides anything, it only decides how to
 * say it, which is why it lives in the app rather than in @vigilo/shared.
 */

/**
 * "3 hours left", "18 minutes left", "expired". Used on temporary grants,
 * where the useful thing is how long is left, not the timestamp it ends at.
 */
export function timeRemaining(iso: string, now = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'expired';

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} left`;

  const days = Math.round(hours / 24);
  return `${days} days left`;
}

const dateFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const dateTimeFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** A plain `YYYY-MM-DD`, shown the way an Australian reads it. */
export function formatDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : dateFormat.format(parsed);
}

export function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : dateTimeFormat.format(parsed);
}

/**
 * The same, in the organisation's timezone.
 *
 * Doc 06 §7: the org timezone is the only one staff ever see. A device set to
 * another zone, or a worker who has travelled, must still read a record at the
 * hour it was written, and the same entry must not say 17:27 on one tab and
 * 19:27 on another.
 */
export function formatDateTimeIn(iso: string, timeZone: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

/** Whole years, the way a date of birth is read out. */
export function ageInYears(dateOfBirth: string, now = new Date()): number | null {
  const born = new Date(`${dateOfBirth}T00:00:00`);
  if (Number.isNaN(born.getTime())) return null;

  let age = now.getFullYear() - born.getFullYear();
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) age -= 1;
  return age;
}

/**
 * The clock time in the org timezone, which is the only timezone staff ever
 * see (doc 06 §7). A phone in another zone still reads the roster's hours.
 */
export function formatTimeIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

export function formatWindowTime(iso: string, timeZone: string): string {
  return formatTimeIn(iso, timeZone);
}

/**
 * A `YYYY-MM-DD` from the calendar, not an instant.
 *
 * Deliberately no `timeZone`: the date has already been resolved in the org
 * zone, and handing a plain date to a formatter with a zone on it means
 * parsing it as UTC midnight and then shifting, which lands on the day before
 * anywhere west of Greenwich. The calendar cell and its heading have to agree.
 */
export function formatDateHeading(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(year!, month! - 1, day!));
}

export function formatWindowRange(startsAt: string, endsAt: string, timeZone: string): string {
  return `${formatWindowTime(startsAt, timeZone)}–${formatWindowTime(endsAt, timeZone)}`;
}

export function formatDayHeading(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso));
}

/** "closes in 34 min", "closed 2 hours ago". The useful half of a timestamp. */
export function closesIn(endsAt: string, now = new Date()): string {
  const ms = new Date(endsAt).getTime() - now.getTime();
  const minutes = Math.round(Math.abs(ms) / 60_000);

  if (ms > 0) {
    if (minutes < 60) return `closes in ${minutes} min`;
    const hours = Math.round(minutes / 60);
    return `closes in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }

  if (minutes < 60) return `closed ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `closed ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return `closed ${Math.round(hours / 24)} days ago`;
}
