/** 용기분석 › 용기 원가 — 용기 3종(레토르트 · 210ml · 185ml)의 전월 대비 비용 변동 분해
 *
 *  수량 = 재고 정합성 탭의 실제 투입량 (재고조사: 직접입력 투입량, 없으면 기초 + 입고 − 기말)
 *  단가 = 사용자가 월별로 직접 넣는 값  → containerCost/{YYYY-MM} = { prices: { retort, c210, c185 } }
 *  생산금액 = monthlyMeta/{YYYY-MM}.productionAmount (원재료분석과 같은 값)
 *
 *  용기비 증감 = ① 물량 + ② 구성(Mix) + ③ 단가   (세 몫의 합은 정확히 증감과 같다)
 *    ① 물량 = (당월 총수량 − 전월 총수량) × 전월 가중평균단가
 *    ② 구성 = 당월 총수량 × (당월 비중으로 본 전월 단가 평균 − 전월 가중평균단가)
 *             → 단가가 같아도 비싼 용기를 덜 쓰고 싼 용기를 더 쓰면 개당 평균단가가 내려간다
 *    ③ 단가 = Σ 당월 수량 × (당월 단가 − 전월 단가)
 */
export const CONTAINER_COST_COL = 'containerCost';

export const CONTAINER_ITEMS = [
  { id: 'retort', label: '레토르트 용기' },
  { id: 'c210', label: '큰용기(210ml)' },
  { id: 'c185', label: '작은용기(185ml)' },
] as const;
export type ContainerId = typeof CONTAINER_ITEMS[number]['id'];

export interface CCMonth {
  qty: Partial<Record<ContainerId, number | null>>;
  price: Partial<Record<ContainerId, number | null>>;
  amount: number;   // 생산금액 (0 = 미입력)
}

export interface CCRow {
  id: ContainerId; label: string;
  pA: number; pB: number; qA: number; qB: number;
  sA: number; sB: number;      // 수량 비중 (0~1)
  dq: number; ds: number;      // 수량 증감, 비중 변화 (%p)
  costA: number; costB: number;
  tier: '고단가' | '저단가';
}
export interface CCResult {
  missing: string[];
  rows: CCRow[];
  QA: number; QB: number; CA: number; CB: number;
  avgA: number; avgB: number;
  /** 단가는 전월 그대로 두고 비중만 당월로 바꿨을 때 개당 평균단가 − 전월 평균 (원/개) = Mix 로 바뀐 평균단가 */
  mixAvgDelta: number;
  volume: number; mix: number; price: number; total: number;
  /** d = 원가율 증감(%p), money = 그 %p 를 당월 생산금액으로 환산한 금액 */
  ratio: { rA: number; rB: number; d: number; mixPp: number; money: number } | null;
  priceChanged: { label: string; pA: number; pB: number }[];
}

