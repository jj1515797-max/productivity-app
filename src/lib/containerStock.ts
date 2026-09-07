/** 용기·필름 재고조사 정합성 검증 — 순수 계산 로직
 *
 *  투입량(실제 소모) = 기초재고 + 당월입고 − 기말재고
 *  이론사용량        = 그 달 생산량(EA). 로스 0% 기준.
 *  차이 = 투입량 − 이론사용량  →  이게 실제 로스(불량·파손·시운전)여야 한다.
 *
 *  차이가 음수면 물리적으로 불가능하다. 용기를 쓰지도 않고 제품을 만들 수는 없다.
 *  → 재고조사·입고·생산량 중 하나가 틀렸다는 뜻이고, 그걸 자동으로 짚어주는 게 이 파일의 목적.
 */

/** 이론사용량을 어디서 가져올지 */
export type TheorySource = 'large' | 'small' | 'ambient' | 'cold' | 'all';

export interface MaterialDef {
  id: string;
  label: string;
  source: TheorySource;
  color: string;      // tailwind 색 이름 (violet / cyan / amber / slate)
}

/** 자재 정의. 이론사용량은 용기분석의 생산량에서 자동으로 끌어온다. */
export const MATERIALS: MaterialDef[] = [
  { id: 'c210', label: '210ml 용기', source: 'large', color: 'violet' },
  { id: 'c185', label: '185ml 용기', source: 'small', color: 'cyan' },
  { id: 'retort', label: '레토르트', source: 'ambient', color: 'amber' },
  { id: 'film', label: '실링필름', source: 'cold', color: 'slate' },
];

/** 한 달 생산량(이론사용량의 원천) */
export interface TheoryMonth {
  small: number;      // 185ml 용기 (코드 -51)
  large: number;      // 210ml 용기
  ambient: number;    // 실온(레토르트)
  unknown: number;    // 제품 DB 에 없어 용기 구분 못 한 수량
}

export function theoryOf(t: TheoryMonth | undefined, src: TheorySource): number | null {
  if (!t) return null;
  switch (src) {
    case 'large': return t.large;
    case 'small': return t.small;
    case 'ambient': return t.ambient;
    case 'cold': return t.small + t.large;
    case 'all': return t.small + t.large + t.ambient;
  }
}

/** 사용자가 입력하는 한 달치 재고조사 값. 비어 있으면 null. */
export interface StockEntry {
  open: number | null;      // 기초재고
  inbound: number | null;   // 당월입고
  close: number | null;     // 기말재고
  input: number | null;     // 투입량 직접입력 (구매팀 값)
}
export const emptyEntry = (): StockEntry => ({ open: null, inbound: null, close: null, input: null });

/** 기초+입고−기말 이 모두 채워졌을 때만 계산값을 낸다 */
export function computedInput(e: StockEntry | undefined): number | null {
  if (!e) return null;
  if (e.open === null || e.inbound === null || e.close === null) return null;
  return e.open + e.inbound - e.close;
}
/** 실제로 쓸 투입량: 직접입력이 있으면 그것, 없으면 계산값 */
export function effectiveInput(e: StockEntry | undefined): number | null {
  if (!e) return null;
  return e.input !== null ? e.input : computedInput(e);
}

export type Severity = 'critical' | 'warn' | 'info' | 'ok';

export interface Finding {
  month: string;
  severity: Severity;
  title: string;
  detail: string;
  /** 이 진단이 가리키는 금액/수량 (정렬용) */
  size: number;
}

export interface MonthRow {
  month: string;
  entry: StockEntry;
  calcInput: number | null;    // 기초+입고−기말
  input: number | null;        // 실제 사용 투입량
  theory: number | null;       // 이론사용량
  diff: number | null;         // 투입량 − 이론사용량
  lossRate: number | null;     // diff / theory
  cumDiff: number | null;      // 누적 차이 (입력된 달만 누적)
  /** ok=정상 · timing=옆 달과 상쇄되는 시점 오차 · bad=설명 안 되는 이상 */
  flag: 'none' | 'ok' | 'timing' | 'bad';
  /** timing 인 경우 그 상쇄 구간 라벨 (예: '3~4월') */
  cluster: string | null;
}

