/** 분석 › 노무비분석 — 노무비율 트리 (윤기성 실장 11/6 회의: 인당생산성 · 연장근무 · 정규공수, 금액 = 공수 × 시간당 금액)
 *  데이터: laborMonthly/{YYYY-MM} (공수표 붙여넣기 + 월별 노무비율·통제 밖 금액 입력). 계산은 src/lib/laborTree.ts */
import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, getDocs, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { LABOR_COL, decompose, laborCostOf, metrics, parseGongsu, parseRatios } from '../lib/laborTree';
import type { LaborMetrics, LaborMonth, Part, SubPart } from '../lib/laborTree';
import { useProductionAmounts } from '../lib/monthlyAmount';

const mon = (m: string) => `${Number(m.slice(5, 7))}월`;
const monY = (m: string) => `${m.slice(2, 4)}.${m.slice(5, 7)}`;
const pct = (r: number, d = 2) => `${(r * 100).toFixed(d)}%`;
const sgn = (v: number, s: string) => (v > 0 ? '+' : v < 0 ? '−' : '±') + s;
const pp = (x: number, d = 2) => sgn(x, `${Math.abs(x * 100).toFixed(d)}%p`);
const man = (won: number) => sgn(won, `${Math.round(Math.abs(won) / 1e4).toLocaleString()}만`);
const won = (v: number) => `${Math.round(v).toLocaleString()}`;
const chg = (a: number, b: number) => (a > 0 ? sgn(b - a, `${Math.abs(((b - a) / a) * 100).toFixed(1)}%`) : '');
const tone = (x: number) => (x > 0.00005 ? 'up' : x < -0.00005 ? 'down' : 'flat');
const TONE_TXT = { up: 'text-rose-700', down: 'text-blue-700', flat: 'text-gray-500' } as const;
const TONE_BAR = { up: 'bg-[#e34948]', down: 'bg-[#2a78d6]', flat: 'bg-gray-300' } as const;
const TONE_EDGE = { up: 'border-l-[#e34948]', down: 'border-l-[#2a78d6]', flat: 'border-l-gray-300' } as const;

type Num = keyof Pick<LaborMonth, 'workDays' | 'regularHours' | 'otHours' | 'extraHours' | 'weightedHours' | 'personDays' | 'productionAmount' | 'laborRatio' | 'laborCost' | 'outsideCost' | 'packDays' | 'prepDays'>;
const COLS: { k: Num; t: string; w: string; hint?: string }[] = [
  { k: 'workDays', t: '근무일수', w: 'w-14' },
  { k: 'regularHours', t: '정규공수', w: 'w-20' },
  { k: 'otHours', t: '연장근무', w: 'w-20', hint: '×1.5' },
  { k: 'extraHours', t: '연장초과', w: 'w-16', hint: '×2.0' },
  { k: 'weightedHours', t: '총공수', w: 'w-20', hint: '가중' },
  { k: 'personDays', t: '총인원', w: 'w-20', hint: '연인원' },
  { k: 'productionAmount', t: '생산금액', w: 'w-32' },
  { k: 'laborRatio', t: '노무비율 %', w: 'w-16' },
  { k: 'laborCost', t: '노무비 (원)', w: 'w-32', hint: '있으면 우선' },
  { k: 'outsideCost', t: '통제 밖 (원)', w: 'w-28', hint: '관리직·퇴직급여' },
  { k: 'packDays', t: '내포장 연인원', w: 'w-16', hint: '선택' },
  { k: 'prepDays', t: '전처리 연인원', w: 'w-16', hint: '선택' },
];

function NumCell({ v, onChange, w }: { v?: number; onChange: (n: number | undefined) => void; w: string }) {
  const [txt, setTxt] = useState<string | null>(null);
  const show = txt ?? (v ? v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '');
  return (
    <input value={show} inputMode="decimal"
      onFocus={() => setTxt(v ? String(v) : '')}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        const s = (txt || '').replace(/[,\s원%]/g, '');
        const n = Number(s);
        onChange(s && Number.isFinite(n) ? n : undefined);
        setTxt(null);
      }}
      className={`${w} border rounded px-1.5 py-0.5 text-right tabular-nums bg-yellow-50 focus:bg-white`} />
  );
}

/* ───────── 트리 ───────── */
interface TNode { id: string; title: string; formula?: string; a?: string; b?: string; c?: string; better?: '↑' | '↓'; pp: number; money?: number; root?: boolean; kids?: TNode[] }

