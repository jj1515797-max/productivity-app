/** 원재료분석2 — 실측 출고량 역배분
 *  BOM × 생산수량 = 원재료별 이론 사용량 + 제품별 기여 비율
 *  실측 출고량 입력 시 비율로 역배분해 제품별 원재료 원가 산출
 */
import type { AmbientEntry } from '../types';
import type { AmbientRecipe, Recipe } from './wasteCompute';
import { CODE_KEY_PREFIX, normalizeCode, normalizeMaterialName } from './wasteCompute';
import { canonicalShort } from './codeUtil';

export interface BomContribution {
  /** 제품코드 (canonicalShort) — 실온은 ambient id */
  code: string;
  productName: string;
  isAmbient: boolean;
  productionQty: number;     // 그 달 생산수량 EA
  grams: number;             // 이 제품이 이 원재료에 기여한 이론 g
  share: number;             // grams / theoreticalGrams (이 원재료 안에서 비중)
}
export interface IngTheoretical {
  key: string;               // 통일 키 (코드 우선)
  name: string;
  code?: string;
  theoreticalGrams: number;  // 이론 사용량 (BOM × 생산량) g
  contributions: BomContribution[];
}

export function computeTheoreticalByProduct(
  coldByCode: Map<string, number>,    // canonicalShort 코드 → 월 생산수량
  ambient: AmbientEntry[],
  recipeMap: Map<string, Recipe>,
  ambientRecipeMap: Map<string, AmbientRecipe>,
  productNameByCode: Map<string, string>,  // canonicalShort → 표시명
): Map<string, IngTheoretical> {
  const acc = new Map<string, IngTheoretical>();
  const addContribution = (
    name: string, code: string | undefined, grams: number, contrib: Omit<BomContribution, 'share'>,
  ) => {
    if (grams <= 0) return;
    const key = code ? (CODE_KEY_PREFIX + normalizeCode(code)) : normalizeMaterialName(name);
    let cur = acc.get(key);
    if (!cur) { cur = { key, name, code, theoreticalGrams: 0, contributions: [] }; acc.set(key, cur); }
    cur.theoreticalGrams += grams;
    cur.contributions.push({ ...contrib, share: 0 });
  };

  // 냉장 — recipeMap canonicalShort 재인덱싱
  const normRecipeMap = new Map<string, Recipe>();
  recipeMap.forEach((r) => {
    const k = canonicalShort(r.code || '');
    if (k && !normRecipeMap.has(k)) normRecipeMap.set(k, r);
  });
  coldByCode.forEach((qty, code) => {
    if (qty <= 0) return;
    const r = normRecipeMap.get(code);
    if (!r) return;
    const productName = productNameByCode.get(code) || r.name || code;
    r.ingredients.forEach((ing) => {
      const g = (ing.gPerPiece || 0) * qty;
      addContribution(ing.name, ing.code, g, {
        code, productName, isAmbient: false, productionQty: qty, grams: g,
      });
    });
  });

  // 실온 — productName 별 합산 후 레시피 적용
  const ambSum = new Map<string, number>();   // normalized name → qty
  const ambDisplay = new Map<string, string>();
  ambient.forEach((a) => {
    const pname = a.productName || '';
    if (!pname) return;
    const key = normalizeMaterialName(pname);
    ambSum.set(key, (ambSum.get(key) || 0) + (a.qty || 0));
    if (!ambDisplay.has(key)) ambDisplay.set(key, pname);
  });
  ambSum.forEach((qty, key) => {
    if (qty <= 0) return;
    const recipe = ambientRecipeMap.get(key);
    if (!recipe) return;
    const bp = recipe.batchPieces || 1;
    const batchCount = Math.max(1, Math.round(qty / bp));
    recipe.ingredients.forEach((ing) => {
      const g = (ing.gPerBatch || 0) * batchCount;
      addContribution(ing.name, ing.code, g, {
        code: key, productName: ambDisplay.get(key) || key, isAmbient: true, productionQty: qty, grams: g,
      });
    });
  });

  // share 채우기
  acc.forEach((v) => {
    if (v.theoreticalGrams <= 0) return;
    v.contributions.forEach((c) => { c.share = c.grams / v.theoreticalGrams; });
    v.contributions.sort((a, b) => b.grams - a.grams);
  });
  return acc;
}

