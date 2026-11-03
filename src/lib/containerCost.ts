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
  { id: 'retort', label: '레토르트 용기', short: '레토르트' },
  { id: 'c210', label: '큰용기(210ml)', short: '큰용기' },
  { id: 'c185', label: '작은용기(185ml)', short: '작은용기' },
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
const won = (n: number) => (Math.round(n * 10) / 10).toLocaleString();   // 125.7원 → 125.7 (반올림해 126 으로 보이면 증감과 안 맞아 보인다)
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

/* ───────── 원가율 나누기 ─────────
 *  원가율 증감(%p) = 구성 + 단가 + 개당 생산금액   (세 몫의 합 = 증감)
 *   구성 = 구성 금액 ÷ 생산금액B,  단가 = 단가 금액 ÷ 생산금액B
 *   개당 생산금액 = 원가율A × ((생산금액A ÷ 수량A) ÷ (생산금액B ÷ 수량B) − 1)
 *     ← 물량은 생산금액(분모)과 같이 움직여 상쇄되고, 용기 1개당 생산금액이 바뀐 만큼만 남는다
 *  재고조사 기준이면 수량 = 투입량 → 로스(투입 − 생산)는 이미 수량에 들어 있어 따로 더하지 않는다. */
export interface CCRatio { rA: number; rB: number; d: number; mix: number; price: number; rev: number; money: number }
export function containerRatio(r: CCResult, amount: { A: number; B: number }): CCRatio | null {
  if (!(amount.A > 0 && amount.B > 0)) return null;
  const rA = r.CA / amount.A, rB = r.CB / amount.B;
  return {
    rA: rA * 100, rB: rB * 100, d: (rB - rA) * 100,
    mix: (r.mix / amount.B) * 100, price: (r.price / amount.B) * 100,
    rev: rA * ((amount.A / r.QA) / (amount.B / r.QB) - 1) * 100,
    money: (rB - rA) * amount.B,
  };
}

const pp2 = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;
const pct1 = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n * 100).toFixed(1)}%`;
const man = (n: number) => `${Math.round(Math.abs(n) / 1e4).toLocaleString()}만 원`;
const sman = (n: number) => `${n >= 0 ? '+' : '−'}${man(n)}`;
const g1 = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)}%`;
const shortOf = (id: ContainerId) => CONTAINER_ITEMS.find((x) => x.id === id)!.short;
const mm = (m: string) => `${Number(m.slice(5))}월`;

/* ───────── 분석 (짧게) ─────────
 *  용기비 금액 증감은 물량(많이 만들면 많이 씀)이 대부분이라 보지 않는다. 비율로 본다:
 *   원가율 = 개당 용기단가 ÷ 용기 1개당 생산금액
 *   개당 용기단가 증감 = 구성(원/개) + 단가(원/개)   ← 용기 쪽
 *   원가율 증감(%p) = 구성 + 단가(용기 쪽) + 개당 생산금액(제품 쪽 — 제품 단가·구성, 용기와 무관) */
