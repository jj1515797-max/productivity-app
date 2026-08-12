/** BOM 재귀 전개 — 반제품(중간 가공품)을 원물 단위까지 풀어주는 엔진
 *
 * 사용 시나리오:
 *  - 제품 BOM 에 "순수본베이스 PB-Z-001 79.36g" 같이 반제품이 들어가 있고,
 *    그 반제품 자체에 "1g 당 원물 사용량" BOM 이 등록돼 있다.
 *  - 분석1/2 에서 이 함수로 펼치면 PB-Z-001 줄은 사라지고,
 *    정제수·무·양파 등 원물로 비율 곱셈하여 추가된다.
 *
 * 안전 가드:
 *  - 사이클 감지: 같은 코드를 path 에서 만나면 중단 (정제수 자기 자신 참조 등)
 *  - 깊이 제한: 기본 5 단계 (반제품 → 반제품 → 반제품 깊은 체인 보호)
 *  - 미등록 반제품: 코드가 subRecipeMap 에 없으면 그대로 leaf 로 취급
 *  - 부분 실패: 한 ingredient 가 사이클이어도 나머지는 정상 처리
 */
import type { AmbientRecipe, Recipe } from './wasteCompute';
import { canonicalShort } from './codeUtil';

export interface ExpandedIngredient {
  /** 최종 원물 이름 (반제품 풀린 후) */
  name: string;
  /** 최종 원물 코드 */
  code?: string;
  /** 제품 1개당 투입량 (g) — 반제품 경유 시 곱셈으로 환산됨 */
  gPerPiece: number;
  /** 경유한 반제품 체인 (디버깅/검증용). 비어있으면 직투입. ['PB-Z-001'] = 순수본베이스 경유 */
  via: string[];
}

export interface ExpansionWarning {
  type: 'cycle' | 'depth';
  via: string[];
  code: string;
  name: string;
}

const MAX_DEPTH = 5;

/** 반제품 코드 정규화 — recipe code 와 ingredient code 의 비교 키 */
function keyOf(code: string | undefined): string {
  return code ? canonicalShort(code) : '';
}

/** subRecipeMap 을 canonicalShort 키로 한 번 인덱싱 */
function indexSubRecipes(subRecipeMap: Map<string, Recipe>): Map<string, Recipe> {
  const out = new Map<string, Recipe>();
  subRecipeMap.forEach((r) => {
    const k = keyOf(r.code);
    if (k && !out.has(k)) out.set(k, r);
  });
  return out;
}

/** 한 원재료를 (사이클·깊이 안전하게) 재귀 전개 */
function expandOne(
  ing: { name: string; code?: string; gPerPiece: number },
  subIndex: Map<string, Recipe>,
  via: string[],
  warnings: ExpansionWarning[],
): ExpandedIngredient[] {
  if (via.length >= MAX_DEPTH) {
    warnings.push({ type: 'depth', via, code: ing.code || '', name: ing.name });
    return [{ name: ing.name, code: ing.code, gPerPiece: ing.gPerPiece, via }];
  }
  const k = keyOf(ing.code);
  // 반제품이 아니면 그대로 leaf
  if (!k || !subIndex.has(k)) {
    return [{ name: ing.name, code: ing.code, gPerPiece: ing.gPerPiece, via }];
  }
  // 사이클 감지
  if (via.includes(k)) {
    warnings.push({ type: 'cycle', via, code: ing.code || '', name: ing.name });
    return [{ name: ing.name, code: ing.code, gPerPiece: ing.gPerPiece, via }];
  }
  const sub = subIndex.get(k)!;
  const nextVia = [...via, k];
  const out: ExpandedIngredient[] = [];
  (sub.ingredients || []).forEach((sIng) => {
    const subG = (sIng.gPerPiece || 0) * ing.gPerPiece;  // 반제품 1g 당 원물 g × 제품에 들어간 반제품 g
    if (subG <= 0) return;
    const expanded = expandOne({ name: sIng.name, code: sIng.code, gPerPiece: subG }, subIndex, nextVia, warnings);
    out.push(...expanded);
  });
  return out;
}

