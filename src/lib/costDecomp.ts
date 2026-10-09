/** 원재료비 · 원재료비율 증감 분해 — 원재료분석 화면과 수식 엑셀(원가율분해 시트)이 같은 규칙을 쓴다.
 *
 *  원재료마다  E·F = A·B월 표준소요(레시피 × 생산),  G·H = A·B월 실투입,  M·N = A·B월 적용 단가(원/g)
 *  k = B월 생산량 ÷ A월 생산량,  A월 수율 = E ÷ G
 *    ① 물량      (k − 1) × A월 원재료비
 *    ② 단가      k × Σ G × (N − M)
 *    ③ 제품구성  Σ G × (F/E − k) × N           … A월 수율이 정상인 원재료
 *    ④ 수율      Σ (H − F × G/E) × N           … 두 달 수율이 정상인 원재료
 *    ⑤ 기타      나머지 (A월 정상·B월 이상이면 수율 몫만, 그 외는 (H − k × G) × N)
 *  연동 원재료비 = k × Σ G × N  (A월 쓰임새를 B월 생산량·B월 단가로 환산) → B월 실제와의 차이 = ③ + ④ + ⑤
 *
 *  ⚠ materialDecompSheets.ts 의 시트 수식과 한 줄씩 같아야 한다. 바꾸면 둘 다 바꾸고 검산이 0 인지 확인할 것.
 */
import type { AmbientRecipe, Recipe } from './wasteCompute';
import { CODE_KEY_PREFIX, normalizeCode, normalizeMaterialName } from './wasteCompute';
import { canonicalShort } from './codeUtil';
import type { MonthlyProduction } from './monthlyProduction';
import type { UsageRow } from './materialUsage';
import { remapInputs } from './materialInputMap';

export const DECOMP_LO = 0.2;
export const DECOMP_HI = 2.0;
/** 수율이 이만큼(비율) 넘게 바뀐 원재료는 레시피 변경·입력 오류일 수 있어 따로 표시 */
export const DECOMP_SWING = 0.3;

export type DecompStatus =
  | 'ok' | 'bUnused' | 'aUnused' | 'noUse' | 'outside'
  | 'bNoAct' | 'bNoStd' | 'bOut' | 'aNoAct' | 'aNoStd' | 'aOut' | 'excl';

/** 상태 문구 — 엑셀 시트와 같은 문자열 */
export function statusLabel(st: DecompStatus, monthA: string, monthB: string): string {
  switch (st) {
    case 'ok': return '정상';
    case 'bUnused': return `${monthB}엔 안 씀`;
    case 'aUnused': return `${monthA}엔 안 씀`;
    case 'noUse': return '사용 없음';
    case 'outside': return '레시피 밖';
    case 'bNoAct': return `${monthB} 실투입 없음`;
    case 'bNoStd': return `${monthB} 표준 없음`;
    case 'bOut': return `${monthB} 수율 범위 밖`;
    case 'aNoAct': return `${monthA} 실투입 없음`;
    case 'aNoStd': return `${monthA} 표준 없음`;
    case 'aOut': return `${monthA} 수율 범위 밖`;
    default: return '제외(정제수 등)';
  }
}