export interface Analysis {
  rows: MonthRow[];
  findings: Finding[];
  totalInput: number;
  totalTheory: number;
  totalDiff: number;
  totalLossRate: number | null;
  filledCount: number;
  /** 상쇄 판정에 쓰는 기준 로스율 */
  lossLimit: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString();
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const mLabel = (m: string) => `${Number(m.slice(5, 7))}월`;

/**
 * 월별 행 + 자동 진단.
 * @param months     오름차순 'YYYY-MM' 배열
 * @param lossLimit  정상으로 볼 최대 로스율 (기본 3%)
 */
export function analyze(
  months: string[],
  entries: Record<string, StockEntry>,
  theory: Record<string, TheoryMonth>,
  src: TheorySource,
  lossLimit = 0.03,
): Analysis {
  const rows: MonthRow[] = [];
  let cum = 0;
  let hasAny = false;

  for (const month of months) {
    const entry = entries[month] || emptyEntry();
    const calcInput = computedInput(entry);
    const input = effectiveInput(entry);
    const th = theoryOf(theory[month], src);
    const diff = input !== null && th !== null ? input - th : null;
    if (diff !== null) { cum += diff; hasAny = true; }
    rows.push({
      month, entry, calcInput, input, theory: th, diff,
      lossRate: diff !== null && th ? diff / th : null,
      cumDiff: hasAny ? cum : null,
      flag: 'none', cluster: null,
    });
  }

  const findings: Finding[] = [];
  const filled = rows.filter((r) => r.diff !== null && r.theory !== null && r.theory > 0);
  /** 기말 = 기초 + 입고 인 달. 출고가 반영 안 된 장부재고를 넣은 것이라 투입량이 0 이 된다. */
  const bookOnly = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;

    // ① 재고 연속성 — 기초재고는 전월 기말재고와 같아야 한다
    if (prev && r.entry.open !== null && prev.entry.close !== null && r.entry.open !== prev.entry.close) {
      const gap = r.entry.open - prev.entry.close;
      findings.push({
        month: r.month, severity: 'critical', size: Math.abs(gap),
        title: `${mLabel(r.month)} 기초재고가 ${mLabel(prev.month)} 기말재고와 다릅니다`,
        detail: `${mLabel(prev.month)} 기말 ${fmt(prev.entry.close)} → ${mLabel(r.month)} 기초 ${fmt(r.entry.open)} `
          + `(${gap > 0 ? '+' : ''}${fmt(gap)}). 재고가 장부상 끊겨 있으면 이 달 투입량 자체를 믿을 수 없습니다. `
          + `두 달 중 어느 쪽 재고조사가 틀렸는지 먼저 확인하세요.`,
      });
    }

    // ② 계산 투입량 ≠ 구매팀 직접입력
    if (r.entry.input !== null && r.calcInput !== null && r.entry.input !== r.calcInput) {
      const gap = r.entry.input - r.calcInput;
      findings.push({
        month: r.month, severity: 'warn', size: Math.abs(gap),
        title: `${mLabel(r.month)} 구매팀 투입량과 재고 계산값이 ${fmt(Math.abs(gap))} 다릅니다`,
        detail: `구매팀 ${fmt(r.entry.input)} vs 기초+입고−기말 ${fmt(r.calcInput)}. `
          + (r.entry.open !== null && r.entry.inbound !== null
            ? `구매팀 값이 맞다면 기말재고가 ${fmt(r.entry.open + r.entry.inbound - r.entry.input)} 이어야 합니다 `
              + `(지금 넣으신 값 ${fmt(r.entry.close!)} 보다 ${fmt(Math.abs(gap))} ${gap > 0 ? '적음' : '많음'}). `
            : '')
          + `같은 달을 두 방법으로 센 건데 값이 다르면 월말 입고 반영 시점이나 창고 이동분이 빠졌을 가능성이 큽니다. `
          + `아래 표는 구매팀 값을 기준으로 계산했습니다.`,
      });
    }

    // ③ 출고 미반영 — 기말이 '기초+입고' 그대로면 투입량이 0 으로 나온다
    if (r.calcInput === 0 && r.entry.open !== null && r.entry.inbound !== null && r.entry.close !== null
        && r.theory !== null && r.theory > 0) {
      bookOnly.add(r.month);
      findings.push({
        month: r.month, severity: 'critical', size: r.theory,
        title: `${mLabel(r.month)} 기말재고가 '기초 + 입고' 와 정확히 같습니다 — 출고가 반영되지 않았습니다`,
        detail: `${fmt(r.entry.open)} + ${fmt(r.entry.inbound)} − ${fmt(r.entry.close)} = 0. `
          + `그 달에 ${fmt(r.theory)}개를 생산했는데 창고에서 나간 게 하나도 없다는 뜻이라 성립하지 않습니다. `
          + `ERP 재고수불부의 출고합계가 0 이면 아직 생산출고가 안 잡힌 마감 전 장부입니다. `
          + `여기 넣을 기말재고는 반드시 「재고조사(실사)로 센 실물 수량」이어야 합니다 — `
          + `ERP 장부상 기말을 그대로 넣으면 투입량이 ERP 출고량과 같아져 이 검증 자체가 의미를 잃습니다.`,
      });
    }

    // ④ 입고 0 인데 투입 큼
    if (r.entry.inbound === 0 && r.input !== null && r.theory !== null && r.input > r.theory * 0.5) {
      findings.push({
        month: r.month, severity: 'info', size: r.input,
        title: `${mLabel(r.month)} 당월입고가 0 입니다`,
        detail: `입고 없이 ${fmt(r.input)}개를 소모한 것으로 잡혔습니다. 재고만으로 돌렸다면 정상이지만, `
          + `입고 전표가 다음 달로 넘어간 것은 아닌지 확인하세요.`,
      });
    }
  }

