/** 원재료 카테고리 DB — ERP 코드 기준 분류
 *
 *  Firestore: materialCategories/{docId} = { code, name, category }
 *    · code     : 원재료 ERP 코드 (있으면 이게 1순위 매칭키)
 *    · name     : 원재료명 (코드가 없거나 실투입이 이름키로 들어온 경우의 2순위 매칭키)
 *    · category : 사용자가 직접 정하는 분류명 (육류, 해산물, 잎채소류, 잡곡 및 견과류 …)
 *
 *  분석 화면은 이 분류로 원재료를 묶어 카테고리 타일을 만든다.
 *  매칭이 안 되는 원재료는 반드시 '미분류' 로 남겨 화면에 띄운다 —
 *  조용히 빼면 카테고리 합 ≠ 전체가 되어 숫자를 못 믿게 된다.
 */
import { normalizeCode } from './codeUtil';
import { normalizeMaterialName } from './wasteCompute';

export const UNCLASSIFIED = '미분류';

export interface CategoryDoc {
  id: string;
  code: string;
  name: string;
  category: string;
}

/** 코드/이름 → 카테고리 조회용 색인 */
export interface CategoryIndex {
  byCode: Map<string, string>;
  byName: Map<string, string>;
  /** 등록된 카테고리 이름들 (등록 순서 유지) */
  categories: string[];
}

export function buildCategoryIndex(docs: CategoryDoc[]): CategoryIndex {
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();
  const seen = new Set<string>();
  const categories: string[] = [];
  docs.forEach((d) => {
    const cat = (d.category || '').trim();
    if (!cat) return;
    if (!seen.has(cat)) { seen.add(cat); categories.push(cat); }
    const c = normalizeCode(d.code || '');
    if (c) byCode.set(c, cat);
    const n = normalizeMaterialName(d.name || '');
    // 이름은 2순위라 먼저 등록된 것을 이긴다고 보지 않는다 (코드가 정답)
    if (n && !byName.has(n)) byName.set(n, cat);
  });
  return { byCode, byName, categories };
}

/** 원재료 한 건의 카테고리. 못 찾으면 '미분류' */
export function categoryOf(idx: CategoryIndex, code: string, name: string): string {
  const c = normalizeCode(code || '');
  if (c) {
    const hit = idx.byCode.get(c);
    if (hit) return hit;
  }
  const n = normalizeMaterialName(name || '');
  if (n) {
    const hit = idx.byName.get(n);
    if (hit) return hit;
  }
  return UNCLASSIFIED;
}

/** 카테고리 정렬 — 등록 순서대로, '미분류' 는 항상 맨 뒤 */
export function sortCategories(idx: CategoryIndex, names: string[]): string[] {
  const order = new Map(idx.categories.map((c, i) => [c, i]));
  return [...names].sort((a, b) => {
    if (a === UNCLASSIFIED) return 1;
    if (b === UNCLASSIFIED) return -1;
    return (order.get(a) ?? 9999) - (order.get(b) ?? 9999) || a.localeCompare(b);
  });
}

/** 붙여넣기 파싱 — 코드 / 원재료명 / 카테고리
 *  구분자는 탭 또는 쉼표. 원재료명에 쉼표가 들어있는 경우('한우(익,민찌)')를 위해
 *  탭이 하나라도 있으면 탭만 구분자로 쓴다. */
export function parseCategoryPaste(text: string): { rows: Omit<CategoryDoc, 'id'>[]; errors: string[] } {
  const rows: Omit<CategoryDoc, 'id'>[] = [];
  const errors: string[] = [];
  // 줄 전체를 trim 하면 안 된다 — 끝의 빈 셀('11320010\t한우\t')이 사라져
  // 3열짜리가 2열로 둔갑하고, 원재료명이 카테고리로 등록되어 버린다.
  const lines = text.split('\n').filter((l) => l.trim());
  lines.forEach((line, i) => {
    const raw = (line.includes('\t') ? line.split('\t') : line.split(','));
    const cells = raw.map((c) => c.trim());
    // 헤더로 보이는 줄은 건너뛴다
    if (i === 0 && /코드|품목|원재료|분류|카테고리/.test(line) && !/\d{4}/.test(cells[0] || '')) return;
    if (raw.length < 2) { errors.push(`${i + 1}행: 열이 부족합니다 — "${line.trim()}"`); return; }

    let code = '', name = '', category = '';
    if (raw.length >= 3) {
      // 열 개수는 '자른 결과' 로 판단한다 (빈 칸도 하나의 열)
      [code, name, category] = [cells[0] || '', cells[1] || '', cells[2] || ''];
    } else {
      // 2열이면 (코드|이름) + 카테고리
      const isCode = /^\d{4,}$/.test(cells[0].replace(/[-\s]/g, ''));
      if (isCode) { code = cells[0]; } else { name = cells[0]; }
      category = cells[1];
    }
    if (!category) { errors.push(`${i + 1}행: 카테고리가 비었습니다 — "${line.trim()}"`); return; }
    if (!code && !name) { errors.push(`${i + 1}행: 코드도 이름도 없습니다 — "${line.trim()}"`); return; }
    rows.push({ code, name, category });
  });
  return { rows, errors };
}

/** Firestore 문서 ID — 코드가 있으면 코드, 없으면 정규화 이름 */
export function categoryDocId(code: string, name: string): string {
  const c = normalizeCode(code || '');
  if (c) return `c_${c}`;
  return `n_${normalizeMaterialName(name || '')}`;
}
