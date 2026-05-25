import type { AttendanceRecord, AttendanceStatus, Member } from '../types';
import { LEAVE_DAY_WEIGHT } from '../types';

/** 휴직 여부: leaveFrom <= date <= (leaveTo || ∞) */
export function isOnLeave(m: Member, date: string): boolean {
  if (!m.leaveFrom) return false;
  if (m.leaveFrom > date) return false;
  if (m.leaveTo && m.leaveTo < date) return false;
  return true;
}

/** 레코드에서 statuses 배열로 정규화 (구/신 버전 모두 지원) */
export function getStatuses(record?: AttendanceRecord): AttendanceStatus[] {
  if (!record) return [];
  if (record.statuses && record.statuses.length > 0) return record.statuses;
  if (record.status) return [record.status];
  return [];
}

/** 표시용 상태: 명시 기록이 없으면 일요일=휴무, 평일=출근(빈 배열) 으로 처리 */
export function effectiveStatuses(record: AttendanceRecord | undefined, date: string): AttendanceStatus[] {
  const s = getStatuses(record);
  if (s.length > 0) return s;
  const [y, mo, d] = date.split('-').map(Number);
  const dow = new Date(y, mo - 1, d).getDay();
  if (dow === 0) return ['휴무'];
  return [];
}

/** 복합 휴가 라벨: 출근=없음, 단일=그대로, 다중=원치(+)로 결합 */
export function formatStatusLabel(statuses: AttendanceStatus[]): string {
  if (statuses.length === 0) return '출근';
  if (statuses.length === 1) return statuses[0];
  return statuses.join('+');
}

/** 복합 휴가의 일 환산 합 (출근/휴무 제외) */
export function leaveDaysFromStatuses(statuses: AttendanceStatus[]): number {
  let sum = 0;
  statuses.forEach((s) => {
    if (s === '출근' || s === '휴무') return;
    sum += LEAVE_DAY_WEIGHT[s] || 0;
  });
  return sum;
}

export type AttendanceSummary = {
  /** 총원 (전체 active 멤버) */
  totalN: number;
  /** 휴직 인원 */
  onLeaveN: number;
  /** 휴무 인원 (statuses 에 '휴무' 포함) */
  restN: number;
  /** 출근인원 (= 총원 - 휴직 - 휴무) - 생산성 분모 */
  workforceN: number;
  /** 연차 환산 일수 (연차=1, 반차=0.5, 반반차=0.25 ...) — 다중 상태는 합산 */
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
    const statuses = effectiveStatuses(records[m.id], date);
    if (statuses.includes('휴무')) { restN++; }
    leaveDays += leaveDaysFromStatuses(statuses);
  });
  const workforceN = totalN - onLeaveN - restN;
  return { totalN, onLeaveN, restN, workforceN, leaveDays };
}
