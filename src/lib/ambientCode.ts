/** 실온이유식 ERP 품목코드 ↔ 실온 레시피(제품명 키) 연결
 *
 *  ERP 품목명:  [베본]실완_한우야채진밥 · [베본]실후_TOGO 한우참깨애호박죽 · [본키]실_한우야채죽
 *  레시피 이름:  순수본_한우야채진밥     · TOGO_한우참깨애호박죽            · 본죽키즈_한우야채죽
 *
 *  규칙: ERP 이름에서 [브랜드] 와 단계 접두어(실초_/실중_/실후_/실완_/실_)를 떼고,
 *        레시피 이름에서 브랜드 접두어(순수본_/본죽키즈_)를 뗀 뒤 공백·_ 를 없애 비교한다.
 *        TOGO 는 제품명의 일부로 남겨 순수본 같은 이름과 구분한다.
 *        같은 이름이 여러 브랜드에 있으면 [베본]→순수본, [본키]→본죽키즈 로 고른다.
 */

export interface AmbRecipeRef { id: string; name: string; code?: string }
export interface AmbCodeRow {
  line: number;
  code: string;
  erpName: string;
  recipeId: string | null;      // 자동 매칭 결과
  candidates: AmbRecipeRef[];   // 같은 핵심 이름 후보
  why: string;                  // 못 찾았거나 애매할 때 이유
}

const BRAND_OF: Record<string, string> = { 베본: '순수본', 본키: '본죽키즈', 순수본: '순수본', 본죽키즈: '본죽키즈' };
const RECIPE_BRANDS = ['순수본', '본죽키즈'];

const squash = (s: string) => s.toLowerCase().replace(/[\s_\-·.]/g, '');

/** ERP 품목명 → { brand, key } */
export function erpNameKey(erpName: string): { brand: string | null; key: string } {
  let s = (erpName || '').trim();
  let brand: string | null = null;
  const m = s.match(/^\[([^\]]+)\]\s*/);
  if (m) { brand = BRAND_OF[m[1].trim()] || m[1].trim(); s = s.slice(m[0].length); }
  s = s.replace(/^실(초|중|후|완)?\s*_\s*/, '');
  return { brand, key: squash(s) };
}

/** 레시피 이름 → { brand, key } */
export function recipeNameKey(name: string): { brand: string | null; key: string } {
  const s = (name || '').trim();
  for (const b of RECIPE_BRANDS) {
    if (s.startsWith(`${b}_`)) return { brand: b, key: squash(s.slice(b.length + 1)) };
  }
  return { brand: null, key: squash(s) };
}

/** 붙여넣기(코드 / ERP 품목명) → 행. 탭·쉼표·공백 구분, 머리글 무시 */
export function parseAmbCodes(text: string): { code: string; erpName: string; line: number }[] {
  const out: { code: string; erpName: string; line: number }[] = [];
  text.split('\n').forEach((l0, i) => {
    const l = l0.replace(/\r/g, '').trim();
    if (!l) return;
    let code = ''; let name = '';
    if (l.includes('\t')) { const c = l.split('\t').map((x) => x.trim()).filter(Boolean); code = c[0] || ''; name = c.slice(1).join(' '); }
    else { const k = l.search(/\s/); if (k > 0) { code = l.slice(0, k); name = l.slice(k).trim(); } }
    if (!code || !name || /코드|품목/.test(code)) return;
    out.push({ code: code.trim(), erpName: name, line: i + 1 });
  });
  return out;
}

export function matchAmbCodes(rows: { code: string; erpName: string; line: number }[], recipes: AmbRecipeRef[]): AmbCodeRow[] {
  const byKey = new Map<string, AmbRecipeRef[]>();
  recipes.forEach((r) => {
    const k = recipeNameKey(r.name).key;
    byKey.set(k, [...(byKey.get(k) || []), r]);
  });
  return rows.map((r) => {
    const e = erpNameKey(r.erpName);
    const cands = byKey.get(e.key) || [];
    let pick: AmbRecipeRef | undefined;
    let why = '';
    if (cands.length === 1) pick = cands[0];
    else if (cands.length > 1) {
      const sameBrand = cands.filter((c) => recipeNameKey(c.name).brand === e.brand);
      if (sameBrand.length === 1) pick = sameBrand[0];
      else why = `같은 이름 레시피가 ${cands.length}개 — 직접 고르세요`;
    } else why = '같은 이름 레시피 없음 — 직접 고르거나 레시피를 먼저 등록하세요';
    return { line: r.line, code: r.code, erpName: r.erpName, recipeId: pick ? pick.id : null, candidates: cands, why };
  });
}