export function analyzeContainerCost(a: CCMonth, b: CCMonth, monthA: string, monthB: string): CCResult | null {
  const missing: string[] = [];
  const val = (m: CCMonth, kind: 'qty' | 'price', id: ContainerId, month: string, what: string) => {
    const v = m[kind][id];
    if (typeof v !== 'number' || !Number.isFinite(v)) { missing.push(`${month} ${CONTAINER_ITEMS.find((x) => x.id === id)!.label} ${what}`); return 0; }
    return v;
  };
  const base = CONTAINER_ITEMS.map((it) => ({
    id: it.id, label: it.label,
    qA: val(a, 'qty', it.id, monthA, '투입량'), qB: val(b, 'qty', it.id, monthB, '투입량'),
    pA: val(a, 'price', it.id, monthA, '단가'), pB: val(b, 'price', it.id, monthB, '단가'),
  }));
  if (missing.length) return { missing } as CCResult;
  const QA = base.reduce((s, r) => s + r.qA, 0);
  const QB = base.reduce((s, r) => s + r.qB, 0);
  if (QA <= 0 || QB <= 0) return { missing: ['투입량 합계가 0입니다'] } as CCResult;
  const CA = base.reduce((s, r) => s + r.qA * r.pA, 0);
  const CB = base.reduce((s, r) => s + r.qB * r.pB, 0);
  const avgA = CA / QA, avgB = CB / QB;
  const mixAvg = base.reduce((s, r) => s + (r.qB / QB) * r.pA, 0);
  const rows: CCRow[] = base.map((r) => ({
    ...r, sA: r.qA / QA, sB: r.qB / QB, dq: r.qB - r.qA, ds: (r.qB / QB - r.qA / QA) * 100,
    costA: r.qA * r.pA, costB: r.qB * r.pB, tier: r.pA >= avgA ? '고단가' : '저단가',
  }));
  const volume = (QB - QA) * avgA;
  const mix = QB * (mixAvg - avgA);
  const price = base.reduce((s, r) => s + r.qB * (r.pB - r.pA), 0);
  const ratio = a.amount > 0 && b.amount > 0
    ? { rA: CA / a.amount, rB: CB / b.amount, d: (CB / b.amount - CA / a.amount) * 100, mixPp: (mix / b.amount) * 100,
        money: (CB / b.amount - CA / a.amount) * b.amount }
    : null;
  const priceChanged = rows.filter((r) => Math.abs(r.pB - r.pA) > 1e-9).map((r) => ({ label: r.label, pA: r.pA, pB: r.pB }));
  return { missing: [], rows, QA, QB, CA, CB, avgA, avgB, mixAvgDelta: mixAvg - avgA, volume, mix, price, total: CB - CA, ratio, priceChanged };
}

