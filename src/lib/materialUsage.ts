/** 월별 원재료 사용량 + 금액 계산기 (원재료분석 페이지용) */
import type { AmbientEntry, Item, MachineEntry } from '../types';
import type { AmbientRecipe, Recipe } from './wasteCompute';
import { CODE_KEY_PREFIX, monthPriceKey, normalizeCode, normalizeMaterialName } from './wasteCompute';
import { canonicalShort } from './codeUtil';
import { getStage, STAGE_LETTERS } from './monthlyProduction';

export interface UsageRow {
  /** 원재료 매칭 키 (코드 우선, 없으면 이름 정규화) */
  key: string;
  name: string;
  code?: string;
  /** 사용량 g */
  grams: number;
  /** ₩/g */
  pricePerGram: number;
  /** ₩ */
  cost: number;
  hasPrice: boolean;
}

export interface UsageResult {
  rows: UsageRow[];
  /** 매칭 안 된 냉장 제품코드 (recipes 미등록) */
  missingColdCodes: string[];
  /** 매칭 안 된 실온 productName (ambientRecipes 미등록) */
  missingAmbientNames: string[];
  /** 단가 미입력 원재료 (key 기준) */
  missingPrices: string[];
}

/** 그 달 제품코드별 실제 생산수 (잔여량 수정 시 계획 분배) */
export function computeColdProductionByCode(
  entries: MachineEntry[],
  items: Item[],
  logisticsByDay: Record<string, number>,
): Map<string, number> {
  const qty = (e: MachineEntry) => (e.actualProduction || 0) + (e.additionalProduction || 0);

  // 일별 items.totalQty by code (canonicalShort 키로 통일: A-001-01 / A-001 / A01 → A01)
  const itemsByDateCode: Record<string, Record<string, number>> = {};
  items.forEach((it) => {
    const d = it.date;
    if (!itemsByDateCode[d]) itemsByDateCode[d] = {};
    const k = canonicalShort(it.code || '');
    if (!k) return;
    itemsByDateCode[d][k] = (itemsByDateCode[d][k] || 0) + (it.totalQty || 0);
  });
  // 일별 entries by code (canonicalShort 키)
  const entriesByDateCode: Record<string, Record<string, number>> = {};
  entries.forEach((e) => {
    const d = e.date;
    if (!entriesByDateCode[d]) entriesByDateCode[d] = {};
    const k = canonicalShort(e.code || '');
    if (!k) return;
    entriesByDateCode[d][k] = (entriesByDateCode[d][k] || 0) + qty(e);
  });

  const out = new Map<string, number>();
  const allDates = new Set<string>([
    ...Object.keys(itemsByDateCode),
    ...Object.keys(entriesByDateCode),
    ...Object.keys(logisticsByDay),
  ]);
  allDates.forEach((d) => {
    const useItems = logisticsByDay[d] !== undefined; // 잔여량 수정 있으면 계획 분배
    const src = useItems ? (itemsByDateCode[d] || {}) : (entriesByDateCode[d] || {});
    Object.entries(src).forEach(([code, n]) => {
      out.set(code, (out.get(code) || 0) + n);
    });
  });
  return out;
}

/** 월별 사용량 계산: 냉장 + 실온
 *  priceMonth 지정 시 그 달 단가로 평가 (Flexed Budget 분석용). 미지정이면 month 자체.
 */
