/** pgSqlGen.mjs 타입 정의 (브라우저 백업 기능 + Node 덤프 스크립트 공용) */

export interface TableStat {
  table: string;
  rows: number;
  cols: number;
  inserts: number;
  pk: 'doc_id' | 'doc_path';
  types: Record<string, string>;
}

export interface SqlValidation {
  nCreate: number;
  nDrop: number;
  nInsert: number;
  nIndex: number;
  parenBalanced: boolean;
  quotesBalanced: boolean;
  wrapped: boolean;
  open: number;
  close: number;
}

export interface Collector {
  /** 문서 1건 추가. docPath 는 'days/2026-07-01/items/A01' 같은 전체 경로 */
  addDoc(docPath: string, data: Record<string, unknown> | undefined): void;
  build(opts?: { header?: string }): { sql: string; stats: TableStat[]; docCount: number };
  tables: Map<string, unknown>;
}

export function createCollector(opts?: {
  configCollections?: Set<string>;
  batchSize?: number;
}): Collector;

export function validateSql(sql: string): SqlValidation;
export function tableName(docPath: string): string;