/* ───────── 보고서 문구 ───────── */
const p1 = (n: number) => n.toFixed(1);
const signP = (n: number, d = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}`;
const won = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : (Math.round(n * 10) / 10).toLocaleString());
/** 128만 원 → "약 128만 원 (약 1.3백)" — 백 = 백만원 */
export function moneyText(n: number): string {
  const man = Math.round(Math.abs(n) / 1e4);
  return `약 ${man.toLocaleString()}만 원 (약 ${(man / 100).toFixed(1)}백)`;
}
const effectWord = (n: number) => (n <= 0 ? '절감' : '증가');

/** 비중 변화가 큰 품목 2개 (0.05%p 이상) — 보고서 한 줄에 다 넣으면 길어진다.
 *  수량과 비중이 같은 방향이면 '사용량 축소/확대', 다르면(수량은 늘었는데 비중은 줄어든 경우 등) '사용 비중 축소/확대' */
function mixParts(r: CCResult) {
  return r.rows
    .filter((x) => Math.abs(x.ds) >= 0.05)
    .sort((x, y) => Math.abs(y.ds) - Math.abs(x.ds))
    .slice(0, 2)
    .map((x) => {
      const verb = x.ds < 0 ? '축소' : '확대';
      const qty = `${x.dq < 0 ? '↓' : '↑'}${p1(Math.abs(x.dq) / 1000)}천 개`;
      const same = (x.dq < 0) === (x.ds < 0);
      return {
        x,
        text: same
          ? `${x.tier} ${x.label} 사용량 ${verb}(${qty}, ${signP(x.ds)}%p)`
          : `${x.tier} ${x.label} 사용 비중 ${verb}(수량 ${qty}, 비중 ${signP(x.ds)}%p)`,
      };
    });
}

export function containerComments(r: CCResult): { opt1: string[]; opt2: string[]; opt3: string } {
  const parts = mixParts(r);
  const avgWord = r.mixAvgDelta <= 0 ? '하락' : '상승';
  const avgAbs = p1(Math.abs(r.mixAvgDelta));
  const priceLine = r.priceChanged.length === 0
    ? '#. 용기 품목별 단가 전월 대비 변동 없음'
    : `#. 단가 변동 : ${r.priceChanged.map((c) => `${c.label} ${won(c.pA)}→${won(c.pB)}원(${signP(c.pB - c.pA)}원)`).join(', ')} (${moneyText(r.price)} ${effectWord(r.price)})`;
  const mixLine = parts.length
    ? `#. ${parts.map((p) => p.text).join(' 및 ')}로 개당 평균단가 ${avgAbs}원 ${avgWord} (${moneyText(r.mix)} ${effectWord(r.mix)} 효과)`
    : `#. 용기 사용 구성(비중) 변동 미미 — 개당 평균단가 ${avgAbs}원 ${avgWord}`;
  const ratioLine = r.ratio
    ? `#. 용기 원가율 증감 ${signP(r.ratio.d, 2)}%p (${moneyText(r.ratio.money)} ${effectWord(r.ratio.money)})`
    : `#. 용기비 증감 ${moneyText(r.total)} ${effectWord(r.total)} (생산금액을 넣으면 원가율 %p 로도 표시)`;

  const shrink = parts.filter((p) => p.x.ds < 0).map((p) => `${p.x.tier} ${p.x.label} 비중 축소(${signP(p.x.ds)}%p)`);
  const grow = parts.filter((p) => p.x.ds > 0).map((p) => `${p.x.tier} ${p.x.label} 확대(${signP(p.x.ds)}%p)`);
  const head = r.ratio ? `${signP(r.ratio.d, 2)}%p(${(Math.abs(r.ratio.money) / 1e6).toFixed(1)}백)` : `${(r.total / 1e6 >= 0 ? '+' : '−')}${(Math.abs(r.total) / 1e6).toFixed(1)}백`;
  const opt2 = [
    `#. 용기비: ${head} / ${r.priceChanged.length ? '일부 품목 단가 변동' : '품목별 단가 동일'}, 사용 구성(Mix) ${r.mix <= 0 ? '개선으로' : '변동으로'} 평균단가 ${r.mixAvgDelta <= 0 ? '▼' : '▲'}${avgAbs}원/개 ${avgWord}`,
    `#. 주요 요인: ${[...shrink, ...grow].join(' 및 ') || '구성 변동 미미'}`,
  ];
  const shortParts = parts.map((p) => `${p.x.label} ${p.x.ds < 0 ? '▼' : '▲'}${p1(Math.abs(p.x.ds))}%p`).join(', ');
  const opt3 = `#. 용기 사용 구성(Mix) ${r.mix <= 0 ? '개선' : '변동'}(${shortParts || '변동 미미'})에 따른 평균단가 ${avgWord}(${r.mixAvgDelta <= 0 ? '▼' : '▲'}${avgAbs}원/개, ${moneyText(r.mix)} ${effectWord(r.mix)} 효과)`;
  return { opt1: [priceLine, mixLine, ratioLine], opt2, opt3 };
}

/* ───────── 최종: 생산량(실제 사용) + 재고조사(제조원가) 를 함께 ─────────
 *  재고조사 투입량 = 생산량 + 로스(투입 − 생산).  재고조사 용기비 = 생산 기준 용기비 + 로스 금액
 *  재고조사 기준 용기비 증감 = ① 물량 + ② 구성(Mix) + ③ 단가 + ④ 로스 변화   (①~③ 은 생산량 기준)
 *  재고조사 기준 원가율 증감(%p) = ⓐ 개당 생산금액 + ② 구성 + ③ 단가 + ④ 로스   (네 몫의 합 = 증감)
 *    ⓐ = 생산 기준 원가율A × ((생산금액A/생산량A) ÷ (생산금액B/생산량B) − 1)  ← 물량은 분모와 같이 늘어 상쇄되고 남는 몫
 *    ② = 구성 금액 ÷ 생산금액B,  ③ = 단가 금액 ÷ 생산금액B,  ④ = 로스금액B/생산금액B − 로스금액A/생산금액A */