export interface CCPoint { k: string; t: string; tone: 'good' | 'bad' | 'plain' }
const s1 = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}`;
export function containerAnalysis(r: CCResult, q: CCRatio | null, amount: { A: number; B: number }): CCPoint[] {
  const tone = (v: number, eps: number): CCPoint['tone'] => (Math.abs(v) < eps ? 'plain' : v < 0 ? 'good' : 'bad');
  const dAvg = r.avgB - r.avgA, mixU = r.mixAvgDelta, priceU = r.price / r.QB;
  const pts: CCPoint[] = [];
  // 결론 — 용기 쪽(개당 용기단가) + 원가율이 어디서 움직였나
  let t = Math.abs(dAvg) < 0.3
    ? `용기 쪽은 개당 ${s1(dAvg)}원으로 거의 보합`
      + (Math.abs(mixU) >= 0.3 && Math.abs(priceU) >= 0.3 && Math.sign(mixU) !== Math.sign(priceU) ? ` (구성 ${s1(mixU)}원 ↔ 단가 ${s1(priceU)}원 상쇄)` : '')
    : `용기 쪽에서 개당 ${s1(dAvg)}원 ${dAvg < 0 ? '절감' : '상승'} (구성 ${s1(mixU)}원, 단가 ${s1(priceU)}원)`;
  if (q) {
    const cs = q.mix + q.price;
    const tail = `용기 쪽 ${pp2(cs)}%p, 제품 쪽 ${pp2(q.rev)}%p`;
    const dir = q.d < 0 ? '하락' : '상승';
    // 용기 쪽과 제품 쪽이 반대로 움직였으면 어느 쪽이 이겼는지, 진 쪽은 '오히려' 반대였다고 바로 쓴다
    const opp = Math.abs(cs) >= 0.005 && Math.abs(q.rev) >= 0.005 && Math.sign(cs) !== Math.sign(q.rev);
    t += Math.abs(q.d) < 0.005 ? ` · 원가율 보합 (${tail})`
      : opp && Math.sign(q.d) === Math.sign(q.rev)
        ? ` · 원가율 ${pp2(q.d)}%p ${dir}은 제품 쪽(${pp2(q.rev)}%p) ${q.d < 0 ? '덕분' : '때문'} — 용기 쪽은 오히려 ${pp2(cs)}%p ${cs > 0 ? '올림' : '내림'}`
        : opp
          ? ` · 원가율 ${pp2(q.d)}%p ${dir}은 용기 쪽(${pp2(cs)}%p) ${q.d < 0 ? '덕분' : '때문'} — 제품 쪽은 반대로 ${pp2(q.rev)}%p`
          : ` · 원가율 ${pp2(q.d)}%p ${dir}은 ${Math.abs(q.rev) > Math.abs(cs) ? '대부분 제품 쪽 몫' : '용기 쪽이 주도'} (${tail})`;
  } else t += ' · 두 달 생산금액을 넣으면 원가율로 봅니다';
  pts.push({ k: '결론', t, tone: tone(dAvg, 0.3) });

  const moved = [...r.rows].filter((x) => Math.abs(x.ds) >= 0.05).sort((x, y) => Math.abs(y.ds) - Math.abs(x.ds)).slice(0, 2);
  pts.push({
    k: '구성',
    t: (moved.length
      ? `${moved.map((x) => `${shortOf(x.id)}(${x.tier}) ${(x.sA * 100).toFixed(1)}% → ${(x.sB * 100).toFixed(1)}% (${s1(x.ds)}%p)`).join(', ')}`
      : '용기 비중 변화 거의 없음') + ` → 개당 ${s1(mixU)}원 (${sman(r.mix)})`,
    tone: tone(mixU, 0.3),
  });
  pts.push({
    k: '단가',
    t: r.priceChanged.length
      ? `${r.priceChanged.map((c) => `${shortOf(r.rows.find((x) => x.label === c.label)!.id)} ${won(c.pA)} → ${won(c.pB)}원`).join(', ')} → 개당 ${s1(priceU)}원 (${sman(r.price)})`
      : '품목별 단가 전월과 같음',
    tone: tone(priceU, 0.3),
  });
  if (q) {
    const perA = amount.A / r.QA, perB = amount.B / r.QB;
    pts.push({
      k: '제품 쪽',
      t: `생산금액 ${g1(amount.B / amount.A - 1)}, 용기 ${g1(r.QB / r.QA - 1)} → 용기 1개당 생산금액 ${Math.round(perA).toLocaleString()} → ${Math.round(perB).toLocaleString()}원 (${g1(perB / perA - 1)}) → 원가율 ${pp2(q.rev)}%p · 제품 단가·구성 몫, 용기와 무관`,
      tone: tone(q.rev, 0.005),
    });
  }
  return pts;
}

/* ───────── 재고조사 확인 (참고) — 투입 − 생산 = 로스 ─────────
 *  투입이 생산보다 적은 용기는 물리적으로 불가능 → 재고조사 수량·월말 시점 확인 */
export interface CCLossRow {
  id: ContainerId; label: string;
  prodA: number; stockA: number; lossA: number; rateA: number;
  prodB: number; stockB: number; lossB: number; rateB: number;
}
export interface CCLoss { rows: CCLossRow[]; QpA: number; QpB: number; QsA: number; QsB: number; rateA: number; rateB: number; checks: string[]; negatives: string[] }
type Qty = Partial<Record<ContainerId, number | null>>;
export function containerLoss(prod: { A: Qty; B: Qty }, stock: { A: Qty; B: Qty }, monthA: string, monthB: string): CCLoss | null {
  const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (!CONTAINER_ITEMS.every((it) => n(prod.A[it.id]) !== null && n(prod.B[it.id]) !== null && n(stock.A[it.id]) !== null && n(stock.B[it.id]) !== null)) return null;
  const rows: CCLossRow[] = CONTAINER_ITEMS.map((it) => {
    const prodA = prod.A[it.id]!, prodB = prod.B[it.id]!, stockA = stock.A[it.id]!, stockB = stock.B[it.id]!;
    return {
      id: it.id, label: it.label,
      prodA, stockA, lossA: stockA - prodA, rateA: prodA > 0 ? (stockA - prodA) / prodA : 0,
      prodB, stockB, lossB: stockB - prodB, rateB: prodB > 0 ? (stockB - prodB) / prodB : 0,
    };
  });
  const s = (f: (x: CCLossRow) => number) => rows.reduce((t, x) => t + f(x), 0);
  const QpA = s((x) => x.prodA), QpB = s((x) => x.prodB), QsA = s((x) => x.stockA), QsB = s((x) => x.stockB);
  const checks: string[] = [], negatives: string[] = [];
  ([['A', monthA], ['B', monthB]] as const).forEach(([k, m]) => {
    const ls = rows.map((x) => ({ x, l: k === 'A' ? x.lossA : x.lossB, rate: k === 'A' ? x.rateA : x.rateB }));
    const neg = ls.filter((y) => y.l < 0), big = ls.filter((y) => y.rate > 0.05);
    neg.forEach((y) => negatives.push(`${mm(m)} ${y.x.label} −${Math.abs(Math.round(y.l)).toLocaleString()}개`));
    if (!neg.length) return;
    const negT = neg.map((y) => `${shortOf(y.x.id)} ${Math.abs(Math.round(y.l)).toLocaleString()}개 적게`).join(', ');
    checks.push(big.length
      ? `${mm(m)} 재고조사: ${negT}, ${big.map((y) => `${shortOf(y.x.id)} ${pct1(y.rate)} 많게 잡힘`).join(', ')} (생산 대비) → 용기끼리 섞여 셌을 가능성. 합계는 맞음`
      : `${mm(m)} 재고조사: ${negT} 잡힘 (투입 < 생산, 불가능) → 재고조사 수량·월말 시점 확인`);
  });
  return { rows, QpA, QpB, QsA, QsB, rateA: (QsA - QpA) / QpA, rateB: (QsB - QpB) / QpB, checks, negatives };
}

/* ───────── 보고서 문구 ───────── */
export function containerReport(r: CCResult, q: CCRatio | null, negatives: string[]): { std: string[]; two: string[]; one: string } {
  const b = containerComments(r);
  const ratioLine = q
    ? `#. 용기 원가율 ${q.rA.toFixed(2)}% → ${q.rB.toFixed(2)}% (${Math.abs(q.d) < 0.005 ? '보합, ' : ''}${pp2(q.d)}%p, ${moneyText(q.money)} ${effectWord(q.money)}) : 구성(Mix) ${pp2(q.mix)}%p · 단가 ${pp2(q.price)}%p · 개당 생산금액 ${pp2(q.rev)}%p`
    : b.opt1[2];
  const warn = negatives.length ? `※ 재고조사 투입량이 생산량보다 적음 : ${negatives.join(', ')} — 재고조사·월말 시점 확인 필요` : '';
  const ranked = q ? (['mix', 'price', 'rev'] as const).map((k) => ({ k: k === 'mix' ? '구성(Mix)' : k === 'price' ? '단가' : '개당 생산금액', v: q[k] }))
    .filter((p) => Math.abs(p.v) >= 0.005).sort((x, y) => Math.abs(y.v) - Math.abs(x.v)) : [];
  const two = q ? [
    `#. 용기 원가율 ${q.rA.toFixed(2)}% → ${q.rB.toFixed(2)}% (${pp2(q.d)}%p, ${(Math.abs(q.money) / 1e6).toFixed(1)}백) / ${r.priceChanged.length ? '단가 변동' : '품목별 단가 동일'}, 사용 구성(Mix) ${r.mix <= 0 ? '개선으로' : '변동으로'} 평균단가 ${r.mixAvgDelta <= 0 ? '▼' : '▲'}${Math.abs(r.mixAvgDelta).toFixed(1)}원/개`,
    `#. 주요 요인: ${ranked.map((p) => `${p.k} ${pp2(p.v)}%p`).join(', ') || '변동 미미'}`,
  ] : b.opt2;
  return { std: [b.opt1[0], b.opt1[1], ratioLine, warn].filter(Boolean), two, one: b.opt3 };
}

