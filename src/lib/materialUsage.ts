/** 월별 원재료 사용량 + 금액 계산기 (원재료분석 페이지용) */
import type { AmbientEntry, Item, MachineEntry } from '../types';
import type { AmbientRecipe, Recipe } from './wasteCompute';
import { CODE_KEY_PREFIX, monthPriceKey, normalizeCode, normalizeMaterialName } from './wasteCompute';

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

  // 일별 items.totalQty by code
  const itemsByDateCode: Record<string, Record<string, number>> = {};
  items.forEach((it) => {
    const d = it.date;
    if (!itemsByDateCode[d]) itemsByDateCode[d] = {};
    const k = (it.code || '').toLowerCase();
    if (!k) return;
    itemsByDateCode[d][k] = (itemsByDateCode[d][k] || 0) + (it.totalQty || 0);
  });
  // 일별 entries by code
  const entriesByDateCode: Record<string, Record<string, number>> = {};
  entries.forEach((e) => {
    const d = e.date;
    if (!entriesByDateCode[d]) entriesByDateCode[d] = {};
    const k = (e.code || '').toLowerCase();
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

/** 월별 사용량 계산: 냉장 + 실온 */
export function computeMonthlyUsage(
  month: string,
  entries: MachineEntry[],
  items: Item[],
  ambient: AmbientEntry[],
  logisticsByDay: Record<string, number>,
  recipeMap: Map<string, Recipe>,
  ambientRecipeMap: Map<string, AmbientRecipe>, // key = normalizeMaterialName(name)
  priceMap: Map<string, number>,
): UsageResult {
  const usageGrams = new Map<string, { name: string; code?: string; grams: number }>();
  const addUsage = (ingName: string, ingCode: string | undefined, g: number) => {
    if (g <= 0) return;
    const key = ingCode ? (CODE_KEY_PREFIX + normalizeCode(ingCode)) : normalizeMaterialName(ingName);
    const prev = usageGrams.get(key);
    if (prev) prev.grams += g;
    else usageGrams.set(key, { name: ingName, code: ingCode, grams: g });
  };

  // ===== 냉장 =====
  const coldByCode = computeColdProductionByCode(entries, items, logisticsByDay);
  const missingColdCodes: string[] = [];
  coldByCode.forEach((count, code) => {
    if (count <= 0) return;
    const r = recipeMap.get(code) || recipeMap.get(code.toUpperCase()) || recipeMap.get(code.toLowerCase());
    // recipeMap 키는 원본 code (저장 그대로) — 대소문자 시도
    const recipe = r ?? Array.from(recipeMap.values()).find((rr) => rr.code.toLowerCase() === code);
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
    const codeKey = code ? monthPriceKey(month, CODE_KEY_PREFIX + normalizeCode(code)) : '';
    const nameKey = monthPriceKey(month, normalizeMaterialName(name));
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