export interface CCLossRow {
  id: ContainerId; label: string;
  prodA: number; stockA: number | null; lossA: number | null; rateA: number | null;
  prodB: number; stockB: number | null; lossB: number | null; rateB: number | null;
}
export interface CCFull {
  base: CCResult;
  hasStock: boolean;
  loss: CCLossRow[];
  lossQtyA: number; lossQtyB: number; lossRateA: number; lossRateB: number;
  lossCostA: number; lossCostB: number;
  CsA: number; CsB: number;
  /** %p 단위 (×100 한 값) */
  ratio: { rA: number; rB: number; d: number; rev: number; mix: number; price: number; loss: number; money: number; stockBased: boolean } | null;
  negatives: string[];
}

export function analyzeContainerFull(
  prod: { A: Partial<Record<ContainerId, number | null>>; B: Partial<Record<ContainerId, number | null>> },
  stock: { A: Partial<Record<ContainerId, number | null>>; B: Partial<Record<ContainerId, number | null>> },
  price: { A: CCMonth['price']; B: CCMonth['price'] },
  amount: { A: number; B: number },
  monthA: string, monthB: string,
): CCFull | { base: CCResult } | null {
  const base = analyzeContainerCost({ qty: prod.A, price: price.A, amount: amount.A }, { qty: prod.B, price: price.B, amount: amount.B }, monthA, monthB);
  if (!base || base.missing.length) return base ? { base } : null;
  const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const hasStock = CONTAINER_ITEMS.every((it) => num(stock.A[it.id]) !== null && num(stock.B[it.id]) !== null);
  const loss: CCLossRow[] = base.rows.map((r) => {
    const sA = num(stock.A[r.id]), sB = num(stock.B[r.id]);
    return {
      id: r.id, label: r.label,
      prodA: r.qA, stockA: sA, lossA: sA === null ? null : sA - r.qA, rateA: sA === null || r.qA <= 0 ? null : (sA - r.qA) / r.qA,
      prodB: r.qB, stockB: sB, lossB: sB === null ? null : sB - r.qB, rateB: sB === null || r.qB <= 0 ? null : (sB - r.qB) / r.qB,
    };
  });
  const sum = (f: (x: CCLossRow) => number | null) => loss.reduce((s, x) => s + (f(x) || 0), 0);
  const lossQtyA = sum((x) => x.lossA), lossQtyB = sum((x) => x.lossB);
  const pOf = (id: ContainerId, m: 'A' | 'B') => base.rows.find((x) => x.id === id)![m === 'A' ? 'pA' : 'pB'];
  const lossCostA = hasStock ? loss.reduce((s, x) => s + (x.lossA || 0) * pOf(x.id, 'A'), 0) : 0;
  const lossCostB = hasStock ? loss.reduce((s, x) => s + (x.lossB || 0) * pOf(x.id, 'B'), 0) : 0;
  const negatives: string[] = [];
  loss.forEach((x) => {
    if (x.lossA !== null && x.lossA < 0) negatives.push(`${monthA} ${x.label} ${Math.round(x.lossA).toLocaleString()}개`);
    if (x.lossB !== null && x.lossB < 0) negatives.push(`${monthB} ${x.label} ${Math.round(x.lossB).toLocaleString()}개`);
  });
  let ratio: CCFull['ratio'] = null;
  if (amount.A > 0 && amount.B > 0) {
    const rpA = base.CA / amount.A, rpB = base.CB / amount.B;
    const rev = rpA * ((amount.A / base.QA) / (amount.B / base.QB) - 1);
    const mix = base.mix / amount.B, pr = base.price / amount.B;
    const ls = hasStock ? lossCostB / amount.B - lossCostA / amount.A : 0;
    const rA = rpA + (hasStock ? lossCostA / amount.A : 0), rB = rpB + (hasStock ? lossCostB / amount.B : 0);
    ratio = { rA: rA * 100, rB: rB * 100, d: (rB - rA) * 100, rev: rev * 100, mix: mix * 100, price: pr * 100, loss: ls * 100, money: (rB - rA) * amount.B, stockBased: hasStock };
  }
  return {
    base, hasStock, loss,
    lossQtyA, lossQtyB, lossRateA: lossQtyA / base.QA, lossRateB: lossQtyB / base.QB,
    lossCostA, lossCostB,
    CsA: base.CA + lossCostA, CsB: base.CB + lossCostB,
    ratio, negatives,
  };
}

