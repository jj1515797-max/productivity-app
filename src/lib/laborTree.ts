/** 노무비분석 — 노무비율 트리 (윤기성 실장 11/6 회의 지시)
 *
 *  노무비율 = 노무비 ÷ 생산금액
 *    = 현장 노무비율 + 통제 밖 노무비율(관리직 급여·퇴직급여 등)
 *  현장 노무비율 = 시간당 금액 × (1 + 연장 가중비율) × 1인 1일 정규공수 ÷ 인당 일생산금액
 *    · 인당 일생산금액(생산성) = 생산금액 ÷ 연인원(총인원)
 *    · 1인 1일 정규공수       = 정규공수 ÷ 연인원   (중도 입사·단축 근무가 있으면 인원수가 아니라 정규공수로 봐야 한다)
 *    · 연장 가중비율          = (연장 × 1.5 + 초과 × 2.0) ÷ 정규공수 = 총공수 ÷ 정규공수 − 1
 *    · 시간당 금액            = 현장 노무비 ÷ 총공수(가중)   ← 금액 = 공수 × 시간당 금액
 *  위 식은 정의상 정확히 맞으므로, 두 달 사이 증감을 로그 평균(LMDI)으로 나누면 다섯 몫의 합이 노무비율 증감과 정확히 같다.
 *  (내린 항목만 보면 금액이 맞지 않는다 — 오른 항목과 내린 항목을 같이 본다)
 *
 *  Firestore laborMonthly/{YYYY-MM} = 아래 LaborMonth
 */
export const LABOR_COL = 'laborMonthly';

export interface LaborMonth {
  month: string;
  workDays?: number;
  regularHours: number;      // 정규공수 (h)
  otHours: number;           // 연장근무 (h)
  extraHours: number;        // 연장초과 (h, ×2.0)
  weightedHours?: number;    // 총공수 (가중) — 없으면 정규 + 연장×1.5 + 초과×2.0
  personDays: number;        // 총인원 (연인원)
  avgHeadcount?: number;
  productionAmount: number;  // 생산금액 (원)
  laborCost?: number;        // 노무비 총액 (원)
  laborRatio?: number;       // 노무비율 (%) — 금액이 없을 때
  outsideCost?: number;      // 통제 밖 (관리직 급여·퇴직급여 등, 원)
  packDays?: number;         // 내포장 연인원 (선택) — 생산성을 공정별로 나눌 때
  prepDays?: number;         // 전처리 연인원 (선택)
  updatedAt?: string;
}

export interface LaborMetrics {
  month: string;
  P: number; L: number; Lx: number; Lf: number;
  Hr: number; Ho: number; He: number; Hw: number; N: number; days: number; head: number;
  R: number; Rf: number; Rx: number;
  q: number;   // 인당 일생산금액
  h: number;   // 1인 1일 정규공수
  o: number;   // 연장 가중비율
  w: number;   // 시간당 금액 (현장 노무비 ÷ 가중 공수)
  qh: number;  // 정규공수 1시간당 생산금액
  pack: number; prep: number;   // 공정별 연인원 (없으면 0)
}

export function laborCostOf(m: LaborMonth): number {
  if (m.laborCost && m.laborCost > 0) return m.laborCost;
  if (m.laborRatio && m.laborRatio > 0 && m.productionAmount > 0) return (m.laborRatio / 100) * m.productionAmount;
  return 0;
}

export function metrics(m: LaborMonth): LaborMetrics | null {
  const P = m.productionAmount, L = laborCostOf(m), Hr = m.regularHours, N = m.personDays;
  if (!(P > 0 && L > 0 && Hr > 0 && N > 0)) return null;
  const Ho = m.otHours || 0, He = m.extraHours || 0;
  const Hw = m.weightedHours && m.weightedHours >= Hr ? m.weightedHours : Hr + 1.5 * Ho + 2 * He;
  const Lx = Math.min(Math.max(m.outsideCost || 0, 0), L);
  const Lf = L - Lx;
  const o = Hw / Hr - 1;
  return {
    month: m.month, P, L, Lx, Lf, Hr, Ho, He, Hw, N, days: m.workDays || 0, head: m.avgHeadcount || 0,
    R: L / P, Rf: Lf / P, Rx: Lx / P,
    q: P / N, h: Hr / N, o, w: Lf > 0 ? Lf / Hw : 0, qh: P / Hr,
    pack: m.packDays || 0, prep: m.prepDays || 0,
  };
}

export type PartKey = 'prod' | 'hours' | 'ot' | 'wage' | 'outside';
export interface SubPart { key: string; label: string; pp: number; money: number; a: number; b: number }
export interface Part { key: PartKey; label: string; pp: number; money: number; subs?: SubPart[] }

const lmean = (a: number, b: number) => (a > 0 && b > 0 && Math.abs(a - b) > 1e-12 ? (a - b) / (Math.log(a) - Math.log(b)) : a);

