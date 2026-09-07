/** 용기분석 공용 로더 — 한 달치 생산량을 용기 구분별로 집계한다.
 *  용기분석 표(품목별)와 재고조사 검증(이론사용량)이 같은 숫자를 쓰도록 여기 한 곳에서만 계산한다.
 */
import { collection, collectionGroup, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { canonicalShort, compareCode } from './codeUtil';
import { computeMonthlyProduction } from './monthlyProduction';
import { todayKey } from './dateUtil';
import type { AmbientEntry, Item, MachineEntry } from '../types';

export interface ContainerRow {
  code: string; name: string; qty: number;
  size: 'small' | 'large' | 'unknown';
  erpCode?: string;
}
export interface ContainerMonth {
  rows: ContainerRow[];
  ambiguous: string[];
  monthlyTotal: number;      // 월별현황 공식으로 재계산한 냉장 총량 (교차검증용)
  small: number; large: number; unknown: number; ambient: number;
  /** 호기별 냉장 생산량 — 필름처럼 호기로 갈리는 자재용 */
  m1: number; m2: number; m3: number;
  /** 호기를 알 수 없어 배분하지 못한 냉장 수량 */
  mUnassigned: number;
}

export const isPastMonth = (m: string) => m < todayKey().slice(0, 7);

export async function loadContainerMonth(month: string): Promise<ContainerMonth> {
  const start = `${month}-01`, end = `${month}-31`;
  const [entSnap, itemSnap, ambSnap, prodSnap] = await Promise.all([
    getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', start), where('date', '<=', end))),
    getDocs(query(collectionGroup(db, 'items'), where('date', '>=', start), where('date', '<=', end))),
    getDocs(query(collectionGroup(db, 'ambient'), where('date', '>=', start), where('date', '<=', end))),
    getDocs(collection(db, 'productSettings')),
  ]);

  const [yy, mm] = month.split('-').map(Number);
  const lastDay = new Date(yy, mm, 0).getDate();
  const dates = Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const logSnaps = await Promise.all(dates.map((d) => getDocs(collection(db, 'days', d, 'logistics'))));
  const logisticsByDay: Record<string, number> = {};
  const logisticsByDayCode: Record<string, Record<string, number>> = {};
  logSnaps.forEach((s, i) => {
    if (s.empty) return;
    let sum = 0;
    const perCode: Record<string, number> = {};
    s.forEach((d) => {
      const data = d.data() as { code?: string; qty?: number };
      const q = data.qty || 0;
      sum += q;
      const k = canonicalShort(data.code || d.id);
      if (k) perCode[k] = (perCode[k] || 0) + q;
    });
    logisticsByDay[dates[i]] = sum;
    logisticsByDayCode[dates[i]] = perCode;
  });

  // days/ 하위만 (waste/entries · remix/items 섞이지 않게 경로로 거름)
  const entries = entSnap.docs
    .filter((d) => d.ref.path.startsWith('days/') && d.ref.path.includes('/machines/'))
    .map((d) => d.data() as MachineEntry)
    .filter((e) => !!e.machine);
  const items = itemSnap.docs.filter((d) => d.ref.path.startsWith('days/')).map((d) => d.data() as Item);
  const ambient = ambSnap.docs.filter((d) => d.ref.path.startsWith('days/')).map((d) => d.data() as AmbientEntry);

  // 제품 DB → 단축코드별 용기 구분 (ERP 코드 끝 '-51' = 작은용기)
  const sizeByShort = new Map<string, 'small' | 'large'>();
  const erpByShort = new Map<string, string>();
  const nameByShort = new Map<string, string>();
  const conflict = new Set<string>();
  prodSnap.forEach((d) => {
    const data = d.data() as { code?: string; name?: string };
    const erp = (data.code || d.id || '').trim();
    if (!erp) return;
    const short = canonicalShort(erp);
    const size: 'small' | 'large' = /-51$/.test(erp) ? 'small' : 'large';
    const prev = sizeByShort.get(short);
    if (prev && prev !== size) conflict.add(short);
    sizeByShort.set(short, size);
    erpByShort.set(short, erp);
    if (data.name) nameByShort.set(short, data.name);
  });

  const prod = computeMonthlyProduction(entries, items, [], logisticsByDay, logisticsByDayCode);
  const rows: ContainerRow[] = [];
  prod.coldByCode.forEach((qty, short) => {
    if (Math.round(qty) === 0) return;
    rows.push({
      code: short,
      name: nameByShort.get(short) || prod.stages.flatMap((s) => s.items).find((i) => i.code === short)?.name || short,
      qty,                                   // 원값 유지 (합계는 원값으로, 표시만 반올림)
      size: sizeByShort.get(short) || 'unknown',
      erpCode: erpByShort.get(short),
    });
  });
  rows.sort((a, b) => b.qty - a.qty || compareCode(a.code, b.code));

  // 교차검증: 월별현황(AnalyticsMonthly)과 동일한 일자 단위 공식으로 냉장 총량 재계산
  //   물류 있는 날 = 목표합 + 잔여합 / 없는 날 = entries 합
  const rawColdByDay: Record<string, number> = {};
  entries.forEach((e) => {
    rawColdByDay[e.date] = (rawColdByDay[e.date] || 0) + (e.actualProduction || 0) + (e.additionalProduction || 0);
  });
  const totalQtyByDay: Record<string, number> = {};
  items.forEach((it) => { totalQtyByDay[it.date] = (totalQtyByDay[it.date] || 0) + (it.totalQty || 0); });
  let monthlyTotal = 0;
  new Set([...Object.keys(rawColdByDay), ...Object.keys(logisticsByDay), ...Object.keys(totalQtyByDay)])
    .forEach((d) => {
      monthlyTotal += logisticsByDay[d] !== undefined
        ? (totalQtyByDay[d] || 0) + logisticsByDay[d]
        : (rawColdByDay[d] || 0);
    });

  const raw = { small: 0, large: 0, unknown: 0 };
  rows.forEach((r) => { raw[r.size] += r.qty; });

  return {
    rows, ambiguous: [...conflict], monthlyTotal,
    small: Math.round(raw.small), large: Math.round(raw.large), unknown: Math.round(raw.unknown),
    ambient: Math.round(ambient.reduce((s, a) => s + (a.qty || 0), 0)),
    m1: Math.round(prod.coldByMachine['1호기'] || 0),
    m2: Math.round(prod.coldByMachine['2호기'] || 0),
    m3: Math.round(prod.coldByMachine['3호기'] || 0),
    mUnassigned: Math.round(prod.coldMachineUnassigned),
  };
}
