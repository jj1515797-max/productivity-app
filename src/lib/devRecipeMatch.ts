/** 개발 배합비 시트 → 분석용 레시피 자동 매칭
 *
 *  개발에서 받은 배합비 시트에는 보통 이런 문제가 있다.
 *   · ERP 코드가 없다
 *   · 원재료명이 제각각이다 (녹두 / 간녹두, 곤드레 / 고려엉겅퀴, 소스류)
 *   · 원재료를 쪼개 놓았다 (멥쌀이 두 줄)
 *
 *  ※ 쪼개진 줄은 합치지 않는다. 개발 시트를 준 그대로 저장한다.
 *    같은 코드가 여러 줄이어도 사용량 계산 단계에서 코드 기준으로 합산되므로
 *    결과는 같고, 대신 원본 배합비 구조가 그대로 남아 나중에 대조할 수 있다.
 *
 *  대신 우리에겐 이미 제품별 BOM(recipes)이 있다. 제품코드를 알면
 *  후보가 그 제품 BOM 안의 원재료 몇 개로 줄어든다. '전체에서 이름 찾기'가
 *  아니라 '소수 후보 중 고르기'가 되므로 정확도가 크게 올라간다.
 *
 *  매칭은 절대 조용히 확정하지 않는다. 근거와 확신도를 같이 돌려주고
 *  사람이 화면에서 확인·수정하게 한다.
 */
import { canonicalShort, normalizeCode } from './codeUtil';
import { normalizeMaterialName } from './wasteCompute';

/** 이름 비교용 정규화 — 괄호주석·공정어·단위 표기를 털어낸다.
 *  '한우(익,민찌)' 와 '한우' 를 같은 것으로 보되, '녹두' 와 '간녹두' 는 다르게 둔다. */
const NOISE = [
  '전처리', '세척', '자숙', '데침', '데치기', '해동', '건조', '분쇄', '세절',
  '국내산', '수입산', '냉동', '냉장', '실온', '유기농', '무농약', '친환경',
];
export function cleanName(raw: string): string {
  let s = normalizeMaterialName(raw);
  s = s.replace(/\([^)]*\)/g, '');          // 괄호 주석 제거
  s = s.replace(/\[[^\]]*\]/g, '');
  s = s.replace(/[0-9]+(\.[0-9]+)?(kg|g|mm|cm|%|호)/g, '');   // 규격 표기
  NOISE.forEach((w) => { s = s.split(normalizeMaterialName(w)).join(''); });
  s = s.replace(/[-_/,·.·’'"`~!@#$^&*+=|\\:;<>?]/g, '');
  return s.trim();
}

/** 한글 음절을 자모로 분해한다.
 *  '맵쌀' 과 '멥쌀' 은 글자 단위로는 완전히 다른 문자지만
 *  자모로 펴면 ㅁㅐㅂㅆㅏㄹ / ㅁㅔㅂㅆㅏㄹ 로 6자 중 5자가 같다.
 *  두 글자짜리 원재료명이 많은 한글에서 오타·표기차를 잡으려면 이 단계가 꼭 필요하다. */
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
export function toJamo(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c >= 0 && c <= 11171) {
      out += CHO[Math.floor(c / 588)] + JUNG[Math.floor((c % 588) / 28)] + (JONG[c % 28] !== ' ' ? JONG[c % 28] : '');
    } else out += ch;
  }
  return out;
}

/** '소스류' 처럼 붙은 분류 접미사를 뗀다. 남는 말이 2자 이상일 때만. */
export function stripGroupSuffix(s: string): string {
  const m = s.match(/^(.*?)(류|등|외|군)$/);
  if (m && m[1].length >= 2) return m[1];
  return s;
}

/** 문자 bigram Dice 계수 (0~1). 한글 이름 비교에 안정적이다. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const dice = (x: string, y: string) => {
    const gx = grams(x), gy = grams(y);
    let hit = 0, nx = 0, ny = 0;
    gx.forEach((v) => { nx += v; });
    gy.forEach((v) => { ny += v; });
    gx.forEach((v, k) => { const w = gy.get(k); if (w) hit += Math.min(v, w); });
    return nx + ny === 0 ? 0 : (2 * hit) / (nx + ny);
  };
  // 글자 단위와 자모 단위를 같이 본다. 짧은 이름일수록 자모 쪽이 결정적이다.
  const byChar = dice(a, b);
  const byJamo = dice(toJamo(a), toJamo(b));
  return Math.max(byChar, byJamo * 0.95);
}

/** 같은 재료인데 이름이 아예 다른 경우 — 문자열로는 절대 못 잡는다.
 *  현장에서 실제로 쓰이는 쌍만 최소한으로 둔다. 나머지는 잔여 1:1 배정이 맡는다. */