/** A → B 노무비율 증감을 다섯 몫으로 (pp = 비율 소수, money = pp × B 생산금액) */
export function decompose(A: LaborMetrics, B: LaborMetrics): { dR: number; parts: Part[]; money: number } {
  const lw = lmean(B.Rf, A.Rf);
  const ln = (b: number, a: number) => (a > 0 && b > 0 ? Math.log(b / a) : 0);
  const raw: [PartKey, string, number][] = [
    ['prod', '인당 일생산금액', -lw * ln(B.q, A.q)],
    ['hours', '1인 1일 정규공수', lw * ln(B.h, A.h)],
    ['ot', '연장근무', lw * ln(1 + B.o, 1 + A.o)],
    ['wage', '시간당 금액', B.w > 0 && A.w > 0 ? lw * ln(B.w, A.w) : B.Rf - A.Rf],
    ['outside', '통제 밖 (관리직·퇴직급여)', B.Rx - A.Rx],
  ];
  const parts: Part[] = raw.map(([key, label, pp]) => ({ key, label, pp, money: pp * B.P }));

  // 연장근무 → 연장(×1.5) / 초과(×2.0, 총공수와의 차이 포함)  — 1+o = 1 + a + b 이므로 몫이 정확히 나뉜다
  const L1o = lmean(1 + B.o, 1 + A.o);
  const aOf = (M: LaborMetrics) => (1.5 * M.Ho) / M.Hr;
  const ot = parts.find((p) => p.key === 'ot')!;
  if (L1o > 0) {
    const sub = (key: string, label: string, a: number, b: number): SubPart => {
      const pp = (lw * (b - a)) / L1o;
      return { key, label, pp, money: pp * B.P, a, b };
    };
    ot.subs = [
      sub('ot15', '연장 (×1.5) ÷ 정규공수', aOf(A), aOf(B)),
      sub('ot20', '초과·휴일 (×2.0) ÷ 정규공수', A.o - aOf(A), B.o - aOf(B)),
    ];
  }

  // 인당 생산성 → 내포장 / 전처리 / 그 외 (두 달 모두 공정별 연인원이 있을 때) — N/P = Σ Nᵢ/P
  const pa = A.pack + A.prep > 0 && A.pack + A.prep <= A.N, pb = B.pack + B.prep > 0 && B.pack + B.prep <= B.N;
  if (pa && pb) {
    const SA = A.N / A.P, SB = B.N / B.P, LS = lmean(SB, SA);
    const prod = parts.find((p) => p.key === 'prod')!;
    const sub = (key: string, label: string, nA: number, nB: number): SubPart => {
      const pp = (lw * (nB / B.P - nA / A.P)) / LS;
      return { key, label, pp, money: pp * B.P, a: nA > 0 ? A.P / nA : 0, b: nB > 0 ? B.P / nB : 0 };
    };
    prod.subs = [
      sub('pack', '내포장 생산성', A.pack, B.pack),
      sub('prep', '전처리 생산성', A.prep, B.prep),
      sub('etc', '그 외 공정 생산성', A.N - A.pack - A.prep, B.N - B.pack - B.prep),
    ];
  }
  const dR = B.R - A.R;
  return { dR, parts, money: dR * B.P };
}

/** 노무비 금액 변화를 공수 × 시간당 금액으로 (정규 / 연장 / 통제 밖) */
export function costSplit(M: LaborMetrics) {
  return { regular: M.Hr * M.w, overtime: (M.Hw - M.Hr) * M.w, outside: M.Lx, total: M.L };
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

/** 월별 노무비율 붙여넣기 — 세로(「1월 ⇥ 9.2%」, 「2026-01 ⇥ 9.2」) 또는 가로(월 줄 + 값 줄). 0.092 처럼 소수면 %로 바꾼다 */
export function parseRatios(text: string, year: string): Record<string, number> {
  const out: Record<string, number> = {};
  const lines = text.split('\n').map((l) => l.split('\t').map((s) => s.trim())).filter((r) => r.some(Boolean));
  const monthOf = (s: string): string | null => {
    let m = s.match(/(\d{4})\s*[-./년]\s*(\d{1,2})/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\s*월?$/);
    if (m && +m[1] >= 1 && +m[1] <= 12) return `${year}-${m[1].padStart(2, '0')}`;
    return null;
  };
  const val = (s: string): number | null => {
    if (!s) return null;
    const v = Number(s.replace(/[%,\s]/g, ''));
    return Number.isFinite(v) && v > 0 ? (v < 1 ? v * 100 : v) : null;
  };
  for (let i = 0; i < lines.length - 1; i++) {
    const ms = lines[i].map(monthOf);
    if (ms.filter(Boolean).length < 2) continue;
    ms.forEach((m, j) => { const v = m ? val(lines[i + 1][j] || '') : null; if (m && v !== null) out[m] = v; });
  }
  if (Object.keys(out).length) return out;
  lines.forEach((r) => {
    const m = monthOf(r[0] || '');
    const v = r.slice(1).map(val).find((x) => x !== null);
    if (m && v != null) out[m] = v;
  });
  return out;
}