/* ───────── 필름 (리드필름) ─────────
 *  롤 단위라 한 달씩 보면 월말에 롤을 언제 꺼냈는지에 따라 1~2롤씩 출렁인다 → 두 달 누적 로스율을 같이 본다.
 *  이론 롤 = 그 필름을 쓰는 생산량 ÷ 롤당 포장 개수(업체 기준).  로스율 = ERP 투입 롤 ÷ 이론 롤 − 1
 *  필름비 증감 = ① 물량(생산량 변화, 전월 롤/개·단가) + ② 사용량(개당 롤 변화 = 로스 변화) + ③ 단가   (합 = 증감) */
export const FILM_ITEMS = [
  { id: 'f2', label: '리드필름 2열 (베이비본죽)', short: '2열', line: '1·2호기 생산', perRoll: 6450 },
  { id: 'f4', label: '리드필름 냉장 4열 (베이비본죽)', short: '냉장 4열', line: '3호기 생산', perRoll: 12900 },
  { id: 'fr', label: '리드필름 4열 (베이비본 togo)', short: 'togo 4열', line: '실온 생산', perRoll: 12900 },
] as const;
export type FilmId = typeof FILM_ITEMS[number]['id'];

export interface FilmMonth {
  prod: Partial<Record<FilmId, number | null>>;
  rolls: Partial<Record<FilmId, number | null>>;
  price: Partial<Record<FilmId, number | null>>;
  amount: number;
}
export interface FilmRow {
  id: FilmId; label: string; short: string; line: string; perRoll: number;
  prodA: number; prodB: number; rollsA: number; rollsB: number; theoA: number; theoB: number;
  lossA: number; lossB: number; lossCum: number;
  pA: number; pB: number; costA: number; costB: number;
  vol: number; use: number; price: number;
}
export interface FilmResult {
  missing: string[];
  rows: FilmRow[];
  CA: number; CB: number; vol: number; use: number; price: number;
  rollsA: number; rollsB: number; theoA: number; theoB: number;
  /** %p (×100) — prod = 생산량·생산금액이 같이 움직이고 남는 몫, use = 사용량(로스), price = 단가 */
  ratio: { rA: number; rB: number; d: number; prod: number; use: number; price: number } | null;
}