/** 원재료 리스트 통째로 펼치기 (제품 BOM → leaf 원물 BOM) */
export function expandIngredients(
  ingredients: { name: string; code?: string; gPerPiece: number }[],
  subRecipeMap: Map<string, Recipe>,
): { expanded: ExpandedIngredient[]; warnings: ExpansionWarning[] } {
  const subIndex = indexSubRecipes(subRecipeMap);
  const warnings: ExpansionWarning[] = [];
  const expanded: ExpandedIngredient[] = [];
  ingredients.forEach((ing) => {
    expanded.push(...expandOne(ing, subIndex, [], warnings));
  });
  return { expanded, warnings };
}

/** Recipe 전체를 펼친 새 Recipe 로 반환 (ingredients 만 교체) */
export function expandRecipe(recipe: Recipe, subRecipeMap: Map<string, Recipe>): Recipe {
  if (!subRecipeMap || subRecipeMap.size === 0) return recipe;
  const { expanded } = expandIngredients(recipe.ingredients || [], subRecipeMap);
  // 같은 (코드/이름) 으로 중복되면 g 합산
  const merged = new Map<string, ExpandedIngredient & { seq: number }>();
  expanded.forEach((x) => {
    const k = x.code ? `c:${keyOf(x.code)}` : `n:${(x.name || '').trim()}`;
    const prev = merged.get(k);
    if (prev) prev.gPerPiece += x.gPerPiece;
    else merged.set(k, { ...x, seq: merged.size + 1 });
  });
  return { ...recipe, ingredients: Array.from(merged.values()).map((x, i) => ({ seq: i + 1, name: x.name, code: x.code, gPerPiece: x.gPerPiece })) };
}

/** Recipe Map 전체 펼치기 (분석 진입 전 1회 호출). subRecipeMap 비어있으면 원본 그대로 반환 */
export function expandRecipeMap(
  recipeMap: Map<string, Recipe>,
  subRecipeMap: Map<string, Recipe>,
): Map<string, Recipe> {
  if (!subRecipeMap || subRecipeMap.size === 0) return recipeMap;
  const out = new Map<string, Recipe>();
  recipeMap.forEach((r, k) => out.set(k, expandRecipe(r, subRecipeMap)));
  return out;
}

/** AmbientRecipe 펼치기 — 반제품 레시피는 개당(1EA) 기준이므로 실온 레시피도 개당으로 맞춘 뒤 합친다.
 *  과거 배합당 기준(batchPieces>1) 데이터가 남아 있어도 여기서 개당으로 환산하고 batchPieces=1 로 반환하므로
 *  단위가 어긋나지 않는다. (환산 안 하면 반제품 몫이 batchPieces 배만큼 과소계상됨) */
export function expandAmbientRecipe(recipe: AmbientRecipe, subRecipeMap: Map<string, Recipe>): AmbientRecipe {
  if (!subRecipeMap || subRecipeMap.size === 0) return recipe;
  const bp = recipe.batchPieces || 1;
  // 개당 g 로 환산해서 반제품(gPerPiece)과 단위를 맞춘다
  const ings = (recipe.ingredients || []).map((i) => ({ name: i.name, code: i.code, gPerPiece: (i.gPerBatch || 0) / bp }));
  const { expanded } = expandIngredients(ings, subRecipeMap);
  const merged = new Map<string, { name: string; code?: string; gPerBatch: number; seq: number }>();
  expanded.forEach((x) => {
    const k = x.code ? `c:${keyOf(x.code)}` : `n:${(x.name || '').trim()}`;
    const prev = merged.get(k);
    if (prev) prev.gPerBatch += x.gPerPiece;
    else merged.set(k, { name: x.name, code: x.code, gPerBatch: x.gPerPiece, seq: merged.size + 1 });
  });
  // 개당 기준으로 환산했으므로 나눔 계수는 1
  return { ...recipe, batchPieces: 1, ingredients: Array.from(merged.values()).map((x, i) => ({ seq: i + 1, name: x.name, code: x.code, gPerBatch: x.gPerBatch })) };
}

export function expandAmbientRecipeMap(
  ambientRecipeMap: Map<string, AmbientRecipe>,
  subRecipeMap: Map<string, Recipe>,
): Map<string, AmbientRecipe> {
  if (!subRecipeMap || subRecipeMap.size === 0) return ambientRecipeMap;
  const out = new Map<string, AmbientRecipe>();
  ambientRecipeMap.forEach((r, k) => out.set(k, expandAmbientRecipe(r, subRecipeMap)));
  return out;
}
