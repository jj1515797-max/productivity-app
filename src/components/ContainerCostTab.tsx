/** 용기분석 › 용기분석(원가) — 전월 대비 용기비 변동을 물량 · 구성(Mix) · 단가로 나누고 보고서 문구까지
 *  수량 기준 (전환):
 *   · 생산량 기준(기본) — 월별 사용량 탭과 같은 값. 작은·큰용기 = 제품 DB 용기 구분별 냉장 생산량, 레토르트 = 실온 생산량.
 *     재고 정합성 탭이 계산해 서버(containerStock/_theory)에 올려 둔 값을 같이 쓰고, 없으면 여기서 계산해 올린다.
 *   · 재고조사 기준 — 재고 정합성 탭의 실제 투입량 (직접입력, 없으면 기초+입고−기말). 생산량 기준과의 차이 = 로스·시점 차이
 *  단가·생산금액은 여기서 넣으면 서버에 저장(모든 기기 공통). */
import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { isPastMonth, loadContainerMonth } from '../lib/containerLoad';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { effectiveInput } from '../lib/containerStock';
import type { StockEntry } from '../lib/containerStock';
import { CONTAINER_COST_COL, CONTAINER_ITEMS, analyzeContainerCost, analyzeContainerFull, containerComments, containerFullComments, containerNarrative, moneyText } from '../lib/containerCost';
import type { CCFull, CCMonth, ContainerId } from '../lib/containerCost';
import { saveProductionAmount, useProductionAmounts } from '../lib/monthlyAmount';
import { AmtInput } from './CostDecompPanel';

function shiftMonth(m: string, delta: number): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const nf = (n: number) => Math.round(n).toLocaleString();
const wonf = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : (Math.round(n * 10) / 10).toLocaleString());
const sgn = (n: number, d = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const sgnInt = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(Math.round(n)).toLocaleString()}`;

/** 단가 입력 (소수 가능) — 칸을 벗어나면 저장 */
function PriceInput({ value, onSave }: { value: number | null | undefined; onSave: (v: number | null) => void }) {
  // ERP 평균단가는 소수가 길다 — 소수 둘째 자리까지만 보여 주고, 손대지 않으면 저장값(원래 값)은 그대로 둔다
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const show = (v: number | null | undefined) => (typeof v === 'number' ? String(r2(v)) : '');
  const [t, setT] = useState(show(value));
  useEffect(() => { setT(show(value)); }, [value]);
  return (
    <input value={t} inputMode="decimal" placeholder="단가"
      onChange={(e) => setT(e.target.value)}
      onBlur={() => {
        const s = t.replace(/[,\s원]/g, '');
        if (s === '') { if (value != null) onSave(null); return; }
        const n = Number(s);
        if (!Number.isFinite(n) || n < 0) { setT(show(value)); return; }
        if (typeof value === 'number' && Math.abs(n - r2(value)) < 1e-9) return;   // 보이는 값 그대로면 저장 안 함
        onSave(n);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className="w-24 border rounded px-2 py-1 text-right tabular-nums bg-yellow-50" />
  );
}

type TheoryCell = { small: number; large: number; ambient: number; unknown: number; ts: number };
/** 재고 정합성 탭과 같은 규칙 — 지난달은 그 달이 끝난 뒤 계산된 값만, 이번 달은 5분 이내 값만 */
const usableTheory = (m: string, c: TheoryCell | undefined) => {
  if (!c || typeof c.small !== 'number') return false;
  if (!isPastMonth(m)) return Date.now() - c.ts < 5 * 60 * 1000;
  const [y, mm] = m.split('-').map(Number);
  return c.ts >= new Date(y, mm, 1).getTime();
};
type Basis = 'prod' | 'stock';

function useDoc<T>(col: string, id: string): T | undefined {
  const [v, setV] = useState<T | undefined>(undefined);
  useEffect(() => {
    setV(undefined);
    return onSnapshot(doc(db, col, id), (s) => setV((s.data() as T) || ({} as T)), () => setV({} as T));
  }, [col, id]);
  return v;
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard?.writeText(text).then(() => { setOk(true); window.setTimeout(() => setOk(false), 1500); }).catch(() => {}); }}
      className={`px-2.5 py-1 text-xs rounded border font-bold ${ok ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white hover:bg-gray-50'}`}>
      {ok ? '복사됨 ✓' : '📋 복사'}
    </button>
  );
}