export const SYNONYMS: [string, string][] = [
  ['곤드레', '고려엉겅퀴'],
  ['취나물', '참취'],
  ['비름나물', '참비름'],
  ['방풍나물', '갯기름나물'],
  ['얼갈이', '얼갈이배추'],
  ['알타리', '총각무'],
  ['부추', '정구지'],
  ['깻잎', '들깻잎'],
  ['당면', '전분당면'],
  ['멸치', '멸치액젓'],
];
const SYN = new Map<string, string[]>();
SYNONYMS.forEach(([a, b]) => {
  const ka = normalizeMaterialName(a), kb = normalizeMaterialName(b);
  SYN.set(ka, [...(SYN.get(ka) || []), kb]);
  SYN.set(kb, [...(SYN.get(kb) || []), ka]);
});
export function isSynonym(a: string, b: string): boolean {
  const ka = normalizeMaterialName(a), kb = normalizeMaterialName(b);
  return (SYN.get(ka) || []).includes(kb);
}

export interface BomIngredient {
  name: string;
  code?: string;
  src?: MatSource;
}
/** 제품코드(canonicalShort) → 그 제품 BOM 의 원재료들 */
export type BomIndex = Map<string, BomIngredient[]>;

/** 후보 원재료의 출처.
 *  BOM 에 아예 없는 원재료가 실제로 있다 — 정제수처럼 배합비에는 있지만
 *  현장 BOM 에는 안 넣은 것. 그래서 설정 › 원재료 ERP 코드까지 후보에 넣어야 한다. */
export type MatSource = 'bom' | 'erp';
export const SRC_LABEL: Record<MatSource, string> = { bom: 'BOM', erp: '원재료 ERP코드' };

/** 원재료 마스터 (전 제품 통합) — 제품 BOM 에서 못 찾았을 때의 2차 후보 */
export interface MasterIngredient {
  name: string;
  code: string;
  /** 이 원재료가 등장하는 제품 수 — 동점일 때 흔한 쪽을 택하는 근거 */
  uses: number;
  src: MatSource;
}

export type MatchKind =
  | 'exact'        // 정규화 이름 완전일치 (같은 제품 BOM 안)
  | 'clean'        // 잡음 제거 후 일치
  | 'contains'     // 포함관계 (소스류 ⊂ 불고기소스)
  | 'fuzzy'        // 유사도
  | 'master'       // 그 제품 BOM 엔 없고 전체 마스터에서 찾음
  | 'leftover'     // 짝이 안 지어진 것끼리 남아서 배정 (이름이 아예 달라도 잡힌다)
  | 'none';        // 실패

export interface Candidate {
  name: string;
  code: string;
  score: number;
  kind: MatchKind;
  src: MatSource;
}

export interface MatchResult {
  /** 개발 시트의 원본 이름 */
  raw: string;
  code: string;          // 확정된 ERP 코드 ('' = 미확정)
  name: string;          // 확정된 원재료명 (BOM 표기)
  kind: MatchKind;
  score: number;
  /** 사람이 고를 수 있는 후보 (점수순, 자기 자신 포함) */
  candidates: Candidate[];
  /** true = 눈으로 확인 필요 */
  needsReview: boolean;
  /** 확정하지 못한 이유 (미확정일 때만) — 화면에 그대로 보여준다 */
  why?: string;
}

const EXACT_MIN = 0.999;
/** 이 아래는 후보로만 제시하고 자동 확정하지 않는다 */
export const AUTO_MIN = 0.72;

/** 개발 시트의 원재료명 하나를 매칭한다.
 *  @param prodShort 제품 단축코드 (A01 등). BOM 후보를 좁히는 데 쓴다. */
