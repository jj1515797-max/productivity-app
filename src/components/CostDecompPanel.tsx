/** 원재료분석 › 맨 위 분석 — 숫자 한 표(원재료비율 · 개당 원재료비 · 같은 생산량 기준 금액) + 짧은 분석 줄 + 원재료별/제품별/분류별 근거.
 *  금액 증감은 물량(많이 만들면 많이 씀)을 빼고 본다: 같은 생산량 기준 차이 = 수율 + 제품 구성 + 단가 + 기타.
 *  계산은 src/lib/costDecomp.ts (수식 엑셀 「원가율분해」 시트와 같은 규칙). */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { DecompMatRow, DecompProdRow, DecompResult } from '../lib/costDecomp';
import { DECOMP_SWING, ratioDecomp, statusLabel } from '../lib/costDecomp';
import { saveProductionAmount, useProductionAmounts } from '../lib/monthlyAmount';

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


/** 분석 줄 */
interface Pt { k: string; t: string; tone: 'good' | 'bad' | 'plain' }
const sgnN = (n: number, d = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const g1 = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)}%`;

/** 결론·근거 줄 — 금액은 물량(많이 만들면 많이 씀)을 뺀 같은 생산량 기준, 원가율은 생산금액 대비 */
function buildPoints(view: DecompView, ratio: ReturnType<typeof ratioDecomp>, amtA: number, amtB: number, mA: string, mB: string) {
  const { rows, products, totals: t } = view.result;
  const z = (v: number) => Math.abs(v) < 0.5;
  const tn = (v: number, eps = 0.5): Pt['tone'] => (Math.abs(v) < eps ? 'plain' : v < 0 ? 'good' : 'bad');
  const net = t.price + t.mix + t.yld + t.other;   // 같은 생산량 기준 원재료비 차이 (= 실제 증감 − 물량)
  const pts: Pt[] = [];

  // 결론 — 무엇이 원가율을 움직였나 (주원인 · 보탬 · 상쇄)
  const named = (k: string, v: number) => (
    k === 'yld' ? (v <= 0 ? '수율 개선' : '수율 악화')
      : k === 'mix' ? '제품 구성'
        : k === 'price' ? (v <= 0 ? '단가 인하' : '단가 인상')
          : k === 'other' ? '기타'
            : (v >= 0 ? '개당 생산금액 하락' : '개당 생산금액 상승'));
  const src = ratio
    ? (['yld', 'mix', 'price', 'other', 'rev'] as const).map((k) => ({ k, v: ratio[k] * 100, s: pp(ratio[k]) }))
    : (['yld', 'mix', 'price', 'other'] as const).map((k) => ({ k, v: t[k] / 1e4, s: `${man(t[k])}` }));
  const eps = ratio ? 0.005 : 1;
  const parts = src.filter((p) => Math.abs(p.v) >= eps).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const d = ratio ? ratio.dr * 100 : net / 1e4;
  const head = ratio
    ? `원재료비율 ${pct(ratio.rA, 2)} → ${pct(ratio.rB, 2)} (${pp(ratio.dr)}${Math.abs(d) < eps ? ' 보합' : d < 0 ? ' 하락' : ' 상승'})`
    : `같은 생산량 기준 원재료비 ${man(net)} (개당 ${sgnN(net / t.QB)}원)`;
  let concl = head;
  if (parts.length) {
    const dir = Math.sign(d);
    const main = parts.find((p) => Math.sign(p.v) === dir) || parts[0];
    const same = parts.filter((p) => p !== main && Math.sign(p.v) === Math.sign(main.v));
    const opp = parts.filter((p) => p !== main && Math.sign(p.v) !== Math.sign(main.v));
    concl += ` · 주원인 ${named(main.k, main.v)} ${main.s}`
      + (same.length ? ` · 보탬 ${same.map((p) => `${named(p.k, p.v)} ${p.s}`).join(', ')}` : '')
      + (opp.length ? ` · 상쇄 ${opp.map((p) => `${named(p.k, p.v)} ${p.s}`).join(', ')}` : '');
  }
  pts.push({ k: '결론', t: concl, tone: tn(d, eps) });

  // 수율
  const okRows = rows.filter((r) => r.status === 'ok').sort((a, b) => a.yld - b.yld);
  const best = okRows.filter((r) => r.yld < -0.5).slice(0, 3);
  const worst = okRows.filter((r) => r.yld > 0.5).slice(-3).reverse();
  pts.push({
    k: '수율',
    t: z(t.yld) && !best.length && !worst.length ? '변화 없음'
      : `${man(t.yld)} (좋아짐 ${man(t.gain.yld)} · 나빠짐 ${man(t.loss.yld)})`
        + (best.length ? ` · 아낌: ${best.map((r) => `${r.name} ${man(r.yld)}`).join(', ')}` : '')
        + (worst.length ? ` · 더 씀: ${worst.map((r) => `${r.name} ${man(r.yld)}`).join(', ')}` : ''),
    tone: tn(t.yld, 1e5),
  });

  // 제품 구성 — 레시피 없는 제품은 개당 원재료비를 몰라(0) 싼 제품처럼 보이므로 이름에서 뺀다
  const ps = products.filter((p) => p.hasRecipe && p.ings.length > 0).sort((a, b) => a.effect - b.effect);
  const pDown = ps.filter((p) => p.effect < -0.5).slice(0, 2);
  const pUp = ps.filter((p) => p.effect > 0.5).slice(-2).reverse();
  const pName = (p: DecompProdRow) => `${p.name.replace(/^순수본_/, '')} ${p.delta > 0 ? '↑' : '↓'} ${man(p.effect)}`;
  pts.push({
    k: '제품 구성',
    t: z(t.mix) ? '변화 없음'
      : `${man(t.mix)} — 원재료가 ${t.mix > 0 ? '더' : '덜'} 드는 제품 쪽으로 생산 비중 이동 (↑↓ = 비중)`
        + (pUp.length ? ` · 올린 제품: ${pUp.map(pName).join(', ')}` : '')
        + (pDown.length ? ` · 내린 제품: ${pDown.map(pName).join(', ')}` : ''),
    tone: tn(t.mix, 1e5),
  });

  // 단가
  const prUp = rows.filter((r) => r.price > 0.5).sort((a, b) => b.price - a.price).slice(0, 2);
  const prDn = rows.filter((r) => r.price < -0.5).sort((a, b) => a.price - b.price).slice(0, 2);
  pts.push({
    k: '단가',
    t: t.aSubShare >= 0.999 ? `${mA} 단가가 없어 ${mB} 단가로 계산 (단가 효과 0)`
      : z(t.price) ? '변화 없음'
        : `${man(t.price)} (오름 ${man(t.loss.price)} · 내림 ${man(t.gain.price)})`
          + (prUp.length ? ` · 오른 것: ${prUp.map((r) => `${r.name} ${man(r.price)}`).join(', ')}` : '')
          + (prDn.length ? ` · 내린 것: ${prDn.map((r) => `${r.name} ${man(r.price)}`).join(', ')}` : ''),
    tone: tn(t.price, 1e5),
  });

  // 기타 — 클 때만
  if (Math.abs(t.other) >= 1e5) {
    const big = rows.filter((r) => Math.abs(r.other) >= 0.5).sort((a, b) => Math.abs(b.other) - Math.abs(a.other)).slice(0, 3);
    pts.push({ k: '기타', t: `${man(t.other)} — 수율을 비교 못 한 원재료(실투입 없음·범위 밖)${big.length ? ` · 큰 것: ${big.map((r) => `${r.name} ${man(r.other)}`).join(', ')}` : ''} → 아래 원재료별 「비교 불가」`, tone: tn(t.other, 1e5) });
  }

  // 매출 쪽
  if (ratio) {
    const perA = amtA / t.QA, perB = amtB / t.QB;
    pts.push({ k: '매출 쪽', t: `생산금액 ${g1(amtB / amtA - 1)}, 생산량 ${g1(t.k - 1)} → 개당 생산금액 ${Math.round(perA).toLocaleString()} → ${Math.round(perB).toLocaleString()}원 (${g1(perB / perA - 1)}) → ${pp(ratio.rev)} · 판가·매출 구성 몫, 원재료와 무관`, tone: tn(ratio.rev * 100, 0.005) });
  }

  // 확인할 것 — 짧게
  const swingNames = rows.filter((r) => r.swing).sort((a, b) => Math.abs(b.yld) - Math.abs(a.yld)).slice(0, 3).map((r) => r.name);
  const warns = [
    t.swingCount > 0 && !z(t.swingYld) ? `수율이 ${DECOMP_SWING * 100}%p 넘게 바뀐 원재료 ${t.swingCount}종(${swingNames.join('·')} 등) ${man(t.swingYld)}이 수율에 들어 있음 — 배합(개당 g) 변경·실투입 입력 오류도 수율로 잡힘` : '',
    t.aSubShare >= 0.1 && t.aSubShare < 0.999 ? `${mA} 원재료비의 ${Math.round(t.aSubShare * 100)}%는 그달 단가가 없어 다른 달 단가로 계산 — 단가 효과가 작게 보일 수 있음` : '',
    view.coverage.missingA + view.coverage.missingB > 0 ? `레시피 없는 제품 ${mA} ${Math.round(view.coverage.missingA).toLocaleString()} EA · ${mB} ${Math.round(view.coverage.missingB).toLocaleString()} EA — 수율·구성이 왜곡될 수 있음` : '',
    ratio && (ratio.rA > 2 || ratio.rB > 2 || ratio.rA < 0.01 || ratio.rB < 0.01) ? '원재료비율이 1~200% 밖 — 생산금액 단위(원) 확인' : '',
  ].filter(Boolean);
  return { pts, warns, net };
}

function Points({ points }: { points: Pt[] }) {
  const dot = { good: 'bg-emerald-500', bad: 'bg-rose-500', plain: 'bg-gray-300' };
  return (
    <ul className="space-y-2 text-[15px] leading-snug text-gray-800">
      {points.map((p) => (
        <li key={p.k} className="flex gap-3">
          <span className="w-20 shrink-0 font-bold text-gray-500 flex items-center gap-1.5 whitespace-nowrap self-start pt-0.5"><span className={`w-2 h-2 rounded-full ${dot[p.tone]}`} />{p.k}</span>
          <span className={p.k === '결론' ? 'font-bold' : ''}>{p.t}</span>
        </li>
      ))}
    </ul>
  );
}

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
  // 생산금액은 서버(monthlyMeta)에 저장 — 다른 PC·휴대폰에서도 같은 값. 용기분석 원가율과 같은 값을 쓴다
  const amounts = useProductionAmounts([monthA, monthB]);
  const amtA = amounts[monthA] || 0;
  const amtB = amounts[monthB] || 0;
  const [amtErr, setAmtErr] = useState('');
  const saveAmt = (m: string, v: number) => {
    setAmtErr('');
    saveProductionAmount(m, v).catch((e) => setAmtErr(`생산금액 저장 실패: ${e?.message || e}`));
  };
  const ratio = ratioDecomp(t, amtA, amtB);
  // 해가 다르면(전년 비교) 연도까지
  const lab = (m: string) => (monthA.slice(0, 4) !== monthB.slice(0, 4) ? `${m.slice(2, 4)}년 ${Number(m.slice(5))}월` : `${Number(m.slice(5))}월`);
  const mA = lab(monthA), mB = lab(monthB);
  const ok = view.hasActualA && view.hasActualB && t.QA > 0;
  const an = useMemo(() => (ok ? buildPoints(view, ratio, amtA, amtB, mA, mB) : null), [ok, view, ratio, amtA, amtB, mA, mB]);
  const [tab, setTab] = useState<'mat' | 'prod' | 'cat'>('mat');

  // 실투입이 없는 달이 있으면 원재료비가 0 으로 계산돼 '100% 감소' 같은 엉뚱한 결론이 나온다 — 안내만 보여준다
  if (!ok || !an) {
    const miss = [!view.hasActualA ? monthA : '', !view.hasActualB ? monthB : ''].filter(Boolean).join(', ');
    const msg = miss
      ? `${miss} 실투입(설정 › 실제 투입중량)이 없어 원재료비를 계산할 수 없습니다. 실투입을 넣은 뒤 다시 분석하세요.`
      : `${monthA} 생산량이 없어 분해할 수 없습니다 (앱 도입 전 달이면 설정 › 월별 생산수량을 넣으세요).`;
    return (
      <div className="bg-white border-2 border-amber-300 rounded-lg p-4">
        <div className="font-bold text-gray-800">💰 원재료 분석 <span className="text-sm font-normal text-gray-500">{monthA} → {monthB}</span></div>
        <div className="mt-2 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          ⚠ {msg}
        </div>
      </div>
    );
  }

  const perA = t.MA / t.QA, perB = t.MB / t.QB;
  const comps = [t.yld, t.mix, t.price, t.other];
  const cell = 'px-3 py-2.5 text-right';
  return (
    <div className="bg-white border-2 border-slate-300 rounded-lg overflow-hidden">
      {/* 머리 */}
      <div className="px-4 py-3 bg-slate-800 text-white flex items-center gap-3 flex-wrap">
        <span className="font-bold">💰 원재료 분석</span>
        <span className="text-sm text-slate-300">{mA} → {mB}</span>
        <div className="flex items-center text-xs rounded overflow-hidden border border-slate-500">
          <span className="px-2 py-1 bg-slate-700 text-slate-300">레시피</span>
          {([['yield', '분석용'], ['bom', '현장 BOM']] as const).map(([v, label]) => (
            <button key={v} onClick={() => onRecipeSrc(v)} disabled={v === 'yield' && !yieldDbReady}
              className={`px-2.5 py-1 font-semibold ${recipeSrc === v ? 'bg-white text-slate-800' : 'text-slate-200 hover:bg-slate-700'} disabled:opacity-40`}>{label}</button>
          ))}
        </div>
        <span className="text-[11px] text-slate-400 ml-auto">원재료비 = ERP 실투입 × 재고평가 단가</span>
      </div>

      {/* 숫자 한 표 — 금액은 물량(많이 만들면 많이 씀)을 뺀 같은 생산량 기준 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums min-w-[760px]">
          <thead className="text-xs text-gray-500">
            <tr className="border-b">
              <th className="px-4 py-2 text-left font-semibold" />
              <th className="px-3 py-2 text-right font-semibold">{mA}</th>
              <th className="px-3 py-2 text-right font-semibold">{mB}</th>
              <th className="px-3 py-2 text-right font-bold text-gray-800 bg-slate-50">증감</th>
              <th className="px-3 py-2 text-right font-semibold border-l">수율</th>
              <th className="px-3 py-2 text-right font-semibold">제품 구성</th>
              <th className="px-3 py-2 text-right font-semibold">단가</th>
              <th className="px-3 py-2 text-right font-semibold">기타</th>
              <th className="px-3 py-2 text-right font-semibold border-l">개당 생산금액</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="px-4 py-2.5 font-bold text-gray-700 whitespace-nowrap">원재료비율</td>
              {ratio ? (
                <>
                  <td className={cell}>{pct(ratio.rA, 2)}</td>
                  <td className={cell}>{pct(ratio.rB, 2)}</td>
                  <td className={`${cell} font-extrabold text-base bg-slate-50 ${toneP(ratio.dr)}`}>{pp(ratio.dr)}</td>
                  {[ratio.yld, ratio.mix, ratio.price, ratio.other].map((v, i) => (
                    <td key={i} className={`${cell} font-bold ${i === 0 ? 'border-l' : ''} ${toneP(v)}`}>{pp(v)}</td>
                  ))}
                  <td className={`${cell} font-bold border-l ${toneP(ratio.rev)}`}>{pp(ratio.rev)}</td>
                </>
              ) : <td colSpan={8} className="px-3 py-2.5 text-xs text-gray-500">아래에 두 달 생산금액을 넣으면 나옵니다</td>}
            </tr>
            <tr className="border-b">
              <td className="px-4 py-2.5 font-bold text-gray-700 whitespace-nowrap">개당 원재료비</td>
              <td className={cell}>{perA.toFixed(1)}원</td>
              <td className={cell}>{perB.toFixed(1)}원</td>
              <td className={`${cell} font-extrabold text-base bg-slate-50 ${tone((perB - perA) * 1e3)}`}>{sgnN(perB - perA)}원</td>
              {comps.map((v, i) => (
                <td key={i} className={`${cell} font-bold ${i === 0 ? 'border-l' : ''} ${tone((v / t.QB) * 1e3)}`}>{sgnN(v / t.QB)}원</td>
              ))}
              <td className={`${cell} text-gray-300 border-l`}>—</td>
            </tr>
            <tr className="border-b">
              <td className="px-4 py-2.5 font-bold text-gray-700 whitespace-nowrap">금액 <span className="text-[11px] font-normal text-gray-500">같은 생산량</span></td>
              <td className={`${cell} text-gray-500 text-xs`} title={`${monthA} 실제 원재료비`}>{man(t.MA, false)}</td>
              <td className={`${cell} text-gray-500 text-xs`} title={`${monthB} 실제 원재료비`}>{man(t.MB, false)}</td>
              <td className={`${cell} font-extrabold text-base bg-slate-50 ${tone(an.net)}`} title={`실제 증감 ${man(t.MB - t.MA)} 중 생산량이 바뀐 몫 ${man(t.vol)}을 뺀 값`}>{man(an.net)}</td>
              {comps.map((v, i) => (
                <td key={i} className={`${cell} font-bold ${i === 0 ? 'border-l' : ''} ${tone(v)}`}>{man(v)}</td>
              ))}
              <td className={`${cell} text-gray-300 border-l`}>—</td>
            </tr>
            <tr className="text-gray-500 bg-slate-50/60">
              <td className="px-4 py-2 text-xs font-semibold whitespace-nowrap">생산금액</td>
              <td className="px-3 py-1.5 text-right"><span className="inline-block"><AmtInput label="" value={amtA} onChange={(v) => saveAmt(monthA, v)} /></span></td>
              <td className="px-3 py-1.5 text-right"><span className="inline-block"><AmtInput label="" value={amtB} onChange={(v) => saveAmt(monthB, v)} /></span></td>
              <td className="px-3 py-2 text-right text-xs font-bold bg-slate-50">{amtA > 0 && amtB > 0 ? g1(amtB / amtA - 1) : ''}</td>
              <td colSpan={4} className="px-3 py-2 text-[11px] border-l">{amtErr ? <span className="text-rose-600">{amtErr}</span> : `생산 ${Math.round(t.QA).toLocaleString()} → ${Math.round(t.QB).toLocaleString()} EA (${g1(t.k - 1)})`}</td>
              <td className="px-3 py-2 text-right text-xs border-l">{ratio ? `${Math.round(amtA / t.QA).toLocaleString()} → ${Math.round(amtB / t.QB).toLocaleString()}원` : ''}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 분석 */}
      <div className="px-4 py-3 border-t">
        <Points points={an.pts} />
      </div>
      {an.warns.length > 0 && (
        <div className="px-4 py-2.5 border-t bg-amber-50 text-sm text-amber-900 space-y-1">
          {an.warns.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}

      {/* 근거 */}
      <div className="px-4 pt-3 flex gap-1 border-t border-b bg-slate-50/50">
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

      {/* 레시피 기준 비교 — 접어 둠 */}
      {alt && (
        <details className="border-t">
          <summary className="px-4 py-2.5 text-sm font-bold text-gray-700 cursor-pointer select-none bg-slate-50">레시피 기준 비교 <span className="font-normal text-xs text-gray-500">· 합계·단가는 같고 수율·구성·기타 나눔만 달라짐 (분석용이 실제 배합에 가까움)</span></summary>
          <div className="overflow-x-auto px-4 py-3">
            <table className="text-xs min-w-[520px] w-full">
              <thead className="text-gray-500">
                <tr><th className="text-left px-2 py-1">레시피</th><th className="text-right px-2 py-1">수율</th><th className="text-right px-2 py-1">제품 구성</th><th className="text-right px-2 py-1">기타</th><th className="text-right px-2 py-1">수율 비교 원재료</th><th className="text-right px-2 py-1">레시피 있는 생산 비율</th></tr>
              </thead>
              <tbody>
                {[view, alt].map((v, i) => {
                  const tt = v.result.totals;
                  return (
                    <tr key={i} className={`border-t ${i === 0 ? 'font-bold bg-indigo-50/50' : ''}`}>
                      <td className="px-2 py-1">{v.recipeLabel}{i === 0 ? ' (지금)' : ''}</td>
                      <td className={`text-right px-2 py-1 tabular-nums ${tone(tt.yld)}`}>{man(tt.yld)}</td>
                      <td className={`text-right px-2 py-1 tabular-nums ${tone(tt.mix)}`}>{man(tt.mix)}</td>
                      <td className={`text-right px-2 py-1 tabular-nums ${tone(tt.other)}`}>{man(tt.other)}</td>
                      <td className="text-right px-2 py-1">{v.result.rows.filter((r) => r.status === 'ok').length}종</td>
                      <td className="text-right px-2 py-1">{v.coverage.a.toFixed(1)}% · {v.coverage.b.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
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
export function AmtInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
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
              {th('yld', '수율효과')}
              {th('mix', '제품구성')}
              {th('other', '기타')}
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
                        {Math.abs(r.price) >= 1 && <span>단가효과 {won(r.price)}</span>}
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
      <div className="text-[10px] text-gray-500">줄을 누르면 표준소요·실투입·단가가 보입니다. 수율효과 = ({monthB} 실투입 − {monthB} 표준 ÷ {monthA} 수율) × {monthB} 단가. − 는 덜 써서 아낀 금액입니다.</div>
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
              <th className="px-2 py-1.5 text-right">구성효과</th>
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
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <div className="overflow-x-auto border rounded">
      <table className="w-full text-xs min-w-[720px]">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="px-2 py-1.5 text-left">분류</th>
            <th className="px-2 py-1.5 text-right">{monthA} → {monthB} 수율</th>
            <th className="px-2 py-1.5 w-40">수율효과</th>
            <th className="px-2 py-1.5 text-right" />
            <th className="px-2 py-1.5 text-right">제품구성</th>
            <th className="px-2 py-1.5 text-right">기타</th>
            <th className="px-2 py-1.5 text-right">{monthB} 원재료비</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {list.map(([name, c]) => (
            <Fragment key={name}>
            <tr onClick={() => toggle(name)} className={`cursor-pointer hover:bg-indigo-50/40 ${open.has(name) ? 'bg-indigo-50/60' : ''}`}>
              <td className="px-2 py-1.5 font-semibold"><span className="text-gray-400 w-3 inline-block">{open.has(name) ? '▾' : '▸'}</span> {name} <span className="text-[10px] text-gray-400 font-normal">{c.n}종</span></td>
              <td className="px-2 py-1.5 text-right tabular-nums">{c.sG > 0 ? pct(c.sE / c.sG) : '—'} → {c.sH > 0 ? pct(c.sF / c.sH) : '—'}</td>
              <td className="px-2 py-1.5"><Diverge v={c.yld} max={mx} /></td>
              <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${tone(c.yld)}`}>{won(c.yld)}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${tone(c.mix)}`}>{won(c.mix)}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${tone(c.other)}`}>{won(c.other)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{Math.round(c.costB).toLocaleString()}</td>
            </tr>
            {open.has(name) && rows
              .filter((r) => r.status !== 'noUse' && (r.category || '미분류') === name)
              .sort((a, b) => a.yld - b.yld || Math.abs(b.mix) - Math.abs(a.mix))
              .map((r) => (
                <tr key={r.key} className="bg-slate-50/80 text-[11px]">
                  <td className="pl-7 pr-2 py-1">
                    <span className="text-gray-800">{r.name}</span>{r.swing && <span className="ml-1 text-amber-700" title="수율이 크게 바뀜 — 레시피 변경·입력 확인">⚠</span>}
                    {r.status !== 'ok' && <span className="ml-1 text-[10px] text-gray-400">{statusLabel(r.status, monthA, monthB)}</span>}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-700">{pct(r.yA)} → {pct(r.yB)}{r.dY !== null && <span className={`ml-1 ${r.dY > 0 ? 'text-emerald-700' : r.dY < 0 ? 'text-rose-700' : 'text-gray-400'}`}>({pp(r.dY, 1)})</span>}</td>
                  <td className="px-2 py-1"><Diverge v={r.yld} max={mx} /></td>
                  <td className={`px-2 py-1 text-right tabular-nums ${tone(r.yld)}`}>{Math.abs(r.yld) >= 1 ? won(r.yld) : '—'}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${tone(r.mix)}`}>{Math.abs(r.mix) >= 1 ? won(r.mix) : '—'}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${tone(r.other)}`}>{Math.abs(r.other) >= 1 ? won(r.other) : '—'}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-600">{Math.round(r.costB).toLocaleString()}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="text-[10px] text-gray-500 px-2 py-1">분류 줄을 누르면 그 분류의 원재료가 펼쳐집니다. 수율은 두 달 모두 '정상'인 원재료만으로 낸 가중 수율(Σ표준 ÷ Σ실투입)입니다. 분류는 설정 › 원재료 분류 기준.</div>
    </div>
  );
}
