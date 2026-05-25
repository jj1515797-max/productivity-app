export interface Item {
  id: string;
  code: string;
  name: string;
  orderQty: number;
  coupang: number;
  marketKurly: number;
  sample?: number;
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

export type AttendanceStatus = '출근' | '연차' | '반차' | '반반차' | '결혼/생일 반차' | '병가' | '경조사' | '휴무';

export const ATTENDANCE_STATUSES: AttendanceStatus[] = [
  '출근', '연차', '반차', '반반차', '결혼/생일 반차', '병가', '경조사', '휴무',
];

/** 연차 환산 일수: 연차=1, 반차=0.5, 반반차=0.25, 결혼반차=0.5, 병가=1, 경조사=1 */
export const LEAVE_DAY_WEIGHT: Record<AttendanceStatus, number> = {
  출근: 0, 휴무: 0,
  연차: 1, 반차: 0.5, 반반차: 0.25,
  '결혼/생일 반차': 0.5, 병가: 1, 경조사: 1,
};

export interface AttendanceRecord {
  memberId: string;
  name: string;
  /** 단일 상태 (구버전 호환) */
  status?: AttendanceStatus;
  /** 복합 상태 (반차+반반차 등) — 우선 사용. 비어있으면 출근 처리 */
  statuses?: AttendanceStatus[];
  date: string;
  note?: string;
}

export interface ProductSetting {
  code: string;
  type?: '냄비' | '바트' | null;
  name?: string;
  packWeight?: number;   // 포장중량 (g) — 냉장 기준
}

export interface Material {
  id: string;
  name: string;
  category?: string;
  specs?: string[];   // ['3mm', '5mm', '7mm']
  unit?: string;      // 'kg' 등
}

export const WAREHOUSES = [1, 2, 3, 4, 5, 6, 7] as const;

export interface InventoryMovement {
  type: '입고' | '출고';
  warehouse: number;          // 1-7
  materialName: string;
  spec?: string;
  qty: number;
  unit?: string;
  /** 입고일자 (입고 시 사용) */
  incomingDate?: string;
  /** 소비기한 (출고 시 사용) */
  expiryDate?: string;
  /** @deprecated UI 제거됨, 구버전 호환용 */
  counterpart?: string;
  /** @deprecated UI 제거됨, 구버전 호환용 */
  note?: string;
  done?: boolean;
  date: string;
  createdAt?: string;
}

export interface InventoryRequest {
  text: string;
  done?: boolean;
  date: string;
  createdAt?: string;
}

export interface RemixEntry {
  code: string;
  count: number;     // 재배합 건수 (보통 1, 합산용)
  qty?: number;      // 재배합 수량 (셀 표시값)
  date: string;
}

export interface GraphPoint {
  month: string;     // 'YYYY-MM'
  value: number;
}

export interface GraphData {
  points?: GraphPoint[];
}
