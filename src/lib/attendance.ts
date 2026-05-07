import type { AttendanceRecord, AttendanceStatus, Member } from '../types';
import { LEAVE_DAY_WEIGHT } from '../types';

/** 휴직 여부: leaveFrom <= date <= (leaveTo || ∞) */
export function isOnLeave(m: Member, date: string): boolean {
  if (!m.leaveFrom) return false;
  if (m.leaveFrom > date) return false;
  if (m.leaveTo && m.leaveTo < date) return false;
  return true;
}

export type AttendanceSummary = {
  /** 총원 (전체 active 멤버) */
  totalN: number;
  /** 휴직 인원 */
  onLeaveN: number;
  /** 휴무 인원 */
  restN: number;
  /** 출근인원 (= 총원 - 휴직 - 휴무) - 생산성 분모 */
  workforceN: number;
  /** 연차 환산 일수 (연차=1, 반차=0.5, 반반차=0.25 ...) */
  leaveDays: number;
};

export function summarizeAttendance(
  members: Member[],
  records: Record<string, AttendanceRecord>,
  date: string,
): AttendanceSummary {
  let totalN = 0, onLeaveN = 0, restN = 0;
  let leaveDays = 0;
  members.forEach((m) => {
    totalN++;
    if (isOnLeave(m, date)) { onLeaveN++; return; }
    const status = (records[m.id]?.status as AttendanceStatus) || '출근';
    if (status === '휴무') { restN++; return; }
    leaveDays += LEAVE_DAY_WEIGHT[status] || 0;
  });
  const workforceN = totalN - onLeaveN - restN;
  return { totalN, onLeaveN, restN, workforceN, leaveDays };
}