export default function ContainerCostTab() {
  const [monthB, setMonthB] = useState(() => shiftMonth(todayKey().slice(0, 7), -1));
  const [monthA, setMonthA] = useState(() => shiftMonth(todayKey().slice(0, 7), -2));
  const setB = (m: string) => { setMonthB(m); setMonthA(shiftMonth(m, -1)); };

  const stockA = useDoc<Record<string, StockEntry>>('containerStock', monthA);
  const stockB = useDoc<Record<string, StockEntry>>('containerStock', monthB);
  const costA = useDoc<{ prices?: Partial<Record<ContainerId, number>> }>(CONTAINER_COST_COL, monthA);
  const costB = useDoc<{ prices?: Partial<Record<ContainerId, number>> }>(CONTAINER_COST_COL, monthB);
  const amounts = useProductionAmounts([monthA, monthB]);
  const theoryDoc = useDoc<Record<string, TheoryCell>>('containerStock', '_theory');
  // 처음엔 재고조사 기준(투입량 = 제조원가와 같은 기준). 생산량 기준을 고르면 그 기기에서 기억
  const [basis, setBasisState] = useState<Basis>(() => { try { return localStorage.getItem('containerCost:basisV2') === 'prod' ? 'prod' : 'stock'; } catch { return 'stock'; } });
  const setBasis = (b: Basis) => { setBasisState(b); try { localStorage.setItem('containerCost:basisV2', b); } catch { /* noop */ } };

  // 생산량 기준 값이 없거나 오래된 달은 계산해서 서버에 올린다 (재고 정합성 탭과 같은 저장 자리 — 서로 다시 계산하지 않게)
  const [calc, setCalc] = useState('');
  const [calcTheory, setCalcTheory] = useState<Record<string, TheoryCell>>({});
  const theoryOf = (m: string): TheoryCell | undefined => (usableTheory(m, theoryDoc?.[m]) ? theoryDoc![m] : calcTheory[m]);
  useEffect(() => {
    if (theoryDoc === undefined) return;
    const need = [monthA, monthB].filter((m) => !usableTheory(m, theoryDoc[m]) && !calcTheory[m]);
    if (need.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const m of need) {
        if (cancelled) return;
        setCalc(`${m} 생산량 계산 중…`);
        try {
          const r = await loadContainerMonth(m);
          const t: TheoryCell = { small: r.small, large: r.large, ambient: r.ambient, unknown: r.unknown, ts: Date.now() };
          setCalcTheory((p) => ({ ...p, [m]: t }));
          setDoc(doc(db, 'containerStock', '_theory'), {
            [m]: { small: r.small, large: r.large, ambient: r.ambient, unknown: r.unknown, m1: r.m1, m2: r.m2, m3: r.m3, mUnassigned: r.mUnassigned, ts: t.ts },
          }, { merge: true }).catch(() => {});
        } catch (e) {
          setErr(`${m} 생산량 계산 실패: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!cancelled) setCalc('');
    })();
    return () => { cancelled = true; };
  }, [theoryDoc, monthA, monthB]); // eslint-disable-line react-hooks/exhaustive-deps

  const loading = stockA === undefined || stockB === undefined || costA === undefined || costB === undefined || theoryDoc === undefined;

  const [err, setErr] = useState('');
  const savePrice = (m: string, id: ContainerId, v: number | null) => {
    setErr('');
    setDoc(doc(db, CONTAINER_COST_COL, m), { prices: { [id]: v }, updatedAt: new Date().toISOString() }, { merge: true })
      .catch((e) => setErr(`단가 저장 실패: ${e?.message || e}`));
  };
  const saveAmt = (m: string, v: number) => {
    setErr('');
    saveProductionAmount(m, v).catch((e) => setErr(`생산금액 저장 실패: ${e?.message || e}`));
  };

  const prodQty = (m: string): Record<ContainerId, number | null> => {
    const t = theoryOf(m);
    return { c185: t ? t.small : null, c210: t ? t.large : null, retort: t ? t.ambient : null };
  };
  const stockQty = (stock: Record<string, StockEntry> | undefined): Record<ContainerId, number | null> =>
    Object.fromEntries(CONTAINER_ITEMS.map((it) => [it.id, effectiveInput(stock?.[it.id])])) as Record<ContainerId, number | null>;
  const qtyView = {
    prod: { A: prodQty(monthA), B: prodQty(monthB) },
    stock: { A: stockQty(stockA), B: stockQty(stockB) },
  };
  const monthData = (stock: Record<string, StockEntry> | undefined, cost: { prices?: Partial<Record<ContainerId, number>> } | undefined, m: string): CCMonth => ({
    qty: basis === 'prod' ? prodQty(m) : stockQty(stock),
    price: Object.fromEntries(CONTAINER_ITEMS.map((it) => [it.id, typeof cost?.prices?.[it.id] === 'number' ? cost!.prices![it.id]! : null])),
    amount: amounts[m] || 0,
  });
  const A = monthData(stockA, costA, monthA);
  const B = monthData(stockB, costB, monthB);
  const r = useMemo(() => (loading || calc ? null : analyzeContainerCost(A, B, monthA, monthB)),
    [loading, calc, JSON.stringify(A), JSON.stringify(B), monthA, monthB]); // eslint-disable-line react-hooks/exhaustive-deps
  const unknownQty = basis === 'prod' ? (theoryOf(monthA)?.unknown || 0) + (theoryOf(monthB)?.unknown || 0) : 0;
  const ready = r && r.missing.length === 0;
  // 최종 분석: 사용 구성은 생산량(실제 사용) 기준, 로스 = 재고조사 투입 − 생산량, 원가율은 재고조사 기준
  const full = useMemo(() => (loading || calc ? null
    : analyzeContainerFull(qtyView.prod, qtyView.stock, { A: A.price, B: B.price }, { A: A.amount, B: B.amount }, monthA, monthB)),
  [loading, calc, JSON.stringify(qtyView), JSON.stringify(A.price), JSON.stringify(B.price), A.amount, B.amount, monthA, monthB]); // eslint-disable-line react-hooks/exhaustive-deps
  const F = full && 'hasStock' in full ? (full as CCFull) : null;
  const stockMode = basis === 'stock' && !!F?.hasStock;
  const story = F ? containerNarrative(F, basis, monthA, monthB, { A: A.amount, B: B.amount }) : null;
  const c = ready ? (stockMode && F ? containerFullComments(F, monthA, monthB) : containerComments(r!)) : null;
  // 원가율 나누기 (생산량 기준일 땐 로스 없이)
  const ratioView = (() => {
    if (!F || !(A.amount > 0 && B.amount > 0)) return null;
    if (stockMode && F.ratio) return F.ratio;
    const b0 = F.base;
    const rpA = b0.CA / A.amount, rpB = b0.CB / B.amount;
    return { rA: rpA * 100, rB: rpB * 100, d: (rpB - rpA) * 100, rev: rpA * ((A.amount / b0.QA) / (B.amount / b0.QB) - 1) * 100,
      mix: (b0.mix / B.amount) * 100, price: (b0.price / B.amount) * 100, loss: 0, money: (rpB - rpA) * B.amount, stockBased: false };
  })();

  return (
    <div className="space-y-4">
      {/* 달 고르기 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-bold text-gray-700">전월(기준)</span>
        <input type="month" value={monthA} onChange={(e) => e.target.value && setMonthA(e.target.value)} className="border rounded px-2 py-1 text-sm font-bold" />
        <span className="text-gray-400">→</span>
        <span className="text-sm font-bold text-gray-700">당월(비교)</span>
        <button onClick={() => setB(shiftMonth(monthB, -1))} className="w-8 h-8 rounded hover:bg-gray-100">◀</button>
        <input type="month" value={monthB} onChange={(e) => e.target.value && setB(e.target.value)} className="border rounded px-2 py-1 text-sm font-bold" />
        <button onClick={() => setB(shiftMonth(monthB, 1))} className="w-8 h-8 rounded hover:bg-gray-100">▶</button>
        {(loading || calc) && <span className="text-xs text-blue-600">{calc || '불러오는 중…'}</span>}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">수량 기준</span>
          <div className="flex rounded-md border overflow-hidden text-xs">
            {([['stock', '재고조사 기준 (투입량)'], ['prod', '생산량 기준 (월별 사용량)']] as const).map(([k, t]) => (
              <button key={k} onClick={() => setBasis(k)}
                className={`px-3 py-1.5 font-bold ${basis === k ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{t}</button>
            ))}
          </div>
        </div>
      </div>

      {/* 입력 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">단가 · 생산금액 입력 <span className="text-xs font-normal text-gray-500">— 노란 칸에 넣고 칸을 벗어나면 저장됩니다</span></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-600 bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left">용기</th>
                <th className="px-3 py-2 text-right text-blue-700">{monthA} 단가(원)</th>
                <th className="px-3 py-2 text-right text-rose-700">{monthB} 단가(원)</th>
                <th className={`px-3 py-2 text-right ${basis === 'prod' ? 'text-gray-900 bg-amber-50' : 'text-gray-400'}`}>생산량 {monthA} → {monthB}</th>
                <th className={`px-3 py-2 text-right ${basis === 'stock' ? 'text-gray-900 bg-amber-50' : 'text-gray-400'}`}>재고조사 투입량 {monthA} → {monthB}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {CONTAINER_ITEMS.map((it) => (
                <tr key={it.id}>
                  <td className="px-3 py-2 font-semibold text-gray-800">{it.label}</td>
                  <td className="px-3 py-2 text-right"><PriceInput value={A.price[it.id]} onSave={(v) => savePrice(monthA, it.id, v)} /></td>
                  <td className="px-3 py-2 text-right"><PriceInput value={B.price[it.id]} onSave={(v) => savePrice(monthB, it.id, v)} /></td>
                  {(['prod', 'stock'] as const).map((k) => {
                    const a = qtyView[k].A[it.id], b = qtyView[k].B[it.id];
                    const cell = (v: number | null) => (v != null ? nf(v) : <span className="text-rose-500 text-xs">{k === 'prod' ? '계산 전' : '미입력'}</span>);
                    return (
                      <td key={k} className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${basis === k ? 'font-bold text-gray-900 bg-amber-50/60' : 'text-gray-400'}`}>
                        {cell(a)} → {cell(b)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="bg-slate-50/60">
                <td className="px-3 py-2 font-semibold text-gray-800">생산금액(원) <span className="text-[11px] font-normal text-gray-500">원재료분석과 같은 값</span></td>
                <td className="px-3 py-2 text-right"><AmtInput label="" value={A.amount} onChange={(v) => saveAmt(monthA, v)} /></td>
                <td className="px-3 py-2 text-right"><AmtInput label="" value={B.amount} onChange={(v) => saveAmt(monthB, v)} /></td>
                <td colSpan={2} className="px-3 py-2 text-xs text-gray-500">생산량 = 월별 사용량 탭과 같은 값 · 재고조사 = 「재고 정합성」 탭 투입량 (둘의 차이 = 로스·월말 시점 차이)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      {err && <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">{err}</div>}

      {!loading && r && r.missing.length > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800">
          ⚠ 아래 값이 없어 아직 계산할 수 없습니다: <b>{r.missing.join(', ')}</b>
          <div className="text-xs mt-1">단가는 위 표에서{basis === 'stock' ? ', 투입량은 「재고 정합성」 탭에서' : ''} 넣어 주세요.</div>
        </div>
      )}

      {unknownQty > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800">
          ⚠ 제품 DB 에 없어 용기 구분을 못 한 생산량 {nf(unknownQty)}개는 계산에서 빠졌습니다 — 설정 › 제품 DB 에 코드를 등록하면 반영됩니다.
        </div>
      )}

      {ready && r && c && (
        <>
          {/* 분석 결과 — 원재료분석 맨 위 설명처럼 */}
          {story && (
            <div className="bg-white border-2 border-indigo-200 rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-indigo-50 font-bold text-indigo-900 text-sm">
                📊 분석 결과 <span className="text-xs font-normal text-indigo-700">· {monthA} → {monthB} · {stockMode ? '재고조사 투입 기준 (제조원가와 같은 기준)' : '생산량 기준 (실제 사용)'}</span>
              </div>
              <div className="p-4 space-y-2 text-[15px] leading-relaxed text-gray-800">
                {story.lines.map((l, i) => <p key={i}>{l}</p>)}
                {story.warnings.length > 0 && (
                  <div className="mt-3 bg-rose-50 border border-rose-200 rounded-lg p-3 space-y-1.5 text-sm text-rose-800">
                    {story.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 1. 요약표 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">1. 용기 데이터 요약 <span className="text-xs font-normal text-gray-500">({stockMode ? '재고조사 투입 기준' : '생산량 기준 (실제 사용)'})</span></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-600 bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left">구분 (단가)</th>
                    <th className="px-3 py-2 text-right">{monthA} 수량 (비중)</th>
                    <th className="px-3 py-2 text-right">{monthB} 수량 (비중)</th>
                    <th className="px-3 py-2 text-right">수량 증감 (비중 변화)</th>
                    <th className="px-3 py-2 text-right">용기비 {monthA} → {monthB}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {r.rows.map((x) => (
                    <tr key={x.id}>
                      <td className="px-3 py-2">
                        <b>{x.label}</b> <span className="text-gray-500">({wonf(x.pB)}원{x.pA !== x.pB ? ` ← ${wonf(x.pA)}원` : ''})</span>
                        <span className={`ml-1.5 px-1.5 rounded text-[11px] font-bold ${x.tier === '고단가' ? 'bg-rose-100 text-rose-700' : 'bg-sky-100 text-sky-700'}`}>{x.tier}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{nf(x.qA)}개 ({(x.sA * 100).toFixed(1)}%)</td>
                      <td className="px-3 py-2 text-right tabular-nums">{nf(x.qB)}개 ({(x.sB * 100).toFixed(1)}%)</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${x.ds < 0 ? 'text-blue-700' : x.ds > 0 ? 'text-rose-600' : 'text-gray-500'}`}>{sgnInt(x.dq)}개 ({sgn(x.ds)}%p)</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700">{nf(x.costA)} → {nf(x.costB)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-100 font-bold">
                  <tr>
                    <td className="px-3 py-2">합계 / 평균단가</td>
                    <td className="px-3 py-2 text-right tabular-nums">{nf(r.QA)}개 (평균 {r.avgA.toFixed(1)}원)</td>
                    <td className="px-3 py-2 text-right tabular-nums">{nf(r.QB)}개 (평균 {r.avgB.toFixed(1)}원)</td>
                    <td className="px-3 py-2 text-right tabular-nums">개당 평균단가 {sgn(r.avgB - r.avgA)}원 ({sgn(((r.avgB - r.avgA) / r.avgA) * 100)}%)</td>
                    <td className="px-3 py-2 text-right tabular-nums">{nf(r.CA)} → {nf(r.CB)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="px-4 py-2.5 text-sm border-t bg-amber-50/50">
              <b>{stockMode ? '투입 기준 비중 변화 효과' : '사용 구성(Mix) 변동에 따른 비용 효과'}</b>: {moneyText(r.mix)} {r.mix <= 0 ? '절감' : '증가'} 효과
              <span className="text-xs text-gray-500"> · 단가는 {monthA} 그대로 두고 비중만 바뀌었을 때 개당 평균단가 {sgn(r.mixAvgDelta)}원</span>
              {stockMode && F && (
                <div className="text-xs text-gray-600 mt-1">
                  └ 이 중 실제 사용(생산량) 구성 몫 {sgnInt(F.base.mix)}원, 나머지 {sgnInt(r.mix - F.base.mix)}원은 품목별 로스(투입 − 생산) 차이 — 아래 2·3번 참고
                </div>
              )}
            </div>
          </div>

          {/* 2. 증감 나누기 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">
              2. 용기비 증감 {sgnInt(r.total)}원 나누기 <span className="text-xs font-normal text-gray-500">(− 줄어듦 · + 늘어남 · {stockMode ? '네' : '세'} 몫을 더하면 증감과 같습니다{stockMode ? ' · 구성은 실제 사용(생산량) 기준, 나머지 차이는 ④ 로스' : ''})</span>
            </div>
            <div className="p-4 grid grid-cols-2 lg:grid-cols-5 gap-3">
              {[
                { t: '① 물량', s: '많이·적게 써서 (원가율 영향 없음)', v: F ? F.base.volume : r.volume, neutral: true },
                { t: '② 사용 구성(Mix)', s: '비싼·싼 용기 비중 (실제 사용 기준)', v: F ? F.base.mix : r.mix },
                { t: '③ 단가', s: '용기를 비싸게·싸게 사서', v: F ? F.base.price : r.price },
                ...(stockMode && F ? [{ t: '④ 로스 변화', s: '재고조사 투입 − 생산량', v: F.lossCostB - F.lossCostA }] : []),
              ].map((k) => (
                <div key={k.t} className="border rounded-lg p-3">
                  <div className="text-sm font-bold text-gray-800">{k.t}</div>
                  <div className="text-[11px] text-gray-500">{k.s}</div>
                  <div className={`text-xl font-extrabold tabular-nums mt-1 ${'neutral' in k && k.neutral ? 'text-gray-700' : k.v < 0 ? 'text-emerald-700' : k.v > 0 ? 'text-rose-600' : 'text-gray-500'}`}>{sgnInt(k.v)}원</div>
                </div>
              ))}
              <div className="border-2 border-indigo-200 rounded-lg p-3 bg-indigo-50/40 col-span-2 lg:col-span-1">
                <div className="text-sm font-bold text-gray-800">용기 원가율 <span className="text-[11px] font-normal text-gray-500">{stockMode ? '재고조사 기준' : '생산량 기준'}</span></div>
                {ratioView ? (
                  <>
                    <div className="text-xl font-extrabold tabular-nums mt-1">{ratioView.rA.toFixed(2)}% → {ratioView.rB.toFixed(2)}%</div>
                    <div className={`text-sm font-bold tabular-nums ${Math.abs(ratioView.d) < 0.005 ? 'text-gray-600' : ratioView.d < 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{sgn(ratioView.d, 2)}%p{Math.abs(ratioView.d) < 0.005 ? ' (보합)' : ''}</div>
                    <div className="mt-1.5 text-[11px] text-gray-600 space-y-0.5 tabular-nums">
                      {[['구성', ratioView.mix], ['단가', ratioView.price], ...(stockMode ? [['로스', ratioView.loss]] : []), ['개당 생산금액', ratioView.rev]].map(([k, v]) => (
                        <div key={k as string} className="flex justify-between"><span>{k}</span><span className={(v as number) < -0.0005 ? 'text-emerald-700' : (v as number) > 0.0005 ? 'text-rose-600' : ''}>{sgn(v as number, 2)}%p</span></div>
                      ))}
                    </div>
                  </>
                ) : <div className="text-xs text-gray-500 mt-1">두 달 생산금액을 넣으면 원가율(%p)로 봅니다</div>}
              </div>
            </div>
          </div>

          {/* 3. 용기 로스 (재고조사 투입 − 생산량) */}
          {F && F.hasStock && (
            <div className="bg-white border rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">
                3. 용기 로스 (재고조사 투입 − 생산량) <span className="text-xs font-normal text-gray-500">— 음수(빨강) = 생산한 것보다 덜 쓴 것으로 나옴 → 재고조사·월말 시점 확인</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-600 bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left">용기</th>
                      <th className="px-3 py-2 text-right text-blue-700">{monthA} 생산 / 투입</th>
                      <th className="px-3 py-2 text-right text-blue-700">{monthA} 로스</th>
                      <th className="px-3 py-2 text-right text-rose-700">{monthB} 생산 / 투입</th>
                      <th className="px-3 py-2 text-right text-rose-700">{monthB} 로스</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {F.loss.map((x) => {
                      const cell = (l: number | null, rate: number | null) => (l === null ? <td className="px-3 py-2 text-right text-gray-300">—</td> : (
                        <td className={`px-3 py-2 text-right tabular-nums font-bold ${l < 0 ? 'bg-rose-50 text-rose-700' : 'text-gray-800'}`}>
                          {sgnInt(l)}개 <span className="text-xs font-normal">({rate !== null ? sgn(rate * 100) : '—'}%)</span>
                          {l < 0 && <div className="text-[10px] font-normal">생산보다 덜 씀 — 확인 필요</div>}
                        </td>
                      ));
                      return (
                        <tr key={x.id}>
                          <td className="px-3 py-2 font-semibold text-gray-800">{x.label}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-600">{nf(x.prodA)} / {x.stockA === null ? '—' : nf(x.stockA)}</td>
                          {cell(x.lossA, x.rateA)}
                          <td className="px-3 py-2 text-right tabular-nums text-gray-600">{nf(x.prodB)} / {x.stockB === null ? '—' : nf(x.stockB)}</td>
                          {cell(x.lossB, x.rateB)}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-100 font-bold">
                    <tr>
                      <td className="px-3 py-2">합계</td>
                      <td className="px-3 py-2 text-right tabular-nums">{nf(F.base.QA)} / {nf(F.base.QA + F.lossQtyA)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{sgnInt(F.lossQtyA)}개 ({sgn(F.lossRateA * 100)}%) · {sgnInt(F.lossCostA)}원</td>
                      <td className="px-3 py-2 text-right tabular-nums">{nf(F.base.QB)} / {nf(F.base.QB + F.lossQtyB)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{sgnInt(F.lossQtyB)}개 ({sgn(F.lossRateB * 100)}%) · {sgnInt(F.lossCostB)}원</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* 4. 보고서 문구 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">4. 보고서 문구</div>
            <div className="p-4 space-y-4 text-sm">
              {[
                { t: '옵션 1 · 표준 보고서 양식 (추천)', lines: c.opt1 },
                { t: '옵션 2 · 핵심 요약 2줄', lines: c.opt2 },
                { t: '옵션 3 · 비고란용 1줄', lines: [c.opt3] },
              ].map((o) => (
                <div key={o.t} className="border rounded-lg">
                  <div className="px-3 py-2 border-b bg-gray-50 flex items-center gap-2">
                    <span className="font-bold text-gray-700">{o.t}</span>
                    <span className="ml-auto"><CopyBtn text={o.lines.join('\n')} /></span>
                  </div>
                  <div className="px-3 py-2 space-y-1 text-gray-800 leading-relaxed">
                    {o.lines.map((l, i) => <div key={i}>{l}</div>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