export interface PerIngResult {
  key: string;
  name: string;
  code?: string;
  theoreticalG: number;
  actualG: number;
  /** 이론/실제 비율 (예: 1000/1200 = 83.3%) 100% 이상이면 수율 양호 */
  yieldPct: number;
  unitCost: number;          // ₩/g (출고금액 입력 시 실측, 미입력 시 기초단가)
  totalCost: number;         // actualG × unitCost
  hasPrice: boolean;
  /** 분배 불가 = 이론사용량 0 인데 실제출고 입력됨 (BOM 누락/타 라인 등) */
  orphan: boolean;
}
export interface PerProductBreakdown {
  ingKey: string;
  name: string;
  actualG: number;
  cost: number;
}
export interface PerProductResult {
  code: string;
  productName: string;
  isAmbient: boolean;
  productionQty: number;
  materialCost: number;
  materialCostPerEA: number;
  breakdown: PerProductBreakdown[];
}
export interface AllocationResult {
  perIng: PerIngResult[];
  perProduct: PerProductResult[];
  orphans: PerIngResult[];   // 이론 0 + 실측 > 0
  ingTotalCost: number;
  theoTotalCost: number;
}

export function allocateActualOutflow(
  byIng: Map<string, IngTheoretical>,
  outflowGrams: Record<string, number>,
  outflowAmounts: Record<string, number>,
  basePriceMap: Map<string, number>,        // key = (CODE_KEY_PREFIX+normCode) 또는 normalizedName, value = ₩/g
): AllocationResult {
  const perIng: PerIngResult[] = [];
  const orphans: PerIngResult[] = [];
  const perProductAcc = new Map<string, PerProductResult>();
  let ingTotalCost = 0, theoTotalCost = 0;

  // 1) 모든 이론 원재료 순회
  byIng.forEach((info, key) => {
    const actualG = Number(outflowGrams[key] || 0);
    const actualAmt = Number(outflowAmounts[key] || 0);
    const basePrice = basePriceMap.get(key) ?? lookupByName(basePriceMap, info.name);
    const hasPrice = basePrice !== undefined && basePrice > 0;
    const unitCost = actualAmt > 0 && actualG > 0 ? actualAmt / actualG : (hasPrice ? basePrice! : 0);
    const totalCost = actualG * unitCost;
    const yieldPct = actualG > 0 ? (info.theoreticalGrams / actualG) * 100 : 0;
    perIng.push({
      key, name: info.name, code: info.code,
      theoreticalG: info.theoreticalGrams, actualG, yieldPct,
      unitCost, totalCost, hasPrice, orphan: false,
    });
    ingTotalCost += totalCost;
    theoTotalCost += info.theoreticalGrams * (hasPrice ? basePrice! : 0);

    // 2) 제품별 분배
    if (info.theoreticalGrams > 0 && actualG > 0) {
      info.contributions.forEach((c) => {
        const allocG = actualG * c.share;
        const allocCost = allocG * unitCost;
        const pk = `${c.isAmbient ? 'A:' : 'C:'}${c.code}`;
        let p = perProductAcc.get(pk);
        if (!p) {
          p = {
            code: c.code, productName: c.productName, isAmbient: c.isAmbient,
            productionQty: c.productionQty,
            materialCost: 0, materialCostPerEA: 0, breakdown: [],
          };
          perProductAcc.set(pk, p);
        }
        p.materialCost += allocCost;
        p.breakdown.push({ ingKey: key, name: info.name, actualG: allocG, cost: allocCost });
      });
    }
  });

  // 3) Orphan = 이론에 없는데 실측 입력만 들어옴
  Object.entries(outflowGrams).forEach(([k, v]) => {
    const g = Number(v || 0);
    if (g <= 0) return;
    if (byIng.has(k)) return;   // 이미 처리됨
    const amt = Number(outflowAmounts[k] || 0);
    const basePrice = basePriceMap.get(k);
    const hasPrice = basePrice !== undefined && basePrice > 0;
    const unitCost = amt > 0 ? amt / g : (hasPrice ? basePrice! : 0);
    orphans.push({
      key: k, name: k, code: undefined,
      theoreticalG: 0, actualG: g, yieldPct: 0, unitCost, totalCost: g * unitCost, hasPrice, orphan: true,
    });
  });

  // 4) EA 당 원가 + 정렬
  perProductAcc.forEach((p) => {
    p.materialCostPerEA = p.productionQty > 0 ? p.materialCost / p.productionQty : 0;
    p.breakdown.sort((a, b) => b.cost - a.cost);
  });
  const perProduct = Array.from(perProductAcc.values()).sort((a, b) => b.materialCost - a.materialCost);
  perIng.sort((a, b) => b.totalCost - a.totalCost);

  return { perIng, perProduct, orphans, ingTotalCost, theoTotalCost };
}

function lookupByName(map: Map<string, number>, name: string): number | undefined {
  const k = normalizeMaterialName(name);
  return map.get(k);
}
