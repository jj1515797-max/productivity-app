/** 지난달 품목별 생산수량 캐시 (prodMonthCache/{YYYY-MM}) — 원가 등급 비중 분석용.
 *  한 달 생산수량을 다시 세려면 Firestore 읽기가 약 1만 건이라, 한 번 센 지난달은 서버에 저장해 둔다.
 *  · 원재료분석을 돌릴 때 이미 읽은 달은 그 데이터로 바로 저장 (추가 읽기 없음)
 *  · 없는 달은 화면에서 「계산」을 눌러 그 달만 센다 (잔여량이 있는 날은 items + 잔여량, 없는 날만 호기 실적 — 원재료분석과 같은 규칙) */
import { collection, collectionGroup, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { db } from '../firebase';
import { isDaysDoc, isMachineEntryDoc } from './appDocs';
import { canonicalShort } from './codeUtil';
import { computeColdProductionByCode } from './materialUsage';
import { PM_COL } from './productionMonthly';
import type { ProductionMonthlyDoc } from './productionMonthly';
import { normalizeMaterialName } from './wasteCompute';
import { PROD_CACHE_COL } from './costGrade';
import type { ProdMonth } from './costGrade';
import type { AmbientEntry, Item, MachineEntry } from '../types';

/** 이미 읽어 둔 한 달 데이터 → 품목별 생산수량 */
export function toProdMonth(
  month: string,
  raw: { entries: MachineEntry[]; items: Item[]; ambient: AmbientEntry[]; logistics: Record<string, number>; logisticsByCode?: Record<string, Record<string, number>> },
): ProdMonth {
  const cold: Record<string, number> = {};
  computeColdProductionByCode(raw.entries, raw.items, raw.logistics, raw.logisticsByCode).forEach((q, k) => {
    if (q > 0) cold[k] = (cold[k] || 0) + q;
  });
  const ambient: Record<string, number> = {};
  const names: Record<string, string> = {};
  raw.ambient.forEach((a) => {
    const nm = (a.productName || '').trim();
    if (!nm) return;
    const k = normalizeMaterialName(nm);
    ambient[k] = (ambient[k] || 0) + (a.qty || 0);
    names[k] = nm;
  });
  const total = Object.values(cold).reduce((s, v) => s + v, 0) + Object.values(ambient).reduce((s, v) => s + v, 0);
  return { month, cold, ambient, names, total, source: 'app', computedAt: new Date().toISOString() };
}

export const isClosedMonth = (m: string) => {
  const d = new Date();
  const cur = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return m < cur;
};

/** 지난달만 저장 (이번 달은 아직 바뀐다) */
export async function saveProdMonth(p: ProdMonth) {
  if (!isClosedMonth(p.month) || p.total <= 0) return;
  await setDoc(doc(db, PROD_CACHE_COL, p.month), p);
}

/** 저장된 달 읽기 (없으면 null). 앱 데이터가 없는 달(도입 전)은 설정 › 월별 생산수량 문서를 쓴다 */
export async function readProdMonth(m: string): Promise<ProdMonth | null> {
  const s = await getDoc(doc(db, PROD_CACHE_COL, m)).catch(() => null);
  if (s?.exists()) return s.data() as ProdMonth;
  return null;
}
export async function readPmMonth(m: string): Promise<ProdMonth | null> {
  const s = await getDoc(doc(db, PM_COL, m)).catch(() => null);
  if (!s?.exists()) return null;
  const d = s.data() as ProductionMonthlyDoc;
  return { month: m, cold: d.cold || {}, ambient: d.ambient || {}, names: d.names || {}, total: d.total || 0, source: 'pm', computedAt: d.updatedAt || '' };
}

/** 한 달 생산수량을 새로 센다 (읽기 약 1만 건) — 잔여량이 없는 날만 호기 실적을 읽어 읽기를 줄인다 */
export async function computeProdMonth(m: string, onProgress?: (s: string) => void): Promise<ProdMonth> {
  const start = `${m}-01`, end = `${m}-31`;
  onProgress?.(`${m} 생산 계획·실온 읽는 중…`);
  const [its, amb] = await Promise.all([
    getDocs(query(collectionGroup(db, 'items'), where('date', '>=', start), where('date', '<=', end))),
    getDocs(query(collectionGroup(db, 'ambient'), where('date', '>=', start), where('date', '<=', end))),
  ]);
  const items = its.docs.filter(isDaysDoc).map((d) => d.data() as Item);
  const ambient = amb.docs.filter(isDaysDoc).map((d) => d.data() as AmbientEntry);
  const [yy, mm] = m.split('-').map(Number);
  const last = new Date(yy, mm, 0).getDate();
  const dates = Array.from({ length: last }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`);
  const logistics: Record<string, number> = {};
  const logisticsByCode: Record<string, Record<string, number>> = {};
  const noLog: string[] = [];
  for (let i = 0; i < dates.length; i += 8) {
    onProgress?.(`${m} 잔여량 읽는 중… (${Math.min(i + 8, dates.length)}/${dates.length}일)`);
    const chunk = dates.slice(i, i + 8);
    const snaps = await Promise.all(chunk.map((d) => getDocs(collection(db, 'days', d, 'logistics'))));
    snaps.forEach((s, j) => {
      const d = chunk[j];
      if (s.empty) { noLog.push(d); return; }
      let sum = 0; const pc: Record<string, number> = {};
      s.forEach((x) => {
        const v = x.data() as { code?: string; qty?: number };
        const q = v.qty || 0; sum += q;
        const k = canonicalShort(v.code || x.id);
        if (k) pc[k] = (pc[k] || 0) + q;
      });
      logistics[d] = sum; logisticsByCode[d] = pc;
    });
  }
  // 잔여량이 없는 날 중 생산 계획(items)이나 실온이 있는 날만 호기 실적을 읽는다
  const busy = new Set([...items.map((x) => x.date), ...ambient.map((x) => x.date)]);
  const entries: MachineEntry[] = [];
  const need = noLog.filter((d) => busy.has(d));
  for (const d of need) {
    onProgress?.(`${m} ${d.slice(8)}일 호기 실적 읽는 중…`);
    const es = await getDocs(query(collectionGroup(db, 'entries'), where('date', '==', d)));
    es.docs.filter(isMachineEntryDoc).forEach((x) => entries.push(x.data() as MachineEntry));
  }
  const p = toProdMonth(m, { entries, items, ambient, logistics, logisticsByCode });
  if (p.total <= 0) {
    const pm = await readPmMonth(m);
    if (pm) return pm;
  }
  return p;
}
