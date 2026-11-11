/** 노무비분석 — 노무비율 트리 (윤기성 실장 11/6 회의 지시)
 *
 *  공수표의 총인원 = 총공수(가중: 정규 + 연장×1.5 + 초과×2.0) ÷ 8 이고, 생산성(인당 일생산금액) = 생산금액 ÷ 총인원.
 *  → 연장근무는 이미 인당 생산성 안에 들어 있다. 그래서 트리는
 *
 *  노무비율 = 노무비 ÷ 생산금액 = 현장 노무비율 + 통제 밖(관리직 급여·퇴직급여 등)
 *  현장 노무비율 = 시간당 금액 × 가중 총공수 ÷ 생산금액 = 시간당 금액 × 8 ÷ 인당 생산성
 *    · 인당 생산성의 역수(생산금액당 가중 공수)는 정규공수 몫 + 연장(×1.5) 몫 + 초과·휴일(×2.0) 몫으로 더해진다
 *    · 시간당 금액 = 현장 노무비 ÷ 가중 총공수   ← 금액 = 공수 × 시간당 금액
 *  두 달 사이 증감을 로그 평균(LMDI)으로 나누면 몫의 합이 노무비율 증감과 정확히 같다.
 *  (내린 항목만 보면 금액이 맞지 않는다 — 오른 항목과 내린 항목을 같이 본다)
 *
 *  Firestore laborMonthly/{YYYY-MM} = 아래 LaborMonth
 */
export const LABOR_COL = 'laborMonthly';

export interface LaborMonth {
  month: string;
  workDays?: number;
  regularHours: number;      // 정규공수 (h)
  otHours: number;           // 연장근무 (h, ×1.5)
  extraHours: number;        // 연장초과 (h, ×2.0)
  weightedHours?: number;    // 총공수 (가중) — 없으면 정규 + 연장×1.5 + 초과×2.0
  personDays?: number;       // 총인원 (= 총공수 ÷ 8, 참고용)
  avgHeadcount?: number;
  productionAmount: number;  // 생산금액 (원)
  laborCost?: number;        // 노무비 총액 (원)
  laborRatio?: number;       // 노무비율 (%) — 금액이 없을 때
  outsideCost?: number;      // 통제 밖 (관리직 급여·퇴직급여 등, 원)
  updatedAt?: string;
}

export interface LaborMetrics {
  month: string;
  P: number; L: number; Lx: number; Lf: number;
  Hr: number; Ho: number; He: number; Hw: number; days: number; head: number;
  R: number; Rf: number; Rx: number;
  q: number;   // 인당 생산성 = 생산금액 ÷ (총공수 ÷ 8)  — 공수표 「생산성」과 같은 값
  w: number;   // 시간당 금액 (현장 노무비 ÷ 가중 총공수)
  sReg: number; sOt: number; sEx: number;   // 생산 1원당 정규 / 연장×1.5 / 초과×2.0 공수 (합 = Hw/P)
}

export function laborCostOf(m: LaborMonth): number {
  if (m.laborCost && m.laborCost > 0) return m.laborCost;
  if (m.laborRatio && m.laborRatio > 0 && m.productionAmount > 0) return (m.laborRatio / 100) * m.productionAmount;
  return 0;
}

export function metrics(m: LaborMonth): LaborMetrics | null {
  const P = m.productionAmount, L = laborCostOf(m), Hr = m.regularHours;
  if (!(P > 0 && L > 0 && Hr > 0)) return null;
  const Ho = m.otHours || 0, He = m.extraHours || 0;
  const Hw = m.weightedHours && m.weightedHours >= Hr ? m.weightedHours : Hr + 1.5 * Ho + 2 * He;
  const Lx = Math.min(Math.max(m.outsideCost || 0, 0), L);
  const Lf = L - Lx;
  return {
    month: m.month, P, L, Lx, Lf, Hr, Ho, He, Hw, days: m.workDays || 0, head: m.avgHeadcount || 0,
    R: L / P, Rf: Lf / P, Rx: Lx / P,
    q: (8 * P) / Hw, w: Lf > 0 ? Lf / Hw : 0,
    sReg: Hr / P, sOt: (1.5 * Ho) / P, sEx: Math.max(0, Hw - Hr - 1.5 * Ho) / P,   // 초과 몫에 총공수 반올림 차이 포함
  };
}