export function computeMonthlyUsage(
  month: string,
  entries: MachineEntry[],
  items: Item[],
  ambient: AmbientEntry[],
  logisticsByDay: Record<string, number>,
  recipeMap: Map<string, Recipe>,
  ambientRecipeMap: Map<string, AmbientRecipe>, // key = normalizeMaterialName(name)
  priceMap: Map<string, number>,
  priceMonth?: string,
): UsageResult {
  const pMonth = priceMonth ?? month;
  const usageGrams = new Map<string, { name: string; code?: string; grams: number }>();
  const addUsage = (ingName: string, ingCode: string | undefined, g: number) => {
    if (g <= 0) return;
    const key = ingCode ? (CODE_KEY_PREFIX + normalizeCode(ingCode)) : normalizeMaterialName(ingName);
    const prev = usageGrams.get(key);
    if (prev) prev.grams += g;
    else usageGrams.set(key, { name: ingName, code: ingCode, grams: g });
  };

  // ===== 냉장 =====
  // recipeMap 도 canonicalShort 키로 재인덱싱 (저장은 A-001 이어도 lookup 은 A01 로 통일)
  const normRecipeMap = new Map<string, Recipe>();
  recipeMap.forEach((r) => {
    const k = canonicalShort(r.code || '');
    if (k && !normRecipeMap.has(k)) normRecipeMap.set(k, r);
  });
  const coldByCode = computeColdProductionByCode(entries, items, logisticsByDay);
  const missingColdCodes: string[] = [];
  coldByCode.forEach((count, code) => {
    if (count <= 0) return;
    const recipe = normRecipeMap.get(code); // code 는 이미 canonicalShort
    if (!recipe) { missingColdCodes.push(code); return; }
    recipe.ingredients.forEach((ing) => {
      addUsage(ing.name, ing.code, (ing.gPerPiece || 0) * count);
    });
  });

  // ===== 실온 =====
  const missingAmbientNames: string[] = [];
  // ambient 엔트리를 productName 별로 묶어 batchCount 합산
  ambient.forEach((a) => {
    const pname = a.productName || '';
    if (!pname) return;
    const key = normalizeMaterialName(pname);
    const recipe = ambientRecipeMap.get(key);
    if (!recipe) {
      if (!missingAmbientNames.includes(pname)) missingAmbientNames.push(pname);
      return;
    }
    const bp = recipe.batchPieces || 1;
    const batchCount = Math.max(1, Math.round((a.qty || 0) / bp));
    recipe.ingredients.forEach((ing) => {
      addUsage(ing.name, ing.code, (ing.gPerBatch || 0) * batchCount);
    });
  });

  // ===== 금액 산출 (코드 우선 → 이름) =====
  const missingPrices: string[] = [];
  const rows: UsageRow[] = [];
  usageGrams.forEach(({ name, code, grams }, key) => {
    const codeKey = code ? monthPriceKey(pMonth, CODE_KEY_PREFIX + normalizeCode(code)) : '';
    const nameKey = monthPriceKey(pMonth, normalizeMaterialName(name));
    const hasCode = !!codeKey && priceMap.has(codeKey);
    const hasPrice = hasCode || priceMap.has(nameKey);
    const pricePerGram = hasCode ? (priceMap.get(codeKey) ?? 0) : (priceMap.get(nameKey) ?? 0);
    const cost = grams * pricePerGram;
    if (!hasPrice) missingPrices.push(name);
    rows.push({ key, name, code, grams, pricePerGram, cost, hasPrice });
  });

  // 사용량 내림차순
  rows.sort((a, b) => b.grams - a.grams);

  return { rows, missingColdCodes, missingAmbientNames, missingPrices };
}