export function analyzeFilm(a: FilmMonth, b: FilmMonth, monthA: string, monthB: string): FilmResult {
  const missing: string[] = [];
  const get = (m: FilmMonth, k: 'prod' | 'rolls' | 'price', id: FilmId, month: string, what: string) => {
    const v = m[k][id];
    if (typeof v !== 'number' || !Number.isFinite(v)) { missing.push(`${month} ${FILM_ITEMS.find((x) => x.id === id)!.label} ${what}`); return 0; }
    return v;
  };
  const rows: FilmRow[] = FILM_ITEMS.map((it) => {
    const prodA = get(a, 'prod', it.id, monthA, '생산량'), prodB = get(b, 'prod', it.id, monthB, '생산량');
    const rollsA = get(a, 'rolls', it.id, monthA, '투입 롤'), rollsB = get(b, 'rolls', it.id, monthB, '투입 롤');
    const pA = get(a, 'price', it.id, monthA, '롤 단가'), pB = get(b, 'price', it.id, monthB, '롤 단가');
    const theoA = prodA / it.perRoll, theoB = prodB / it.perRoll;
    const uA = prodA > 0 ? rollsA / prodA : 0, uB = prodB > 0 ? rollsB / prodB : 0;
    return {
      id: it.id, label: it.label, short: it.short, line: it.line, perRoll: it.perRoll,
      prodA, prodB, rollsA, rollsB, theoA, theoB,
      lossA: theoA > 0 ? rollsA / theoA - 1 : 0, lossB: theoB > 0 ? rollsB / theoB - 1 : 0,
      lossCum: theoA + theoB > 0 ? (rollsA + rollsB) / (theoA + theoB) - 1 : 0,
      pA, pB, costA: rollsA * pA, costB: rollsB * pB,
      vol: (prodB - prodA) * uA * pA, use: prodB * (uB - uA) * pA, price: rollsB * (pB - pA),
    };
  });
  const s = (f: (r: FilmRow) => number) => rows.reduce((t, r) => t + f(r), 0);
  const CA = s((r) => r.costA), CB = s((r) => r.costB);
  const vol = s((r) => r.vol), use = s((r) => r.use), price = s((r) => r.price);
  let ratio: FilmResult['ratio'] = null;
  if (!missing.length && a.amount > 0 && b.amount > 0) {
    const rA = CA / a.amount, rB = CB / b.amount;
    const u = use / b.amount, p = price / b.amount;
    ratio = { rA: rA * 100, rB: rB * 100, d: (rB - rA) * 100, prod: (rB - rA - u - p) * 100, use: u * 100, price: p * 100 };
  }
  return { missing, rows, CA, CB, vol, use, price, rollsA: s((r) => r.rollsA), rollsB: s((r) => r.rollsB), theoA: s((r) => r.theoA), theoB: s((r) => r.theoB), ratio };
}

