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
