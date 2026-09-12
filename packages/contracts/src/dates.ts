import { z } from 'zod';
import { FITNESS_TIMEZONE } from './limits';

export type CalendarErrorCode = 'INVALID_DATE' | 'FUTURE_START_DATE' | 'INVALID_TIME_SOURCE';
export class CalendarDateError extends Error {
  readonly status: number;
  constructor(readonly code: CalendarErrorCode, message: string) {
    super(message); this.name = 'CalendarDateError'; this.status = code === 'INVALID_TIME_SOURCE' ? 503 : 422;
  }
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

export const CalendarDateSchema = z.string().refine(isCalendarDate, '需要真实的 YYYY-MM-DD 公历日期');

/** Proleptic Gregorian ordinal relative to 1970-01-01, not elapsed local milliseconds. */
export function epochDay(date: string): number {
  if (!isCalendarDate(date)) throw new CalendarDateError('INVALID_DATE', '日期格式或公历日期无效');
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const previousYear = year - 1;
  const beforeMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return 365 * previousYear + Math.floor(previousYear / 4) - Math.floor(previousYear / 100)
    + Math.floor(previousYear / 400) + beforeMonth[month - 1]!
    + (month > 2 && isLeapYear(year) ? 1 : 0) + day - 1 - 719162;
}

const shanghaiFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: FITNESS_TIMEZONE, calendar: 'gregory', numberingSystem: 'latn',
  year: 'numeric', month: '2-digit', day: '2-digit', era: 'short',
});

/** Caller supplies a trusted instant. No device-local timezone or implicit Date.now fallback. */
export function shanghaiDate(now: Date | number): string {
  const time = now instanceof Date ? now.getTime() : now;
  if (typeof time !== 'number' || !Number.isFinite(time)) throw new CalendarDateError('INVALID_TIME_SOURCE', '当前时间源不可用');
  try {
    const parts = shanghaiFormatter.formatToParts(time);
    const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
    if (part('era') !== 'AD') throw new Error('out of calendar range');
    const result = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
    if (!isCalendarDate(result)) throw new Error('out of calendar range');
    return result;
  } catch { throw new CalendarDateError('INVALID_TIME_SOURCE', '当前时间源不可用'); }
}

export function fitnessDayCount(startDate: string | null, now: Date | number): number | null {
  if (startDate === null) return null;
  const start = epochDay(startDate);
  const today = epochDay(shanghaiDate(now));
  if (start > today) throw new CalendarDateError('FUTURE_START_DATE', '开始日期不能晚于上海当前日期');
  return today - start + 1;
}

export function fitnessDayCountFromDate(startDate: string | null, asOfDate: string): number | null {
  if (startDate === null) return null;
  const start = epochDay(startDate);
  const today = epochDay(asOfDate);
  if (start > today) throw new CalendarDateError('FUTURE_START_DATE', '开始日期不能晚于当前确认日期');
  return today - start + 1;
}
