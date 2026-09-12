import { describe, expect, it } from 'vitest';
import { CalendarDateError, CalendarDateSchema, createFitnessSettingsInputSchema, epochDay, fitnessDayCount, FitnessSettingsDraftSchema, FitnessSettingsInputSchema, shanghaiDate, validateFitnessSettings } from '../src';

describe('Shanghai calendar-day fitness counting', () => {
  it('keeps an unknown start date null without inventing a time or number', () => {
    expect(FitnessSettingsDraftSchema.parse({}).startDate).toBeNull();
    expect(fitnessDayCount(null, new Date('invalid'))).toBeNull();
    expect(FitnessSettingsInputSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(validateFitnessSettings({ expectedVersion: 0, startDate: null }, Date.UTC(2026, 8, 11)).startDate).toBeNull();
  });

  it('advances at Shanghai midnight, even when less than 24 hours have passed', () => {
    expect(fitnessDayCount('2026-09-11', new Date('2026-09-11T15:59:59.999Z'))).toBe(1);
    expect(fitnessDayCount('2026-09-11', new Date('2026-09-11T16:00:00.000Z'))).toBe(2);
    expect(shanghaiDate(new Date('2026-09-11T16:00:00.000Z'))).toBe('2026-09-12');
  });

  it('uses the same instant irrespective of the caller timezone notation', () => {
    const instants = ['2026-09-11T16:00:00Z', '2026-09-12T00:00:00+08:00', '2026-09-11T09:00:00-07:00'];
    expect(instants.map(value => fitnessDayCount('2026-09-01', new Date(value)))).toEqual([12, 12, 12]);
  });

  it.each([
    ['2024-02-28', '2024-03-01T04:00:00Z', 3],
    ['2025-02-28', '2025-03-01T04:00:00Z', 2],
    ['2000-02-28', '2000-03-01T04:00:00Z', 3],
    ['1900-02-28', '1900-03-01T04:00:00Z', 2],
  ])('counts real leap boundaries for %s', (start, now, expected) => {
    expect(fitnessDayCount(start, new Date(now))).toBe(expected);
  });

  it.each(['2026-02-30', '2025-02-29', '1900-02-29', '2026-13-01', '2026-00-01', '2026-01-00', '2026-9-11', '2026-09-11T00:00:00Z', '0000-01-01', '', ' 2026-09-11'])('rejects malformed or nonexistent date %s instead of normalizing it', value => {
    expect(CalendarDateSchema.safeParse(value).success).toBe(false);
    expect(() => epochDay(value)).toThrow(CalendarDateError);
  });

  it('avoids the JavaScript Date.UTC 0–99 year remapping trap', () => {
    expect(epochDay('1970-01-01')).toBe(0);
    expect(epochDay('1969-12-31')).toBe(-1);
    expect(epochDay('0100-01-01') - epochDay('0099-12-31')).toBe(1);
  });

  it('rejects future dates on the server and exposes the field in the form schema', () => {
    const input = { expectedVersion: 1, startDate: '2026-09-12', timezone: 'Asia/Shanghai' };
    const now = new Date('2026-09-11T15:59:59Z');
    expect(() => validateFitnessSettings(input, now)).toThrowError(expect.objectContaining({ code: 'FUTURE_START_DATE', status: 422 }));
    const result = createFitnessSettingsInputSchema(now).safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]).toMatchObject({ path: ['startDate'], message: 'FUTURE_START_DATE' });
    expect(FitnessSettingsInputSchema.safeParse({ ...input, timezone: 'America/Los_Angeles' }).success).toBe(false);
  });

  it('fails explicitly when a configured date has no trustworthy current instant', () => {
    expect(() => fitnessDayCount('2026-09-11', NaN)).toThrowError(expect.objectContaining({ code: 'INVALID_TIME_SOURCE', status: 503 }));
  });
});
