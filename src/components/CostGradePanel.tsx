/** 원재료분석 › 원가 등급 비중 분석 (윤기성 실장 11/6 지시)
 *  품목별 고·중·저원가 등급을 한 번 정해 고정하고, 월별 등급 비중 ↔ 원재료비율의 흐름과 상관계수를 본다.
 *  계산 규칙은 src/lib/costGrade.ts */
import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import type { AmbientRecipe, Recipe } from '../lib/wasteCompute';
import {
  GRADES, GRADE_DOC, corrWord, gradeOf, makePriceLookup, monthGradeStat, monthMaterialCost, pearson, prodQtyMap, tertileCuts, unitCosts,
} from '../lib/costGrade';
import type { Grade, GradeDoc, ProdMonth } from '../lib/costGrade';
import { computeProdMonth, readPmMonth, readProdMonth, saveProdMonth } from '../lib/prodMonthCache';
import { useProductionAmounts } from '../lib/monthlyAmount';

const shift = (m: string, d: number) => { const [y, mm] = m.split('-').map(Number); const t = new Date(y, mm - 1 + d, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const monthsBetween = (a: string, b: string) => { const out: string[] = []; for (let m = a; m <= b && out.length < 24; m = shift(m, 1)) out.push(m); return out; };
const mon = (m: string) => `${m.slice(2, 4)}.${Number(m.slice(5))}월`;
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const GC: Record<Grade, { bar: string; chip: string }> = {
  저: { bar: '#2f855a', chip: 'bg-emerald-100 text-emerald-800' },
  중: { bar: '#a0aec0', chip: 'bg-gray-100 text-gray-700' },
  고: { bar: '#c53030', chip: 'bg-rose-100 text-rose-800' },
};

type Status = ProdMonth | null | 'loading' | 'computing';

export default function CostGradePanel({ recipeMap, ambientMap, priceMap, recipeLabel, refreshKey }: {
  recipeMap: Map<string, Recipe>;
  ambientMap: Map<string, AmbientRecipe>;
  priceMap: Map<string, number>;
  recipeLabel: string;
  refreshKey?: number;
}) {
  const last = shift(thisMonth(), -1);
  const [from, setFrom] = useState(shift(last, -7));
  const [to, setTo] = useState(last);
  const months = useMemo(() => monthsBetween(from, to), [from, to]);
  const [gradeDoc, setGradeDoc] = useState<GradeDoc | null | undefined>(undefined);
  const [prod, setProd] = useState<Record<string, Status>>({});
  const [inputs, setInputs] = useState<Record<string, { inputs: Record<string, number>; names: Record<string, string> } | null>>({});
  const [manual, setManual] = useState<Record<string, number | null>>({});
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const amounts = useProductionAmounts(months);

  useEffect(() => onSnapshot(doc(db, GRADE_DOC.col, GRADE_DOC.id), (s) => setGradeDoc(s.exists() ? (s.data() as GradeDoc) : null), () => setGradeDoc(null)), []);

  // 월별: 생산수량 캐시(없으면 월별 생산수량) · ERP 실투입 · 공식 원재료비율(선택) — 한 달에 문서 2~3건만 읽는다
  useEffect(() => {
    let off = false;
    months.forEach(async (m) => {
      setProd((p) => ({ ...p, [m]: 'loading' }));
      const [c, inp, meta] = await Promise.all([
        readProdMonth(m).then((x) => x || readPmMonth(m)),
        getDoc(doc(db, 'materialInput', m)).then((s) => (s.exists() ? (s.data() as { inputs?: Record<string, number>; names?: Record<string, string> }) : null)).catch(() => null),
        getDoc(doc(db, 'monthlyMeta', m)).then((s) => (s.exists() ? Number((s.data() as { rawMaterialRatio?: number }).rawMaterialRatio) || null : null)).catch(() => null),
      ]);
      if (off) return;
      setProd((p) => ({ ...p, [m]: c }));
      setInputs((p) => ({ ...p, [m]: inp ? { inputs: inp.inputs || {}, names: inp.names || {} } : null }));
      setManual((p) => ({ ...p, [m]: meta }));
    });
    return () => { off = true; };
  }, [months.join(','), refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const priceMonths = useMemo(() => [...new Set([...priceMap.keys()].map((k) => k.slice(0, 7)))].sort(), [priceMap]);
  const refMonth = gradeDoc?.refMonth || priceMonths[priceMonths.length - 1] || last;
  const costs = useMemo(() => unitCosts(recipeMap, ambientMap, makePriceLookup(priceMap, refMonth)), [recipeMap, ambientMap, priceMap, refMonth]);
  const loaded = months.map((m) => prod[m]).filter((x): x is ProdMonth => !!x && typeof x === 'object');

  // 처음 고정할 때 기준선 — 불러온 달 생산수량 가중 3분위
  const autoCuts = useMemo(() => {
    const q = new Map<string, number>();
    loaded.forEach((p) => prodQtyMap(p).forEach((v, k) => q.set(k, (q.get(k) || 0) + v)));
    return tertileCuts(costs, q);
  }, [costs, loaded.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [cut, setCut] = useState<{ low: number; high: number } | null>(null);
  const cuts = cut || autoCuts;

  // 아직 고정 전이면 지금 기준선으로 미리보기 (전 품목을 같은 기준선으로 분류)
  const statDoc: GradeDoc | null = useMemo(() => gradeDoc || (gradeDoc === null
    ? { refMonth, recipeSrc: recipeLabel, low: cuts.low, high: cuts.high, grades: {}, createdAt: '', updatedAt: '' } : null),
  [gradeDoc, refMonth, recipeLabel, cuts.low, cuts.high]);
  const preview = !gradeDoc && !!statDoc;
  const rows = useMemo(() => months.map((m) => {
    const p = prod[m];
    const stat = statDoc && p && typeof p === 'object' ? monthGradeStat(p, statDoc, costs) : null;
    const inp = inputs[m];
    const amt = amounts[m] || 0;
    const mc = inp ? monthMaterialCost(inp.inputs, inp.names, makePriceLookup(priceMap, m)) : null;
    const calcRatio = mc && amt > 0 ? mc.cost / amt : null;
    const man = manual[m];
    const ratio = man ? man / 100 : calcRatio;
    const priceOwn = priceMonths.includes(m);
    return { m, p, stat, ratio, calcRatio, manualRatio: man, amt, priceOwn, hasInput: !!inp };
  }), [months, prod, statDoc, costs, inputs, amounts, manual, priceMap, priceMonths]);

  const paired = rows.filter((r) => r.stat && r.ratio !== null);
  const rHigh = pearson(paired.map((r) => r.stat!.share['고']), paired.map((r) => r.ratio!));
  const rMix = pearson(paired.map((r) => r.stat!.mixIndex), paired.map((r) => r.ratio!));

  const compute = async (m: string) => {
    setErr(''); setProd((p) => ({ ...p, [m]: 'computing' }));
    try {
      const p = await computeProdMonth(m, setProgress);
      setProd((x) => ({ ...x, [m]: p }));
      saveProdMonth(p).catch(() => {});   // 저장은 뒤에서 (화면은 바로)
    } catch (e) {
      setErr(`${m} 계산 실패: ${e instanceof Error ? e.message : String(e)}`);
      setProd((x) => ({ ...x, [m]: null }));
    } finally { setProgress(''); }
  };

  const fixGrades = async (mode: 'new' | 'reset' | 'add') => {
    if (mode === 'reset' && !window.confirm('등급 기준을 새로 정하면 지금까지의 고정 등급이 바뀌어 이전 비교와 기준이 달라집니다. 진행할까요?')) return;
    setSaving(true); setErr('');
    try {
      const now = new Date().toISOString();
      if (mode === 'add' && gradeDoc) {
        const add: Record<string, unknown> = {};
        costs.forEach((v, k) => { if (!gradeDoc.grades[k] && v.c > 0) add[k] = { g: gradeOf(v.c, gradeDoc.low, gradeDoc.high), c: Math.round(v.c * 10) / 10, n: v.n, k: v.k }; });
        await setDoc(doc(db, GRADE_DOC.col, GRADE_DOC.id), { grades: add, updatedAt: now }, { merge: true });
      } else {
        const grades: GradeDoc['grades'] = {};
        costs.forEach((v, k) => { if (v.c > 0) grades[k] = { g: gradeOf(v.c, cuts.low, cuts.high), c: Math.round(v.c * 10) / 10, n: v.n, k: v.k }; });
        await setDoc(doc(db, GRADE_DOC.col, GRADE_DOC.id), { refMonth, recipeSrc: recipeLabel, low: cuts.low, high: cuts.high, grades, createdAt: now, updatedAt: now });
        setCut(null);
      }
    } catch (e) { setErr(`저장 실패: ${e instanceof Error ? e.message : String(e)}`); } finally { setSaving(false); }
  };

  const saveManual = (m: string, v: string) => {
    const n = Number(v.replace(/[%\s,]/g, ''));
    const val = v.trim() === '' ? null : Number.isFinite(n) && n > 0 && n < 100 ? n : undefined;
    if (val === undefined) return;
    setManual((p) => ({ ...p, [m]: val }));
    setDoc(doc(db, 'monthlyMeta', m), { rawMaterialRatio: val ?? null }, { merge: true }).catch((e) => setErr(`저장 실패: ${e?.message || e}`));
  };

  const newCount = gradeDoc ? [...costs.entries()].filter(([k, v]) => !gradeDoc.grades[k] && v.c > 0).length : 0;
  const gradeCount = (g: Grade) => gradeDoc ? Object.values(gradeDoc.grades).filter((x) => x.g === g).length : 0;
  const [listOpen, setListOpen] = useState(false);
  const [gFilter, setGFilter] = useState<Grade | ''>('');
  const [q, setQ] = useState('');

  return (
    <div className="bg-white border-2 border-slate-300 rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-slate-800 text-white flex items-center gap-3 flex-wrap">
        <span className="font-bold">📊 원가 등급 비중 분석</span>
        <span className="text-[11px] text-slate-300">품목별 고·중·저원가 등급을 고정하고 월별 비중과 원재료비율의 관계를 봅니다</span>
        <div className="ml-auto flex items-center gap-1 text-xs text-slate-900">
          <input type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="border rounded px-1.5 py-0.5" />
          <span className="text-slate-300">~</span>
          <input type="month" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="border rounded px-1.5 py-0.5" />
        </div>
      </div>

      {/* 등급 기준 */}
      <div className="p-4 border-b bg-slate-50 text-sm">
        {gradeDoc === undefined ? <span className="text-gray-500">불러오는 중…</span> : gradeDoc === null || cut ? (
          <div className="space-y-2">
            <div className="font-bold text-gray-800">{gradeDoc ? '등급 기준 다시 정하기' : '처음 한 번 등급을 고정합니다'}</div>
            <div className="text-xs text-gray-600">개당 원재료비 = 레시피({recipeLabel}) × {mon(refMonth)} 재고평가 단가. 기준선은 불러온 달 생산수량의 1/3씩 나뉘도록 자동으로 잡았어요(직접 고쳐도 돼요).</div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-2 rounded text-xs font-bold ${GC['저'].chip}`}>저원가</span>
              <span className="text-xs">개당 원재료비 &lt;</span>
              <input type="number" value={cuts.low} onChange={(e) => setCut({ ...cuts, low: Number(e.target.value) || 0 })} className="w-24 border rounded px-2 py-1 text-right bg-yellow-50" />
              <span className="text-xs">원 ≤</span>
              <span className={`px-2 rounded text-xs font-bold ${GC['중'].chip}`}>중원가</span>
              <span className="text-xs">&lt;</span>
              <input type="number" value={cuts.high} onChange={(e) => setCut({ ...cuts, high: Number(e.target.value) || 0 })} className="w-24 border rounded px-2 py-1 text-right bg-yellow-50" />
              <span className="text-xs">원 ≤</span>
              <span className={`px-2 rounded text-xs font-bold ${GC['고'].chip}`}>고원가</span>
              <button onClick={() => fixGrades(gradeDoc ? 'reset' : 'new')} disabled={saving || costs.size === 0}
                className="ml-2 px-3 py-1.5 rounded bg-slate-800 text-white text-xs font-bold disabled:opacity-40">{saving ? '저장 중…' : `${costs.size}개 품목 등급 고정`}</button>
              {gradeDoc && <button onClick={() => setCut(null)} className="px-2 py-1 text-xs underline text-gray-600">취소</button>}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-bold text-gray-800">고정 기준</span>
            <span className={`px-2 rounded text-xs font-bold ${GC['저'].chip}`}>저 &lt; {gradeDoc.low.toLocaleString()}원</span>
            <span className={`px-2 rounded text-xs font-bold ${GC['중'].chip}`}>중</span>
            <span className={`px-2 rounded text-xs font-bold ${GC['고'].chip}`}>고 ≥ {gradeDoc.high.toLocaleString()}원</span>
            <span className="text-xs text-gray-500">{mon(gradeDoc.refMonth)} 단가 · {gradeDoc.recipeSrc} · 저 {gradeCount('저')} / 중 {gradeCount('중')} / 고 {gradeCount('고')}개 · {gradeDoc.createdAt.slice(0, 10)} 고정</span>
            {newCount > 0 && (
              <button onClick={() => fixGrades('add')} disabled={saving} className="px-2.5 py-1 rounded bg-indigo-600 text-white text-xs font-bold">신규 품목 {newCount}개 같은 기준으로 추가</button>
            )}
            <button onClick={() => setCut({ low: gradeDoc.low, high: gradeDoc.high })} className="ml-auto text-xs underline text-gray-500">기준 다시 정하기</button>
          </div>
        )}
      </div>

      {err && <div className="px-4 py-2 text-sm bg-rose-50 text-rose-700 border-b">{err}</div>}
      {progress && <div className="px-4 py-2 text-xs bg-blue-50 text-blue-700 border-b">{progress}</div>}

      {statDoc && (
        <>
          {preview && <div className="px-4 py-1.5 text-xs bg-amber-50 text-amber-800 border-b">미리보기 — 위 기준선으로 나눈 비중입니다. 「등급 고정」을 눌러야 저장되고, 그 뒤로는 기준이 바뀌지 않아요.</div>}
          <Chart rows={rows} />
          {/* 상관 */}
          <div className="px-4 py-3 border-t grid gap-2 sm:grid-cols-2 text-sm">
            {[{ t: '고원가 비중 ↔ 원재료비율', r: rHigh }, { t: '구성지수(고정 단가) ↔ 원재료비율', r: rMix }].map((x) => (
              <div key={x.t} className="border rounded-lg p-3">
                <div className="text-xs text-gray-500">{x.t} · {paired.length}개월</div>
                <div className="text-xl font-extrabold tabular-nums">{x.r === null ? '—' : `r = ${x.r.toFixed(2)}`}
                  <span className={`ml-2 text-sm font-bold ${x.r !== null && Math.abs(x.r) >= 0.7 ? 'text-rose-600' : 'text-gray-500'}`}>{corrWord(x.r)}{x.r !== null && Math.abs(x.r) >= 0.4 ? (x.r > 0 ? ' · 같은 방향' : ' · 반대 방향') : ''}</span>
                </div>
              </div>
            ))}
            <div className="sm:col-span-2 text-xs text-gray-500">
              r이 +1에 가까울수록 「고원가 비중이 오르면 원재료비율도 오른다」는 뜻이에요. 0.7 이상이면 제품 구성이 원재료비율을 움직인다고 말할 수 있고, 0.4 미만이면 다른 요인(수율·단가)이 더 커요. 6개월 미만이면 참고만 하세요.
            </div>
          </div>
        </>
      )}

      {/* 월별 표 */}
      <div className="overflow-x-auto border-t">
        <table className="w-full text-sm tabular-nums min-w-[760px]">
          <thead className="bg-slate-50 text-xs text-gray-600">
            <tr>
              <th className="px-3 py-2 text-left">월</th>
              <th className="px-3 py-2 text-right">생산수량</th>
              {GRADES.map((g) => <th key={g} className="px-3 py-2 text-right">{g}원가 비중</th>)}
              <th className="px-3 py-2 text-right">구성지수 (원/개)</th>
              <th className="px-3 py-2 text-right">원재료비율</th>
              <th className="px-3 py-2 text-right">공식 값 입력 (선택)</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.m}>
                <td className="px-3 py-2 font-semibold whitespace-nowrap">{mon(r.m)}</td>
                <td className="px-3 py-2 text-right">
                  {r.p === 'loading' ? <span className="text-gray-400 text-xs">…</span>
                    : r.p === 'computing' ? <span className="text-blue-600 text-xs">계산 중</span>
                      : r.p ? <>{Math.round(r.p.total).toLocaleString()}{r.p.source === 'pm' && <span className="ml-1 text-[10px] text-gray-400">월별수량</span>}</>
                        : <button onClick={() => compute(r.m)} className="px-2 py-0.5 rounded border text-xs hover:bg-gray-50" title="이 달 생산수량을 새로 셉니다 (Firestore 읽기 약 1만 건)">계산</button>}
                </td>
                {GRADES.map((g) => <td key={g} className="px-3 py-2 text-right">{r.stat ? pct(r.stat.share[g]) : '—'}</td>)}
                <td className="px-3 py-2 text-right">{r.stat ? `${Math.round(r.stat.mixIndex).toLocaleString()}` : '—'}{!preview && r.stat && r.stat.newCount > 0 && <span className="ml-1 text-[10px] text-indigo-600" title="고정 등급에 없는 신규 품목을 같은 기준으로 임시 분류">신규 {r.stat.newCount}</span>}</td>
                <td className="px-3 py-2 text-right font-bold">
                  {r.ratio !== null ? pct(r.ratio, 2) : <span className="text-xs text-gray-400 font-normal">{!r.hasInput ? '실투입 없음' : '생산금액 없음'}</span>}
                  {r.manualRatio ? <span className="ml-1 text-[10px] text-emerald-700">공식</span> : r.ratio !== null && !r.priceOwn ? <span className="ml-1 text-[10px] text-amber-600" title="그달 재고평가 단가가 없어 가까운 달 단가로 계산">단가대체</span> : null}
                </td>
                <td className="px-3 py-2 text-right">
                  <input defaultValue={r.manualRatio ?? ''} key={`${r.m}-${r.manualRatio ?? ''}`} placeholder={r.calcRatio !== null ? (r.calcRatio * 100).toFixed(2) : '%'}
                    onBlur={(e) => saveManual(r.m, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    className="w-20 border rounded px-2 py-0.5 text-right text-xs bg-yellow-50" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 text-[11px] text-gray-500 border-t">
        생산수량은 원재료분석을 돌린 지난달은 자동 저장되고, 없는 달은 「계산」(그 달만 읽기 약 1만 건)을 누르면 돼요. 원재료비율 = ERP 실투입 × 그달 재고평가 단가 ÷ 생산금액이고, 보고서의 공식 값을 넣으면 그 값으로 상관을 계산해요. 구성지수는 고정 단가로 본 평균 개당 원재료비라 제품 구성만의 변화예요.
      </div>

      {/* 품목별 등급 */}
      {gradeDoc && (
        <div className="border-t">
          <button onClick={() => setListOpen((v) => !v)} className="w-full px-4 py-2.5 text-left text-sm font-bold text-gray-700 bg-slate-50">
            {listOpen ? '▾' : '▸'} 품목별 고정 등급 ({Object.keys(gradeDoc.grades).length}개)
          </button>
          {listOpen && (
            <div className="p-3 space-y-2">
              <div className="flex gap-1.5 items-center flex-wrap">
                {(['', ...GRADES] as const).map((g) => (
                  <button key={g || 'all'} onClick={() => setGFilter(g)} className={`px-2.5 py-1 rounded-full text-xs border ${gFilter === g ? 'bg-slate-800 text-white' : 'bg-white'}`}>{g ? `${g}원가` : '전체'}</button>
                ))}
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="품목 검색" className="ml-auto border rounded px-2 py-1 text-xs w-36" />
              </div>
              <div className="max-h-80 overflow-y-auto border rounded">
                <table className="w-full text-xs tabular-nums">
                  <tbody className="divide-y">
                    {Object.entries(gradeDoc.grades)
                      .filter(([k, v]) => (!gFilter || v.g === gFilter) && (!q.trim() || v.n.includes(q.trim()) || k.toLowerCase().includes(q.trim().toLowerCase())))
                      .sort((a, b) => b[1].c - a[1].c).slice(0, 300)
                      .map(([k, v]) => (
                        <tr key={k}>
                          <td className="px-2 py-1"><span className={`px-1.5 rounded font-bold ${GC[v.g].chip}`}>{v.g}</span></td>
                          <td className="px-2 py-1 font-mono text-gray-500">{v.k === 'ambient' ? '실온' : k}</td>
                          <td className="px-2 py-1">{v.n}</td>
                          <td className="px-2 py-1 text-right">{Math.round(v.c).toLocaleString()}원</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 월별 등급 비중(100% 막대) + 원재료비율 선 */
function Chart({ rows }: { rows: { m: string; stat: ReturnType<typeof monthGradeStat> | null; ratio: number | null }[] }) {
  const W = 760, H = 230, L = 40, R = 52, T = 18, B = 28;
  const n = rows.length;
  if (!n) return null;
  const bw = Math.min(46, ((W - L - R) / n) * 0.6);
  const x = (i: number) => L + ((i + 0.5) * (W - L - R)) / n;
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const rs = rows.map((r) => r.ratio).filter((v): v is number => v !== null);
  const lo = rs.length ? Math.min(...rs) - 0.005 : 0.2, hi = rs.length ? Math.max(...rs) + 0.005 : 0.3;
  const yr = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const pts = rows.map((r, i) => (r.ratio !== null ? [x(i), yr(r.ratio)] as const : null));
  return (
    <div className="px-2 pt-3 overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" role="img" aria-label="월별 원가 등급 비중과 원재료비율">
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-gray-200" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="10" className="fill-gray-400">{v * 100}%</text>
          </g>
        ))}
        {rows.map((r, i) => {
          let acc = 0;
          return (
            <g key={r.m}>
              {r.stat && GRADES.map((g) => {
                const v = r.stat!.share[g];
                const y0 = y(acc + v), h = y(acc) - y(acc + v);
                acc += v;
                return <rect key={g} x={x(i) - bw / 2} y={y0} width={bw} height={Math.max(0, h)} fill={GC[g].bar} opacity={0.85} />;
              })}
              {r.stat && <text x={x(i)} y={y(1) - 4} textAnchor="middle" fontSize="10" className="fill-rose-700 font-bold">{pct(r.stat.share['고'], 0)}</text>}
              <text x={x(i)} y={H - 10} textAnchor="middle" fontSize="10" className="fill-gray-500">{mon(r.m)}</text>
            </g>
          );
        })}
        <polyline fill="none" stroke="#1e3a8a" strokeWidth="2.5"
          points={pts.filter(Boolean).map((p) => `${p![0]},${p![1]}`).join(' ')} />
        {pts.map((p, i) => p && (
          <g key={i}>
            <circle cx={p[0]} cy={p[1]} r="4" fill="#fff" stroke="#1e3a8a" strokeWidth="2" />
            <text x={p[0] + 6} y={p[1] - 6} fontSize="10" className="fill-blue-900 font-bold">{pct(rows[i].ratio!, 1)}</text>
          </g>
        ))}
        <text x={W - R + 6} y={T + 8} fontSize="10" className="fill-blue-900">원재료비율</text>
      </svg>
      <div className="flex gap-3 justify-center text-[11px] text-gray-600 pb-2">
        {GRADES.map((g) => <span key={g} className="flex items-center gap-1"><span className="w-3 h-3 inline-block rounded-sm" style={{ background: GC[g].bar }} />{g}원가 비중</span>)}
        <span className="flex items-center gap-1"><span className="w-4 h-0.5 inline-block bg-blue-900" />원재료비율</span>
      </div>
    </div>
  );
}