  /* ─── 이상치 판정 ─────────────────────────────────────────────
     정상 구간: 차이가 0 이상 ~ 이론 × lossLimit 이하.
     음수는 원래 불가능하므로 계측 잡음(NEG_TOL)만 눈감아 준다.
     구간을 벗어난 달은, 옆 달과 합치면 정상으로 돌아오는지부터 본다.
       → 돌아오면 '재고 실사 시점이 월 경계를 넘긴 것'  (timing)
       → 안 돌아오면 진짜 문제                          (bad)     */
  const NEG_TOL = 0.005;
  const inBand = (d: number, th: number) => th > 0 && d >= -th * NEG_TOL && d <= th * lossLimit;
  const MAX_SPAN = 3;

  const claimed = new Set<string>();     // 이미 어느 구간에 묶인 달
  const seenCluster = new Set<string>();

  for (const r of rows) {
    if (r.diff === null || r.theory === null || r.theory <= 0) { r.flag = 'none'; continue; }
    r.flag = inBand(r.diff, r.theory) ? 'ok' : 'bad';
  }

  for (let k = 0; k < filled.length; k++) {
    const r = filled[k];
    if (r.flag !== 'bad' || claimed.has(r.month)) continue;
    if (bookOnly.has(r.month)) { claimed.add(r.month); continue; }   // 원인이 이미 밝혀진 달

    // r 을 포함하는 가장 짧은 구간을 찾는다 (짧을수록, 그다음 편차 작을수록 좋다)
    let best: { a: number; b: number; d: number; t: number } | null = null;
    for (let len = 2; len <= MAX_SPAN && !best; len++) {
      for (let a = Math.max(0, k - len + 1); a + len - 1 < filled.length && a <= k; a++) {
        const b = a + len - 1;
        let d = 0, t = 0, pos = 0, neg = 0;
        for (let x = a; x <= b; x++) {
          d += filled[x].diff!; t += filled[x].theory!;
          if (filled[x].diff! > 0) pos++; else if (filled[x].diff! < 0) neg++;
        }
        // 시점 오차라면 반드시 한쪽은 남고 한쪽은 모자란다.
        // 계속 +만 나오는 구간은 상쇄가 아니라 그냥 로스가 큰 것이므로 묶지 않는다.
        if (!pos || !neg) continue;
        if (!inBand(d, t)) continue;
        if (!best || Math.abs(d / t) < Math.abs(best.d / best.t)) best = { a, b, d, t };
      }
    }

    if (best) {
      const span = filled.slice(best.a, best.b + 1);
      const label = `${mLabel(span[0].month)}~${mLabel(span[span.length - 1].month)}`;
      span.forEach((s) => { s.flag = 'timing'; s.cluster = label; claimed.add(s.month); });
      if (seenCluster.has(label)) continue;
      seenCluster.add(label);
      const worst = span.reduce((m, s) => (Math.abs(s.diff!) > Math.abs(m.diff!) ? s : m), span[0]);
      findings.push({
        month: worst.month, severity: 'warn', size: Math.abs(worst.diff!),
        title: `${label} 은 따로 보면 이상하지만 합치면 맞습니다 (재고조사 시점 오차)`,
        detail: span.map((s) => `${mLabel(s.month)} ${s.diff! > 0 ? '+' : ''}${fmt(s.diff!)}`).join(' / ')
          + ` → 합계 ${best.d > 0 ? '+' : ''}${fmt(best.d)} (${pct(best.d / best.t)}). `
          + `${mLabel(worst.month)} 하나만 보면 ${worst.diff! < 0 ? '이론사용량이 더 많아 불가능해 보이지만' : '로스가 과해 보이지만'}, `
          + `${span.length}개월을 합치면 정상 범위로 돌아옵니다. 재고 실사일이 월 마감일과 어긋나 한 달 몫이 옆 달로 밀린 것입니다. `
          + `수량 자체는 맞으니 재고 실사일만 마감일에 맞추면 사라집니다.`,
      });
      continue;
    }

    // 옆 달로도 설명이 안 되는 달
    claimed.add(r.month);
    if (r.diff! < 0) {
      findings.push({
        month: r.month, severity: 'critical', size: -r.diff!,
        title: `${mLabel(r.month)} 이론사용량이 투입량보다 ${fmt(-r.diff!)}개 많습니다`,
        detail: `투입 ${fmt(r.input!)} < 이론 ${fmt(r.theory!)} (${pct(r.diff! / r.theory!)}). `
          + `용기를 쓰지 않고 제품을 만들 수는 없으니 어딘가 틀린 값입니다. 앞뒤 ${MAX_SPAN}개월을 합쳐 봐도 메워지지 않습니다. `
          + `① 기말재고 과다계상(창고에 없는 걸 있다고 셈) ② 당월입고 누락 ③ 생산량 과다입력 순으로 확인하세요.`,
      });
    } else {
      findings.push({
        month: r.month, severity: 'warn', size: r.diff!,
        title: `${mLabel(r.month)} 로스율 ${pct(r.diff! / r.theory!)} — 기준(${pct(lossLimit)}) 초과`,
        detail: `투입 ${fmt(r.input!)} − 이론 ${fmt(r.theory!)} = ${fmt(r.diff!)}개가 생산에 쓰이지 않고 사라졌습니다. `
          + `앞뒤 달과 상쇄되지도 않습니다. 실제 파손·시운전이 그만큼 났는지, `
          + `아니면 기말재고를 덜 세었는지(창고에 남아 있는데 안 셈) 확인하세요.`,
      });
    }
  }