function NodeBox({ n, max }: { n: TNode; max: number }) {
  const t = tone(n.pp);
  return (
    <div className={`shrink-0 ${n.root ? 'w-60' : 'w-56'} bg-white border border-slate-300 border-l-4 ${n.root ? 'border-l-slate-700' : TONE_EDGE[t]} rounded-md px-2.5 py-2 shadow-sm`}
      title={n.formula}>
      <div className="flex items-baseline gap-1">
        <span className="font-bold text-[13px] text-gray-900">{n.title}</span>
        {n.better && <span className="text-[10px] text-gray-500">{n.better === '↑' ? '높을수록 좋음' : '낮을수록 좋음'}</span>}
      </div>
      {n.formula && <div className="text-[10px] text-gray-500 leading-tight">{n.formula}</div>}
      {n.a !== undefined && (
        <div className="mt-1 text-xs tabular-nums text-gray-700">
          {n.a} → <b className="text-gray-900">{n.b}</b> {n.c && <span className="text-gray-500">({n.c})</span>}
        </div>
      )}
      <div className={`mt-1 text-xs font-bold tabular-nums ${n.root ? 'text-gray-900' : TONE_TXT[t]}`}>
        {t === 'up' ? '▲ ' : t === 'down' ? '▼ ' : ''}노무비율 {pp(n.pp)}{n.money !== undefined && <span className="font-normal"> · {man(n.money)}원</span>}
      </div>
      {!n.root && (
        <div className="mt-1 h-1.5 bg-slate-100 rounded">
          <div className={`h-1.5 rounded ${TONE_BAR[t]}`} style={{ width: `${max > 0 ? Math.min(100, (Math.abs(n.pp) / max) * 100) : 0}%` }} />
        </div>
      )}
    </div>
  );
}

