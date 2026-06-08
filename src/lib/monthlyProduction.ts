/** 월별 생산량 분해 — 냉장(단계·품목별) + 실온(제품별)
 *  냉장 일별 합산 규칙은 월별현황 페이지(AnalyticsMonthly)와 동일:
 *    - 잔여량 수정(logistics) 있는 날: items.totalQty + logistics  → 코드별 분배(totalQty 비율)
 *    - 없는 날: entries(actual+additional) 그대로
 */
import type { AmbientEntry, Item, MachineEntry } from '../types';
import { canonicalShort } from './codeUtil';
import { normalizeMaterialName } from './wasteCompute';

export const STAGE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'F500', 'G', 'H', 'I'] as const;
export const STAGE_COLOR: Record<string, string> = {
  A: 'bg-blue-500', B: 'bg-green-500', C: 'bg-orange-500', D: 'bg-purple-500',
  E: 'bg-pink-500', F: 'bg-teal-500', F500: 'bg-cyan-500',
  G: 'bg-amber-500', H: 'bg-rose-500', I: 'bg-indigo-500',
};

export function getStage(code: string): string | null {
  if (!code) return null;
  const m = code.match(/^([A-Za-z])(\d+)/);
  if (!m) {
    const c = code.charAt(0).toUpperCase();
    return (STAGE_LETTERS as readonly string[]).includes(c) ? c : null;
  }
  const letter = m[1].toUpperCase();
  const num = parseInt(m[2], 10);
  if (letter === 'F') return num >= 500 ? 'F500' : 'F';
  return letter;
}

export interface ColdItem {
  code: string;
  name: string;
  qty: number;          // 월합 (logistics-aware)
  stage: string | null;
}
export interface StageGroup {
  letter: string;
  total: number;
  count: number;
  items: ColdItem[];
}
export interface AmbientItem {
  productName: string;
  qty: number;
  count: number;        // 생산 일수/횟수
}
export interface MonthlyProduction {
  coldTotal: number;
  ambientTotal: number;
  total: number;
  stages: StageGroup[];
  ambient: AmbientItem[];
  maxStage: number;
  /** 코드 → qty (월합). 원재료 검색 시 단계별 사용량 분배에 사용 */
  coldByCode: Map<string, number>;
}

