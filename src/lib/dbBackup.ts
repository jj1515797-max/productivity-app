/** 브라우저에서 Firestore 전체를 읽어 PostgreSQL SQL 덤프를 만든다 (설정 > DB 백업).
 *
 *  · 읽기 전용 — 쓰기/삭제 API 미사용. 운영 데이터는 변하지 않는다.
 *  · 웹 SDK 는 listCollections() 를 못 쓰므로(관리자 전용) 컬렉션 목록은 아래 상수로 관리한다.
 *    새 컬렉션을 코드에 추가하면 여기에도 반드시 추가할 것.
 *  · 서브컬렉션은 collectionGroup 으로 한 번에 모으고, 문서 경로로 테이블을 구분한다.
 *  · SQL 생성은 pgSqlGen.mjs (실제 PostgreSQL 적재로 검증된 모듈) 를 그대로 사용.
 */
import {
  collection, collectionGroup, documentId, getDocs, limit, orderBy, query, startAfter,
} from 'firebase/firestore';
import { db } from '../firebase';
import { createCollector, validateSql } from './pgSqlGen.mjs';
import type { TableStat, SqlValidation } from './pgSqlGen.mjs';

/** 최상위 컬렉션 (코드베이스 기준) — 새 컬렉션을 만들면 여기에도 꼭 넣는다 */
export const ROOT_COLLECTIONS = [
  'productSettings', 'materials', 'recipes', 'subRecipes', 'ambientRecipes',
  'materialPrices', 'materialPricesInventory', 'materialPricesMonthly', 'materialOutflow',
  'materialErpCodes', 'supplierCodes', 'members', 'productivity',
  'monthlyStats', 'monthlyMeta', 'under10Manual', 'visits',
  'attendanceSnapshot', 'attendanceMeta', 'analyticsGraphs',
  'appMeta', 'settings', 'purchaseInbound',
  // 원재료수율·원가 분석용
  'recipesYield', 'subRecipesYield', 'ambientRecipesYield',   // 분석용 레시피 3종
  'materialInput',        // 실제 투입중량 (ERP 수불 불출량)
  'materialCategories',   // 원재료 카테고리
  'productionMonthly',    // 월별 생산수량 (앱 도입 전 달)
  // 현장 기능
  'productBarcodes',      // 제품 바코드 DB
  'coolingCarts', 'coolingConfig',   // 냉각 대차 입출고 · 냉각실 설정
  'containerStock',       // 용기 재고
  'purchaseChat',         // 구매팀 채팅
];
/** 서브컬렉션 ID (collectionGroup 으로 전량 수집 — 같은 이름이면 부모가 달라도 다 모인다:
 *  items = days/{날짜}/items + remix/{날짜}/items, entries = 호기 생산 + waste/{날짜}/entries) */
export const GROUP_COLLECTIONS = [
  'items', 'logistics', 'ambient', 'scoop', 'scoopFlags', 'entries', 'records', 'movements', 'requests',
  'packSorted',   // days/{날짜}/packSorted — 외포장 정렬
  'logs',         // barcodeScans/{날짜}/logs — 바코드 검수 기록
];

export interface BackupProgress {
  phase: string;      // 현재 수집 중인 컬렉션
  docs: number;       // 지금까지 읽은 문서 수
  done: number;       // 완료한 컬렉션 수
  total: number;      // 전체 컬렉션 수
}
export interface BackupResult {
  sql: string;
  stats: TableStat[];
  docCount: number;
  validation: SqlValidation;
  incomplete: string | null;   // 읽기 상한 도달 시 중단 지점
  /** 읽다가 오류가 나 빠진 컬렉션 (권한·색인 등) — 비어 있어야 정상 */
  skipped: string[];
  sizeBytes: number;
}

const PAGE = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runBackup(opts: {
  maxReads?: number;
  paceMs?: number;
  onProgress?: (p: BackupProgress) => void;
  signal?: { aborted: boolean };
} = {}): Promise<BackupResult> {
  const maxReads = opts.maxReads ?? 40000;
  const paceMs = opts.paceMs ?? 60;
  const collector = createCollector();
  let docCount = 0;
  let incomplete: string | null = null;
  const skipped: string[] = [];

  const totalUnits = ROOT_COLLECTIONS.length + GROUP_COLLECTIONS.length;
  let done = 0;
  const report = (phase: string) => opts.onProgress?.({ phase, docs: docCount, done, total: totalUnits });

  /** 커서 페이징으로 전량 수집 (누락 방지) */
  const pull = async (name: string, isGroup: boolean) => {
    const base = isGroup ? collectionGroup(db, name) : collection(db, name);
    let cursor: unknown = null;
    for (;;) {
      if (opts.signal?.aborted) { incomplete = `${name} (사용자 중단)`; return; }
      if (docCount >= maxReads) { incomplete = `${name} (읽기 상한 도달)`; return; }
      const q = cursor
        ? query(base, orderBy(documentId()), startAfter(cursor), limit(PAGE))
        : query(base, orderBy(documentId()), limit(PAGE));
      const snap = await getDocs(q);
      if (snap.empty) return;
      snap.docs.forEach((d) => {
        collector.addDoc(d.ref.path, d.data() as Record<string, unknown>);
        docCount++;
      });
      report(name);
      if (snap.size < PAGE) return;
      cursor = snap.docs[snap.docs.length - 1];
      if (paceMs) await sleep(paceMs);
    }
  };

  for (const name of ROOT_COLLECTIONS) {
    report(name);
    try { await pull(name, false); } catch (e) { console.warn(`[백업] ${name} 건너뜀:`, e); skipped.push(name); }
    done++;
    if (incomplete) break;
  }
  if (!incomplete) {
    for (const name of GROUP_COLLECTIONS) {
      report(name);
      try { await pull(name, true); } catch (e) { console.warn(`[백업] ${name}(그룹) 건너뜀:`, e); skipped.push(`${name}(하위)`); }
      done++;
      if (incomplete) break;
    }
  }

  const stamp = new Date().toISOString();
  const header = (incomplete
    ? `generated: ${stamp}  ⚠ 불완전 (중단: ${incomplete})`
    : `generated: ${stamp}`) + (skipped.length ? `  ⚠ 읽기 실패로 빠짐: ${skipped.join(', ')}` : '');
  const { sql, stats } = collector.build({ header });
  report('완료');
  return {
    sql, stats, docCount,
    validation: validateSql(sql),
    incomplete,
    skipped,
    sizeBytes: new Blob([sql]).size,
  };
}

export function downloadSql(sql: string, filename: string) {
  const url = URL.createObjectURL(new Blob([sql], { type: 'application/sql;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
