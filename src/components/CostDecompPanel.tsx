/** 원재료분석 › 원가율 분해 — 엑셀을 열지 않고 화면에서 보는 결론 · 연동 비교 · 효과 합계 · 원재료별/제품별/분류별 근거.
 *  계산은 src/lib/costDecomp.ts (수식 엑셀 「원가율분해」 시트와 같은 규칙). */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { DecompMatRow, DecompProdRow, DecompResult } from '../lib/costDecomp';
import { DECOMP_SWING, ratioDecomp, statusLabel } from '../lib/costDecomp';

export interface DecompView {
  result: DecompResult;
  recipeLabel: string;
  coverage: { a: number; b: number; missingA: number; missingB: number };
  hasActualA: boolean;
  hasActualB: boolean;
}

/* ===== 숫자 표기 ===== */
const sgn = (n: number) => (n > 0.5 ? '+' : n < -0.5 ? '−' : '');
/** 큰 금액은 만 원 단위 (보고용) */
const man = (n: number, signed = true) => {
  const a = Math.abs(n);
  const s = signed ? sgn(n) : n < -0.5 ? '−' : '';
  if (a >= 1e8 || Math.round(a / 1e4) >= 1e4) return `${s}${(a / 1e8).toFixed(2)}억`;
  if (a >= 1e4) return `${s}${Math.round(a / 1e4).toLocaleString()}만`;
  return `${s}${Math.round(a).toLocaleString()}`;
};
const won = (n: number) => `${sgn(n)}${Math.round(Math.abs(n)).toLocaleString()}`;
const pct = (v: number | null, d = 1) => (v === null ? '—' : `${(v * 100).toFixed(d)}%`);
const pp = (v: number | null, d = 2) => {
  if (v === null) return '—';
  const r = Math.abs(v * 100).toFixed(d);
  return `${Number(r) === 0 ? '' : v > 0 ? '+' : '−'}${r}%p`;
};
const tone = (n: number) => (n < -0.5 ? 'text-emerald-700' : n > 0.5 ? 'text-rose-700' : 'text-gray-500');
/** %p 값 색 — 표시 자릿수(0.00%p)에서 0 이면 회색 */
const toneP = (v: number) => tone(Math.abs(v * 100) < 0.005 ? 0 : v);