export function matchIngredient(
  rawName: string,
  prodShort: string,
  bom: BomIndex,
  master: MasterIngredient[],
): MatchResult {
  const raw = (rawName || '').trim();
  const n = normalizeMaterialName(raw);
  const c = cleanName(raw);
  const out = (code: string, name: string, kind: MatchKind, score: number, cands: Candidate[]): MatchResult => {
    let why: string | undefined;
    if (!code) {
      const a = cands[0], bb = cands[1];
      if (!a || a.score < AUTO_MIN) {
        why = a
          ? `가장 비슷한 게 ${a.name} ${Math.round(a.score * 100)}% — 기준 ${Math.round(AUTO_MIN * 100)}% 미달`
          : '비교할 후보가 없습니다';
      } else if (bb && a.score - bb.score < 0.12) {
        why = `${a.name} ${Math.round(a.score * 100)}% 와 ${bb.name} ${Math.round(bb.score * 100)}% 가 비슷해 하나로 못 정했습니다`;
      } else {
        why = `${a.name} ${Math.round(a.score * 100)}% — 확정 기준에 못 미쳐 직접 고르셔야 합니다`;
      }
    }
    return {
      raw, code, name, kind, score, candidates: cands,
      needsReview: kind !== 'exact' && kind !== 'clean' ? true : !code,
      why,
    };
  };

  const scoreList = (list: BomIngredient[], base: MatchKind): Candidate[] => {
    const seen = new Set<string>();
    const cands: Candidate[] = [];
    list.forEach((ing) => {
      const key = normalizeCode(ing.code || '') || normalizeMaterialName(ing.name);
      if (seen.has(key)) return;
      seen.add(key);
      const bn = normalizeMaterialName(ing.name);
      const bc = cleanName(ing.name);
      let score = 0; let kind: MatchKind = base;
      const bs = stripGroupSuffix(bc), cs = stripGroupSuffix(c);
      if (bn === n) { score = 1; kind = 'exact'; }
      else if (bc && bc === c) { score = 0.97; kind = 'clean'; }
      else if (isSynonym(ing.name, raw)) { score = 0.96; kind = 'clean'; }
      else if (bs && cs && (bs.includes(cs) || cs.includes(bs))) {
        // 포함관계 — 짧은 쪽이 긴 쪽에 온전히 들어갈 때만. 길이비로 감점.
        const r = Math.min(bs.length, cs.length) / Math.max(bs.length, cs.length);
        score = 0.75 + 0.2 * r; kind = 'contains';
      } else {
        score = similarity(bc || bn, c || n);
        kind = 'fuzzy';
      }
      cands.push({
        name: ing.name, code: normalizeCode(ing.code || ''), score,
        kind: base === 'master' && kind !== 'exact' ? 'master' : kind,
        src: ing.src || (base === 'master' ? 'erp' : 'bom'),
      });
    });
    return cands.sort((a, b) => b.score - a.score);
  };

  // 1차: 그 제품의 BOM 안에서
  const short = canonicalShort(prodShort);
  const inBom = bom.get(short) || [];
  const c1 = scoreList(inBom, 'fuzzy');
  const best1 = c1[0];
  if (best1 && best1.score >= EXACT_MIN && best1.code) {
    return out(best1.code, best1.name, 'exact', 1, c1.slice(0, 6));
  }
  if (best1 && best1.score >= AUTO_MIN) {
    // 2위와 충분히 벌어져야 자동 확정한다. 붙어 있으면 사람이 고른다.
    const gap = best1.score - (c1[1]?.score ?? 0);
    const decided = best1.code && gap >= 0.08;
    return out(decided ? best1.code : '', decided ? best1.name : '', best1.kind, best1.score, c1.slice(0, 6));
  }

  // 2차: 전체 원재료 마스터
  const c2 = scoreList(master.map((m) => ({ name: m.name, code: m.code, src: m.src })), 'master');
  const best2 = c2[0];
  const merged = [...c1, ...c2]
    .filter((x, i, a) => a.findIndex((y) => y.code === x.code && y.name === x.name) === i)
    .sort((a, b) => b.score - a.score).slice(0, 8);
  if (best2 && best2.score >= AUTO_MIN) {
    const gap = best2.score - (c2[1]?.score ?? 0);
    // 정리 후 이름이 그대로 일치(0.96↑)하면 2위와 조금만 벌어져도 확정한다.
    // 0.12 격차를 요구하면 '정제수' 처럼 비슷한 이름이 마스터에 여럿일 때 영원히 미확정으로 남는다.
    const decided = best2.code && (best2.score >= 0.96 ? gap >= 0.02 : (gap >= 0.12 && best2.score >= 0.9));
    // 이름이 정확히 같으면 BOM 밖에서 찾았어도 헷갈릴 게 없다.
    // (정제수처럼 배합비엔 있고 현장 BOM 엔 없는 원재료가 실제로 있다)
    if (decided && best2.score >= EXACT_MIN) {
      return { raw, code: best2.code, name: best2.name, kind: 'master', score: 1, candidates: merged, needsReview: false };
    }
    return out(decided ? best2.code : '', decided ? best2.name : '', 'master', best2.score, merged);
  }
  return out('', '', 'none', best2?.score ?? 0, merged);
}