/** 두 월 결과 합치기 (원재료별 비교 row) */
export interface DiffRow {
  key: string;
  name: string;
  code?: string;
  aGrams: number;
  aCost: number;
  aHasPrice: boolean;
  bGrams: number;
  bCost: number;
  bHasPrice: boolean;
  diffCost: number;
  diffPct: number;
}
export function diffUsage(aResult: UsageResult, bResult: UsageResult): DiffRow[] {
  const map = new Map<string, DiffRow>();
  aResult.rows.forEach((r) => {
    map.set(r.key, {
      key: r.key, name: r.name, code: r.code,
      aGrams: r.grams, aCost: r.cost, aHasPrice: r.hasPrice,
      bGrams: 0, bCost: 0, bHasPrice: false,
      diffCost: 0, diffPct: 0,
    });
  });
  bResult.rows.forEach((r) => {
    const prev = map.get(r.key);
    if (prev) {
      prev.bGrams = r.grams; prev.bCost = r.cost; prev.bHasPrice = r.hasPrice;
      if (!prev.name && r.name) prev.name = r.name;
      if (!prev.code && r.code) prev.code = r.code;
    } else {
      map.set(r.key, {
        key: r.key, name: r.name, code: r.code,
        aGrams: 0, aCost: 0, aHasPrice: false,
        bGrams: r.grams, bCost: r.cost, bHasPrice: r.hasPrice,
        diffCost: 0, diffPct: 0,
      });
    }
  });
  const list = Array.from(map.values());
  list.forEach((r) => {
    r.diffCost = r.bCost - r.aCost;
    r.diffPct = r.aCost > 0 ? ((r.bCost - r.aCost) / r.aCost) * 100 : (r.bCost > 0 ? 100 : 0);
  });
  // B월 사용량 내림차순, 없으면 A월
  list.sort((a, b) => (b.bGrams || b.aGrams) - (a.bGrams || a.aGrams));
  return list;
}

/** Flexed Budget 분석 row — 두 월 모두 B월 단가로 평가 + A월 결과를 B월 생산규모로 연동 */
export interface FlexedRow {
  key: string;
  name: string;
  code?: string;
  aGrams: number;
  aCost: number;       // A 생산량 × 레시피 × B단가
  bGrams: number;
  bCost: number;       // B 생산량 × 레시피 × B단가
  flexedCost: number;  // aCost × (bScale / aScale)
  diffCost: number;    // flexedCost − bCost  (+ 효율↑ / − 낭비)
  diffPct: number;     // flexedCost 대비 %
  bSharePct: number;   // B월 cost 비중 (전체 B 합 대비)
  hasPrice: boolean;
}
export function computeFlexedDiff(
  aRowsBPrice: UsageRow[],
  bRows: UsageRow[],
  aScale: number,
  bScale: number,
): FlexedRow[] {
  const ratio = aScale > 0 ? bScale / aScale : 1;
  const map = new Map<string, FlexedRow>();
  aRowsBPrice.forEach((r) => {
    map.set(r.key, {
      key: r.key, name: r.name, code: r.code,
      aGrams: r.grams, aCost: r.cost,
      bGrams: 0, bCost: 0,
      flexedCost: r.cost * ratio,
      diffCost: 0, diffPct: 0, bSharePct: 0,
      hasPrice: r.hasPrice,
    });
  });
  bRows.forEach((r) => {
    const prev = map.get(r.key);
    if (prev) {
      prev.bGrams = r.grams; prev.bCost = r.cost;
      if (!prev.name && r.name) prev.name = r.name;
      if (!prev.code && r.code) prev.code = r.code;
      prev.hasPrice = prev.hasPrice || r.hasPrice;
    } else {
      map.set(r.key, {
        key: r.key, name: r.name, code: r.code,
        aGrams: 0, aCost: 0,
        bGrams: r.grams, bCost: r.cost,
        flexedCost: 0,
        diffCost: 0, diffPct: 0, bSharePct: 0,
        hasPrice: r.hasPrice,
      });
    }
  });
  const list = Array.from(map.values());
  const bTotal = list.reduce((s, r) => s + r.bCost, 0);
  list.forEach((r) => {
    r.diffCost = r.flexedCost - r.bCost;
    r.diffPct = r.flexedCost > 0 ? (r.diffCost / r.flexedCost) * 100 : (r.bCost > 0 ? -100 : 0);
    r.bSharePct = bTotal > 0 ? (r.bCost / bTotal) * 100 : 0;
  });
  // B월 금액 내림차순
  list.sort((a, b) => b.bCost - a.bCost);
  return list;
}

/** 원재료별 — 냉장 단계별(A/B/C/…/I) + 실온 사용량(g) + 단가
 *  원재료분석 검색창에서 매칭된 원재료의 단계별 사용 분배에 사용.
 *  냉장 분배는 coldByCode(원본 코드, qty) 와 recipeMap(canonicalShort 키)으로 코드별 레시피 적용 후
 *  코드의 stage(getStage)로 묶어 합산.
 */
