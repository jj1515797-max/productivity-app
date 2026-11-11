/** 원재료분석 › 원가 등급 비중 분석 (윤기성 실장 11/6 회의 지시)
 *
 *  매달 바뀌는 기준(전월 개당 원재료비 865원·894원 등)으로 고원가·저원가를 나누면 3개월 이상 흐름을 비교할 수 없다.
 *  → 품목별 개당 원재료비로 고·중·저원가 등급을 **한 번 정해 고정**하고 (신제품만 같은 기준으로 추가),
 *    월별 등급 비중(생산수량 기준)과 원재료비율의 흐름 · 상관계수를 본다.
 *
 *  Firestore
 *   · costGrades/current   = { refMonth, recipeSrc, low, high, grades: { 키: { g, c, n, k } }, createdAt, updatedAt }
 *       키 = 냉장 단축코드(canonicalShort) / 실온 'amb:' + 정규화 제품명,  c = 개당 원재료비(원), g = '고'|'중'|'저'
 *   · prodMonthCache/{YYYY-MM} = { month, cold: {단축코드: 수량}, ambient: {정규화제품명: 수량}, names, total, source, computedAt }
 *       지난달 품목별 생산수량 — 원재료분석을 돌릴 때 이미 읽은 데이터로 채운다 (한 달 계산에 Firestore 읽기 약 1만 건이라 재사용)
 */
import { canonicalShort } from './codeUtil';
import { CODE_KEY_PREFIX, monthPriceKey, normalizeCode, normalizeMaterialName } from './wasteCompute';
import type { AmbientRecipe, Recipe } from './wasteCompute';

export const GRADE_DOC = { col: 'costGrades', id: 'current' } as const;
export const PROD_CACHE_COL = 'prodMonthCache';

export type Grade = '고' | '중' | '저';
export const GRADES: Grade[] = ['저', '중', '고'];
export interface GradeEntry { g: Grade; c: number; n: string; k: 'cold' | 'ambient' }
export interface GradeDoc {
  refMonth: string;
  recipeSrc: string;
  low: number;    // c < low → 저
  high: number;   // c ≥ high → 고
  grades: Record<string, GradeEntry>;
  createdAt: string;
  updatedAt: string;
}
export interface ProdMonth {
  month: string;
  cold: Record<string, number>;
  ambient: Record<string, number>;
  names?: Record<string, string>;
  total: number;
  source: 'app' | 'pm';
  computedAt: string;
}

export const ambKey = (name: string) => 'amb:' + normalizeMaterialName(name);
export const gradeOf = (c: number, low: number, high: number): Grade => (c >= high ? '고' : c < low ? '저' : '중');

/** 단가 찾기 — 기준월에 없으면 그 이전 가장 가까운 달, 그것도 없으면 이후 가장 가까운 달 */
export function makePriceLookup(priceMap: Map<string, number>, refMonth: string) {
  const months = [...new Set([...priceMap.keys()].map((k) => k.slice(0, 7)))].sort();
  const order = [refMonth, ...months.filter((m) => m < refMonth).reverse(), ...months.filter((m) => m > refMonth)];
  return (name: string, code?: string): number | null => {
    for (const m of order) {
      if (code) {
        const v = priceMap.get(monthPriceKey(m, CODE_KEY_PREFIX + normalizeCode(code)));
        if (v !== undefined) return v;
      }
      const v2 = priceMap.get(monthPriceKey(m, normalizeMaterialName(name)));
      if (v2 !== undefined) return v2;
    }
    return null;
  };
}

/** 레시피 전체의 개당 원재료비 (원). 생산 여부와 상관없이 모든 레시피를 계산한다 */
export function unitCosts(
  recipeMap: Map<string, Recipe>,
  ambientMap: Map<string, AmbientRecipe>,
  price: (name: string, code?: string) => number | null,
): Map<string, { c: number; n: string; k: 'cold' | 'ambient'; missing: number }> {
  const out = new Map<string, { c: number; n: string; k: 'cold' | 'ambient'; missing: number }>();
  recipeMap.forEach((r) => {
    const key = canonicalShort(r.code || '');
    if (!key || out.has(key)) return;
    let c = 0, missing = 0;
    (r.ingredients || []).forEach((i) => {
      const g = Number(i.gPerPiece) || 0;
      if (g <= 0) return;
      const p = price(i.name, i.code);
      if (p === null) { missing++; return; }
      c += g * p;
    });
    out.set(key, { c, n: r.name || r.code, k: 'cold', missing });
  });
  ambientMap.forEach((r) => {
    const key = ambKey(r.name);
    if (out.has(key)) return;
    const bp = Number(r.batchPieces) || 1;
    let c = 0, missing = 0;
    (r.ingredients || []).forEach((i) => {
      const g = (Number(i.gPerBatch) || 0) / bp;
      if (g <= 0) return;
      const p = price(i.name, i.code);
      if (p === null) { missing++; return; }
      c += g * p;
    });
    out.set(key, { c, n: r.name, k: 'ambient', missing });
  });
  return out;
}