/** 가운데 0 기준으로 왼쪽(−, 유리)·오른쪽(+, 불리)으로 뻗는 막대 */
function Diverge({ v, max, neutral }: { v: number; max: number; neutral?: boolean }) {
  const w = max > 0 ? Math.min(50, (Math.abs(v) / max) * 50) : 0;
  return (
    <div className="relative h-3 w-full bg-gray-100 rounded">
      <div className="absolute inset-y-0 left-1/2 w-px bg-gray-400" />
      <div className={`absolute inset-y-0 rounded ${neutral ? 'bg-slate-400' : v < 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}
        style={v < 0 ? { right: '50%', width: `${w}%` } : { left: '50%', width: `${w}%` }} />
    </div>
  );
}

// 캐시 접두사(matAnalysis:) 밖에 둔다 — 「분석결과 삭제」가 사용자가 넣은 생산금액까지 지우지 않게
const AMT_KEY = (m: string) => `matDecompAmt:${m}`;
const readAmt = (m: string) => {
  try {
    const v = localStorage.getItem(AMT_KEY(m)) ?? localStorage.getItem(`matAnalysis:amt:${m}`);
    return Number(v) || 0;
  } catch { return 0; }
};

export default function CostDecompPanel({
  monthA, monthB, view, alt, recipeSrc, onRecipeSrc, yieldDbReady,
}: {
  monthA: string;
  monthB: string;
  view: DecompView;
  /** 다른 레시피 기준으로 낸 결과 (비교용) */
  alt: DecompView | null;
  recipeSrc: 'yield' | 'bom';
  onRecipeSrc: (v: 'yield' | 'bom') => void;
  yieldDbReady: boolean;
}) {
  const { rows, products, totals: t } = view.result;
  // 생산금액은 민감 수치라 이 브라우저에만 둔다 (서버 저장 안 함)
  const [amtA, setAmtA] = useState(() => readAmt(monthA));
  const [amtB, setAmtB] = useState(() => readAmt(monthB));
  useEffect(() => { setAmtA(readAmt(monthA)); setAmtB(readAmt(monthB)); }, [monthA, monthB]);
  const saveAmt = (m: string, v: number, set: (x: number) => void) => {
    set(v);
    try { if (v > 0) localStorage.setItem(AMT_KEY(m), String(v)); else localStorage.removeItem(AMT_KEY(m)); } catch { /* noop */ }
  };
  const ratio = ratioDecomp(t, amtA, amtB);

  const dM = t.MB - t.MA;
  const flexGap = t.MB - t.flexed;   // = ③ + ④ + ⑤
  const effects = [
    { key: 'vol', label: '① 물량', sub: '많이·적게 만들어서 (원가율엔 영향 없음)', v: t.vol, gain: null as number | null, loss: null as number | null, ratio: null as number | null },
    { key: 'price', label: '② 단가', sub: '원재료를 비싸게·싸게 사서', v: t.price, gain: t.gain.price, loss: t.loss.price, ratio: ratio?.price ?? null },
    { key: 'mix', label: '③ 제품 구성', sub: '원재료가 많이·적게 드는 제품을 더 만들어서', v: t.mix, gain: t.gain.mix, loss: t.loss.mix, ratio: ratio?.mix ?? null },
    { key: 'yld', label: '④ 수율', sub: '같은 제품을 더 적게·많이 투입해서', v: t.yld, gain: t.gain.yld, loss: t.loss.yld, ratio: ratio?.yld ?? null },
    { key: 'other', label: '⑤ 기타', sub: '수율을 비교할 수 없는 원재료', v: t.other, gain: t.gain.other, loss: t.loss.other, ratio: ratio?.other ?? null },
  ];
  const effMax = Math.max(1, ...effects.map((e) => Math.abs(e.v)));

  /* ===== 결론 문장 ===== */
  const conclusion = useMemo(() => {
    const zero = (v: number) => Math.abs(v) < 0.5;
    const byYld = rows.filter((r) => r.status === 'ok').sort((a, b) => a.yld - b.yld);
    const bestY = byYld.filter((r) => r.yld < -0.5).slice(0, 3);
    const worstY = byYld.filter((r) => r.yld > 0.5).slice(-3).reverse();
    // 레시피 없는 제품은 개당 원재료비를 알 수 없어(0 으로 계산) '싼 제품'처럼 보이므로 결론 문장에서 뺀다
    const prodSorted = products.filter((p) => p.hasRecipe && p.ings.length > 0).sort((a, b) => a.effect - b.effect);
    const prodGain = prodSorted.filter((p) => p.effect < -0.5).slice(0, 2);
    const prodLoss = prodSorted.filter((p) => p.effect > 0.5).slice(-2).reverse();
    const parts = [
      { name: '수율', v: t.yld }, { name: '제품 구성', v: t.mix }, { name: '기타(비교 불가 원재료)', v: t.other },
    ].sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    // '가장 큰 이유'는 증감과 같은 방향인 몫 중에서 고른다. 반대로 작용한 더 큰 몫이 있으면 따로 적는다
    const same = parts.filter((x) => !zero(x.v) && Math.sign(x.v) === Math.sign(flexGap));
    const against = parts.filter((x) => !zero(x.v) && Math.sign(x.v) !== Math.sign(flexGap));
    const growth = t.QA > 0 ? t.QB / t.QA - 1 : 0;
    // 전체 생산이 k 배가 됐을 때보다 더/덜 — 실제 수량이 늘었어도 비중은 줄었을 수 있어 '비중'으로 쓴다
    const prodPhrase = (p: DecompProdRow) =>
      `${p.name}(원재료비가 평균보다 ${p.vsBase > 0 ? '많이' : '적게'} 드는 제품)의 생산 비중이 ${p.delta > 0 ? '늘어' : '줄어'} ${man(p.effect)}`;
    const swingRows = rows.filter((r) => r.swing).sort((a, b) => Math.abs(b.yld) - Math.abs(a.yld));
    const swingNames = swingRows.slice(0, 3).map((r) => r.name);
    const headline = zero(flexGap)
      ? '같은 생산량 · 같은 단가로 놓고 보면 원재료비 차이가 없습니다.'
      : `같은 생산량 · 같은 단가로 놓고 보면 원재료비가 ${man(Math.abs(flexGap), false)}원 ${flexGap < 0 ? '줄었습니다' : '늘었습니다'}.`
        + (same.length ? ` 가장 큰 이유는 「${same[0].name}」(${man(same[0].v)}원)입니다.` : '')
        + (against.length && same.length && Math.abs(against[0].v) > Math.abs(same[0].v) * 0.5
          ? ` 다만 「${against[0].name}」은 반대로 ${man(against[0].v)}원 작용했습니다.` : '');
    const volPart = zero(t.vol) ? '' : `생산량이 ${Math.abs(growth * 100).toFixed(1)}% ${growth >= 0 ? '늘어' : '줄어'} 생긴 ① 물량(${man(t.vol)})`;
    const pricePart = zero(t.price) ? '' : `② 단가(${man(t.price)})`;
    const minus = [volPart, pricePart].filter(Boolean);
    return {
      headline,
      lines: [
        `${monthB} 원재료비는 ${man(t.MB, false)}원으로 ${monthA}보다 ${zero(dM) ? '변함없습니다' : `${man(dM)}원(${t.MA > 0 ? `${sgn(dM)}${Math.abs((dM / t.MA) * 100).toFixed(1)}%` : '—'}) 변했습니다`}.`
          + (minus.length ? ` ${minus.length === 2 ? `${volPart}과 ${pricePart}를` : volPart ? `${volPart}을` : `${pricePart}를`} 빼면, 같은 생산량·같은 단가 기준 차이는 ${man(flexGap)}원입니다.` : ''),
        zero(t.yld) && !bestY.length && !worstY.length
          ? '수율 변화로 생긴 차이는 없습니다.'
          : `수율 ${man(t.yld)}원 — 좋아진 원재료 ${man(t.gain.yld)} · 나빠진 원재료 ${man(t.loss.yld)}.${bestY.length ? ` 많이 아낀 원재료: ${bestY.map((r) => `${r.name} ${man(r.yld)}`).join(', ')}.` : ''}${worstY.length ? ` 더 쓴 원재료: ${worstY.map((r) => `${r.name} ${man(r.yld)}`).join(', ')}.` : ''}`,
        zero(t.mix)
          ? '제품 구성 변화로 생긴 차이는 없습니다.'
          : `제품 구성 ${man(t.mix)}원 — 생산 비중이 원재료가 ${t.mix > 0 ? '더' : '덜'} 드는 제품 쪽으로 옮겨 갔습니다.${prodLoss.length ? ` 원재료비를 늘린 제품: ${prodLoss.map(prodPhrase).join(', ')}.` : ''}${prodGain.length ? ` 줄인 제품: ${prodGain.map(prodPhrase).join(', ')}.` : ''}`,
        ratio
          ? `원재료비율 ${pct(ratio.rA, 2)} → ${pct(ratio.rB, 2)} (${pp(ratio.dr)}) — 수율 ${pp(ratio.yld)} · 제품 구성 ${pp(ratio.mix)} · 단가 ${pp(ratio.price)} · 개당 생산금액 ${pp(ratio.rev)} · 기타 ${pp(ratio.other)}.`
          : '아래 「원가율로 보기」에 두 달 생산금액을 넣으면 원재료비율(%p)로도 나눠 드립니다.',
      ],
      warns: [
        t.aSubShare >= 0.999
          ? `${monthA} 단가가 없어 그달 원재료비를 모두 ${monthB} 단가로 계산했습니다 — 그래서 ② 단가 효과는 0 이고, 나머지는 '같은 단가' 기준의 순수한 차이입니다.`
          : t.aSubShare >= 0.1
            ? `${monthA} 원재료비의 ${Math.round(t.aSubShare * 100)}%는 그달 단가가 없어 다른 달 단가로 계산했습니다 — 그 원재료들은 단가 효과가 0 으로 잡혀 ② 가 실제보다 작게 보일 수 있습니다.`
            : '',
        t.swingCount > 0 && !zero(t.swingYld)
          ? `수율 효과 ${man(t.yld)}에는 수율이 ${DECOMP_SWING * 100}%p 넘게 바뀐 원재료 ${t.swingCount}종(${swingNames.join('·')} 등)의 ${man(t.swingYld)}이 들어 있습니다. 두 달 모두 지금 레시피로 계산하므로, 그사이 배합(개당 g)을 바꿨거나 입력이 틀렸으면 그 차이가 수율로 보입니다 — 확인 후 성과로 쓰세요.`
          : '',
        Math.abs(t.other) > Math.abs(flexGap) * 0.3 && Math.abs(t.other) >= 1e5 ? `⑤ 기타(${man(t.other)})가 큽니다 — 아래 원재료별 표에서 '비교 불가'를 눌러 실투입 없음·범위 밖 원재료를 확인하세요.` : '',
        view.coverage.missingA + view.coverage.missingB > 0 ? `레시피가 없는 제품이 있습니다 (${monthA} ${Math.round(view.coverage.missingA).toLocaleString()} EA · ${monthB} ${Math.round(view.coverage.missingB).toLocaleString()} EA) — 그 제품 원재료는 표준소요 0 이라 수율·구성이 왜곡될 수 있습니다.` : '',
        ratio && (ratio.rA > 2 || ratio.rB > 2 || ratio.rA < 0.01 || ratio.rB < 0.01) ? '원재료비율이 1~200% 범위를 벗어납니다 — 생산금액 단위(원)를 확인하세요.' : '',
      ].filter(Boolean),
    };
  }, [rows, products, t, flexGap, dM, ratio, monthA, monthB, view]);

  const [tab, setTab] = useState<'mat' | 'prod' | 'cat'>('mat');

  // 실투입이 없는 달이 있으면 원재료비가 0 으로 계산돼 '100% 감소' 같은 엉뚱한 결론이 나온다 — 안내만 보여준다
  if (!view.hasActualA || !view.hasActualB || !(t.QA > 0)) {
    const miss = [!view.hasActualA ? monthA : '', !view.hasActualB ? monthB : ''].filter(Boolean).join(', ');
    const msg = miss
      ? `${miss} 실투입(설정 › 실제 투입중량)이 없어 원재료비를 계산할 수 없습니다. 실투입을 넣은 뒤 다시 분석하세요.`
      : `${monthA} 생산량이 없어 분해할 수 없습니다 (앱 도입 전 달이면 설정 › 월별 생산수량을 넣으세요).`;
    return (
      <div className="bg-white border-2 border-amber-300 rounded-lg p-4">
        <div className="font-bold text-gray-800">💰 원가율 분해 <span className="text-sm font-normal text-gray-500">{monthA} → {monthB}</span></div>
        <div className="mt-2 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          ⚠ {msg}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border-2 border-slate-300 rounded-lg overflow-hidden">
      {/* 머리 */}
      <div className="px-4 py-3 bg-slate-800 text-white flex items-center gap-3 flex-wrap">
        <span className="font-bold">💰 원가율 분해</span>
        <span className="text-sm text-slate-300">{monthA} → {monthB}</span>
        <div className="flex items-center text-xs rounded overflow-hidden border border-slate-500">
          <span className="px-2 py-1 bg-slate-700 text-slate-300">레시피</span>
          {([['yield', '분석용'], ['bom', '현장 BOM']] as const).map(([v, label]) => (
            <button key={v} onClick={() => onRecipeSrc(v)} disabled={v === 'yield' && !yieldDbReady}
              className={`px-2.5 py-1 font-semibold ${recipeSrc === v ? 'bg-white text-slate-800' : 'text-slate-200 hover:bg-slate-700'} disabled:opacity-40`}>{label}</button>
          ))}
        </div>
        <span className="text-[11px] text-slate-400 ml-auto">원재료비 = ERP 실투입 × 그달 재고평가 단가 (없으면 {monthB} 단가) · 연동은 {monthB} 단가 · {view.recipeLabel}</span>
      </div>

      {/* 결론 */}
      <div className="p-4 bg-amber-50 border-b border-amber-200">
        <div className="text-xs font-bold text-amber-800 mb-1">📌 결론</div>
        <div className="text-base sm:text-lg font-bold text-gray-900 leading-snug">{conclusion.headline}</div>
        <ul className="mt-2 space-y-1 text-sm text-gray-800 list-disc pl-5">
          {conclusion.lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
        {conclusion.warns.length > 0 && (
          <div className="mt-2 space-y-1">
            {conclusion.warns.map((w, i) => <div key={i} className="text-xs text-amber-900 bg-amber-100 border border-amber-300 rounded px-2 py-1">⚠ {w}</div>)}
          </div>
        )}
      </div>

      {/* 연동 비교 — A → 연동 → B */}
      <div className="p-4 border-b">
        <div className="text-xs font-bold text-gray-600 mb-2">🔁 {monthB} 기준 연동 비교</div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto_1fr] gap-2 items-stretch">
          <Kpi title={`${monthA} 원재료비`} value={man(t.MA, false)} note={`생산 ${Math.round(t.QA).toLocaleString()} EA`} />
          <Arrow label="① 물량 + ② 단가" v={t.vol + t.price} />
          <Kpi title="연동 원재료비" value={man(t.flexed, false)} note={`${monthA} 쓰임새를 ${monthB} 생산량(×${t.k.toFixed(3)})·단가로 환산`} accent />
          <Arrow label="③ 구성 + ④ 수율 + ⑤ 기타" v={flexGap} />
          <Kpi title={`${monthB} 원재료비`} value={man(t.MB, false)} note={`생산 ${Math.round(t.QB).toLocaleString()} EA`} />
        </div>
      </div>

      {/* 효과 합계 */}
      <div className="p-4 border-b">
        <div className="text-xs font-bold text-gray-600 mb-2">📊 원재료비 증감 {man(dM)}원을 나누면 <span className="font-normal text-gray-400">(− 줄어듦 · + 늘어남 · 합은 실제 증감과 같음)</span></div>
        <div className="space-y-2">
          {effects.map((e) => (
            <div key={e.key} className="grid grid-cols-[7.5rem_1fr_6.5rem] sm:grid-cols-[10rem_1fr_7rem_12rem] gap-2 items-center">
              <div>
                <div className="text-sm font-bold text-gray-800">{e.label}</div>
                <div className="text-[10px] text-gray-500 leading-tight">{e.sub}</div>
              </div>
              <Diverge v={e.v} max={effMax} neutral={e.key === 'vol'} />
              <div className={`text-right font-bold tabular-nums ${e.key === 'vol' ? 'text-gray-700' : tone(e.v)}`}>{man(e.v)}</div>
              <div className="hidden sm:block text-[11px] text-gray-500 tabular-nums">
                {e.gain !== null && e.loss !== null ? <>유리 <span className="text-emerald-700">{man(e.gain)}</span> · 불리 <span className="text-rose-700">{man(e.loss)}</span></> : '원가율엔 영향 없음'}
              </div>
            </div>
          ))}
          <div className="grid grid-cols-[7.5rem_1fr_6.5rem] sm:grid-cols-[10rem_1fr_7rem_12rem] gap-2 items-center border-t pt-2">
            <div className="text-sm font-bold">합계</div>
            <div className="text-[11px] text-gray-500">{monthB} − {monthA}</div>
            <div className={`text-right font-bold tabular-nums ${tone(dM)}`}>{man(dM)}</div>
            <div className="hidden sm:block" />
          </div>
        </div>
      </div>

      {/* 원가율로 보기 */}
      <div className="p-4 border-b bg-slate-50">
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span className="text-xs font-bold text-gray-600">🧮 원가율로 보기</span>
          <span className="text-[11px] text-gray-400">생산금액(원)은 이 브라우저에만 저장됩니다</span>
          <AmtInput label={monthA} value={amtA} onChange={(v) => saveAmt(monthA, v, setAmtA)} />
          <AmtInput label={monthB} value={amtB} onChange={(v) => saveAmt(monthB, v, setAmtB)} />
        </div>
        {ratio ? (
          <div className="grid grid-cols-1 sm:grid-cols-[14rem_1fr] gap-3 items-start">
            <div className="bg-white border rounded p-3">
              <div className="text-xs text-gray-500">원재료비율</div>
              <div className="text-xl font-bold tabular-nums">{pct(ratio.rA, 2)} → {pct(ratio.rB, 2)}</div>
              <div className={`text-sm font-bold ${toneP(ratio.dr)}`}>{pp(ratio.dr)}</div>
            </div>
            <div className="space-y-1.5">
              {[
                { label: 'ⓐ 개당 생산금액 (판가·매출 구성)', v: ratio.rev },
                { label: '② 원재료 단가', v: ratio.price },
                { label: '③ 제품 구성 (원재료 쪽)', v: ratio.mix },
                { label: '④ 수율', v: ratio.yld },
                { label: '⑤ 기타', v: ratio.other },
              ].map((x, _i, arr) => {
                const mx = Math.max(1e-9, ...arr.map((y) => Math.abs(y.v)));
                return (
                  <div key={x.label} className="grid grid-cols-[7rem_1fr_4.5rem] sm:grid-cols-[11rem_1fr_5rem] gap-2 items-center">
                    <span className="text-xs text-gray-700 leading-tight">{x.label}</span>
                    <Diverge v={x.v * 1e8} max={mx * 1e8} />
                    <span className={`text-right text-sm font-bold tabular-nums ${toneP(x.v)}`}>{pp(x.v)}</span>
                  </div>
                );
              })}
              <div className="text-[10px] text-gray-500">① 물량은 생산금액도 같이 늘어 비율에서는 상쇄되어 ⓐ 안으로 들어갑니다. 다섯 줄을 더하면 원재료비율 증감과 같습니다.</div>
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-500">두 달 생산금액을 넣으면 원재료비율 증감(%p)을 수율·제품 구성·단가·개당 생산금액으로 나눠 보여줍니다.</div>
        )}
      </div>

      {/* 레시피 기준 비교 */}
      {alt && (
        <div className="p-4 border-b">
          <div className="text-xs font-bold text-gray-600 mb-2">🧾 레시피 기준에 따라 얼마나 달라지나</div>
          <div className="overflow-x-auto">
            <table className="text-xs min-w-[520px] w-full">
              <thead className="text-gray-500">
                <tr><th className="text-left px-2 py-1">레시피</th><th className="text-right px-2 py-1">③ 제품 구성</th><th className="text-right px-2 py-1">④ 수율</th><th className="text-right px-2 py-1">⑤ 기타</th><th className="text-right px-2 py-1">수율 비교 원재료</th><th className="text-right px-2 py-1">레시피 반영</th></tr>
              </thead>
              <tbody>
                {[view, alt].map((v, i) => {
                  const tt = v.result.totals;
                  const okN = v.result.rows.filter((r) => r.status === 'ok').length;
                  return (
                    <tr key={i} className={`border-t ${i === 0 ? 'font-bold bg-indigo-50/50' : ''}`}>
                      <td className="px-2 py-1">{v.recipeLabel}{i === 0 ? ' (지금 보는 것)' : ''}</td>
                      <td className={`text-right px-2 py-1 tabular-nums ${tone(tt.mix)}`}>{man(tt.mix)}</td>
                      <td className={`text-right px-2 py-1 tabular-nums ${tone(tt.yld)}`}>{man(tt.yld)}</td>
                      <td className={`text-right px-2 py-1 tabular-nums ${tone(tt.other)}`}>{man(tt.other)}</td>
                      <td className="text-right px-2 py-1">{okN}종</td>
                      <td className="text-right px-2 py-1">{v.coverage.a.toFixed(1)}% · {v.coverage.b.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] text-gray-500 mt-1">① 물량 · ② 단가 · 원재료비 합계는 실투입 × 단가라 레시피와 무관하게 같고, 레시피는 「표준소요」만 바꿔 ③·④·⑤ 의 나눔이 달라집니다.</div>
        </div>
      )}

      {/* 근거 */}
      <div className="px-4 pt-3 flex gap-1 border-b">
        {([['mat', `원재료별 (${rows.filter((r) => r.status !== 'noUse').length})`], ['prod', `제품별 구성 (${products.length})`], ['cat', '분류별']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-1.5 text-sm rounded-t border-b-2 ${tab === k ? 'border-indigo-600 text-indigo-700 font-bold' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>{label}</button>
        ))}
      </div>
      <div className="p-4">
        {tab === 'mat' && <MaterialTable rows={rows} monthA={monthA} monthB={monthB} />}
        {tab === 'prod' && <ProductTable products={products} cbar={t.cbar} monthA={monthA} monthB={monthB} />}
        {tab === 'cat' && <CategoryTable rows={rows} monthA={monthA} monthB={monthB} />}
      </div>
    </div>
  );
}

function Kpi({ title, value, note, accent }: { title: string; value: string; note: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? 'bg-indigo-50 border-indigo-200' : 'bg-white'}`}>
      <div className="text-xs text-gray-500">{title}</div>
      <div className="text-xl font-bold tabular-nums">{value}<span className="text-sm font-normal text-gray-500">원</span></div>
      <div className="text-[10px] text-gray-500 leading-tight mt-0.5">{note}</div>
    </div>
  );
}
function Arrow({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex sm:flex-col items-center justify-center gap-1 px-1 text-center">
      <span className="text-gray-400 text-lg leading-none"><span className="sm:hidden">↓</span><span className="hidden sm:inline">→</span></span>
      <span className={`text-sm font-bold tabular-nums ${tone(v)}`}>{man(v)}</span>
      <span className="text-[10px] text-gray-500 leading-tight max-w-[7rem]">{label}</span>
    </div>
  );
}
/** '35억' · '3,512,000,000' · '1.5억' · '3억5천만' 을 원으로. 못 읽으면 null (기존 값 유지) */
function parseWon(text: string): number | null {
  const t = text.replace(/[\s,원]/g, '');
  if (!t) return 0;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const units: Record<string, number> = { 억: 1e8, 천만: 1e7, 백만: 1e6, 만: 1e4, 천: 1e3 };
  let rest = t, total = 0;
  const re = /^(\d+(?:\.\d+)?)(억|천만|백만|만|천)?/;
  while (rest) {
    const m = rest.match(re);
    if (!m) return null;
    total += Number(m[1]) * (m[2] ? units[m[2]] : 1);
    rest = rest.slice(m[0].length);
    if (!m[2] && rest) return null;
  }
  return Math.round(total);
}
function AmtInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(value ? value.toLocaleString() : '');
  useEffect(() => { setText(value ? value.toLocaleString() : ''); }, [value]);
  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="text-gray-600">{label}</span>
      <input value={text} placeholder="예: 35억"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { const n = parseWon(text); if (n === null) { setText(value ? value.toLocaleString() : ''); return; } onChange(n); setText(n ? n.toLocaleString() : ''); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="w-36 border rounded px-2 py-1 text-right tabular-nums bg-yellow-50" />
    </label>
  );
}

