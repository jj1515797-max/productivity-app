import type { AttendanceRecord, AttendanceStatus, Member } from '../types';
import { LEAVE_DAY_WEIGHT } from '../types';

/** 휴직 여부: leaveFrom <= date <= (leaveTo || ∞) */
export function isOnLeave(m: Member, date: string): boolean {
  if (!m.leaveFrom) return false;
  if (m.leaveFrom > date) return false;
  if (m.leaveTo && m.leaveTo < date) return false;
  return true;
}

/** 휴직 소급 수정 계획 — 지난 날짜 스냅샷의 이 사람 항목을 고칠지, 인원 문서도 바꿀지 정한다 (순수 함수, 테스트용으로 분리).
 *
 *  '같은 휴직' 은 시작일이 똑같은지가 아니라 **기간이 겹치는지**로 본다 (시작일을 한 번 고친 뒤에도 같은 휴직으로 인식되게).
 *  · base: 지금 고치는 휴직 (화면에 보이는 그 휴직)
 *  · base 와 안 겹치는 새 기간이면 '새 휴직' — 기존 휴직 기간에 속한 날은 건드리지 않는다 (앞이든 뒤든)
 *  · 그날이 편집 범위와 안 겹치는 '다른 휴직' 기간이면 보호
 *  · 휴직 여부가 바뀌는 날 + 같은 휴직인데 기간 표기만 옛날 것인 날을 고친다 (카드에 옛 기간이 남지 않게)
 *  · 인원 문서(지금 휴직 정보)는 그 사람의 현재 휴직과 관계있을 때만 바꾼다
 *    — 지난 날짜의 다른(옛) 휴직을 고치거나, 현재 휴직보다 앞선 옛 휴직을 끼워 넣을 때는 지난 기록만 고친다 */
type Period = { leaveFrom?: string | null; leaveTo?: string | null };
const hasP = (p?: Period | null): p is Period => !!(p && p.leaveFrom);
export const periodsOverlap = (a?: Period | null, b?: Period | null) =>
  hasP(a) && hasP(b) && a.leaveFrom! <= (b.leaveTo || '9999-12-31') && b.leaveFrom! <= (a.leaveTo || '9999-12-31');

export function leaveRetroPlan(
  base: Period, leaveFrom: string | null, leaveTo: string | null, live?: Period | null,
): { scanFrom: string | null; writeMembers: boolean; newPeriod: boolean; shouldPatch: (cur: Period, date: string) => boolean } {
  const N: Period = { leaveFrom: leaveFrom || null, leaveTo: leaveTo || null };
  const newPeriod = hasP(base) && hasP(N) && !periodsOverlap(base, N);
  const scope = (newPeriod ? [N] : [base, N]).filter(hasP);
  const starts = scope.map((x) => x.leaveFrom!).sort();
  const asM = (p: Period) => ({ leaveFrom: p.leaveFrom || undefined, leaveTo: p.leaveTo || undefined }) as Member;
  const writeMembers = !hasP(live)
    || periodsOverlap(live, N)
    || (periodsOverlap(live, base) && !(newPeriod && !!N.leaveTo && N.leaveTo < live!.leaveFrom!));
  return {
    scanFrom: starts[0] || null,
    writeMembers,
    newPeriod,
    shouldPatch: (cur, date) => {
      const curP: Period = { leaveFrom: cur.leaveFrom || null, leaveTo: cur.leaveTo || null };
      const curOn = isOnLeave(asM(curP), date);
      const nextOn = isOnLeave(asM(N), date);
      const same = scope.some((x) => periodsOverlap(curP, x));
      if (curOn && !same) return false;                       // 다른 휴직 기간인 날 — 보호
      if (curOn !== nextOn) return true;                      // 휴직 여부가 바뀌는 날
      // 같은 휴직으로 휴직 중인 날인데 기간 표기만 옛것 — 카드에 보이는 기간도 맞춘다 (휴직 아닌 날은 표기가 안 보이므로 안 씀)
      return curOn && same && (curP.leaveFrom !== N.leaveFrom || (curP.leaveTo || null) !== (N.leaveTo || null));
    },
  };
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
  /** 순수 출근(어떤 휴가도 없음) — 반차/반반차도 빠짐 */
  presentN: number;
  /** 연차 환산 일수 (연차=1, 반차=0.5, 반반차=0.25 ...) — 다중 상태는 합산 */
  leaveDays: number;
};

export function summarizeAttendance(
  members: Member[],
  records: Record<string, AttendanceRecord>,
  date: string,
): AttendanceSummary {
  let totalN = 0, onLeaveN = 0, restN = 0, presentN = 0;
  let leaveDays = 0;
  members.forEach((m) => {
    totalN++;
    if (isOnLeave(m, date)) { onLeaveN++; return; }
    const statuses = effectiveStatuses(records[m.id], date);
    if (statuses.length === 0 || (statuses.length === 1 && statuses[0] === '출근')) {
      presentN++;
      return;
    }
    if (statuses.includes('휴무')) { restN++; }
    leaveDays += leaveDaysFromStatuses(statuses);
  });
  const workforceN = totalN - onLeaveN - restN;
  return { totalN, onLeaveN, restN, workforceN, presentN, leaveDays };
}
