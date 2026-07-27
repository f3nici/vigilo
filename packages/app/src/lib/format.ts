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

/** Whole years, the way a date of birth is read out. */
export function ageInYears(dateOfBirth: string, now = new Date()): number | null {
  const born = new Date(`${dateOfBirth}T00:00:00`);
  if (Number.isNaN(born.getTime())) return null;

  let age = now.getFullYear() - born.getFullYear();
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) age -= 1;
  return age;
}