export type PartKey = 'prod' | 'wage' | 'outside';
export interface SubPart { key: 'reg' | 'ot' | 'ex'; label: string; pp: number; money: number; a: number; b: number }
export interface Part { key: PartKey; label: string; pp: number; money: number; subs?: SubPart[] }

const lmean = (a: number, b: number) => (a > 0 && b > 0 && Math.abs(a - b) > 1e-12 ? (a - b) / (Math.log(a) - Math.log(b)) : a);

/** A → B 노무비율 증감 = 인당 생산성(정규·연장·초과 몫) + 시간당 금액 + 통제 밖  (pp = 비율 소수, money = pp × B 생산금액) */
export function decompose(A: LaborMetrics, B: LaborMetrics): { dR: number; parts: Part[]; money: number } {
  const lw = lmean(B.Rf, A.Rf);
  const ln = (b: number, a: number) => (a > 0 && b > 0 ? Math.log(b / a) : 0);
  const prodPP = -lw * ln(B.q, A.q);
  const wagePP = B.w > 0 && A.w > 0 ? lw * ln(B.w, A.w) : B.Rf - A.Rf - prodPP;
  const SA = A.sReg + A.sOt + A.sEx, SB = B.sReg + B.sOt + B.sEx, LS = lmean(SB, SA);
  const sub = (key: SubPart['key'], label: string, a: number, b: number): SubPart => {
    const pp = LS > 0 ? (lw * (b - a)) / LS : 0;
    return { key, label, pp, money: pp * B.P, a, b };
  };
  const parts: Part[] = [
    {
      key: 'prod', label: '인당 생산성', pp: prodPP, money: prodPP * B.P,
      subs: [sub('reg', '정규공수', A.sReg, B.sReg), sub('ot', '연장근무 (×1.5)', A.sOt, B.sOt), sub('ex', '초과·휴일 (×2.0)', A.sEx, B.sEx)],
    },
    { key: 'wage', label: '시간당 금액', pp: wagePP, money: wagePP * B.P },
    { key: 'outside', label: '통제 밖 (관리직·퇴직급여)', pp: B.Rx - A.Rx, money: (B.Rx - A.Rx) * B.P },
  ];
  const dR = B.R - A.R;
  return { dR, parts, money: dR * B.P };
}

/* ───────── 공수표 붙여넣기 ─────────
 *  머리글: 년 · 월 · 구분 · 근무일수 · 정규공수 · 연장근무 · 연장*1.5 · 연장초과 · 초과*2.0 · 총공수 · 총인원 · 평균인원 · 생산금액 · 생산성
 *  월마다 순수본 / 도급+알바 / 합계 줄 — 합계 줄을 쓰고, 없으면 그 달 줄을 더한다. 병합 셀(빈 년·월)은 위 값을 이어 쓴다. */