function Tree({ n, max }: { n: TNode; max: number }) {
  const kids = n.kids || [];
  return (
    <div className="flex items-center">
      <NodeBox n={n} max={max} />
      {kids.length > 0 && (
        <>
          <div className="w-4 border-t-2 border-slate-300" />
          <div className="flex flex-col gap-2">
            {kids.map((k, i) => (
              <div key={k.id} className="flex items-center relative">
                {kids.length > 1 && (
                  <div className={`absolute left-0 border-l-2 border-slate-300 ${i === 0 ? 'top-1/2 -bottom-1' : i === kids.length - 1 ? '-top-1 bottom-1/2' : '-top-1 -bottom-1'}`} />
                )}
                <div className="w-4 border-t-2 border-slate-300" />
                <Tree n={k} max={max} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function buildTree(A: LaborMetrics, B: LaborMetrics, parts: Part[], dR: number, money: number): TNode {
  const P = (k: Part['key']) => parts.find((p) => p.key === k)!;
  const subNode = (s: SubPart, fmt: (v: number) => string, ratio = false): TNode => ({
    id: s.key, title: s.label, a: fmt(s.a), b: fmt(s.b),
    c: ratio ? sgn(s.b - s.a, `${Math.abs((s.b - s.a) * 100).toFixed(1)}%p`) : chg(s.a, s.b), pp: s.pp, money: s.money,
  });
  const field = P('prod').pp + P('hours').pp + P('ot').pp + P('wage').pp;
  const q = (v: number) => `${(v / 1e4).toFixed(1)}만`;
  return {
    id: 'root', root: true, title: '노무비율', formula: '노무비 ÷ 생산금액',
    a: pct(A.R), b: pct(B.R), pp: dR, money,
    kids: [
      {
        id: 'field', title: '현장 노무비율', formula: '시간당 금액 × (1+연장비율) × 1인 정규공수 ÷ 인당 생산성',
        a: pct(A.Rf), b: pct(B.Rf), pp: field, money: field * B.P,
        kids: [
          {
            id: 'prod', title: '인당 일생산금액', formula: '생산금액 ÷ 총인원(연인원)', better: '↑',
            a: q(A.q), b: q(B.q), c: chg(A.q, B.q), pp: P('prod').pp, money: P('prod').money,
            kids: P('prod').subs?.map((s) => subNode(s, q)),
          },
          {
            id: 'hours', title: '1인 1일 정규공수', formula: '정규공수 ÷ 총인원 — 중도 입사·단축·조퇴가 여기에 잡힘', better: '↓',
            a: `${A.h.toFixed(2)}h`, b: `${B.h.toFixed(2)}h`, c: chg(A.h, B.h), pp: P('hours').pp, money: P('hours').money,
          },
          {
            id: 'ot', title: '연장근무 (특근 포함)', formula: '(연장×1.5 + 초과×2.0) ÷ 정규공수', better: '↓',
            a: pct(A.o, 1), b: pct(B.o, 1), c: `연장 ${won(A.Ho)}→${won(B.Ho)}h`, pp: P('ot').pp, money: P('ot').money,
            kids: P('ot').subs?.map((s) => subNode(s, (v) => pct(v, 1), true)),
          },
          {
            id: 'wage', title: '시간당 금액', formula: '현장 노무비 ÷ 가중 총공수 — 임금 인상·수당·도급/알바 비중', better: '↓',
            a: `${won(A.w)}원`, b: `${won(B.w)}원`, c: chg(A.w, B.w), pp: P('wage').pp, money: P('wage').money,
          },
        ],
      },
      {
        id: 'outside', title: '통제 밖', formula: '관리직 급여·퇴직급여 ÷ 생산금액 (현장이 줄일 수 없는 몫)',
        a: pct(A.Rx), b: pct(B.Rx), pp: P('outside').pp, money: P('outside').money,
      },
    ],
  };
}

/* ───────── 페이지 ───────── */
export default function LaborAnalysis() {
  const [saved, setSaved] = useState<Record<string, LaborMonth> | null>(null);
  const [draft, setDraft] = useState<Record<string, Partial<LaborMonth>>>({});
  const [paste, setPaste] = useState('');
  const [ratioPaste, setRatioPaste] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [pick, setPick] = useState<{ a: string; b: string } | null>(null);
  const [addM, setAddM] = useState('');

  const load = () => getDocs(collection(db, LABOR_COL)).then((s) => {
    const o: Record<string, LaborMonth> = {};
    s.forEach((d) => { o[d.id] = { ...(d.data() as LaborMonth), month: d.id }; });
    setSaved(o);
  }).catch((e) => { setErr(`불러오기 실패: ${e?.message || e}`); setSaved({}); });
  useEffect(() => { load(); }, []);

  const months = useMemo(() => [...new Set([...Object.keys(saved || {}), ...Object.keys(draft)])].sort(), [saved, draft]);
  const pa = useProductionAmounts(months);
  const rowOf = (m: string): LaborMonth => {
    const r = { regularHours: 0, otHours: 0, extraHours: 0, personDays: 0, productionAmount: 0, ...(saved?.[m] || {}), ...(draft[m] || {}), month: m } as LaborMonth;
    return r;
  };
  const effRow = (m: string): LaborMonth => {
    const r = rowOf(m);
    return r.productionAmount > 0 ? r : { ...r, productionAmount: pa[m] || 0 };
  };
  const met = useMemo(() => {
    const o: Record<string, LaborMetrics | null> = {};
    months.forEach((m) => { o[m] = metrics(effRow(m)); });
    return o;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months, saved, draft, pa]);
  const ready = months.filter((m) => met[m]);

  const def = ready.length >= 2 ? { a: ready[ready.length - 2], b: ready[ready.length - 1] } : null;
  const sel = pick && met[pick.a] && met[pick.b] ? pick : def;
  const A = sel ? met[sel.a]! : null, B = sel ? met[sel.b]! : null;
  const dec = A && B ? decompose(A, B) : null;
  const tree = A && B && dec ? buildTree(A, B, dec.parts, dec.dR, dec.money) : null;
  const maxAbs = dec ? Math.max(...dec.parts.flatMap((p) => [Math.abs(p.pp), ...(p.subs || []).map((s) => Math.abs(s.pp))]), 1e-9) : 0;

  const dirty = Object.keys(draft);
  const setCell = (m: string, k: Num, v: number | undefined) => setDraft((d) => ({ ...d, [m]: { ...(d[m] || {}), [k]: v } }));

  const importGongsu = () => {
    const { rows, errors } = parseGongsu(paste);
    if (!rows.length) { setErr(errors[0] || '읽을 줄이 없어요'); return; }
    setErr('');
    setDraft((d) => {
      const n = { ...d };
      rows.forEach((r) => {
        const { month, ...rest } = r;
        const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && !(v === 0 && false)));
        if (!(r.productionAmount > 0)) delete (clean as Record<string, unknown>).productionAmount;   // 생산금액이 없으면 기존 값·월 생산금액 유지
        n[month] = { ...(n[month] || {}), ...clean };
      });
      return n;
    });
    setMsg(`${rows.map((r) => monY(r.month)).join(' · ')} 공수 ${rows.length}개월 불러옴${errors.length ? ` (확인: ${errors.join(', ')})` : ''} — 노무비율(%)을 넣고 저장하세요`);
    setPaste('');
  };
  const importRatios = () => {
    const yr = (months[months.length - 1] || String(new Date().getFullYear())).slice(0, 4);
    const r = parseRatios(ratioPaste, yr);
    const ks = Object.keys(r);
    if (!ks.length) { setErr('노무비율을 못 읽었어요 — 「1월 ⇥ 9.2」 또는 월 줄 + 값 줄로 붙여넣어 주세요'); return; }
    setErr('');
    setDraft((d) => { const n = { ...d }; ks.forEach((m) => { n[m] = { ...(n[m] || {}), laborRatio: r[m] }; }); return n; });
    setMsg(`노무비율 ${ks.length}개월 불러옴 (${ks.map((m) => `${monY(m)} ${r[m]}%`).join(', ')})`);
    setRatioPaste('');
  };
  const saveAll = async () => {
    setSaving(true); setErr('');
    try {
      for (const m of dirty) {
        const r = rowOf(m);
        const out: Record<string, unknown> = { month: m, updatedAt: new Date().toISOString() };
        Object.entries(r).forEach(([k, v]) => { if (k !== 'month' && k !== 'updatedAt' && typeof v === 'number' && Number.isFinite(v)) out[k] = v; });
        await setDoc(doc(db, LABOR_COL, m), out);
      }
      setDraft({}); setMsg(`${dirty.length}개월 저장했어요`);
      await load();
    } catch (e) { setErr(`저장 실패: ${(e as Error)?.message || e}`); }
    setSaving(false);
  };
  const removeMonth = async (m: string) => {
    if (!confirm(`${monY(m)} 노무비 데이터를 지울까요?`)) return;
    setDraft((d) => { const n = { ...d }; delete n[m]; return n; });
    if (saved?.[m]) { await deleteDoc(doc(db, LABOR_COL, m)).catch((e) => setErr(`삭제 실패: ${e?.message || e}`)); await load(); }
  };

  const ups = dec ? dec.parts.filter((p) => tone(p.pp) === 'up').sort((a, b) => b.pp - a.pp) : [];
  const downs = dec ? dec.parts.filter((p) => tone(p.pp) === 'down').sort((a, b) => a.pp - b.pp) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-extrabold">👷 노무비분석</h1>
        <span className="text-xs text-gray-500">노무비율을 트리로 나눠 오른 요인과 내린 요인을 같이 봅니다 · 금액 = 공수 × 시간당 금액</span>
        {ready.length >= 2 && sel && (
          <div className="ml-auto flex items-center gap-1 text-sm">
            <select value={sel.a} onChange={(e) => setPick({ a: e.target.value, b: sel.b })} className="border rounded px-2 py-1">
              {ready.map((m) => <option key={m} value={m}>{monY(m)}</option>)}
            </select>
            <span className="text-gray-400">→</span>
            <select value={sel.b} onChange={(e) => setPick({ a: sel.a, b: e.target.value })} className="border rounded px-2 py-1">
              {ready.map((m) => <option key={m} value={m}>{monY(m)}</option>)}
            </select>
          </div>
        )}
      </div>

      {err && <div className="px-3 py-2 text-sm bg-rose-50 text-rose-700 border border-rose-200 rounded">{err}</div>}
      {msg && <div className="px-3 py-2 text-sm bg-blue-50 text-blue-800 border border-blue-200 rounded">{msg}</div>}

      {saved === null ? <div className="text-sm text-gray-500">불러오는 중…</div> : !dec || !A || !B || !tree ? (
        <div className="bg-white border-2 border-dashed border-slate-300 rounded-lg p-5 text-sm text-gray-700 space-y-1">
          <div className="font-bold">두 달 이상 데이터가 있어야 트리가 나옵니다 ({ready.length}개월 준비됨)</div>
          <div>① 아래 「공수표 붙여넣기」에 엑셀 공수표를 <b>머리글 줄까지</b> 복사해 넣기 (년·월·구분·근무일수·정규공수·연장근무·연장초과·총공수·총인원·생산금액)</div>
          <div>② 「노무비율 붙여넣기」 또는 표에 월별 <b>노무비율(%)</b> 넣기 — 노무비 금액을 알면 금액 칸이 우선</div>
          <div>③ 관리직 급여·퇴직급여처럼 현장이 통제 못 하는 금액은 「통제 밖」 칸에 (없으면 비워도 됨)</div>
          <div>④ 저장 — 저장 전에도 화면에서 바로 계산돼요</div>
        </div>
      ) : (
        <>
          {/* 요약 */}
          <div className="bg-white border-2 border-slate-300 rounded-lg overflow-hidden">
            <div className="px-4 py-3 bg-slate-800 text-white flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-bold">{mon(A.month)} → {mon(B.month)} 노무비율 {pct(A.R)} → {pct(B.R)}</span>
              <span className="font-extrabold text-lg tabular-nums">{pp(dec.dR)}</span>
              <span className="text-sm text-slate-300 tabular-nums">{mon(B.month)} 생산금액 {(B.P / 1e8).toFixed(1)}억 기준 {man(dec.money)}원</span>
            </div>
            <div className="p-4 grid gap-4 lg:grid-cols-[1fr_380px] text-sm">
              <div className="space-y-2">
                <div><span className="font-bold text-rose-700">▲ 올린 요인</span> {ups.length ? ups.map((p) => <span key={p.key} className="inline-block mr-3 tabular-nums">{p.label} <b>{pp(p.pp)}</b> ({man(p.money)})</span>) : <span className="text-gray-500">없음</span>}</div>
                <div><span className="font-bold text-blue-700">▼ 내린 요인</span> {downs.length ? downs.map((p) => <span key={p.key} className="inline-block mr-3 tabular-nums">{p.label} <b>{pp(p.pp)}</b> ({man(p.money)})</span>) : <span className="text-gray-500">없음</span>}</div>
                <div className="text-gray-700">
                  인당 일생산금액은 <b>{chg(A.q, B.q)}</b> {B.q >= A.q ? '좋아졌고' : '나빠졌고'}, 노무비율은 <b>{pp(dec.dR)}</b>({chg(A.R, B.R)}) {dec.dR >= 0 ? '올랐어요' : '내렸어요'}.
                  {' '}생산성은 인원 기준, 노무비율은 금액 기준이라 두 숫자가 같이 움직이지 않습니다 — 그 차이는 연장근무·1인 정규공수·시간당 금액·통제 밖에서 나와요.
                </div>
                <div className="text-[11px] text-gray-500">다섯 몫을 더하면 노무비율 변화와 정확히 같습니다 (로그 평균 분해 · 금액 = 몫 × {mon(B.month)} 생산금액)</div>
              </div>
              {/* 기여도 막대 (0 기준, 오른쪽 = 올림 / 왼쪽 = 내림) */}
              <div className="space-y-1.5" role="img" aria-label="요인별 노무비율 기여도">
                {[...dec.parts, { key: 'sum', label: '합계', pp: dec.dR, money: dec.money }].map((p) => {
                  const t = tone(p.pp), w = Math.min(50, (Math.abs(p.pp) / Math.max(maxAbs, Math.abs(dec.dR))) * 50);
                  return (
                    <div key={p.key} className={`grid grid-cols-[118px_1fr_64px] items-center gap-2 text-xs ${p.key === 'sum' ? 'border-t pt-1.5 font-bold' : ''}`} title={`${p.label}: ${pp(p.pp, 3)} · ${man(p.money)}원`}>
                      <span className="truncate text-gray-700">{p.label}</span>
                      <div className="relative h-3.5">
                        <div className="absolute left-1/2 top-0 bottom-0 border-l border-gray-400" />
                        <div className={`absolute top-0 h-3.5 ${p.key === 'sum' ? 'bg-slate-600' : TONE_BAR[t]} ${p.pp >= 0 ? 'rounded-r' : 'rounded-l'}`}
                          style={p.pp >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
                      </div>
                      <span className="text-right tabular-nums text-gray-800">{pp(p.pp)}</span>
                    </div>
                  );
                })}
                <div className="flex justify-between text-[10px] text-gray-500 pl-[126px] pr-[72px]"><span>◀ 내림</span><span>올림 ▶</span></div>
              </div>
            </div>
          </div>

          {/* 트리 */}
          <div className="bg-white border-2 border-slate-300 rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 flex flex-wrap items-baseline gap-2">
              <span className="font-bold">🌳 노무비율 트리</span>
              <span className="text-[11px] text-gray-500">칸마다 {mon(A.month)} → {mon(B.month)} 값, 그리고 그 변화가 노무비율을 얼마나 올렸(▲)·내렸(▼)는지</span>
              {!dec.parts.find((p) => p.key === 'prod')?.subs && <span className="text-[11px] text-gray-400 ml-auto">내포장·전처리 연인원을 넣으면 생산성이 공정별로 한 단계 더 나뉩니다</span>}
            </div>
            <div className="p-4 overflow-x-auto"><Tree n={tree} max={maxAbs} /></div>
          </div>

          {/* 금액 = 공수 × 시간당 금액 + 민감도 */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="bg-white border-2 border-slate-300 rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-slate-50 font-bold">💰 금액 = 공수 × 시간당 금액</div>
              <table className="w-full text-sm tabular-nums">
                <thead className="text-xs text-gray-600 bg-slate-50"><tr><th className="px-3 py-1.5 text-left"></th><th className="px-3 py-1.5 text-right">{mon(A.month)}</th><th className="px-3 py-1.5 text-right">{mon(B.month)}</th><th className="px-3 py-1.5 text-right">차이</th></tr></thead>
                <tbody>
                  {([
                    ['정규공수 (h)', A.Hr, B.Hr, 'h'],
                    ['연장 가중공수 (h) = 연장×1.5 + 초과×2.0', A.Hw - A.Hr, B.Hw - B.Hr, 'h'],
                    ['시간당 금액 (원)', A.w, B.w, '원'],
                    ['정규 노무비 = 정규공수 × 시간당', A.Hr * A.w, B.Hr * B.w, 'm'],
                    ['연장 노무비 = 연장 가중공수 × 시간당', (A.Hw - A.Hr) * A.w, (B.Hw - B.Hr) * B.w, 'm'],
                    ['통제 밖 (관리직·퇴직급여)', A.Lx, B.Lx, 'm'],
                    ['노무비 합계', A.L, B.L, 'm'],
                    ['생산금액', A.P, B.P, 'm'],
                  ] as [string, number, number, string][]).map(([t, a, b, u]) => (
                    <tr key={t} className={`border-t ${t === '노무비 합계' ? 'font-bold bg-slate-50' : ''}`}>
                      <td className="px-3 py-1.5 text-gray-700">{t}</td>
                      <td className="px-3 py-1.5 text-right">{u === 'm' ? `${man(a).slice(1)}` : won(a)}</td>
                      <td className="px-3 py-1.5 text-right">{u === 'm' ? `${man(b).slice(1)}` : won(b)}</td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{u === 'm' ? man(b - a) : sgn(b - a, won(Math.abs(b - a)))}</td>
                    </tr>
                  ))}
                  <tr className="border-t font-bold"><td className="px-3 py-1.5">노무비율</td><td className="px-3 py-1.5 text-right">{pct(A.R)}</td><td className="px-3 py-1.5 text-right">{pct(B.R)}</td><td className="px-3 py-1.5 text-right">{pp(dec.dR)}</td></tr>
                </tbody>
              </table>
              <div className="px-3 py-2 text-[11px] text-gray-500 border-t">금액 단위 만원. 시간당 금액은 현장 노무비(노무비 − 통제 밖)를 가중 총공수로 나눈 값이라 연장 1시간 = 시간당 금액 × 1.5</div>
            </div>
            <div className="bg-white border-2 border-slate-300 rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-slate-50 font-bold">🎯 무엇을 얼마나 움직이면 ({mon(B.month)} 기준)</div>
              <div className="divide-y text-sm">
                {[
                  ['인당 일생산금액 +1만원', -B.Rf * (1e4 / B.q), `연인원 ${won(B.N)}명 그대로 생산금액 +${won((1e4 * B.N) / 1e4)}만`],
                  ['연장근무 −100시간', -(150 * B.w) / B.P, `100h × 1.5 × ${won(B.w)}원`],
                  ['정규공수 −100시간 (같은 생산)', -(100 * B.w) / B.P, `100h × ${won(B.w)}원`],
                  ['시간당 금액 +100원', B.Rf * (100 / B.w), `가중 총공수 ${won(B.Hw)}h × 100원`],
                ].map(([t, v, n]) => (
                  <div key={t as string} className="px-4 py-2 flex items-center gap-3">
                    <span className="flex-1 text-gray-800">{t}</span>
                    <span className={`font-bold tabular-nums ${TONE_TXT[tone(v as number)]}`}>노무비율 {pp(v as number, 3)}</span>
                    <span className="w-20 text-right tabular-nums text-gray-600">{man((v as number) * B.P)}원</span>
                    <span className="hidden sm:block w-48 text-[11px] text-gray-500">{n}</span>
                  </div>
                ))}
              </div>
              <div className="px-4 py-2 text-[11px] text-gray-500 border-t">
                1인 1일 정규공수 {B.h.toFixed(2)}h · 정규공수 1시간당 생산금액 {won(B.qh)}원 · 연장비율 {pct(B.o, 1)}
              </div>
            </div>
          </div>
        </>
      )}

      {/* 월별 흐름 */}
      {ready.length >= 2 && (
        <div className="bg-white border-2 border-slate-300 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b bg-slate-50 flex items-baseline gap-2"><span className="font-bold">📅 월별 흐름 · 전월 대비 요인</span><span className="text-[11px] text-gray-500">줄을 누르면 위 트리가 그 달(전월 → 그 달)로 바뀝니다</span></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums min-w-[980px]">
              <thead className="text-xs text-gray-600 bg-slate-50">
                <tr>
                  <th className="px-2 py-1.5 text-left">월</th><th className="px-2 py-1.5 text-right">노무비율</th><th className="px-2 py-1.5 text-right">인당 일생산</th>
                  <th className="px-2 py-1.5 text-right">1인 정규공수</th><th className="px-2 py-1.5 text-right">연장비율</th><th className="px-2 py-1.5 text-right">시간당 금액</th><th className="px-2 py-1.5 text-right">통제 밖</th>
                  <th className="px-2 py-1.5 text-right border-l">전월 대비</th><th className="px-2 py-1.5 text-right">생산성</th><th className="px-2 py-1.5 text-right">정규공수</th><th className="px-2 py-1.5 text-right">연장</th><th className="px-2 py-1.5 text-right">시간당</th><th className="px-2 py-1.5 text-right">통제 밖</th><th className="px-2 py-1.5 text-right">금액</th>
                </tr>
              </thead>
              <tbody>
                {ready.map((m, i) => {
                  const M = met[m]!, prev = i > 0 ? met[ready[i - 1]]! : null;
                  const d = prev ? decompose(prev, M) : null;
                  const on = sel?.b === m && sel?.a === ready[i - 1];
                  const cell = (k: Part['key']) => { const p = d?.parts.find((x) => x.key === k); return p ? <span className={TONE_TXT[tone(p.pp)]}>{pp(p.pp)}</span> : ''; };
                  return (
                    <tr key={m} onClick={() => prev && setPick({ a: ready[i - 1], b: m })} className={`border-t ${prev ? 'cursor-pointer hover:bg-slate-50' : ''} ${on ? 'bg-amber-50' : ''}`}>
                      <td className="px-2 py-1.5 font-bold">{monY(m)}</td>
                      <td className="px-2 py-1.5 text-right font-bold">{pct(M.R)}</td>
                      <td className="px-2 py-1.5 text-right">{(M.q / 1e4).toFixed(1)}만</td>
                      <td className="px-2 py-1.5 text-right">{M.h.toFixed(2)}h</td>
                      <td className="px-2 py-1.5 text-right">{pct(M.o, 1)}</td>
                      <td className="px-2 py-1.5 text-right">{won(M.w)}</td>
                      <td className="px-2 py-1.5 text-right">{pct(M.Rx)}</td>
                      <td className="px-2 py-1.5 text-right border-l font-bold">{d ? pp(d.dR) : ''}</td>
                      <td className="px-2 py-1.5 text-right">{cell('prod')}</td>
                      <td className="px-2 py-1.5 text-right">{cell('hours')}</td>
                      <td className="px-2 py-1.5 text-right">{cell('ot')}</td>
                      <td className="px-2 py-1.5 text-right">{cell('wage')}</td>
                      <td className="px-2 py-1.5 text-right">{cell('outside')}</td>
                      <td className="px-2 py-1.5 text-right text-gray-600">{d ? man(d.money) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 데이터 입력 */}
      <div className="bg-white border-2 border-slate-300 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
          <span className="font-bold">✏️ 월별 데이터</span>
          <span className="text-[11px] text-gray-500">노란 칸은 직접 고칠 수 있어요 · 생산금액이 비면 원재료분석의 월 생산금액을 씁니다</span>
          <div className="ml-auto flex items-center gap-1 text-xs">
            <input type="month" value={addM} onChange={(e) => setAddM(e.target.value)} className="border rounded px-1.5 py-0.5" />
            <button disabled={!addM || months.includes(addM)} onClick={() => { setDraft((d) => ({ ...d, [addM]: d[addM] || {} })); setAddM(''); }} className="px-2 py-1 rounded border text-xs disabled:opacity-40">달 추가</button>
            <button onClick={saveAll} disabled={!dirty.length || saving} className="px-3 py-1.5 rounded bg-slate-800 text-white text-xs font-bold disabled:opacity-40">{saving ? '저장 중…' : dirty.length ? `${dirty.length}개월 저장` : '저장됨'}</button>
          </div>
        </div>
        <div className="p-4 grid gap-3 md:grid-cols-2 border-b">
          <div>
            <div className="text-xs font-bold text-gray-700 mb-1">공수표 붙여넣기 <span className="font-normal text-gray-500">(엑셀에서 머리글 줄까지 복사 · 월마다 합계 줄을 씀)</span></div>
            <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} placeholder={'년\t월\t구분\t근무일수\t정규공수\t연장근무\t연장*1.5\t연장초과\t초과*2.0\t총공수\t총인원\t평균인원\t생산금액\t생산성\n2026\t1\t순수본\t…\n\t\t합계\t26\t8,229\t1,268\t…'}
              className="w-full border rounded p-2 text-xs font-mono" />
            <button onClick={importGongsu} disabled={!paste.trim()} className="mt-1 px-3 py-1 rounded bg-indigo-600 text-white text-xs font-bold disabled:opacity-40">공수 불러오기</button>
          </div>
          <div>
            <div className="text-xs font-bold text-gray-700 mb-1">노무비율 붙여넣기 <span className="font-normal text-gray-500">(「1월 ⇥ 9.2%」 줄마다, 또는 월 줄 + 값 줄)</span></div>
            <textarea value={ratioPaste} onChange={(e) => setRatioPaste(e.target.value)} rows={4} placeholder={'1월\t2월\t3월\t…\n9.2%\t10.8%\t10.4%\t…'}
              className="w-full border rounded p-2 text-xs font-mono" />
            <button onClick={importRatios} disabled={!ratioPaste.trim()} className="mt-1 px-3 py-1 rounded bg-indigo-600 text-white text-xs font-bold disabled:opacity-40">노무비율 불러오기</button>
          </div>
        </div>
        {months.length > 0 && (
          <div className="overflow-x-auto">
            <table className="text-xs tabular-nums min-w-full">
              <thead className="bg-slate-50 text-gray-600">
                <tr>
                  <th className="px-2 py-1.5 text-left">월</th>
                  {COLS.map((c) => <th key={c.k} className="px-1.5 py-1.5 text-right whitespace-nowrap">{c.t}{c.hint && <div className="font-normal text-[10px] text-gray-400">{c.hint}</div>}</th>)}
                  <th className="px-2 py-1.5 text-right">노무비 (계산)</th><th className="px-2 py-1.5">상태</th><th></th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => {
                  const r = rowOf(m), e = effRow(m), ok = !!met[m];
                  const lack = [!(e.regularHours > 0) && '정규공수', !(e.personDays > 0) && '총인원', !(e.productionAmount > 0) && '생산금액', !(laborCostOf(e) > 0) && '노무비율'].filter(Boolean);
                  return (
                    <tr key={m} className={`border-t ${draft[m] ? 'bg-amber-50/60' : ''}`}>
                      <td className="px-2 py-1 font-bold whitespace-nowrap">{monY(m)}</td>
                      {COLS.map((c) => (
                        <td key={c.k} className="px-1 py-1 text-right">
                          <NumCell v={r[c.k] as number | undefined} w={c.w} onChange={(v) => setCell(m, c.k, v)} />
                          {c.k === 'productionAmount' && !(r.productionAmount > 0) && e.productionAmount > 0 && <div className="text-[10px] text-gray-400">월 생산금액 {(e.productionAmount / 1e8).toFixed(2)}억</div>}
                        </td>
                      ))}
                      <td className="px-2 py-1 text-right text-gray-600">{laborCostOf(e) > 0 ? `${won(laborCostOf(e) / 1e4)}만` : ''}</td>
                      <td className="px-2 py-1 whitespace-nowrap">{ok ? <span className="text-emerald-700">✓ 계산됨</span> : <span className="text-amber-700">{lack.join('·')} 필요</span>}{draft[m] && <span className="ml-1 text-amber-700">· 저장 전</span>}</td>
                      <td className="px-2 py-1"><button onClick={() => removeMonth(m)} className="text-gray-400 hover:text-rose-600" title="이 달 지우기">✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 트리 설명 */}
      <details className="bg-white border border-slate-300 rounded-lg">
        <summary className="px-4 py-2.5 cursor-pointer font-bold text-sm">📖 트리 읽는 법 (11/6 회의 기준)</summary>
        <div className="px-4 pb-4 text-sm text-gray-700 space-y-2">
          <div className="font-mono text-xs bg-slate-50 border rounded p-3 leading-6 whitespace-pre-wrap">{`노무비율 = 노무비 ÷ 생산금액
 ├ 현장 노무비율 = 시간당 금액 × (1 + 연장비율) × 1인 1일 정규공수 ÷ 인당 일생산금액
 │   ├ 인당 일생산금액 = 생산금액 ÷ 총인원(연인원)          ← 높을수록 노무비율 ↓
 │   │    └ 내포장 · 전처리 · 그 외 공정 생산성 (공정별 연인원을 넣으면)
 │   ├ 1인 1일 정규공수 = 정규공수 ÷ 총인원                  ← 중도 입사·단축 근무 반영
 │   ├ 연장비율 = (연장×1.5 + 초과×2.0) ÷ 정규공수            ← 특근 포함
 │   │    └ 연장(×1.5) · 초과·휴일(×2.0)
 │   └ 시간당 금액 = 현장 노무비 ÷ 가중 총공수                ← 임금 인상·수당·도급/알바 비중
 └ 통제 밖 = 관리직 급여·퇴직급여 ÷ 생산금액                 ← 현장이 줄일 수 없는 몫`}</div>
          <ul className="list-disc pl-5 space-y-1 text-[13px]">
            <li><b>생산성은 인원 기준, 노무비율은 금액 기준</b> — 생산성이 같아도 연장근무가 많은 달(추석 9월 등)은 노무비율이 오릅니다. 그 차이가 트리의 연장·정규공수·시간당 금액 칸에 나옵니다.</li>
            <li><b>인원수가 아니라 정규공수 합계</b>로 봅니다 — 7월 말 52명·8월 말 54명이어도 중도 입사가 있으면 실제 공수가 다릅니다.</li>
            <li><b>내린 항목만 보면 금액이 안 맞습니다</b> — 다섯 칸의 몫을 더하면 노무비율 변화와 정확히 같도록 나눴습니다(로그 평균 분해). 오른 칸과 내린 칸을 같이 보세요.</li>
            <li>금액은 <b>공수 × 시간당 금액</b> — 연장 100시간이 몇 만원·몇 %p인지 「무엇을 얼마나 움직이면」에 나옵니다.</li>
            <li>시간당 금액은 노무비 ÷ 가중 공수로 거꾸로 구한 값이라, 연차수당·상여처럼 공수와 무관한 금액이 들어온 달은 이 칸이 튑니다. 그런 금액을 알면 「통제 밖」에 따로 넣으세요.</li>
          </ul>
        </div>
      </details>
    </div>
  );
}