export interface IngredientStageRow {
  key: string;
  name: string;
  code?: string;
  /** 단계별 g (A/B/C/D/E/F/F500/G/H/I) */
  byStage: Record<string, number>;
  /** 실온 합 g */
  ambientGrams: number;
  /** 전체 g */
  totalGrams: number;
  pricePerGram: number;
  cost: number;
  hasPrice: boolean;
}
export function computeIngredientStageUsage(
  month: string,
  coldByCode: Map<string, number>,        // 원본 코드(원본 그대로) → 월합 qty
  ambient: AmbientEntry[],
  recipeMap: Map<string, Recipe>,
  ambientRecipeMap: Map<string, AmbientRecipe>,
  priceMap: Map<string, number>,
  priceMonth?: string,
): IngredientStageRow[] {
  const pMonth = priceMonth ?? month;
  const empty = (): Record<string, number> => {
    const o: Record<string, number> = {};
    STAGE_LETTERS.forEach((L) => { o[L] = 0; });
    return o;
  };
  type Acc = { name: string; code?: string; byStage: Record<string, number>; ambientGrams: number };
  const acc = new Map<string, Acc>();
  const add = (name: string, code: string | undefined, stage: string | null, grams: number, isAmbient: boolean) => {
    if (grams <= 0) return;
    const key = code ? (CODE_KEY_PREFIX + normalizeCode(code)) : normalizeMaterialName(name);
    let cur = acc.get(key);
    if (!cur) { cur = { name, code, byStage: empty(), ambientGrams: 0 }; acc.set(key, cur); }
    if (isAmbient) cur.ambientGrams += grams;
    else if (stage && cur.byStage[stage] !== undefined) cur.byStage[stage] += grams;
  };

  // 냉장: recipeMap canonicalShort 재인덱싱
  const normRecipeMap = new Map<string, Recipe>();
  recipeMap.forEach((r) => {
    const k = canonicalShort(r.code || '');
    if (k && !normRecipeMap.has(k)) normRecipeMap.set(k, r);
  });
  coldByCode.forEach((qty, code) => {
    if (qty <= 0) return;
    const stage = getStage(code);
    const r = normRecipeMap.get(canonicalShort(code));
    if (!r) return;
    r.ingredients.forEach((ing) => add(ing.name, ing.code, stage, (ing.gPerPiece || 0) * qty, false));
  });

  // 실온
  ambient.forEach((a) => {
    const pname = a.productName || '';
    if (!pname) return;
    const recipe = ambientRecipeMap.get(normalizeMaterialName(pname));
    if (!recipe) return;
    const bp = recipe.batchPieces || 1;
    const batchCount = Math.max(1, Math.round((a.qty || 0) / bp));
    recipe.ingredients.forEach((ing) => add(ing.name, ing.code, null, (ing.gPerBatch || 0) * batchCount, true));
  });

  const out: IngredientStageRow[] = [];
  acc.forEach((v, key) => {
    const stageSum = Object.values(v.byStage).reduce((s, x) => s + x, 0);
    const totalGrams = stageSum + v.ambientGrams;
    const codeKey = v.code ? monthPriceKey(pMonth, CODE_KEY_PREFIX + normalizeCode(v.code)) : '';
    const nameKey = monthPriceKey(pMonth, normalizeMaterialName(v.name));
    const hasCode = !!codeKey && priceMap.has(codeKey);
    const hasPrice = hasCode || priceMap.has(nameKey);
    const pricePerGram = hasCode ? (priceMap.get(codeKey) ?? 0) : (priceMap.get(nameKey) ?? 0);
    out.push({
      key, name: v.name, code: v.code,
      byStage: v.byStage, ambientGrams: v.ambientGrams, totalGrams,
      pricePerGram, cost: totalGrams * pricePerGram, hasPrice,
    });
  });
  out.sort((a, b) => b.totalGrams - a.totalGrams);
  return out;
}
