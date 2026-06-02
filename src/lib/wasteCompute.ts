/** 폐기금액 계산 유틸 */

export interface RecipeIngredient {
  seq: number;
  name: string;
  /** 제품 1개당 총투입량 (g) */
  gPerPiece: number;
}

export interface Recipe {
  code: string;
  name: string;
  ingredients: RecipeIngredient[];
}

export interface MaterialPrice {
  name: string;
  /** ₩/g */
  pricePerGram: number;
}

export interface WasteEntry {
  id?: string;
  date: string;
  code: string;
  name: string;
  qty: number;
  excludedIngredients?: string[];
  createdAt?: string;
}

export interface WasteRow {
  entryId?: string;
  date: string;
  code: string;
  productName: string;
  qty: number;
  seq: number;
  ingredient: string;
  /** g */
  weight: number;
  /** ₩/g */
  price: number;
  /** ₩ */
  cost: number;
  hasPrice: boolean;
}

/** 원재료명 정규화 (단가 매칭용) */
export function normalizeMaterialName(name: string): string {
  return (name || '').trim().toLowerCase().replace(/\s+/g, '');
}

/** 한 폐기 entry 를 원재료별 행 목록으로 확장 */
export function expandWasteEntry(
  entry: WasteEntry,
  recipe: Recipe | undefined,
  priceMap: Map<string, number>,
): WasteRow[] {
  if (!recipe) return [];
  const excluded = new Set((entry.excludedIngredients || []).map(normalizeMaterialName));
  return recipe.ingredients
    .filter((ing) => !excluded.has(normalizeMaterialName(ing.name)))
    .map((ing) => {
      const weight = (ing.gPerPiece || 0) * (entry.qty || 0);
      const price = priceMap.get(normalizeMaterialName(ing.name)) ?? 0;
      const cost = weight * price;
      return {
        entryId: entry.id,
        date: entry.date,
        code: entry.code,
        productName: entry.name,
        qty: entry.qty,
        seq: ing.seq,
        ingredient: ing.name,
        weight,
        price,
        cost,
        hasPrice: priceMap.has(normalizeMaterialName(ing.name)),
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

/** 여러 entry 확장 + 일자별 그룹 */
export function expandAll(
  entries: WasteEntry[],
  recipeMap: Map<string, Recipe>,
  priceMap: Map<string, number>,
): WasteRow[] {
  const out: WasteRow[] = [];
  entries.forEach((e) => {
    const r = recipeMap.get(e.code);
    expandWasteEntry(e, r, priceMap).forEach((row) => out.push(row));
  });
  return out;
}
