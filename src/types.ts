export interface Item {
  id: string;
  code: string;
  name: string;
  orderQty: number;
  coupang: number;
  marketKurly: number;
  totalQty: number;
  actualProduction: number;
  coolingEndTime?: string;
  date: string;
}

export interface MachineEntry {
  id: string;
  code: string;
  actualProduction?: number;
  additionalProduction?: number;
  workTime?: string;
  additionalWorkTime?: string;
  machine: '1호기' | '2호기' | '3호기';
  date: string;
}

export interface ExternalPackEntry {
  code: string;
  name: string;
  orderQty: number;
  shippedQty: number;
  actualProduction: number;
  shortage: number;
  additionalProduction: number;
  machine: '1호기' | '2호기' | '3호기';
  date: string;
}

export interface AmbientEntry {
  productName: string;
  category: string;
  qty: number;
  date: string;
}

export interface Member {
  id: string;
  name: string;
  dept?: string;
  active?: boolean;
  createdAt?: string;
  /** 휴직 시작일 (YYYY-MM-DD). leaveTo 가 null/없음이면 무기한 */
  leaveFrom?: string;
  /** 휴직 종료일 (YYYY-MM-DD). 이 날까지 휴직(inclusive) */
  leaveTo?: string;
}

export type AttendanceStatus = '출근' | '연차' | '반차' | '결혼반차' | '병가' | '경조사' | '휴무';

export const ATTENDANCE_STATUSES: AttendanceStatus[] = [
  '출근', '연차', '반차', '결혼반차', '병가', '경조사', '휴무',
];

export interface AttendanceRecord {
  memberId: string;
  name: string;
  status: AttendanceStatus;
  date: string;
  note?: string;
}
