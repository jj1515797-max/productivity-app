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
  actualProduction: number;
  additionalProduction: number;
  workTime: string;
  additionalWorkTime?: string;
  isLast: boolean;
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