const pp2 = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;
const pct1 = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n * 100).toFixed(1)}%`;

/** 최종 보고서 문구 — 구성(생산량 기준) · 로스(재고조사 − 생산) · 원가율(재고조사 기준) */
export function containerFullComments(f: CCFull, monthA: string, monthB: string): { opt1: string[]; opt2: string[]; opt3: string } {
  const b = containerComments(f.base);
  const r = f.ratio;
  const lossDelta = f.lossCostB - f.lossCostA;
  const lossLine = f.hasStock
    ? `#. 용기 로스(투입−생산) ${Number(monthA.slice(5))}월 ${pct1(f.lossRateA)} → ${Number(monthB.slice(5))}월 ${pct1(f.lossRateB)} (${f.lossQtyB - f.lossQtyA >= 0 ? '+' : '−'}${Math.abs(Math.round(f.lossQtyB - f.lossQtyA)).toLocaleString()}개, ${moneyText(lossDelta)} ${effectWord(lossDelta)})`
    : '';
  const flat = r ? Math.abs(r.d) < 0.005 : false;
  const parts = r ? [
    { k: '구성(Mix)', v: r.mix }, { k: '단가', v: r.price }, ...(f.hasStock ? [{ k: '로스', v: r.loss }] : []), { k: '개당 생산금액', v: r.rev },
  ] : [];
  const ratioLine = r
    ? `#. 용기 원가율 ${r.rA.toFixed(2)}% → ${r.rB.toFixed(2)}% (${flat ? '보합, ' : ''}${pp2(r.d)}%p) : ${parts.map((p) => `${p.k} ${pp2(p.v)}%p`).join(' · ')}${f.hasStock ? '' : ' (생산량 기준)'}`
    : '#. 두 달 생산금액을 넣으면 용기 원가율(%p) 문구가 추가됩니다';
  const warn = f.negatives.length ? `※ 투입량이 생산량보다 적음 : ${f.negatives.join(', ')} — 재고조사·월말 시점 확인 필요` : '';
  const opt1 = [b.opt1[0], b.opt1[1], lossLine, ratioLine, warn].filter(Boolean);

  // 2줄 · 1줄 — 원가율을 가장 크게 움직인 몫 순서로
  const ranked = [...parts].filter((p) => Math.abs(p.v) >= 0.005).sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
  const mixWord = f.base.mix <= 0 ? '사용 구성 개선' : '고단가 용기 비중 확대';
  const lossWord = lossDelta <= 0 ? '용기 로스 감소' : '용기 로스 증가';
  const opt2 = r ? [
    `#. 용기 원가율 ${r.rA.toFixed(2)}% → ${r.rB.toFixed(2)}% (${pp2(r.d)}%p, ${(Math.abs(r.money) / 1e6).toFixed(1)}백) / ${mixWord}(평균단가 ${f.base.mixAvgDelta <= 0 ? '▼' : '▲'}${Math.abs(f.base.mixAvgDelta).toFixed(1)}원/개)${f.hasStock ? `, ${lossWord}(${pct1(f.lossRateA)}→${pct1(f.lossRateB)})` : ''}`,
    `#. 주요 요인: ${ranked.map((p) => `${p.k} ${pp2(p.v)}%p`).join(', ') || '변동 미미'}`,
  ] : b.opt2;
  const opt3 = r && f.hasStock
    ? `#. 용기 원가율 ${flat ? '보합' : r.d < 0 ? '하락' : '상승'}(${r.rA.toFixed(2)}%→${r.rB.toFixed(2)}%) : ${mixWord}(${pp2(r.mix)}%p)${Math.sign(r.mix) !== Math.sign(r.loss) && Math.abs(r.loss) >= 0.005 ? `를 ${lossWord}(${pct1(f.lossRateA)}→${pct1(f.lossRateB)}, ${pp2(r.loss)}%p)가 ${Math.abs(r.loss) >= Math.abs(r.mix + r.price) ? '상쇄' : '일부 상쇄'}` : `, ${lossWord}(${pp2(r.loss)}%p)`}`
    : b.opt3;
  return { opt1, opt2, opt3 };
}