/* ===== 원재료별 ===== */
type MatFilter = 'all' | 'gain' | 'loss' | 'swing' | 'na';
type MatSort = 'yld' | 'mix' | 'other' | 'costB' | 'dY' | 'name';
function MaterialTable({ rows, monthA, monthB }: { rows: DecompMatRow[]; monthA: string; monthB: string }) {
  const [f, setF] = useState<MatFilter>('all');
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<MatSort>('yld');
  const [open, setOpen] = useState<string | null>(null);
  const base = rows.filter((r) => r.status !== 'noUse');
  const cats = [...new Set(base.map((r) => r.category).filter(Boolean))].sort((a, b) => (a === '미분류' ? 1 : b === '미분류' ? -1 : a.localeCompare(b)));
  const list = base
    .filter((r) => (f === 'all' ? true : f === 'gain' ? r.yld < -0.5 : f === 'loss' ? r.yld > 0.5 : f === 'swing' ? r.swing : r.status !== 'ok' && r.status !== 'bUnused' && r.status !== 'aUnused'))
    .filter((r) => !cat || r.category === cat)
    .filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()) || r.code.includes(q.trim()))
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'costB') return b.costB - a.costB;
      if (sort === 'dY') return (a.dY ?? 99) - (b.dY ?? 99);
      if (sort === 'yld') return a.yld - b.yld || Math.abs(b.mix) - Math.abs(a.mix);
      return Math.abs(b[sort]) - Math.abs(a[sort]);
    });
  const sum = (k: 'yld' | 'mix' | 'other' | 'price' | 'costA' | 'costB') => list.reduce((s, r) => s + r[k], 0);
  const chip = (k: MatFilter, label: string, n: number) => (
    <button onClick={() => setF(k)} className={`px-2.5 py-1 rounded-full text-xs border ${f === k ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>{label} <span className="opacity-70">{n}</span></button>
  );
  const th = (k: MatSort, label: string, cls = 'text-right') => (
    <th className={`px-2 py-1.5 ${cls} cursor-pointer select-none whitespace-nowrap ${sort === k ? 'text-indigo-700' : ''}`} onClick={() => setSort(k)}>{label}{sort === k ? ' ▾' : ''}</th>
  );
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        {chip('all', '전체', base.length)}
        {chip('gain', '수율 좋아짐', base.filter((r) => r.yld < -0.5).length)}
        {chip('loss', '수율 나빠짐', base.filter((r) => r.yld > 0.5).length)}
        {chip('swing', `⚠ ${DECOMP_SWING * 100}%p 넘게 변함`, base.filter((r) => r.swing).length)}
        {chip('na', '비교 불가', base.filter((r) => r.status !== 'ok' && r.status !== 'bUnused' && r.status !== 'aUnused').length)}
        <select value={cat} onChange={(e) => setCat(e.target.value)} className="border rounded px-2 py-1 text-xs ml-auto">
          <option value="">분류 전체</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="원재료 검색" className="border rounded px-2 py-1 text-xs w-32" />
      </div>
      <div className="overflow-x-auto border rounded max-h-[560px] overflow-y-auto">
        <table className="w-full text-xs min-w-[760px]">
          <thead className="bg-gray-50 text-gray-600 sticky top-0 z-10">
            <tr>
              {th('name', '원재료', 'text-left')}
              <th className="px-2 py-1.5 text-right">{monthA} 수율</th>
              <th className="px-2 py-1.5 text-right">{monthB} 수율</th>
              {th('dY', '증감')}
              {th('yld', '④ 수율효과')}
              {th('mix', '③ 제품구성')}
              {th('other', '⑤ 기타')}
              {th('costB', `${monthB} 원재료비`)}
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.map((r) => (
              <Fragment key={r.key}>
                <tr onClick={() => setOpen(open === r.key ? null : r.key)} className={`cursor-pointer hover:bg-indigo-50/40 ${r.swing ? 'bg-amber-50/60' : ''}`}>
                  <td className="px-2 py-1.5">
                    <div className="font-semibold text-gray-800">{r.name}{r.swing && <span className="ml-1 text-amber-700" title="수율이 크게 바뀜 — 레시피 변경·입력 확인">⚠</span>}</div>
                    <div className="text-[10px] text-gray-400">{r.category || '—'}{r.status !== 'ok' ? ` · ${statusLabel(r.status, monthA, monthB)}` : ''}</div>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{pct(r.yA)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{pct(r.yB)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${r.dY === null ? 'text-gray-400' : r.dY > 0 ? 'text-emerald-700' : r.dY < 0 ? 'text-rose-700' : ''}`}>{r.dY === null ? '—' : pp(r.dY, 1)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${tone(r.yld)}`}>{Math.abs(r.yld) >= 1 ? won(r.yld) : '—'}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${tone(r.mix)}`}>{Math.abs(r.mix) >= 1 ? won(r.mix) : '—'}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${tone(r.other)}`}>{Math.abs(r.other) >= 1 ? won(r.other) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-700">{Math.round(r.costB).toLocaleString()}</td>
                </tr>
                {open === r.key && (
                  <tr className="bg-slate-50">
                    <td colSpan={8} className="px-3 py-2 text-[11px] text-gray-700">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
                        <span>ERP코드 <b>{r.code || '—'}</b></span>
                        <span>표준소요 {(r.stdA / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} → {(r.stdB / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</span>
                        <span>실투입 {(r.actA / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} → {(r.actB / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</span>
                        <span>단가 {(r.pB * 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })}원/kg{r.pBSub ? ' (다른 달)' : ''}{r.pASub ? '' : ` · ${monthA} ${(r.pA * 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span>
                        <span>상태 <b>{statusLabel(r.status, monthA, monthB)}</b></span>
                        {r.kgDelta !== null && <span>수율로 {r.kgDelta > 0 ? '더' : '덜'} 쓴 양 <b>{Math.abs(r.kgDelta).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</b></span>}
                        <span>원재료비 {Math.round(r.costA).toLocaleString()} → {Math.round(r.costB).toLocaleString()}</span>
                        {Math.abs(r.price) >= 1 && <span>② 단가 {won(r.price)}</span>}
                      </div>
                      {r.swing && <div className="mt-1 text-amber-800">⚠ 수율이 {pp(r.dY, 1)} 바뀌었습니다. 두 달 모두 지금 레시피로 표준을 잡으므로, 그사이 배합(개당 g)을 바꿨거나 실투입 입력이 틀렸으면 그 차이가 수율로 보입니다.</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          <tfoot className="bg-amber-50 font-bold sticky bottom-0">
            <tr>
              <td className="px-2 py-1.5">합계 ({list.length}종)</td>
              <td colSpan={3} />
              <td className={`px-2 py-1.5 text-right tabular-nums ${tone(sum('yld'))}`}>{won(sum('yld'))}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${tone(sum('mix'))}`}>{won(sum('mix'))}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${tone(sum('other'))}`}>{won(sum('other'))}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{Math.round(sum('costB')).toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="text-[10px] text-gray-500">줄을 누르면 표준소요·실투입·단가가 보입니다. ④ 수율효과 = ({monthB} 실투입 − {monthB} 표준 ÷ {monthA} 수율) × {monthB} 단가. − 는 덜 써서 아낀 금액입니다.</div>
    </div>
  );
}

/* ===== 제품별 구성 ===== */
function ProductTable({ products, cbar, monthA, monthB }: { products: DecompProdRow[]; cbar: number; monthA: string; monthB: string }) {
  const [f, setF] = useState<'all' | 'gain' | 'loss'>('all');
  const [q, setQ] = useState('');
  const [more, setMore] = useState(false);
  const list = products
    .filter((p) => (f === 'all' ? true : f === 'gain' ? p.effect < -0.5 : p.effect > 0.5))
    .filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.key.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  const shown = more ? list : list.slice(0, 40);
  const sumEff = list.reduce((s, p) => s + p.effect, 0);
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-gray-600 bg-slate-50 border rounded px-2 py-1.5">
        기준선 = {monthA} 평균 개당 원재료비 <b>{Math.round(cbar).toLocaleString()}원</b>.
        이보다 원재료비가 비싼 제품을 생산량 비율보다 <b>더</b> 만들면 원재료비가 오르고(+), 싼 제품을 더 만들면 내려갑니다(−).
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {([['all', '전체'], ['gain', '원재료비를 줄인 제품'], ['loss', '늘린 제품']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setF(k)} className={`px-2.5 py-1 rounded-full text-xs border ${f === k ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>{label}</button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="제품 검색" className="border rounded px-2 py-1 text-xs w-32 ml-auto" />
      </div>
      <div className="overflow-x-auto border rounded max-h-[560px] overflow-y-auto">
        <table className="w-full text-xs min-w-[720px]">
          <thead className="bg-gray-50 text-gray-600 sticky top-0 z-10">
            <tr>
              <th className="px-2 py-1.5 text-left">품목</th>
              <th className="px-2 py-1.5 text-right">{monthA} 생산</th>
              <th className="px-2 py-1.5 text-right">{monthB} 생산</th>
              <th className="px-2 py-1.5 text-right">비율대로였다면 대비</th>
              <th className="px-2 py-1.5 text-right">개당 원재료비</th>
              <th className="px-2 py-1.5 text-right">기준선 대비</th>
              <th className="px-2 py-1.5 text-right">③ 구성효과</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((p) => (
              <tr key={p.key} className={!p.hasRecipe ? 'bg-rose-50/50' : ''}>
                <td className="px-2 py-1.5">
                  <div className="font-semibold text-gray-800">{p.name}</div>
                  <div className="text-[10px] text-gray-400">{p.kind === 'cold' ? p.key : '실온'}{!p.hasRecipe ? ' · 레시피 없음' : ''}</div>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{Math.round(p.qtyA).toLocaleString()}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{Math.round(p.qtyB).toLocaleString()}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums ${p.delta > 0 ? 'text-indigo-700' : 'text-gray-600'}`}>{won(p.delta) || '0'}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{p.hasRecipe ? Math.round(p.costPerEa).toLocaleString() : <span className="text-rose-600">미상</span>}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums ${p.vsBase > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{won(p.vsBase)}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${tone(p.effect)}`}>{won(p.effect)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-amber-50 font-bold sticky bottom-0">
            <tr>
              <td className="px-2 py-1.5">합계 ({list.length}개)</td>
              <td colSpan={5} />
              <td className={`px-2 py-1.5 text-right tabular-nums ${tone(sumEff)}`}>{won(sumEff)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {list.length > 40 && (
        <button onClick={() => setMore(!more)} className="text-xs text-indigo-700 hover:underline">{more ? '접기' : `나머지 ${list.length - 40}개 더 보기`}</button>
      )}
    </div>
  );
}

/* ===== 분류별 ===== */
function CategoryTable({ rows, monthA, monthB }: { rows: DecompMatRow[]; monthA: string; monthB: string }) {
  const cats = new Map<string, { yld: number; mix: number; other: number; price: number; costB: number; sE: number; sG: number; sF: number; sH: number; n: number }>();
  rows.forEach((r) => {
    if (r.status === 'noUse') return;
    const k = r.category || '미분류';
    const c = cats.get(k) || { yld: 0, mix: 0, other: 0, price: 0, costB: 0, sE: 0, sG: 0, sF: 0, sH: 0, n: 0 };
    c.yld += r.yld; c.mix += r.mix; c.other += r.other; c.price += r.price; c.costB += r.costB; c.n += 1;
    if (r.status === 'ok') { c.sE += r.stdA; c.sG += r.actA; c.sF += r.stdB; c.sH += r.actB; }
    cats.set(k, c);
  });
  const list = [...cats.entries()].sort((a, b) => a[1].yld - b[1].yld);
  const mx = Math.max(1, ...list.map(([, c]) => Math.abs(c.yld)));
  return (
    <div className="overflow-x-auto border rounded">
      <table className="w-full text-xs min-w-[720px]">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="px-2 py-1.5 text-left">분류</th>
            <th className="px-2 py-1.5 text-right">{monthA} → {monthB} 수율</th>
            <th className="px-2 py-1.5 w-40">④ 수율효과</th>
            <th className="px-2 py-1.5 text-right" />
            <th className="px-2 py-1.5 text-right">③ 제품구성</th>
            <th className="px-2 py-1.5 text-right">⑤ 기타</th>
            <th className="px-2 py-1.5 text-right">{monthB} 원재료비</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {list.map(([name, c]) => (
            <tr key={name}>
              <td className="px-2 py-1.5 font-semibold">{name} <span className="text-[10px] text-gray-400 font-normal">{c.n}종</span></td>
              <td className="px-2 py-1.5 text-right tabular-nums">{c.sG > 0 ? pct(c.sE / c.sG) : '—'} → {c.sH > 0 ? pct(c.sF / c.sH) : '—'}</td>
              <td className="px-2 py-1.5"><Diverge v={c.yld} max={mx} /></td>
              <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${tone(c.yld)}`}>{won(c.yld)}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${tone(c.mix)}`}>{won(c.mix)}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${tone(c.other)}`}>{won(c.other)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{Math.round(c.costB).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-[10px] text-gray-500 px-2 py-1">수율은 두 달 모두 '정상'인 원재료만으로 낸 가중 수율(Σ표준 ÷ Σ실투입)입니다. 분류는 설정 › 원재료 분류 기준.</div>
    </div>
  );
}