export interface DecompMatIn {
  key: string;
  code: string;
  name: string;
  category: string;
  excluded: boolean;
  stdA: number; stdB: number;   // g
  actA: number; actB: number;   // g
  pA: number; pB: number;       // 적용 단가 원/g (A 없으면 B, B 없으면 가까운 달)
  pASub: boolean;               // A 단가를 다른 달 단가로 채웠나
  pBSub: boolean;
}
export interface DecompMatRow extends DecompMatIn {
  status: DecompStatus;
  yA: number | null;
  yB: number | null;
  dY: number | null;            // 수율 증감 (비율, 0.05 = 5%p)
  costA: number; costB: number;
  vol: number; price: number; mix: number; yld: number; other: number;
  /** 표준 1g 당 원가 (A월 수율 반영, B단가) — 제품별 구성효과에 쓴다 */
  factor: number;
  /** 수율로 더(+)/덜(−) 쓴 양 kg (정상일 때만) */
  kgDelta: number | null;
  swing: boolean;
}
export interface DecompProdIn {
  key: string;
  name: string;
  kind: 'cold' | 'ambient';
  qtyA: number; qtyB: number;
  ings: { key: string; g: number }[];
  hasRecipe: boolean;
}
export interface DecompProdRow extends DecompProdIn {
  expectedB: number;   // 생산량 비율대로였다면
  delta: number;       // 그보다 더/덜
  costPerEa: number;   // 개당 원재료비 (수율·B단가 반영)
  vsBase: number;      // A월 평균 대비
  effect: number;      // 구성효과 (원)
}
export interface DecompTotals {
  QA: number; QB: number; k: number;
  MA: number; MB: number;
  /** A월 실투입 × B월 단가 */
  CA: number;
  /** 연동 원재료비 = k × CA */
  flexed: number;
  vol: number; price: number; mix: number; yld: number; other: number;
  gain: { price: number; mix: number; yld: number; other: number };
  loss: { price: number; mix: number; yld: number; other: number };
  /** 수율이 크게(SWING 넘게) 바뀐 원재료의 수율효과 합 */
  swingYld: number;
  swingCount: number;
  /** 다른 달 단가로 계산한 원재료비 비중 */
  aSubShare: number; bSubShare: number;
  /** 제품 구성 기준선 (A월 평균 개당 원재료비) */
  cbar: number;
  prodMix: number;
}
export interface DecompResult {
  rows: DecompMatRow[];
  products: DecompProdRow[];
  totals: DecompTotals;
}

const inRange = (v: number | null, lo: number, hi: number) => v !== null && v >= lo && v <= hi;

export function decompStatus(m: DecompMatIn, lo = DECOMP_LO, hi = DECOMP_HI): DecompStatus {
  const { stdA: E, stdB: F, actA: G, actB: H } = m;
  if (m.excluded) return 'excl';
  if (E === 0 && F === 0) return G === 0 && H === 0 ? 'noUse' : 'outside';
  const yA = E > 0 && G > 0 ? E / G : null;
  const yB = F > 0 && H > 0 ? F / H : null;
  const aOK = inRange(yA, lo, hi);
  const bOK = inRange(yB, lo, hi);
  if (aOK) {
    if (bOK) return 'ok';
    if (F === 0 && H === 0) return 'bUnused';
    if (H === 0) return 'bNoAct';
    return F === 0 ? 'bNoStd' : 'bOut';
  }
  if (E === 0 && G === 0) return bOK ? 'aUnused' : (H === 0 ? 'bNoAct' : 'bOut');
  if (G === 0) return 'aNoAct';
  return E === 0 ? 'aNoStd' : 'aOut';
}

export function decompMaterial(m: DecompMatIn, k: number, lo = DECOMP_LO, hi = DECOMP_HI, swing = DECOMP_SWING): DecompMatRow {
  const { stdA: E, stdB: F, actA: G, actB: H, pA: M, pB: N } = m;
  const status = decompStatus(m, lo, hi);
  const yA = E > 0 && G > 0 ? E / G : null;
  const yB = F > 0 && H > 0 ? F / H : null;
  const dY = yA !== null && yB !== null ? yB - yA : null;
  const mixOK = E > 0 && G > 0 && (status === 'ok' || status === 'bUnused' || status === 'bNoAct' || status === 'bNoStd' || status === 'bOut');
  const isNew = status === 'aUnused';
  const FperE = E === 0 ? 0 : F / E;
  const mix = mixOK ? G * (FperE - k) * N : isNew ? H * N : 0;
  const yld = status === 'ok' ? (H - FperE * G) * N : 0;
  const other = mixOK ? (status === 'ok' ? 0 : (H - FperE * G) * N) : isNew ? 0 : (H - k * G) * N;
  return {
    ...m, status, yA, yB, dY,
    costA: G * M, costB: H * N,
    vol: (k - 1) * G * M,
    price: k * G * (N - M),
    mix, yld, other,
    factor: mixOK ? (E === 0 ? 0 : (N * G) / E) : isNew ? (F === 0 ? 0 : (N * H) / F) : 0,
    kgDelta: status === 'ok' ? (H - FperE * G) / 1000 : null,
    swing: status === 'ok' && dY !== null && Math.abs(dY) > swing,   // ④ 수율로 잡힌 원재료만
  };
}