/** 생산수량 가중 3분위 기준선 — 고·중·저가 생산량의 1/3씩이 되도록 (10원 단위 반올림) */
export function tertileCuts(costs: Map<string, { c: number }>, qty: Map<string, number>): { low: number; high: number } {
  const items = [...qty.entries()]
    .map(([k, q]) => ({ c: costs.get(k)?.c ?? NaN, q }))
    .filter((x) => Number.isFinite(x.c) && x.c > 0 && x.q > 0)
    .sort((a, b) => a.c - b.c);
  const tot = items.reduce((s, x) => s + x.q, 0);
  if (!tot) {
    const all = [...costs.values()].map((x) => x.c).filter((c) => c > 0).sort((a, b) => a - b);
    const at = (f: number) => all[Math.min(all.length - 1, Math.floor(all.length * f))] || 0;
    return { low: Math.round(at(1 / 3) / 10) * 10, high: Math.round(at(2 / 3) / 10) * 10 };
  }
  let acc = 0, low = 0, high = 0;
  for (const x of items) {
    acc += x.q;
    if (!low && acc >= tot / 3) low = x.c;
    if (!high && acc >= (tot * 2) / 3) { high = x.c; break; }
  }
  return { low: Math.round(low / 10) * 10, high: Math.round(high / 10) * 10 };
}

/** 한 달 생산수량 → 키별 수량 (냉장 단축코드 / 실온 amb:정규화명) */
export function prodQtyMap(p: ProdMonth): Map<string, number> {
  const m = new Map<string, number>();
  Object.entries(p.cold || {}).forEach(([k, q]) => { const kk = canonicalShort(k) || k; m.set(kk, (m.get(kk) || 0) + (Number(q) || 0)); });
  Object.entries(p.ambient || {}).forEach(([k, q]) => { const kk = 'amb:' + normalizeMaterialName(k); m.set(kk, (m.get(kk) || 0) + (Number(q) || 0)); });
  return m;
}

export interface MonthGradeStat {
  month: string;
  total: number;           // 전체 생산수량
  graded: number;          // 등급이 있는 품목 생산수량
  share: Record<Grade, number>;   // 0~1 (등급 있는 수량 기준)
  mixIndex: number;        // 고정 개당 원재료비로 본 평균 (원/개) — 구성만의 효과
  newCount: number;        // 고정 등급에 없어 같은 기준선으로 임시 분류한 품목 수
}

/** 월 등급 비중. 고정 등급에 없는 품목은 같은 기준선으로 임시 분류(신규), 레시피가 없으면 제외 */
export function monthGradeStat(
  p: ProdMonth, doc: GradeDoc,
  fallback: Map<string, { c: number }>,
): MonthGradeStat {
  const qty = prodQtyMap(p);
  const share: Record<Grade, number> = { 저: 0, 중: 0, 고: 0 };
  let total = 0, graded = 0, costSum = 0, newCount = 0;
  qty.forEach((q, k) => {
    if (q <= 0) return;
    total += q;
    let e: { g: Grade; c: number } | null = doc.grades[k] || null;
    if (!e) {
      const f = fallback.get(k);
      if (f && f.c > 0) { e = { g: gradeOf(f.c, doc.low, doc.high), c: f.c }; newCount++; }
    }
    if (!e) return;
    graded += q; share[e.g] += q; costSum += q * e.c;
  });
  GRADES.forEach((g) => { share[g] = graded ? share[g] / graded : 0; });
  return { month: p.month, total, graded, share, mixIndex: graded ? costSum / graded : 0, newCount };
}

/** 피어슨 상관계수 (n<3 이면 null) */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
export const corrWord = (r: number | null) => (r === null ? '판단 불가' : Math.abs(r) >= 0.7 ? '강함' : Math.abs(r) >= 0.4 ? '보통' : '약함');

/** ERP 실투입 × 그달 재고평가 단가 = 그달 원재료비 (원재료분석 원가율 분해와 같은 금액) */
export function monthMaterialCost(
  inputs: Record<string, number>, names: Record<string, string>,
  price: (name: string, code?: string) => number | null,
): { cost: number; missing: number } {
  let cost = 0, missing = 0;
  Object.entries(inputs || {}).forEach(([k, g]) => {
    const grams = Number(g) || 0;
    if (grams <= 0) return;
    const code = k.startsWith(CODE_KEY_PREFIX) ? k.slice(CODE_KEY_PREFIX.length) : undefined;
    const p = price(names?.[k] || k, code);
    if (p === null) { missing++; return; }
    cost += grams * p;
  });
  return { cost, missing };
}
