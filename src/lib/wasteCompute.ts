/** 폐기금액 계산 유틸 */

export interface RecipeIngredient {
  seq: number;
  name: string;
  /** 제품 1개당 총투입량 (g) */
  gPerPiece: number;
  /** 원재료 ERP코드 (단가 매칭 우선키, 선택) */
  code?: string;
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

/** 실온이유식 레시피 (1회 배합 기준) */
export interface AmbientRecipeIngredient {
  seq: number;
  name: string;
  /** 1회 배합당 g */
  gPerBatch: number;
  /** 원재료 ERP코드 (단가 매칭 우선키, 선택) */
  code?: string;
}

export interface AmbientRecipe {
  /** 풀네임 (prefix 포함, 예: "순수본_한우야채진밥") */
  name: string;
  /** 1회 배합으로 나오는 평균 포장 수 (기본 1100) */
  batchPieces: number;
  ingredients: AmbientRecipeIngredient[];
}

export interface WasteEntry {
  id?: string;
  date: string;
  code: string;
  name: string;
  qty: number;
  excludedIngredients?: string[];
  /** 레시피에 없는데 폐기에 포함할 원료(예: 잘못 투입) — 레시피 원료와 동일하게 단가 계산 */
  extraIngredients?: { name: string; gPerPiece: number; code?: string }[];
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

/** 원재료명 정규화 (단가 매칭용 - 이름 fallback) */
export function normalizeMaterialName(name: string): string {
  return (name || '').trim().toLowerCase().replace(/\s+/g, '');
}

/** 원재료 ERP코드 정규화 (단가 매칭 우선키) */
export function normalizeCode(code: string): string {
  return (code || '').trim().toUpperCase().replace(/\s+/g, '');
}

/** priceMap 안에서 코드 키는 이 접두사로 구분 (이름 키와 충돌 방지) */
export const CODE_KEY_PREFIX = '__c__';

/**
 * 월별 단가 키 생성. priceMap 은 `${month}|${innerKey}` 형태로 저장된다.
 * innerKey 는 이름(normalizeMaterialName) 또는 코드(CODE_KEY_PREFIX+normalizeCode).
 */
export function monthPriceKey(month: string, innerKey: string): string {
  return `${month}|${innerKey}`;
}

/** 한 폐기 entry 를 원재료별 행 목록으로 확장 (단가는 entry 날짜의 月 기준) */
export function expandWasteEntry(
  entry: WasteEntry,
  recipe: Recipe | undefined,
  priceMap: Map<string, number>,
): WasteRow[] {
  const month = (entry.date || '').slice(0, 7); // YYYY-MM
  const excluded = new Set((entry.excludedIngredients || []).map(normalizeMaterialName));

  const mkRow = (name: string, code: string | undefined, gPerPiece: number, seq: number): WasteRow => {
    const weight = (gPerPiece || 0) * (entry.qty || 0);
    // 코드 우선 매칭 → 없으면 이름 매칭 (둘 다 해당 月 단가)
    const codeKey = code ? monthPriceKey(month, CODE_KEY_PREFIX + normalizeCode(code)) : '';
    const nameKey = monthPriceKey(month, normalizeMaterialName(name));
    const hasCode = !!codeKey && priceMap.has(codeKey);
    const hasPrice = hasCode || priceMap.has(nameKey);
    const price = hasCode ? (priceMap.get(codeKey) ?? 0) : (priceMap.get(nameKey) ?? 0);
    return {
      entryId: entry.id, date: entry.date, code: entry.code, productName: entry.name, qty: entry.qty,
      seq, ingredient: name, weight, price, cost: weight * price, hasPrice,
    };
  };

  const rows: WasteRow[] = [];
  // 레시피 원료 (제외 체크 뺀 것)
  if (recipe) {
    recipe.ingredients
      .filter((ing) => !excluded.has(normalizeMaterialName(ing.name)))
      .forEach((ing) => rows.push(mkRow(ing.name, ing.code, ing.gPerPiece, ing.seq)));
  }
  // 추가 원료 (레시피에 없지만 폐기에 포함) — seq 뒤로 (1000+)
  (entry.extraIngredients || []).forEach((ing, i) => {
    rows.push(mkRow(`${ing.name} (추가)`, ing.code, ing.gPerPiece, 1000 + i));
  });

  return rows.sort((a, b) => a.seq - b.seq);
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