export function computeMonthlyProduction(
  entries: MachineEntry[],
  items: Item[],
  ambient: AmbientEntry[],
  logisticsByDay: Record<string, number>,
): MonthlyProduction {
  // 코드는 canonicalShort 로 통일 (대문자/소문자/하이픈/ERP풀코드 → A01 형태)
  // 4월처럼 잔여수정일은 items코드(I07), 비수정일은 entries코드(i07)로 들어와도 같은 키로 묶임
  const codeQty = new Map<string, number>();
  const codeName = new Map<string, string>();  // 표시명: items 의 진짜 제품명만 기록

  // 일별 인덱싱
  const itemsByDay: Record<string, { code: string; totalQty: number }[]> = {};
  items.forEach((it) => {
    if (!it.code) return;
    const k = canonicalShort(it.code);
    if (!itemsByDay[it.date]) itemsByDay[it.date] = [];
    itemsByDay[it.date].push({ code: k, totalQty: it.totalQty || 0 });
    if (it.name && it.name !== it.code) codeName.set(k, it.name);
  });
  const entriesByDay: Record<string, { code: string; qty: number }[]> = {};
  entries.forEach((e) => {
    if (!e.code) return;
    const q = (e.actualProduction || 0) + (e.additionalProduction || 0);
    if (q <= 0) return;
    if (!entriesByDay[e.date]) entriesByDay[e.date] = [];
    entriesByDay[e.date].push({ code: canonicalShort(e.code), qty: q });
  });

  const allDays = new Set<string>([
    ...Object.keys(itemsByDay),
    ...Object.keys(entriesByDay),
    ...Object.keys(logisticsByDay),
  ]);
  allDays.forEach((d) => {
    if (logisticsByDay[d] !== undefined) {
      const dayItems = itemsByDay[d] || [];
      const plannedTot = dayItems.reduce((s, it) => s + it.totalQty, 0);
      const adj = logisticsByDay[d];
      dayItems.forEach((it) => {
        const share = plannedTot > 0 ? it.totalQty / plannedTot : 0;
        const add = it.totalQty + adj * share;
        codeQty.set(it.code, (codeQty.get(it.code) || 0) + add);
      });
    } else {
      const dayEntries = entriesByDay[d] || [];
      dayEntries.forEach((e) => {
        codeQty.set(e.code, (codeQty.get(e.code) || 0) + e.qty);
        if (!codeName.has(e.code)) codeName.set(e.code, e.code);
      });
    }
  });

  // 단계별 분류
  const stageMap = new Map<string, ColdItem[]>();
  STAGE_LETTERS.forEach((L) => stageMap.set(L, []));
  codeQty.forEach((qty, code) => {
    const stage = getStage(code);
    const item: ColdItem = { code, name: codeName.get(code) || code, qty: Math.round(qty), stage };
    if (stage && stageMap.has(stage)) stageMap.get(stage)!.push(item);
  });
  const stages: StageGroup[] = STAGE_LETTERS.map((letter) => {
    const list = stageMap.get(letter) || [];
    list.sort((a, b) => b.qty - a.qty);
    const total = list.reduce((s, x) => s + x.qty, 0);
    return { letter, total, count: list.length, items: list };
  });
  const maxStage = Math.max(1, ...stages.map((s) => s.total));

  // 실온 — productName 별 합산
  const ambMap = new Map<string, AmbientItem>();
  ambient.forEach((a) => {
    const name = a.productName || '';
    if (!name) return;
    const prev = ambMap.get(name);
    if (prev) { prev.qty += a.qty || 0; prev.count += 1; }
    else ambMap.set(name, { productName: name, qty: a.qty || 0, count: 1 });
  });
  const ambientList = Array.from(ambMap.values()).sort((a, b) => b.qty - a.qty);

  const coldTotalRaw = Array.from(codeQty.values()).reduce((s, v) => s + v, 0);
  const coldTotal = Math.round(coldTotalRaw);
  const ambientTotal = ambientList.reduce((s, a) => s + a.qty, 0);

  // 정수 코드별 Map (검색 시 단계 분배용)
  const coldByCodeRounded = new Map<string, number>();
  codeQty.forEach((v, k) => coldByCodeRounded.set(k, Math.round(v)));

  return {
    coldTotal,
    ambientTotal,
    total: coldTotal + ambientTotal,
    stages,
    ambient: ambientList,
    maxStage,
    coldByCode: coldByCodeRounded,
  };
}

/** 특정 제품만 남겨 분해 결과를 재집계 (원재료 검색 필터용)
 *  coldCodes: 허용 냉장 제품코드(canonicalShort) / ambientNames: 허용 실온 제품명(normalizeMaterialName)
 */
export function filterProduction(
  prod: MonthlyProduction,
  coldCodes: Set<string>,
  ambientNames: Set<string>,
): MonthlyProduction {
  const stages: StageGroup[] = prod.stages.map((s) => {
    const items = s.items.filter((it) => coldCodes.has(it.code));
    const total = items.reduce((a, x) => a + x.qty, 0);
    return { letter: s.letter, items, total, count: items.length };
  });
  const maxStage = Math.max(1, ...stages.map((s) => s.total));
  const ambient = prod.ambient.filter((a) => ambientNames.has(normalizeMaterialName(a.productName)));
  const coldByCode = new Map<string, number>();
  prod.coldByCode.forEach((v, k) => { if (coldCodes.has(k)) coldByCode.set(k, v); });
  const coldTotal = stages.reduce((a, s) => a + s.total, 0);
  const ambientTotal = ambient.reduce((a, x) => a + x.qty, 0);
  return { coldTotal, ambientTotal, total: coldTotal + ambientTotal, stages, ambient, maxStage, coldByCode };
}