export function computeCostDecomp(
  mats: DecompMatIn[],
  prods: DecompProdIn[],
  opts: { lo?: number; hi?: number; swing?: number } = {},
): DecompResult {
  const lo = opts.lo ?? DECOMP_LO, hi = opts.hi ?? DECOMP_HI, sw = opts.swing ?? DECOMP_SWING;
  const QA = prods.reduce((s, p) => s + p.qtyA, 0);
  const QB = prods.reduce((s, p) => s + p.qtyB, 0);
  const k = QA > 0 ? QB / QA : 0;
  const rows = mats.map((m) => decompMaterial(m, k, lo, hi, sw));
  const sum = (f: (r: DecompMatRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const MA = sum((r) => r.costA);
  const MB = sum((r) => r.costB);
  const CA = sum((r) => r.actA * r.pB);
  const factor = new Map(rows.map((r) => [r.key, r.factor]));
  const withCost = prods.map((p) => ({ p, c: p.ings.reduce((s, i) => s + i.g * (factor.get(i.key) || 0), 0) }));
  const cbar = QA > 0 ? withCost.reduce((s, x) => s + x.p.qtyA * x.c, 0) / QA : 0;
  const products: DecompProdRow[] = withCost.map(({ p, c }) => {
    const expectedB = p.qtyA * k;
    const delta = p.qtyB - expectedB;
    return { ...p, expectedB, delta, costPerEa: c, vsBase: c - cbar, effect: delta * (c - cbar) };
  });
  const pos = (f: (r: DecompMatRow) => number) => sum((r) => Math.max(0, f(r)));
  const neg = (f: (r: DecompMatRow) => number) => sum((r) => Math.min(0, f(r)));
  const swingRows = rows.filter((r) => r.swing);
  return {
    rows,
    products,
    totals: {
      QA, QB, k, MA, MB, CA,
      flexed: k * CA,
      vol: (k - 1) * MA,
      price: k * (CA - MA),
      mix: sum((r) => r.mix),
      yld: sum((r) => r.yld),
      other: sum((r) => r.other),
      gain: { price: neg((r) => r.price), mix: neg((r) => r.mix), yld: neg((r) => r.yld), other: neg((r) => r.other) },
      loss: { price: pos((r) => r.price), mix: pos((r) => r.mix), yld: pos((r) => r.yld), other: pos((r) => r.other) },
      swingYld: swingRows.reduce((s, r) => s + r.yld, 0),
      swingCount: swingRows.length,
      aSubShare: MA > 0 ? sum((r) => (r.pASub ? r.costA : 0)) / MA : 0,
      bSubShare: MB > 0 ? sum((r) => (r.pBSub ? r.costB : 0)) / MB : 0,
      cbar,
      prodMix: products.reduce((s, p) => s + p.effect, 0),
    },
  };
}

/** 원재료비율(÷ 생산금액) 증감 분해. ⓐ 개당 생산금액 + (② + ③ + ④ + ⑤) ÷ B월 생산금액 = 비율 증감 */
export function ratioDecomp(t: DecompTotals, RA: number, RB: number) {
  if (!(RA > 0) || !(RB > 0)) return null;
  const rA = t.MA / RA;
  const rB = t.MB / RB;
  return {
    rA, rB, dr: rB - rA,
    rev: (rA * (t.k * RA - RB)) / RB,
    price: t.price / RB,
    mix: t.mix / RB,
    yld: t.yld / RB,
    other: t.other / RB,
  };
}

/* ===================== 앱 데이터 → 분해 입력 ===================== */

export interface PriceResolver {
  lookup: (month: string, m: { code: string; name: string; matchName: string }) => number | undefined;
  bApplied: (m: { code: string; name: string; matchName: string }) => { price: number; month: string | null };
}

/** 원재료 입력 — 표준소요(computeMonthlyUsage 행, 반제품을 원물로 펼친 레시피)와 실투입(materialInput)을 원재료수율 화면과 같은 규칙으로 맞춘다 */
export function buildDecompMaterials(p: {
  monthA: string;
  stdA: UsageRow[];
  stdB: UsageRow[];
  inputA: { inputs: Record<string, number>; names: Record<string, string> };
  inputB: { inputs: Record<string, number>; names: Record<string, string> };
  priceRes: PriceResolver;
  priceNameByCode: Map<string, string>;
  categoryOf?: (code: string, name: string) => string;
  excludeTerms?: string[];
}): DecompMatIn[] {
  const union = [...p.stdA, ...p.stdB].map((r) => ({ key: r.key, name: r.name }));
  const actA = remapInputs(union, p.inputA.inputs, p.inputA.names).byStdKey;
  const actB = remapInputs(union, p.inputB.inputs, p.inputB.names).byStdKey;
  const sA = new Map(p.stdA.map((r) => [r.key, r]));
  const sB = new Map(p.stdB.map((r) => [r.key, r]));
  const keys = new Set<string>([...sA.keys(), ...sB.keys()]);
  [actA, actB].forEach((m) => Object.entries(m).forEach(([k, g]) => { if ((Number(g) || 0) > 0) keys.add(k); }));
  const excl = (p.excludeTerms || []).map(normalizeMaterialName).filter(Boolean);
  return [...keys].map((key) => {
    const row = sA.get(key) || sB.get(key);
    const code = row?.code || (key.startsWith(CODE_KEY_PREFIX) ? key.slice(CODE_KEY_PREFIX.length) : '');
    const matchName = row?.name || p.inputA.names[key] || p.inputB.names[key] || code || key;
    const official = code ? p.priceNameByCode.get(CODE_KEY_PREFIX + normalizeCode(code)) : undefined;
    const ref = { code, name: official || matchName, matchName };
    const aRaw = p.priceRes.lookup(p.monthA, ref);
    const b = p.priceRes.bApplied(ref);
    const nn = [normalizeMaterialName(ref.name), normalizeMaterialName(matchName)];
    return {
      key, code, name: official || matchName,
      category: p.categoryOf ? p.categoryOf(code, matchName) : '',
      excluded: excl.some((t) => nn.some((x) => x.includes(t))),
      stdA: sA.get(key)?.grams || 0, stdB: sB.get(key)?.grams || 0,
      actA: Number(actA[key]) || 0, actB: Number(actB[key]) || 0,
      pA: aRaw ?? b.price, pB: b.price,
      pASub: aRaw === undefined, pBSub: b.month !== null,
    };
  });
}

/** 제품 입력 — 생산량(월별현황과 같은 규칙)과 레시피(원물로 펼친 것). 원재료 키는 computeMonthlyUsage 와 같다 */
export function buildDecompProducts(p: {
  aProd: MonthlyProduction;
  bProd: MonthlyProduction;
  recipeMap: Map<string, Recipe>;
  ambientRecipeMap: Map<string, AmbientRecipe>;
  productNameByCode: Map<string, string>;
}): DecompProdIn[] {
  const ingKey = (name: string, code?: string) => (code ? CODE_KEY_PREFIX + normalizeCode(code) : normalizeMaterialName(name));
  const norm = new Map<string, Recipe>();
  p.recipeMap.forEach((r) => { const k = canonicalShort(r.code || ''); if (k && !norm.has(k)) norm.set(k, r); });
  const out: DecompProdIn[] = [];
  const codes = new Set<string>([...p.aProd.coldByCode.keys(), ...p.bProd.coldByCode.keys()]);
  codes.forEach((code) => {
    const qtyA = p.aProd.coldByCode.get(code) || 0;
    const qtyB = p.bProd.coldByCode.get(code) || 0;
    if (qtyA <= 0 && qtyB <= 0) return;
    const r = norm.get(code);
    out.push({
      key: code, name: p.productNameByCode.get(code) || r?.name || code, kind: 'cold', qtyA, qtyB,
      ings: (r?.ingredients || []).map((i) => ({ key: ingKey(i.name, i.code), g: i.gPerPiece || 0 })).filter((x) => x.g > 0),
      hasRecipe: !!r,
    });
  });
  const amb = new Map<string, { name: string; a: number; b: number }>();
  const add = (list: { productName: string; qty: number }[], which: 'a' | 'b') => list.forEach((x) => {
    const cur = amb.get(x.productName) || { name: x.productName, a: 0, b: 0 };
    cur[which] += x.qty || 0;
    amb.set(x.productName, cur);
  });
  add(p.aProd.ambient, 'a');
  add(p.bProd.ambient, 'b');
  amb.forEach((v) => {
    if (v.a <= 0 && v.b <= 0) return;
    const r = p.ambientRecipeMap.get(normalizeMaterialName(v.name));
    const bp = r?.batchPieces || 1;
    out.push({
      key: `amb:${v.name}`, name: v.name, kind: 'ambient', qtyA: v.a, qtyB: v.b,
      ings: (r?.ingredients || []).map((i) => ({ key: ingKey(i.name, i.code), g: (i.gPerBatch || 0) / bp })).filter((x) => x.g > 0),
      hasRecipe: !!r,
    });
  });
  return out;
}