export function parseGongsu(text: string): { rows: LaborMonth[]; errors: string[] } {
  const lines = text.split('\n').map((l) => l.split('\t'));
  const norm = (s: string) => (s || '').replace(/[\s*.()]/g, '');
  const hi = lines.findIndex((r) => r.map(norm).includes('정규공수'));
  if (hi < 0) return { rows: [], errors: ['머리글(년 · 월 · 구분 · 정규공수 …) 줄을 같이 붙여넣어 주세요'] };
  const head = lines[hi].map(norm);
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const c = {
    y: col('년', '연도'), m: col('월'), kind: col('구분'), days: col('근무일수'), reg: col('정규공수'),
    ot: col('연장근무', '연장'), ex: col('연장초과', '초과'), tot: col('총공수'), n: col('총인원', '연인원'),
    head: col('평균인원'), amt: col('생산금액'),
  };
  const num = (r: string[], i: number) => { if (i < 0) return 0; const v = Number((r[i] || '').replace(/[,\s원]/g, '')); return Number.isFinite(v) ? v : 0; };
  let y = String(new Date().getFullYear()), mo = '';
  const byMonth = new Map<string, { total?: string[]; parts: string[][] }>();
  for (let i = hi + 1; i < lines.length; i++) {
    const r = lines[i];
    if (r.every((x) => !x.trim())) continue;
    if (c.y >= 0 && r[c.y]?.trim()) y = r[c.y].trim().replace(/[^\d]/g, '') || y;
    if (c.m >= 0 && r[c.m]?.trim()) mo = r[c.m].trim().replace(/[^\d]/g, '') || mo;
    if (!mo) continue;
    const key = `${y.length === 2 ? '20' + y : y}-${mo.padStart(2, '0')}`;
    const kind = c.kind >= 0 ? (r[c.kind] || '').replace(/\s/g, '') : '';
    const e = byMonth.get(key) || { parts: [] };
    if (kind.includes('합계')) e.total = r; else e.parts.push(r);
    byMonth.set(key, e);
  }
  const rows: LaborMonth[] = [];
  const errors: string[] = [];
  byMonth.forEach((e, month) => {
    const src = e.total ? [e.total] : e.parts;
    const sum = (i: number) => src.reduce((s, r) => s + num(r, i), 0);
    const days = e.total ? num(e.total, c.days) : Math.max(...src.map((r) => num(r, c.days)));
    const amt = e.total ? num(e.total, c.amt) : Math.max(...src.map((r) => num(r, c.amt)));   // 생산금액은 합계 줄에만 있는 경우가 많다
    const row: LaborMonth = {
      month, workDays: days, regularHours: sum(c.reg), otHours: sum(c.ot), extraHours: sum(c.ex),
      weightedHours: c.tot >= 0 ? sum(c.tot) : undefined, personDays: sum(c.n),
      avgHeadcount: c.head >= 0 ? sum(c.head) : undefined, productionAmount: amt,
    };
    if (!(row.regularHours > 0)) errors.push(`${month}: 정규공수가 없습니다`);
    rows.push(row);
  });
  rows.sort((a, b) => a.month.localeCompare(b.month));
  return { rows, errors };
}

/** 월별 노무비율 붙여넣기
 *  · 한 줄에 한 달: 「10월 11.2」 「10월 11.2%」 「2026-10 11.2」 (띄어쓰기·탭 모두 — 손으로 칠 땐 탭을 못 넣는다)
 *  · 엑셀 가로: 월 줄 + 값 줄 (한 달만 있어도 됨)
 *  0.092 처럼 1보다 작으면 %로 바꾼다 */
export function parseRatios(text: string, year: string): Record<string, number> {
  const out: Record<string, number> = {};
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const monthOf = (s: string): string | null => {
    let m = s.match(/(\d{4})\s*[-./년]\s*(\d{1,2})/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\s*월?$/);
    if (m && +m[1] >= 1 && +m[1] <= 12) return `${year}-${m[1].padStart(2, '0')}`;
    return null;
  };
  const val = (s: string): number | null => {
    if (!s || /[월년]/.test(s)) return null;
    const v = Number(s.replace(/[%,\s]/g, ''));
    return Number.isFinite(v) && v > 0 ? (v < 1 ? Math.round(v * 1e6) / 1e4 : v) : null;
  };
  // 1) 한 줄에 「월 값」
  const one = /^((?:\d{4}\s*[-./년]\s*)?\d{1,2})\s*(?:월[\s:=]*|[\s:=]+)([\d.]+)\s*%?$/;
  lines.forEach((l) => {
    const m = l.replace(/\t/g, ' ').match(one);
    const mo = m ? monthOf(m[1].trim()) : null;
    const v = m ? val(m[2]) : null;
    if (mo && v !== null) out[mo] = v;
  });
  if (Object.keys(out).length) return out;
  // 2) 가로: 월 줄 + 바로 아래 값 줄 (칸 위치로 짝)
  const cells = (l: string) => (l.includes('\t') ? l.split('\t') : l.split(/\s+/)).map((x) => x.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    const ms = cells(lines[i]).map(monthOf);
    if (!ms.some(Boolean)) continue;
    const vs = cells(lines[i + 1]);
    ms.forEach((m, j) => { const v = m ? val(vs[j] || '') : null; if (m && v !== null) out[m] = v; });
  }
  return out;
}
