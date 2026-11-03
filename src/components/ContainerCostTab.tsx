/** 용기분석 › 용기분석(원가) — 전월 대비 용기비 변동을 물량 · 구성(Mix) · 단가로 나누고 짧게 분석
 *  수량 기준 (전환):
 *   · 재고조사 기준(기본) — 재고 정합성 탭의 실제 투입량 (직접입력, 없으면 기초+입고−기말) = 제조원가와 같은 기준.
 *     구성·단가·물량 모두 투입량으로 계산 → 물량 + 구성 + 단가 = 증감. 로스(투입 − 생산)는 「재고조사 확인」에 참고로만.
 *   · 생산량 기준 — 월별 사용량 탭과 같은 값. 작은·큰용기 = 제품 DB 용기 구분별 냉장 생산량, 레토르트 = 실온 생산량.
 *     재고 정합성 탭이 계산해 서버(containerStock/_theory)에 올려 둔 값을 같이 쓰고, 없으면 여기서 계산해 올린다.
 *  단가·생산금액은 여기서 넣으면 서버에 저장(모든 기기 공통). */
import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { isPastMonth, loadContainerMonth } from '../lib/containerLoad';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { effectiveInput } from '../lib/containerStock';
import type { StockEntry } from '../lib/containerStock';
import {
  CONTAINER_COST_COL, CONTAINER_ITEMS, FILM_ITEMS, analyzeContainerCost, analyzeFilm,
  containerAnalysis, containerLoss, containerRatio, containerReport, filmSummary,
} from '../lib/containerCost';
import type { CCMonth, CCPoint, ContainerId, FilmId } from '../lib/containerCost';
import { saveProductionAmount, useProductionAmounts } from '../lib/monthlyAmount';
import { AmtInput } from './CostDecompPanel';