/** 필름 — 짧은 분석 + 보고서 한 줄 */
export function filmSummary(f: FilmResult, monthA: string, monthB: string): { points: CCPoint[]; comment: string } {
  const lr = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`;
  const tone = (v: number): CCPoint['tone'] => (Math.abs(v) < 1 ? 'plain' : v < 0 ? 'good' : 'bad');
  const points: CCPoint[] = [];
  points.push({
    k: '결론',
    t: `필름비 ${man(f.CA)} → ${man(f.CB)} (${sman(f.CB - f.CA)})` + (f.ratio ? ` · 원가율 ${f.ratio.rA.toFixed(2)}% → ${f.ratio.rB.toFixed(2)}% (${pp2(f.ratio.d)}%p)` : ''),
    tone: f.ratio ? (Math.abs(f.ratio.d) < 0.005 ? 'plain' : f.ratio.d < 0 ? 'good' : 'bad') : tone(f.CB - f.CA),
  });
  points.push({ k: '나누기', t: `사용량(로스) ${sman(f.use)} · 단가 ${sman(f.price)} (물량 몫 ${sman(f.vol)}은 많이 만들어 많이 쓴 것 — 제외)`, tone: tone(f.use + f.price) });
  const worst = [...f.rows].sort((x, y) => y.lossCum - x.lossCum)[0];
  points.push({
    k: '로스',
    t: `두 달 누적 ${f.rows.map((r) => `${r.short} ${lr(r.lossCum)}`).join(' · ')}` + (worst && worst.lossCum > 0.05 ? ` → 가장 큼: ${worst.short}` : ''),
    tone: worst && worst.lossCum > 0.15 ? 'bad' : 'plain',
  });
  const odd: string[] = [];
  f.rows.forEach((r) => ([[monthA, r.lossA], [monthB, r.lossB]] as const).forEach(([m, l]) => { if (l < 0 || l > 0.5) odd.push(`${mm(m)} ${r.short} ${lr(l)}`); }));
  if (odd.length) points.push({ k: '확인', t: `${odd.join(', ')} — 롤 꺼낸 시점 차이로 한 달 값이 출렁임, 누적으로 판단`, tone: 'plain' });
  const comment = `#. 필름(리드필름) : 투입 ${f.rollsA}롤 → ${f.rollsB}롤(${sman(f.CB - f.CA)})`
    + (f.ratio ? `, 필름 원가율 ${f.ratio.rA.toFixed(2)}% → ${f.ratio.rB.toFixed(2)}%(${pp2(f.ratio.d)}%p)` : '')
    + ` / 두 달 누적 로스 ${f.rows.map((r) => `${r.short} ${lr(r.lossCum)}`).join(', ')}`;
  return { points, comment };
}
