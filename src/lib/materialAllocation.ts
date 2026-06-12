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
  /** 기초단가 DB 값 (₩/g). 매칭 안되면 0 */
  basePrice: number;
  /** 실제 적용 단가 — 출고금액 입력 시 출고금액/출고량, 미입력 시 basePrice */
  unitCost: number;
  /** 출고금액 입력으로 실측단가가 basePrice 와 다른지 */
  usedActualPrice: boolean;
  /** 원가 산출에 실제 쓰인 수량 g (출고 있으면 actualG, 없으면 이론사용량 폴백) */
  costedG: number;
  /** 출고 데이터 없어 이론사용량 × 기초단가로 산출됨 */
  usedTheoretical: boolean;
  totalCost: number;         // costedG × unitCost
  hasPrice: boolean;
  /** 분배 불가 = 이론사용량 0 인데 실제출고 입력됨 (BOM 누락/타 라인 등) */
  orphan: boolean;
  /** 출고 입력 시 코드가 BOM 과 달라 이름으로 자동 재매칭됨 (사용자 정정 권고) */
  remappedFromKey?: string;
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
  outflowNames?: Map<string, string>,       // 출고 키 → 단가표상 원재료명 (이름 폴백 매칭용)
): AllocationResult {
  const perIng: PerIngResult[] = [];
  const orphans: PerIngResult[] = [];
  const perProductAcc = new Map<string, PerProductResult>();
  let ingTotalCost = 0, theoTotalCost = 0;

  // 0) BOM 원재료들의 이름 인덱스 (코드가 안 맞을 때 이름으로 자동 재매칭)
  const byIngByName = new Map<string, string[]>();
  byIng.forEach((info, k) => {
    const n = normalizeMaterialName(info.name);
    if (!n) return;
    const arr = byIngByName.get(n) || [];
    arr.push(k);
    byIngByName.set(n, arr);
  });

  // 0-2) outflow 키 정규화: BOM 에 없는 코드키 → 이름으로 BOM 흡수
  //   - 단일 매칭: 그 BOM 키에 그대로 흡수
  //   - 다중 매칭: 각 BOM 후보의 이론 g 비율로 자동 분배 (같은 이름·다른 코드가 BOM에 섞여있는 과도기 대응)
  const effG: Record<string, number> = { ...outflowGrams };
  const effAmt: Record<string, number> = { ...outflowAmounts };
  const remapMeta = new Map<string, string>();  // BOM key → 원래 입력 키 (UI 안내)
  Object.entries(outflowGrams).forEach(([k, g]) => {
    if (!g || byIng.has(k)) return;
    const inputName = outflowNames?.get(k);
    if (!inputName) return;
    const candidates = byIngByName.get(normalizeMaterialName(inputName)) || [];
    if (candidates.length === 0) return;
    const amt = Number(outflowAmounts[k] || 0);
    if (candidates.length === 1) {
      const target = candidates[0];
      effG[target] = (effG[target] || 0) + Number(g);
      if (amt) effAmt[target] = (effAmt[target] || 0) + amt;
      remapMeta.set(target, k);
    } else {
      const totalTheo = candidates.reduce((s, c) => s + (byIng.get(c)?.theoreticalGrams || 0), 0);
      if (totalTheo <= 0) return;  // 후보 모두 이론 0 → 분배 못함 → orphan
      candidates.forEach((c) => {
        const w = (byIng.get(c)?.theoreticalGrams || 0) / totalTheo;
        if (w <= 0) return;
        effG[c] = (effG[c] || 0) + Number(g) * w;
        if (amt) effAmt[c] = (effAmt[c] || 0) + amt * w;
        remapMeta.set(c, k);
      });
    }
    delete effG[k];
    delete effAmt[k];
  });

  // 1) 모든 이론 원재료 순회
  byIng.forEach((info, key) => {
    const actualG = Number(effG[key] || 0);
    const actualAmt = Number(effAmt[key] || 0);
    const basePriceRaw = basePriceMap.get(key) ?? lookupByName(basePriceMap, info.name);
    const hasPrice = basePriceRaw !== undefined && basePriceRaw > 0;
    const basePrice = hasPrice ? basePriceRaw! : 0;
    const usedActualPrice = actualAmt > 0 && actualG > 0;
    const unitCost = usedActualPrice ? actualAmt / actualG : basePrice;
    // 출고 있으면 actualG, 없으면 기초단가 × 이론사용량 으로 폴백 산출
    const usedTheoretical = actualG <= 0 && hasPrice && info.theoreticalGrams > 0;
    const costedG = actualG > 0 ? actualG : (usedTheoretical ? info.theoreticalGrams : 0);
    const totalCost = costedG * unitCost;
    const yieldPct = actualG > 0 ? (info.theoreticalGrams / actualG) * 100 : 0;
    perIng.push({
      key, name: info.name, code: info.code,
      theoreticalG: info.theoreticalGrams, actualG, yieldPct,
      basePrice, unitCost, usedActualPrice, costedG, usedTheoretical,
      totalCost, hasPrice, orphan: false,
      ...(remapMeta.get(key) ? { remappedFromKey: remapMeta.get(key)! } : {}),
    });
    ingTotalCost += totalCost;
    theoTotalCost += info.theoreticalGrams * basePrice;

    // 2) 제품별 분배 (costedG 기준 — 출고 없으면 이론수량으로 분배)
    if (info.theoreticalGrams > 0 && costedG > 0) {
      info.contributions.forEach((c) => {
        const allocG = costedG * c.share;
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

  // 3) Orphan = 이론에 없는데 실측 입력만 들어옴 (effG 기준: 이름으로 재매칭된 것 제외)
  Object.entries(effG).forEach(([k, v]) => {
    const g = Number(v || 0);
    if (g <= 0) return;
    if (byIng.has(k)) return;   // 이미 처리됨
    const amt = Number(effAmt[k] || 0);
    const basePriceRaw = basePriceMap.get(k);
    const hasPrice = basePriceRaw !== undefined && basePriceRaw > 0;
    const basePrice = hasPrice ? basePriceRaw! : 0;
    const usedActualPrice = amt > 0;
    const unitCost = usedActualPrice ? amt / g : basePrice;
    orphans.push({
      key: k, name: k, code: undefined,
      theoreticalG: 0, actualG: g, yieldPct: 0,
      basePrice, unitCost, usedActualPrice, costedG: g, usedTheoretical: false,
      totalCost: g * unitCost, hasPrice, orphan: true,
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