function shiftMonth(m: string, delta: number): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const nf = (n: number) => Math.round(n).toLocaleString();
const sgn = (n: number, d = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const sgnInt = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(Math.round(n)).toLocaleString()}`;
const man = (n: number) => `${Math.round(n / 1e4).toLocaleString()}만`;
const sman = (n: number) => `${n >= 0 ? '+' : '−'}${Math.round(Math.abs(n) / 1e4).toLocaleString()}만`;
const mon = (m: string) => `${Number(m.slice(5))}월`;
const toneCls = (v: number, eps: number) => (Math.abs(v) < eps ? 'text-gray-600' : v < 0 ? 'text-emerald-700' : 'text-rose-600');

/** 단가 입력 (소수 가능) — 칸을 벗어나면 저장 */
function PriceInput({ value, onSave, placeholder = '단가' }: { value: number | null | undefined; onSave: (v: number | null) => void; placeholder?: string }) {
  // ERP 평균단가는 소수가 길다 — 소수 둘째 자리까지만 보여 주고, 손대지 않으면 저장값(원래 값)은 그대로 둔다
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const show = (v: number | null | undefined) => (typeof v === 'number' ? String(r2(v)) : '');
  const [t, setT] = useState(show(value));
  useEffect(() => { setT(show(value)); }, [value]);
  return (
    <input value={t} inputMode="decimal" placeholder={placeholder}
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

type TheoryCell = { small: number; large: number; ambient: number; unknown: number; m1?: number; m2?: number; m3?: number; mUnassigned?: number; ts: number };
/** 재고 정합성 탭과 같은 규칙 — 지난달은 그 달이 끝난 뒤 계산된 값만, 이번 달은 5분 이내 값만 */
const usableTheory = (m: string, c: TheoryCell | undefined) => {
  if (!c || typeof c.small !== 'number' || c.m1 == null) return false;   // 호기별 값이 없는 옛 저장분은 다시 계산 (필름용)
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

/** 분석 줄 — 왼쪽 굵은 머리말 + 내용 */
function Points({ points }: { points: CCPoint[] }) {
  const dot = { good: 'bg-emerald-500', bad: 'bg-rose-500', plain: 'bg-gray-300' };
  return (
    <ul className="space-y-2 text-[15px] leading-snug text-gray-800">
      {points.map((p) => (
        <li key={p.k} className="flex gap-3">
          <span className="w-16 shrink-0 font-bold text-gray-500 flex items-center gap-1.5 whitespace-nowrap"><span className={`w-2 h-2 rounded-full ${dot[p.tone]}`} />{p.k}</span>
          <span className={p.k === '결론' ? 'font-bold' : ''}>{p.t}</span>
        </li>
      ))}
    </ul>
  );
}

const Card = ({ title, right, children }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) => (
  <section className="bg-white border rounded-lg overflow-hidden">
    <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm flex items-center gap-2">{title}{right && <span className="ml-auto flex items-center gap-2">{right}</span>}</div>
    {children}
  </section>
);

export default function ContainerCostTab() {
  const [monthB, setMonthB] = useState(() => shiftMonth(todayKey().slice(0, 7), -1));
  const [monthA, setMonthA] = useState(() => shiftMonth(todayKey().slice(0, 7), -2));
  const setB = (m: string) => { setMonthB(m); setMonthA(shiftMonth(m, -1)); };

  const stockA = useDoc<Record<string, StockEntry>>('containerStock', monthA);
  const stockB = useDoc<Record<string, StockEntry>>('containerStock', monthB);
  const costA = useDoc<{ prices?: Partial<Record<ContainerId | FilmId, number>> }>(CONTAINER_COST_COL, monthA);
  const costB = useDoc<{ prices?: Partial<Record<ContainerId | FilmId, number>> }>(CONTAINER_COST_COL, monthB);
  const amounts = useProductionAmounts([monthA, monthB]);
  const theoryDoc = useDoc<Record<string, TheoryCell>>('containerStock', '_theory');
  // 처음엔 재고조사 기준(투입량 = 제조원가와 같은 기준). 생산량 기준을 고르면 그 기기에서 기억
  const [basis, setBasisState] = useState<Basis>(() => { try { return localStorage.getItem('containerCost:basisV2') === 'prod' ? 'prod' : 'stock'; } catch { return 'stock'; } });
  const setBasis = (b: Basis) => { setBasisState(b); try { localStorage.setItem('containerCost:basisV2', b); } catch { /* noop */ } };
  const [fmt, setFmt] = useState<'std' | 'two' | 'one'>('std');

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
          const t: TheoryCell = { small: r.small, large: r.large, ambient: r.ambient, unknown: r.unknown, m1: r.m1, m2: r.m2, m3: r.m3, mUnassigned: r.mUnassigned, ts: Date.now() };
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
  const savePrice = (m: string, id: ContainerId | FilmId, v: number | null) => {
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
  const monthData = (cost: { prices?: Partial<Record<ContainerId | FilmId, number>> } | undefined, m: string, side: 'A' | 'B'): CCMonth => ({
    qty: qtyView[basis][side],
    price: Object.fromEntries(CONTAINER_ITEMS.map((it) => [it.id, typeof cost?.prices?.[it.id] === 'number' ? cost!.prices![it.id]! : null])),
    amount: amounts[m] || 0,
  });
  const A = monthData(costA, monthA, 'A');
  const B = monthData(costB, monthB, 'B');
  const r = useMemo(() => (loading || calc ? null : analyzeContainerCost(A, B, monthA, monthB)),
    [loading, calc, JSON.stringify(A), JSON.stringify(B), monthA, monthB]); // eslint-disable-line react-hooks/exhaustive-deps
  const unknownQty = basis === 'prod' ? (theoryOf(monthA)?.unknown || 0) + (theoryOf(monthB)?.unknown || 0) : 0;
  const ready = !!r && r.missing.length === 0;
  const amt = { A: A.amount, B: B.amount };
  const q = ready ? containerRatio(r!, amt) : null;
  const points = ready ? containerAnalysis(r!, q, basis === 'stock' ? '투입' : '사용') : null;
  // 재고조사 확인 (참고) — 투입 − 생산
  const loss = loading || calc ? null : containerLoss(qtyView.prod, qtyView.stock, monthA, monthB);
  const report = ready ? containerReport(r!, q, basis === 'stock' && loss ? loss.negatives : []) : null;
  const reportLines = report ? (fmt === 'std' ? report.std : fmt === 'two' ? report.two : [report.one]) : [];

  /* ── 필름 ── 롤 수량은 재고 정합성과 같은 자리(containerStock/{월}.{f2|f4|fr}.input), 롤 단가는 containerCost */
  const filmProd = (m: string): Record<FilmId, number | null> => {
    const t = theoryOf(m);
    return {
      f2: t && t.m1 != null && t.m2 != null ? t.m1 + t.m2 + (t.mUnassigned || 0) : null,
      f4: t && t.m3 != null ? t.m3 : null,
      fr: t ? t.ambient : null,
    };
  };
  const filmRolls = (stock: Record<string, StockEntry> | undefined): Record<FilmId, number | null> =>
    Object.fromEntries(FILM_ITEMS.map((it) => [it.id, effectiveInput(stock?.[it.id])])) as Record<FilmId, number | null>;
  const filmPrice = (cost: { prices?: Partial<Record<ContainerId | FilmId, number>> } | undefined): Record<FilmId, number | null> =>
    Object.fromEntries(FILM_ITEMS.map((it) => [it.id, typeof cost?.prices?.[it.id] === 'number' ? cost!.prices![it.id]! : null])) as Record<FilmId, number | null>;
  const FA = { prod: filmProd(monthA), rolls: filmRolls(stockA), price: filmPrice(costA), amount: A.amount };
  const FB = { prod: filmProd(monthB), rolls: filmRolls(stockB), price: filmPrice(costB), amount: B.amount };
  const film = loading || calc ? null : analyzeFilm(FA, FB, monthA, monthB);
  const filmReady = !!film && film.missing.length === 0;
  const filmSum = filmReady ? filmSummary(film!, monthA, monthB) : null;
  const saveRolls = (m: string, id: FilmId, v: number | null) => {
    setErr('');
    setDoc(doc(db, 'containerStock', m), { [id]: { input: v } }, { merge: true })
      .catch((e) => setErr(`필름 롤 저장 실패: ${e?.message || e}`));
  };
  // 용기 + 필름 원가율 — 보고서 부재료 줄과 견주는 용
  const subTotal = filmReady && ready && A.amount > 0 && B.amount > 0
    ? { rA: ((r!.CA + film!.CA) / A.amount) * 100, rB: ((r!.CB + film!.CB) / B.amount) * 100 }
    : null;
  const qtyLabel = basis === 'stock' ? '투입량' : '생산량';

  return (
    <div className="space-y-4">
      {/* 달 · 기준 */}
      <div className="bg-white border rounded-lg px-4 py-3 flex items-center gap-2 flex-wrap">
        <input type="month" value={monthA} onChange={(e) => e.target.value && setMonthA(e.target.value)} className="border rounded px-2 py-1 text-sm font-bold" />
        <span className="text-gray-400">→</span>
        <button onClick={() => setB(shiftMonth(monthB, -1))} className="w-8 h-8 rounded hover:bg-gray-100">◀</button>
        <input type="month" value={monthB} onChange={(e) => e.target.value && setB(e.target.value)} className="border rounded px-2 py-1 text-sm font-bold" />
        <button onClick={() => setB(shiftMonth(monthB, 1))} className="w-8 h-8 rounded hover:bg-gray-100">▶</button>
        {(loading || calc) && <span className="text-xs text-blue-600">{calc || '불러오는 중…'}</span>}
        <div className="ml-auto flex rounded-md border overflow-hidden text-xs">
          {([['stock', '재고조사 기준'], ['prod', '생산량 기준']] as const).map(([k, t]) => (
            <button key={k} onClick={() => setBasis(k)}
              className={`px-3 py-1.5 font-bold ${basis === k ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{t}</button>
          ))}
        </div>
      </div>

      {err && <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">{err}</div>}
      {!loading && r && r.missing.length > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800">
          ⚠ 비어 있음: <b>{r.missing.join(', ')}</b>{basis === 'stock' ? ' — 투입량은 「재고 정합성」 탭에서' : ''}
        </div>
      )}
      {unknownQty > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800">
          ⚠ 제품 DB 에 없는 코드 {nf(unknownQty)}개는 빠졌습니다 (설정 › 제품 DB 에 등록하면 반영)
        </div>
      )}

      {/* 분석 */}
      {ready && r && points && (
        <section className="bg-white border-2 border-indigo-200 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b bg-indigo-50 font-bold text-indigo-900 text-sm">
            📊 {mon(monthA)} → {mon(monthB)} 용기 분석 <span className="text-xs font-normal text-indigo-700">· {basis === 'stock' ? '재고조사 투입량 기준' : '생산량 기준'}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead className="text-xs text-gray-500">
                <tr className="border-b">
                  <th className="px-4 py-2 text-left font-semibold" />
                  <th className="px-3 py-2 text-right font-semibold">{mon(monthA)}</th>
                  <th className="px-3 py-2 text-right font-semibold">{mon(monthB)}</th>
                  <th className="px-3 py-2 text-right font-bold text-gray-800 bg-slate-50">증감</th>
                  <th className="px-3 py-2 text-right font-semibold border-l">물량</th>
                  <th className="px-3 py-2 text-right font-semibold">구성</th>
                  <th className="px-3 py-2 text-right font-semibold">단가</th>
                  <th className="px-3 py-2 text-right font-semibold">개당 생산금액</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b">
                  <td className="px-4 py-2.5 font-bold text-gray-700">용기비</td>
                  <td className="px-3 py-2.5 text-right">{man(r.CA)}</td>
                  <td className="px-3 py-2.5 text-right">{man(r.CB)}</td>
                  <td className={`px-3 py-2.5 text-right font-extrabold text-base bg-slate-50 ${toneCls(r.total, 1)}`}>{sman(r.total)}</td>
                  {[r.volume, r.mix, r.price].map((v, i) => (
                    <td key={i} className={`px-3 py-2.5 text-right font-bold ${i === 0 ? 'border-l text-gray-600' : toneCls(v, 1)}`} title={`${sgnInt(v)}원`}>{sman(v)}</td>
                  ))}
                  <td className="px-3 py-2.5 text-right text-gray-300">—</td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-bold text-gray-700">원가율</td>
                  {q ? (
                    <>
                      <td className="px-3 py-2.5 text-right">{q.rA.toFixed(2)}%</td>
                      <td className="px-3 py-2.5 text-right">{q.rB.toFixed(2)}%</td>
                      <td className={`px-3 py-2.5 text-right font-extrabold text-base bg-slate-50 ${toneCls(q.d, 0.005)}`}>{sgn(q.d, 2)}%p</td>
                      <td className="px-3 py-2.5 text-right text-gray-300 border-l">—</td>
                      {[q.mix, q.price, q.rev].map((v, i) => (
                        <td key={i} className={`px-3 py-2.5 text-right font-bold ${toneCls(v, 0.005)}`}>{sgn(v, 2)}%p</td>
                      ))}
                    </>
                  ) : <td colSpan={7} className="px-3 py-2.5 text-xs text-gray-500">아래 표에 두 달 생산금액을 넣으면 나옵니다</td>}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 border-t">
            <Points points={points} />
          </div>
          {basis === 'stock' && loss && loss.checks.length > 0 && (
            <div className="px-4 py-2.5 border-t bg-amber-50 text-sm text-amber-900 space-y-1">
              {loss.checks.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
        </section>
      )}

      {/* 용기 표 — 단가·생산금액 입력 + 수량·비중 */}
      <Card title={<>용기 <span className="text-xs font-normal text-gray-500">노란 칸 입력 · 칸을 벗어나면 저장</span></>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs text-gray-600 bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left">용기</th>
                <th className="px-3 py-2 text-right text-blue-700">{mon(monthA)} 단가</th>
                <th className="px-3 py-2 text-right text-rose-700">{mon(monthB)} 단가</th>
                <th className="px-3 py-2 text-right">{qtyLabel} {mon(monthA)} → {mon(monthB)}</th>
                <th className="px-3 py-2 text-right">비중</th>
                <th className="px-3 py-2 text-right">용기비</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {CONTAINER_ITEMS.map((it) => {
                const row = ready ? r!.rows.find((x) => x.id === it.id) : undefined;
                const qa = qtyView[basis].A[it.id], qb = qtyView[basis].B[it.id];
                const cell = (v: number | null) => (v != null ? nf(v) : <span className="text-rose-500 text-xs">{basis === 'prod' ? '계산 전' : '미입력'}</span>);
                return (
                  <tr key={it.id}>
                    <td className="px-3 py-2 font-semibold text-gray-800 whitespace-nowrap">
                      {it.label}
                      {row && <span className={`ml-1.5 px-1.5 rounded text-[11px] font-bold ${row.tier === '고단가' ? 'bg-rose-100 text-rose-700' : 'bg-sky-100 text-sky-700'}`}>{row.tier}</span>}
                    </td>
                    <td className="px-3 py-2 text-right"><PriceInput value={A.price[it.id]} onSave={(v) => savePrice(monthA, it.id, v)} /></td>
                    <td className="px-3 py-2 text-right"><PriceInput value={B.price[it.id]} onSave={(v) => savePrice(monthB, it.id, v)} /></td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{cell(qa)} → {cell(qb)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {row ? <>{(row.sA * 100).toFixed(1)}% → {(row.sB * 100).toFixed(1)}% <b className={row.ds < 0 ? 'text-blue-700' : row.ds > 0 ? 'text-rose-600' : 'text-gray-500'}>({sgn(row.ds)}%p)</b></> : '—'}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-gray-700">{row ? <>{man(row.costA)} → {man(row.costB)}</> : '—'}</td>
                  </tr>
                );
              })}
              <tr className="bg-slate-50/60">
                <td className="px-3 py-2 font-semibold text-gray-800">생산금액</td>
                <td className="px-3 py-2 text-right"><AmtInput label="" value={A.amount} onChange={(v) => saveAmt(monthA, v)} /></td>
                <td className="px-3 py-2 text-right"><AmtInput label="" value={B.amount} onChange={(v) => saveAmt(monthB, v)} /></td>
                <td colSpan={3} />
              </tr>
            </tbody>
            {ready && r && (
              <tfoot className="bg-slate-100 font-bold">
                <tr>
                  <td className="px-3 py-2">합계</td>
                  <td colSpan={2} className="px-3 py-2 text-right text-xs font-semibold text-gray-600">개당 평균 {r.avgA.toFixed(1)}원 → {r.avgB.toFixed(1)}원</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{nf(r.QA)} → {nf(r.QB)}</td>
                  <td />
                  <td className="px-3 py-2 text-right whitespace-nowrap">{man(r.CA)} → {man(r.CB)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {/* 보고서 문구 */}
      {report && (
        <Card title="보고서 문구" right={<>
          <div className="flex rounded border overflow-hidden text-xs font-bold">
            {([['std', '표준'], ['two', '2줄'], ['one', '1줄']] as const).map(([k, t]) => (
              <button key={k} onClick={() => setFmt(k)} className={`px-2.5 py-1 ${fmt === k ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{t}</button>
            ))}
          </div>
          <CopyBtn text={reportLines.join('\n')} />
        </>}>
          <div className="px-4 py-3 space-y-1 text-sm text-gray-800 leading-relaxed">
            {reportLines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </Card>
      )}

      {/* 필름 (리드필름) — 롤 단위라 두 달 누적으로 판단 */}
      <Card title={<>필름 (리드필름) <span className="text-xs font-normal text-gray-500">이론 롤 = 생산량 ÷ 롤당 개수</span></>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs text-gray-600 bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left">필름</th>
                <th className="px-3 py-2 text-right text-blue-700">{mon(monthA)} 롤 단가</th>
                <th className="px-3 py-2 text-right text-rose-700">{mon(monthB)} 롤 단가</th>
                <th className="px-3 py-2 text-right text-blue-700">{mon(monthA)} 투입 롤</th>
                <th className="px-3 py-2 text-right text-rose-700">{mon(monthB)} 투입 롤</th>
                <th className="px-3 py-2 text-right">이론 롤</th>
                <th className="px-3 py-2 text-right">로스</th>
                <th className="px-3 py-2 text-right">누적 로스</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {FILM_ITEMS.map((it) => {
                const row = filmReady ? film!.rows.find((x) => x.id === it.id) : undefined;
                const pa = FA.prod[it.id], pb = FB.prod[it.id];
                const lossCell = (l: number) => <span className={l < 0 ? 'text-rose-600 font-bold' : l > 0.3 ? 'text-amber-700 font-bold' : ''}>{l >= 0 ? '+' : '−'}{Math.abs(l * 100).toFixed(0)}%</span>;
                return (
                  <tr key={it.id}>
                    <td className="px-3 py-2 whitespace-nowrap"><b className="text-gray-800">{it.short}</b> <span className="text-[11px] text-gray-500">{it.line} · {it.perRoll.toLocaleString()}개/롤</span></td>
                    <td className="px-3 py-2 text-right"><PriceInput value={FA.price[it.id]} onSave={(v) => savePrice(monthA, it.id, v)} /></td>
                    <td className="px-3 py-2 text-right"><PriceInput value={FB.price[it.id]} onSave={(v) => savePrice(monthB, it.id, v)} /></td>
                    <td className="px-3 py-2 text-right"><PriceInput placeholder="롤" value={FA.rolls[it.id]} onSave={(v) => saveRolls(monthA, it.id, v)} /></td>
                    <td className="px-3 py-2 text-right"><PriceInput placeholder="롤" value={FB.rolls[it.id]} onSave={(v) => saveRolls(monthB, it.id, v)} /></td>
                    <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">{pa != null ? (pa / it.perRoll).toFixed(1) : '—'} → {pb != null ? (pb / it.perRoll).toFixed(1) : '—'}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{row ? <>{lossCell(row.lossA)} → {lossCell(row.lossB)}</> : '—'}</td>
                    <td className="px-3 py-2 text-right font-bold">{row ? lossCell(row.lossCum) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {film && film.missing.length > 0 && (
          <div className="px-4 py-2.5 text-sm bg-amber-50 text-amber-800 border-t">⚠ 비어 있음: <b>{film.missing.join(', ')}</b></div>
        )}
        {filmSum && (
          <div className="px-4 py-3 border-t space-y-3">
            <Points points={filmSum.points} />
            <div className="flex items-start gap-2 border rounded-lg px-3 py-2 text-sm text-gray-800">
              <span className="flex-1">{filmSum.comment}</span><CopyBtn text={filmSum.comment} />
            </div>
          </div>
        )}
        {subTotal && (
          <div className="px-4 py-2.5 border-t bg-slate-50 flex items-center gap-3 flex-wrap text-sm">
            <b className="text-gray-800">용기 + 필름 원가율</b>
            <span className="font-extrabold tabular-nums">{subTotal.rA.toFixed(2)}% → {subTotal.rB.toFixed(2)}%</span>
            <b className={`tabular-nums ${toneCls(subTotal.rB - subTotal.rA, 0.005)}`}>{sgn(subTotal.rB - subTotal.rA, 2)}%p</b>
            <span className="text-xs text-gray-500">보고서 부재료 원가율과 차이 = 박스·라벨 등</span>
          </div>
        )}
      </Card>

      {/* 재고조사 확인 (참고) — 투입 − 생산 */}
      {loss && (
        <details className="bg-white border rounded-lg overflow-hidden group">
          <summary className="px-4 py-2.5 bg-slate-50 text-sm font-bold text-gray-800 cursor-pointer select-none">
            재고조사 확인 <span className="font-normal text-gray-600 tabular-nums">· 로스(투입 − 생산) {mon(monthA)} {sgn(loss.rateA * 100)}% → {mon(monthB)} {sgn(loss.rateB * 100)}%</span>
            {loss.negatives.length > 0 && <span className="ml-2 text-xs font-bold text-rose-600">⚠ 생산보다 적게 잡힌 용기 있음</span>}
          </summary>
          <div className="overflow-x-auto border-t">
            <table className="w-full text-sm tabular-nums">
              <thead className="text-xs text-gray-600 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left">용기</th>
                  <th className="px-3 py-2 text-right text-blue-700">{mon(monthA)} 생산 / 투입</th>
                  <th className="px-3 py-2 text-right text-blue-700">로스</th>
                  <th className="px-3 py-2 text-right text-rose-700">{mon(monthB)} 생산 / 투입</th>
                  <th className="px-3 py-2 text-right text-rose-700">로스</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loss.rows.map((x) => {
                  const cell = (l: number, rate: number) => (
                    <td className={`px-3 py-2 text-right font-bold ${l < 0 ? 'bg-rose-50 text-rose-700' : 'text-gray-800'}`}>
                      {sgnInt(l)} <span className="text-xs font-normal">({sgn(rate * 100)}%)</span>
                    </td>
                  );
                  return (
                    <tr key={x.id}>
                      <td className="px-3 py-2 font-semibold text-gray-800">{x.label}</td>
                      <td className="px-3 py-2 text-right text-gray-600">{nf(x.prodA)} / {nf(x.stockA)}</td>
                      {cell(x.lossA, x.rateA)}
                      <td className="px-3 py-2 text-right text-gray-600">{nf(x.prodB)} / {nf(x.stockB)}</td>
                      {cell(x.lossB, x.rateB)}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-100 font-bold">
                <tr>
                  <td className="px-3 py-2">합계</td>
                  <td className="px-3 py-2 text-right">{nf(loss.QpA)} / {nf(loss.QsA)}</td>
                  <td className="px-3 py-2 text-right">{sgnInt(loss.QsA - loss.QpA)} ({sgn(loss.rateA * 100)}%)</td>
                  <td className="px-3 py-2 text-right">{nf(loss.QpB)} / {nf(loss.QsB)}</td>
                  <td className="px-3 py-2 text-right">{sgnInt(loss.QsB - loss.QpB)} ({sgn(loss.rateB * 100)}%)</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {loss.checks.length > 0 && (
            <div className="px-4 py-2.5 border-t text-sm text-amber-900 bg-amber-50 space-y-1">{loss.checks.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
          )}
        </details>
      )}
    </div>
  );
}