  const totalInput = filled.reduce((s, r) => s + r.input!, 0);
  const totalTheory = filled.reduce((s, r) => s + r.theory!, 0);
  const totalDiff = totalInput - totalTheory;

  if (filled.length >= 3) {
    const rate = totalTheory ? totalDiff / totalTheory : 0;
    if (totalDiff < 0) {
      findings.push({
        month: '', severity: 'critical', size: -totalDiff,
        title: `${filled.length}개월 합계로도 이론사용량이 ${fmt(-totalDiff)}개 많습니다`,
        detail: `기간 전체를 합치면 시점 오차는 상쇄되어야 합니다. 그런데도 음수라면 월 경계 문제가 아니라 `
          + `구조적인 누락입니다 — 입고분이 통째로 안 잡혔거나, 생산량이 과다하게 집계되고 있습니다.`,
      });
    } else if (rate > lossLimit) {
      findings.push({
        month: '', severity: 'warn', size: totalDiff,
        title: `${filled.length}개월 누적 로스율 ${pct(rate)} — 기준 초과`,
        detail: `누적 ${fmt(totalDiff)}개. 월별로는 흔들려도 누적이 기준을 넘으면 진짜 로스입니다.`,
      });
    } else {
      findings.push({
        month: '', severity: 'ok', size: 0,
        title: `${filled.length}개월 누적 로스율 ${pct(rate)} — 정상 범위`,
        detail: `누적 ${fmt(totalDiff)}개. 월별 값이 흔들리더라도 총량은 맞아떨어집니다.`,
      });
    }
  }

  const order: Record<Severity, number> = { critical: 0, warn: 1, info: 2, ok: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.size - a.size || a.month.localeCompare(b.month));

  return {
    rows, findings, totalInput, totalTheory, totalDiff,
    totalLossRate: totalTheory ? totalDiff / totalTheory : null,
    filledCount: filled.length, lossLimit,
  };
}
