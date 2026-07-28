/**
 * Local time in the org timezone (doc 03 §1, doc 01 §11).
 *
 * Every window boundary is a wall-clock time an admin typed, and every stored
 * timestamp is UTC. Something has to convert between them, and it has to be the
 * same something on the server and on the device, so it lives here.
 *
 * Built on `Intl`, which both Node and every supported browser already carry.
 * A date library would be a dependency in the one package that is meant to have
 * none, to do a job the platform already does correctly, including the DST
 * rules that change every few years.
 */

/** Minutes since local midnight. May exceed 1440, meaning the following day. */
export type MinutesOfDay = number;

export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

/** `HH:MM`, plus `24:00` for a range that runs to the end of the day. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

export function isTimeOfDay(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export function parseTimeOfDay(value: string): MinutesOfDay {
  if (!isTimeOfDay(value)) {
    throw new RangeError(`Not a time of day: ${value}`);
  }
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** The inverse. 1440 formats as `24:00`, which is how a full day is written. */
export function formatTimeOfDay(minutes: MinutesOfDay): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const value = minutes !== 0 && wrapped === 0 ? MINUTES_PER_DAY : wrapped;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** `YYYY-MM-DD`. The only date format on the wire and in this package. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Calendar arithmetic only. Adding days never touches a clock or an offset. */
export function addDays(isoDate: string, days: number): string {
  const base = Date.parse(`${isoDate}T00:00:00Z`);
  return new Date(base + days * MINUTES_PER_DAY * 60_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / (MINUTES_PER_DAY * 60_000));
}

/** 0 is Sunday, matching `Date.getUTCDay` and the `weekday` columns in doc 03. */
export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

export type ZonedParts = {
  date: string;
  minutes: MinutesOfDay;
  weekday: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Throws on an unknown IANA name rather than silently falling back to UTC. */
export function assertTimeZone(timeZone: string): void {
  partsFormatter(timeZone).format(new Date());
}

/** The wall clock an instant reads as, in this zone. */
export function utcToZoned(instant: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = part.value;
  }

  const date = `${lookup.year}-${lookup.month}-${lookup.day}`;
  return {
    date,
    minutes: Number(lookup.hour) * 60 + Number(lookup.minute),
    weekday: weekdayOf(date),
  };
}

/** This zone's offset from UTC at a given instant, in milliseconds. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const { date, minutes } = utcToZoned(instant, timeZone);
  const seconds = Number(
    partsFormatter(timeZone)
      .formatToParts(instant)
      .find((part) => part.type === 'second')?.value ?? '0',
  );
  const asUtc = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000 + seconds * 1000;
  // Instants carry no sub-second detail here, so rounding to the second is safe
  // and keeps a zone with a historic 45-second offset from drifting.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * A wall-clock time in this zone, as an instant.
 *
 * `minutes` may run past 1440, which is how an overnight segment expresses
 * "01:00 the next morning" without the caller doing date arithmetic first.
 *
 * Two passes, because the offset that applies is the one at the answer rather
 * than the one at the guess, and those differ either side of a DST change.
 * A local time that does not exist (the hour skipped each October in Melbourne)
 * resolves to the instant the clock jumps to, which is the only sensible answer
 * and is why the materialiser never produces a window nobody could work.
 */
export function zonedTimeToUtc(isoDate: string, minutes: MinutesOfDay, timeZone: string): Date {
  const wallClock = Date.parse(`${isoDate}T00:00:00Z`) + minutes * 60_000;
  const firstGuess = wallClock - offsetMsAt(new Date(wallClock), timeZone);
  return new Date(wallClock - offsetMsAt(new Date(firstGuess), timeZone));
}

/** The local date an instant falls on, which is what "today" means to staff. */
export function localDateOf(instant: Date, timeZone: string): string {
  return utcToZoned(instant, timeZone).date;
}