/* ───────── 분석 문단 (원재료분석 맨 위 설명처럼 숫자를 풀어 쓴 것) ───────── */
const man = (n: number) => `${Math.round(Math.abs(n) / 1e4).toLocaleString()}만 원`;
const sman = (n: number) => `${n >= 0 ? '+' : '−'}${man(n)}`;
const g1 = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)}%`;

/** basis 'stock' = 재고조사(투입) 기준 = 제조원가와 같은 기준, 'prod' = 생산량(실제 사용) 기준 */
export function containerNarrative(f: CCFull, basis: 'stock' | 'prod', monthA: string, monthB: string, amount: { A: number; B: number }): { lines: string[]; warnings: string[] } {
  const b = f.base;
  const mA = `${Number(monthA.slice(5))}월`, mB = `${Number(monthB.slice(5))}월`;
  const stockMode = basis === 'stock' && f.hasStock;
  const CA = stockMode ? f.CsA : b.CA, CB = stockMode ? f.CsB : b.CB;
  const lines: string[] = [];
  const prodGrowth = b.QB / b.QA - 1;
  const revGrowth = amount.A > 0 && amount.B > 0 ? amount.B / amount.A - 1 : null;
  const r = f.ratio;

  // ① 전체
  const head = `${mB} 용기비(${stockMode ? '재고조사 투입 기준 — 제조원가와 같은 기준' : '생산량 기준 — 실제 사용'})는 ${man(CA)} → ${man(CB)}으로 ${sman(CB - CA)}(${g1(CB / CA - 1)}) 변했습니다.`;
  if (r && revGrowth !== null) {
    const rA = stockMode ? r.rA : (b.CA / amount.A) * 100, rB = stockMode ? r.rB : (b.CB / amount.B) * 100;
    const d = rB - rA;
    lines.push(`${head} 생산금액이 ${g1(revGrowth)} 변해 용기 원가율은 ${rA.toFixed(2)}% → ${rB.toFixed(2)}%${Math.abs(d) < 0.005 ? '로 보합' : `(${pp2(d)}%p)`}입니다.`);
  } else lines.push(`${head} (두 달 생산금액을 넣으면 원가율로도 설명합니다)`);

  // ② 물량
  lines.push(`이 중 ${sman(b.volume)}은 생산량이 ${g1(prodGrowth)} 변해 용기를 그만큼 ${b.volume >= 0 ? '더' : '덜'} 쓴 몫(① 물량)으로, 생산금액도 같이 움직여 원가율에는 영향이 없습니다.`);

  // ③ 구성 + 단가
  const top = [...b.rows].sort((x, y) => Math.abs(y.ds) - Math.abs(x.ds))[0];
  const mixPp = r ? ` · 원가율 ${pp2(r.mix)}%p` : '';
  lines.push(`실제 사용(생산량 기준)으로 보면 ${top.tier} ${top.label} 비중이 ${(top.sA * 100).toFixed(1)}% → ${(top.sB * 100).toFixed(1)}%(${pp2(top.ds).replace(/(\d)$/, '$1')}%p)로 바뀌어 개당 평균단가가 ${Math.abs(b.mixAvgDelta).toFixed(1)}원 ${b.mixAvgDelta <= 0 ? '내려갔고' : '올랐고'}(② 구성 ${sman(b.mix)}${mixPp}), `
    + (b.priceChanged.length ? `ERP 단가 변동으로 ③ 단가 ${sman(b.price)}${r ? `(${pp2(r.price)}%p)` : ''}이 ${b.price >= 0 ? '더해졌습니다' : '줄었습니다'}.` : '품목별 단가는 전월과 같습니다(③ 단가 0).'));

  // ④ 로스
  if (stockMode) {
    const dl = f.lossCostB - f.lossCostA;
    const qn = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString()}개`;
    lines.push(`용기 로스(재고조사 투입 − 생산량)는 ${mA} ${pct1(f.lossRateA)}(${qn(f.lossQtyA)}) → ${mB} ${pct1(f.lossRateB)}(${qn(f.lossQtyB)})로 ${dl <= 0 ? '줄어' : '늘어'} ${sman(dl)}${r ? `(원가율 ${pp2(r.loss)}%p)` : ''}${dl <= 0 ? '을 덜어 냈습니다' : '이 더해졌습니다'}.`);
  }
  if (r && Math.abs(r.rev) >= 0.005) lines.push(`개당 생산금액이 바뀐 몫(ⓐ)은 원가율 ${pp2(r.rev)}%p입니다.`);

  // ⑤ 결론 — 원가율을 가장 크게 움직인 몫
  if (r) {
    const parts = [
      { k: '용기 구성(Mix)', v: r.mix }, { k: '단가', v: r.price }, ...(stockMode ? [{ k: '용기 로스', v: r.loss }] : []), { k: '개당 생산금액', v: r.rev },
    ].sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
    const up = parts.filter((p) => p.v >= 0.005), down = parts.filter((p) => p.v <= -0.005);
    const d = stockMode ? r.d : (b.CB / amount.B - b.CA / amount.A) * 100;
    const verdict = Math.abs(d) < 0.005 ? '보합' : d < 0 ? '하락' : '상승';
    lines.push(`정리하면 원가율 ${verdict}의 주된 이유는 ${parts[0].k}(${pp2(parts[0].v)}%p)입니다.`
      + (up.length && down.length ? ` 올린 쪽(${up.map((p) => p.k).join('·')})과 내린 쪽(${down.map((p) => p.k).join('·')})이 서로 상쇄됐습니다.` : ''));
  }

  // 경고 — 생산한 것보다 덜 쓴 용기 (물리적으로 불가능)
  const warnings: string[] = [];
  if (f.hasStock) {
    f.loss.forEach((x) => {
      ([['A', mA, x.lossA, x.stockA, x.prodA], ['B', mB, x.lossB, x.stockB, x.prodB]] as const).forEach(([, m, l, s, p]) => {
        if (l !== null && l < 0) warnings.push(`${m} ${x.label}: 생산 ${Math.round(p).toLocaleString()}개인데 투입 ${Math.round(s || 0).toLocaleString()}개 — 생산한 것보다 ${Math.abs(Math.round(l)).toLocaleString()}개 덜 쓴 것으로 나옵니다(불가능). 재고조사 수량이나 월말 기말재고 과다 집계를 확인하세요. 이 차이는 다음 달에 반대로 나타날 수 있습니다.`);
      });
    });
    // 같은 달에 한 용기는 생산보다 크게 많이, 다른 용기는 덜 썼으면 재고조사에서 서로 섞여 잡혔을 수 있다
    (['A', 'B'] as const).forEach((m) => {
      const ls = f.loss.map((x) => ({ x, rate: m === 'A' ? x.rateA : x.rateB, l: m === 'A' ? x.lossA : x.lossB }));
      const neg = ls.filter((y) => y.l !== null && y.l < 0);
      const big = ls.filter((y) => y.rate !== null && y.rate > 0.05);
      if (neg.length && big.length) {
        warnings.push(`${m === 'A' ? mA : mB} ${big.map((y) => `${y.x.label}(+${Math.round(y.l!).toLocaleString()}개, ${pct1(y.rate!)})`).join(', ')}는 생산보다 크게 많이 쓰고 ${neg.map((y) => y.x.label).join(', ')}는 덜 쓴 것으로 나옵니다 — 재고조사에서 두 용기가 일부 섞여 잡혔을 수 있습니다.`);
      }
    });
  }
  return { lines, warnings };
}