export interface DevRow {
  prodCode: string;     // 개발 시트의 제품코드 (원본 표기)
  prodName?: string;
  rawName: string;      // 개발 시트의 원재료명
  pct: number;          // 배합비 % (제품 단위로 보정된 값)
  /** 셀에 '%' 기호가 있었나 — 백분율 서식 판정의 결정적 근거 */
  hadPercentSign?: boolean;
}

/** 배합비 칸에 숫자 대신 이 말이 적혀 있으면 그 줄은 쓰지 않는다는 뜻이다.
 *  (개발 시트에서 뺀 원재료를 지우지 않고 표시만 해두는 경우) */
const SKIP_MARKS = ['삭제', '삭재', '제외', '미사용', '사용안함', '없음', 'x', 'X', '-', 'n/a', 'na'];
export function isSkipMark(v: string): boolean {
  const t = (v || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return false;
  return SKIP_MARKS.some((m) => t === m.toLowerCase() || t.startsWith(m.toLowerCase()));
}

/** 삭제 표시로 건너뛴 줄 — 조용히 버리지 않고 화면에 보여준다 */
export interface SkippedRow {
  prodCode: string;
  rawName: string;
  mark: string;
}

export interface ResolvedRow extends DevRow {
  match: MatchResult;
  /** 배합비 × 포장중량 ÷ 100 (포장중량을 모르면 null) */
  gPerPiece: number | null;
}

export interface ProductReport {
  prodCode: string;      // 원본 표기 그대로
  short: string;
  name: string;
  packWeight: number | null;
  rows: ResolvedRow[];
  pctSum: number;
  /** BOM 에는 있는데 개발 시트엔 없는 원재료 */
  missingFromDev: BomIngredient[];
  /** 배합비 칸에 '삭제' 라고 적혀 건너뛴 줄 */
  skipped: SkippedRow[];
  /** 같은 ERP 코드로 여러 줄이 매칭됨 (개발이 쪼개 놓은 경우).
   *  합치지 않고 그대로 저장한다 — 확인용 정보일 뿐이다. */
  dupCodes: { code: string; name: string; count: number; pct: number }[];
  problems: string[];
}

/** 시트 전체를 제품별로 정리한다 */
export function resolveSheet(
  rows: DevRow[],
  bom: BomIndex,
  master: MasterIngredient[],
  packWeightOf: (short: string) => number | null,
  productNameOf: (short: string) => string,
  skippedRows: SkippedRow[] = [],
): ProductReport[] {
  const byProd = new Map<string, DevRow[]>();
  rows.forEach((r) => {
    const k = r.prodCode.trim();
    if (!k) return;
    if (!byProd.has(k)) byProd.set(k, []);
    byProd.get(k)!.push(r);
  });

  // 삭제 표시된 줄도 제품별로 묶어 둔다 (그 제품에 삭제만 있는 경우도 보여야 한다)
  const skipByProd = new Map<string, SkippedRow[]>();
  skippedRows.forEach((r) => {
    const k = r.prodCode.trim();
    if (!byProd.has(k)) byProd.set(k, []);
    skipByProd.set(k, [...(skipByProd.get(k) || []), r]);
  });

  const out: ProductReport[] = [];
  byProd.forEach((list0, prodCode) => {
    /* 백분율 서식 보정 — 반드시 제품 단위로 판단한다.
       엑셀에서 값으로 붙여넣으면 33.69% 가 0.3369 로 온다. 그때는 합계가 1 근처다.
       반대로 셀에 '%' 가 있거나 합계가 100 근처면 이미 % 이므로 건드리면 안 된다.
       (행마다 '1 이하면 ×100' 을 하면 0.19% 같은 소량 원재료가 19% 로 튄다) */
    const rawSum = list0.reduce((s, r) => s + r.pct, 0);
    const anyPct = list0.some((r) => r.hadPercentSign);
    const scale = (!anyPct && rawSum > 0.9 && rawSum < 1.1) ? 100 : 1;
    const list = scale === 1 ? list0 : list0.map((r) => ({ ...r, pct: r.pct * 100 }));

    const short = canonicalShort(prodCode);
    const pw = packWeightOf(short);
    const resolved: ResolvedRow[] = list.map((r) => {
      const m = matchIngredient(r.rawName, short, bom, master);
      return { ...r, match: m, gPerPiece: pw !== null ? (r.pct / 100) * pw : null };
    });

    /* ===== 잔여 배정 =====
       이름이 아예 다른 경우(곤드레/고려엉겅퀴 같은데 사전에도 없는 것)는 문자열로 못 잡는다.
       그런데 다른 재료가 다 짝을 찾고 나면 양쪽에 남는 게 얼마 없다.
       BOM 에서 아직 아무도 안 가져간 원재료만 후보로 좁혀 다시 본다.
       단, 최소한의 유사성은 있어야 한다 — 아무거나 남았다고 붙이면 조용히 틀린다. */
    const LEFTOVER_MIN = 0.35;
    const claimed = new Set(resolved.map((r) => r.match.code).filter(Boolean));
    // 시트에서 '삭제' 라고 한 원재료는 잔여 후보에서 빼야 한다.
    // 안 빼면 '알배추 삭제' 인데 남아 있다는 이유로 '양배추' 에 붙어버린다.
    const skipClean = new Set((skipByProd.get(prodCode) || []).map((x) => cleanName(x.rawName)));
    const unused = (bom.get(short) || []).filter((ing) => {
      const c = normalizeCode(ing.code || '');
      return c && !claimed.has(c) && !skipClean.has(cleanName(ing.name));
    });
    const pending = resolved.filter((r) => !r.match.code);
    if (unused.length > 0 && pending.length > 0) {
      const unusedCodes = new Set(unused.map((u) => normalizeCode(u.code || '')));
      // 양쪽에 딱 하나씩만 남았으면 소거법으로 정해진다.
      // 이름이 하나도 안 겹쳐도(소고기 ↔ 한우(익,민찌)) 다른 후보가 없으므로 그것이다.
      // 다만 반드시 '확인 필요' 로 표시해 사람이 눈으로 보게 한다.
      const onlyPair = unused.length === 1 && pending.length === 1;
      pending.forEach((r) => {
        const cands = r.match.candidates.filter((c) => unusedCodes.has(c.code));
        const only = unused[0];
        const best = cands[0]
          || (onlyPair ? { name: only.name, code: normalizeCode(only.code || ''), score: 0, kind: 'leftover' as MatchKind, src: 'bom' as MatSource } : undefined);
        if (!best || !best.code) return;
        if (!onlyPair && best.score < LEFTOVER_MIN) return;
        const gap = best.score - (cands[1]?.score ?? 0);
        if (onlyPair || unused.length === 1 || gap >= 0.1) {
          r.match = { ...r.match, code: best.code, name: best.name, kind: 'leftover', score: best.score, needsReview: true };
        }
      });
    }

    const pctSum = resolved.reduce((s, r) => s + r.pct, 0);

    // 같은 코드로 여러 줄 → 개발이 쪼개 놓은 것. 합치지 않고 알리기만 한다.
    const byCode = new Map<string, { name: string; count: number; pct: number }>();
    resolved.forEach((r) => {
      const c = r.match.code;
      if (!c) return;
      const e = byCode.get(c) || { name: r.match.name, count: 0, pct: 0 };
      e.count++; e.pct += r.pct;
      byCode.set(c, e);
    });
    const dupCodes = [...byCode.entries()].filter(([, v]) => v.count > 1)
      .map(([code, v]) => ({ code, ...v }));

    // BOM 에는 있는데 개발 시트엔 없는 것
    const got = new Set(resolved.map((r) => r.match.code).filter(Boolean));
    // 삭제 표시된 원재료는 '시트에 없다' 고 또 경고하지 않는다 — 일부러 뺀 것이다
    const skippedNames = new Set((skipByProd.get(prodCode) || []).map((x) => cleanName(x.rawName)));
    const missingFromDev = (bom.get(short) || []).filter((ing) => {
      const c = normalizeCode(ing.code || '');
      return c && !got.has(c) && !skippedNames.has(cleanName(ing.name));
    });

    const problems: string[] = [];
    if (pw === null) problems.push('포장중량 미등록 — 설정 › 제품 DB 에서 입력해야 g 으로 환산됩니다');
    if (Math.abs(pctSum - 100) > 0.5) problems.push(`배합비 합계가 ${pctSum.toFixed(2)}% 입니다 (100% 이어야 함)`);
    const un = resolved.filter((r) => !r.match.code).length;
    if (un > 0) problems.push(`${un}건 ERP 코드 미확정 — 후보에서 골라야 합니다`);
    const rv = resolved.filter((r) => r.match.code && r.match.needsReview).length;
    if (rv > 0) problems.push(`${rv}건 자동 매칭됨 — 눈으로 확인 권장`);
    if (missingFromDev.length > 0) problems.push(`BOM 에 있는데 시트에 없는 원재료 ${missingFromDev.length}종`);
    if (!bom.has(short)) problems.push('이 제품의 기존 BOM 이 없어 후보를 좁히지 못했습니다');

    out.push({
      prodCode, short, name: productNameOf(short), packWeight: pw,
      rows: resolved, pctSum, missingFromDev, dupCodes, problems,
      skipped: skipByProd.get(prodCode) || [],
    });
  });
  return out.sort((a, b) => a.short.localeCompare(b.short));
}

/** 붙여넣기 파싱 — 제품코드 / (제품명) / 원재료명 / 배합비%
 *  헤더가 있으면 열 위치를 찾아 쓰고, 없으면 열 개수로 추정한다. */
export function parseDevSheet(text: string): {
  rows: DevRow[]; skipped: SkippedRow[]; errors: string[]; headerUsed: boolean;
} {
  const errors: string[] = [];
  const skipped: SkippedRow[] = [];
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { rows: [], skipped: [], errors: ['데이터가 없습니다'], headerUsed: false };

  const split = (l: string) => (l.includes('\t') ? l.split('\t') : l.split(',')).map((c) => c.trim());
  const norm = (s: string) => s.replace(/\s+/g, '').replace(/\([^)]*\)/g, '').toLowerCase();

  const head = split(lines[0]).map(norm);
  const findCol = (...cands: string[]) => head.findIndex((h) => cands.some((c) => h.includes(c)));
  let ci = findCol('품목코드', '제품코드', '코드');
  let ni = findCol('원재료', '재료명', '원료');
  let pi = findCol('배합비', '비율', '%');
  let mi = findCol('제품명', '품목명');
  let start = 1;
  const headerUsed = ci >= 0 && ni >= 0 && pi >= 0;
  if (!headerUsed) {
    // 헤더가 없다 — 열 개수로 추정 (코드 / 이름 / % 또는 코드 / 제품명 / 이름 / %)
    const w = split(lines[0]).length;
    ci = 0; mi = w >= 4 ? 1 : -1; ni = w >= 4 ? 2 : 1; pi = w >= 4 ? 3 : 2;
    start = 0;
  }

  const rows: DevRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const cells = split(lines[i]);
    const prodCode = (cells[ci] || '').trim();
    const rawName = (cells[ni] || '').trim();
    const pctRaw = (cells[pi] || '').trim().replace(/,/g, '').replace('%', '');
    if (!prodCode && !rawName) continue;
    if (!prodCode) { errors.push(`${i + 1}행: 제품코드 없음 — "${lines[i].trim().slice(0, 40)}"`); continue; }
    if (!rawName) { errors.push(`${i + 1}행: 원재료명 없음`); continue; }
    // 배합비 칸에 '삭제' 라고 적힌 줄은 오류가 아니라 '빼라는 뜻' 이다
    if (isSkipMark(pctRaw)) { skipped.push({ prodCode, rawName, mark: pctRaw }); continue; }
    const pct = parseFloat(pctRaw);
    if (!isFinite(pct)) { errors.push(`${i + 1}행: 배합비를 읽을 수 없음 — "${pctRaw}"`); continue; }
    // ⚠ 여기서 '1 이하면 ×100' 같은 행 단위 판정을 하면 안 된다.
    //    0.19% 처럼 소량 원재료는 실제로 1% 미만이라 100배로 부풀려진다.
    //    백분율 서식 판정은 제품 단위 합계를 보고 resolveSheet 에서 한다.
    rows.push({
      prodCode, prodName: mi >= 0 ? (cells[mi] || '').trim() : '', rawName, pct,
      hadPercentSign: (cells[pi] || '').includes('%'),
    });
  }
  return { rows, skipped, errors, headerUsed };
}
