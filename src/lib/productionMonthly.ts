/** 월별 생산수량 (원재료수율 분석 전용) — 앱을 쓰기 전 달(작년 등)의 마감 기준 품목별 생산수량.
 *
 *  Firestore `productionMonthly/{YYYY-MM}` =
 *    { month, cold: { 단축코드: 수량 }, ambient: { 정규화제품명: 수량 }, names: { 키: 표시명 }, total, rows, updatedAt }
 *
 *  · 날짜별 생산 화면(현황판·월별현황)과 섞지 않는다. 원재료수율 분석만 읽는다.
 *  · 그 달에 앱 생산 데이터가 없을 때만 쓴다 (있으면 앱 데이터 우선).
 *  · 냉장은 품목코드(단축코드), 실온이유식은 제품명으로 레시피와 연결한다 — 앱과 같은 규칙.
 */
import { canonicalShort } from './codeUtil';

export const PM_COL = 'productionMonthly';

export interface ProductionMonthlyDoc {
  month: string;
  cold: Record<string, number>;
  ambient: Record<string, number>;
  names: Record<string, string>;
  total: number;
  rows: number;
  updatedAt: string;
}

export interface PmRow {
  line: number;
  raw: string;          // 붙여넣은 코드(또는 제품명) 원본
  name: string;
  qty: number;
  kind: 'cold' | 'ambient';
  key: string;          // 냉장: 단축코드 / 실온: 정규화 제품명
}

/** 실온 레시피 문서 ID 와 같은 규칙 (공백 없앤 소문자) */
export const ambientKey = (name: string) => (name || '').trim().toLowerCase().replace(/\s+/g, '');

/** 품목코드처럼 생겼나 (A-001-01, F553, PB-Z-001 …). 아니면 실온 제품명으로 본다 */
export const looksLikeCode = (s: string) => /^(PB-)?[A-Za-z]{1,3}-?\d{1,4}(-\d{1,3})?$/.test(s.trim());

/** 붙여넣기 → 행. 형식: 코드 / (품목명) / 생산수량 — 탭·쉼표·여러 칸 공백 구분, 머리글 자동 무시.
 *  수량은 그 줄의 '마지막 숫자 칸'. 같은 코드가 여러 줄이면 합친다. */
export function parseProductionPaste(text: string): { rows: PmRow[]; errors: string[] } {
  const rows: PmRow[] = [];
  const errors: string[] = [];
  text.split('\n').forEach((line0, i) => {
    const line = line0.replace(/\r/g, '');
    if (!line.trim()) return;
    let cells: string[];
    if (line.includes('\t')) cells = line.split('\t');
    else if (line.includes(',') && !/\d,\d{3}/.test(line)) cells = line.split(',');
    else {
      // 공백 구분: 첫 칸이 코드면 [코드, 품목명…, 수량], 아니면 [제품명…, 수량]
      const t = line.trim().split(/\s+/);
      cells = t.length <= 2 ? t : looksLikeCode(t[0]) ? [t[0], t.slice(1, -1).join(' '), t[t.length - 1]] : [t.slice(0, -1).join(' '), t[t.length - 1]];
    }
    cells = cells.map((c) => c.trim()).filter((c) => c !== '');
    if (cells.length < 2) { errors.push(`${i + 1}행: 칸이 부족합니다 — "${line.trim().slice(0, 40)}"`); return; }
    const qtyRaw = cells[cells.length - 1].replace(/[,\s]/g, '');
    const qty = Number(qtyRaw);
    if (!isFinite(qty) || qtyRaw === '') {
      // 머리글(코드 / 품목명 / 생산수량)은 조용히 건너뛴다
      if (i === 0 || /수량|코드|품목|제품|qty/i.test(line)) return;
      errors.push(`${i + 1}행: 수량을 읽을 수 없음 — "${cells[cells.length - 1]}"`);
      return;
    }
    if (qty <= 0) return;
    const first = cells[0];
    const name = cells.length >= 3 ? cells.slice(1, -1).join(' ') : '';
    if (looksLikeCode(first)) {
      rows.push({ line: i + 1, raw: first, name, qty, kind: 'cold', key: canonicalShort(first) });
    } else {
      // 코드가 아니면 실온이유식 제품명 (실온 레시피는 제품명이 키)
      rows.push({ line: i + 1, raw: first, name: name || first, qty, kind: 'ambient', key: ambientKey(first) });
    }
  });
  return { rows, errors };
}

/** 행 → 저장 문서 (같은 키 합산) */
export function toDoc(month: string, rows: PmRow[]): ProductionMonthlyDoc {
  const cold: Record<string, number> = {};
  const ambient: Record<string, number> = {};
  const names: Record<string, string> = {};
  rows.forEach((r) => {
    const bucket = r.kind === 'cold' ? cold : ambient;
    bucket[r.key] = (bucket[r.key] || 0) + r.qty;
    if (!names[r.key]) names[r.key] = r.kind === 'cold' ? (r.name || r.raw) : r.raw;
  });
  const total = rows.reduce((s, r) => s + r.qty, 0);
  return { month, cold, ambient, names, total, rows: rows.length, updatedAt: new Date().toISOString() };
}

/** 저장된 월별 수량을 원재료수율 분석의 '한 달 원자료' 모양으로 바꾼다.
 *  냉장: 그 달 1일 하루에 품목별 잔여량(logisticsByCode)으로 넣으면 앱의 생산량 규칙(계획 0 + 잔여)이 그대로 수량이 된다.
 *  실온: 제품명 + 수량 한 줄씩. */
export function toRawMonth(d: ProductionMonthlyDoc) {
  const day = `${d.month}-01`;
  const perCode: Record<string, number> = { ...d.cold };
  const coldTotal = Object.values(perCode).reduce((s, v) => s + v, 0);
  return {
    entries: [],
    items: [],
    ambient: Object.entries(d.ambient).map(([k, qty]) => ({ productName: d.names[k] || k, category: '', qty, date: day })),
    logistics: coldTotal > 0 ? { [day]: coldTotal } : {},
    logisticsByCode: coldTotal > 0 ? { [day]: perCode } : {},
  };
}
