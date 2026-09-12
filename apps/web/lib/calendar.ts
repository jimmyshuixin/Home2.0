import { fitnessDayCountFromDate } from '@xvyin/contracts'
export function fitnessDay(startDate: string | null, todayDate: string): number | null {
  try { return fitnessDayCountFromDate(startDate, todayDate) } catch { return null }
}
