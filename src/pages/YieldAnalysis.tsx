/** 원재료수율 분석
 *
 *  수율 = 표준소요량 ÷ 실제 투입중량
 *    · 표준소요량 = 완제품 생산수량 × BOM 배합비   (앱이 자동 계산, 반제품은 원물로 펼침)
 *    · 실제 투입중량 = 설정 › 실제 투입중량 DB 에 월별로 입력한 값
 *  LOSS = 실제투입 − 표준소요,  LOSS율 = LOSS ÷ 실제투입 = 1 − 수율
 *
 *  반제품(순수본베이스·디포리육수)은 '반제품 펼침'으로 원물까지 분해되어 목록에서 사라지고,
 *  정제수처럼 매입이 없는 자재는 제외 키워드로 걸러낸다.
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, doc, getDoc, getDocs, onSnapshot, query, setDoc, where } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import type { AmbientEntry, Item, MachineEntry } from '../types';
import type { AmbientRecipe, Recipe } from '../lib/wasteCompute';
import { CODE_KEY_PREFIX, monthPriceKey, normalizeCode, normalizeMaterialName } from '../lib/wasteCompute';
import { canonicalShort } from '../lib/codeUtil';
import { computeMonthlyUsage } from '../lib/materialUsage';
import { expandAmbientRecipeMap, expandRecipeMap } from '../lib/bomExpansion';

const EXCLUDE_DEFAULT = ['정제수'];

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(m: string, delta: number): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const kg = (g: number) => g / 1000;
const fmt = (n: number, d = 1) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

interface RawMonth {
  entries: MachineEntry[];
  items: Item[];
  ambient: AmbientEntry[];
  logistics: Record<string, number>;
  logisticsByCode: Record<string, Record<string, number>>;
}

async function fetchMonthLogistics(month: string) {
  const [yy, mm] = month.split('-').map(Number);
  const lastDay = new Date(yy, mm, 0).getDate();
  const dates = Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const snaps = await Promise.all(dates.map((d) => getDocs(collection(db, 'days', d, 'logistics'))));
  const byDay: Record<string, number> = {};
  const byDayCode: Record<string, Record<string, number>> = {};
  snaps.forEach((s, i) => {
    if (s.empty) return;
    let sum = 0;
    const perCode: Record<string, number> = {};
    s.forEach((d) => {
      const data = d.data() as { code?: string; qty?: number };
      const q = data.qty || 0;
      sum += q;
      const k = canonicalShort(data.code || d.id);
      if (k) perCode[k] = (perCode[k] || 0) + q;
    });
    byDay[dates[i]] = sum;
    byDayCode[dates[i]] = perCode;
  });
  return { byDay, byDayCode };
}

async function fetchMonth(month: string): Promise<RawMonth> {
  const start = `${month}-01`;
  const end = `${month}-31`;
  const [ents, its, amb, log] = await Promise.all([
    getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', start), where('date', '<=', end))),
    getDocs(query(collectionGroup(db, 'items'), where('date', '>=', start), where('date', '<=', end))),
    getDocs(query(collectionGroup(db, 'ambient'), where('date', '>=', start), where('date', '<=', end))),
    fetchMonthLogistics(month),
  ]);
  const entries: MachineEntry[] = [];
  ents.forEach((d) => {
    const data = d.data() as MachineEntry;
    if (!data.machine) return;
    entries.push(data);
  });
  return {
    entries,
    items: its.docs.map((d) => d.data() as Item),
    ambient: amb.docs.map((d) => d.data() as AmbientEntry),
    logistics: log.byDay,
    logisticsByCode: log.byDayCode,
  };
}

async function fetchInputs(month: string): Promise<{ inputs: Record<string, number>; names: Record<string, string> }> {
  const snap = await getDoc(doc(db, 'materialInput', month));
  const d = snap.exists() ? (snap.data() as { inputs?: Record<string, number>; names?: Record<string, string> }) : {};
  return { inputs: d.inputs || {}, names: d.names || {} };
}

interface Row {
  key: string;
  name: string;
  code: string;
  stdG: number;        // 표준소요량 g
  actG: number;        // 실제 투입중량 g
  yield: number | null;
  lossG: number | null;
  lossRate: number | null;
  pricePerG: number;
  lossAmt: number | null;
  prevYield: number | null;
  deltaPP: number | null;   // %p
  note: string;
}

export default function YieldAnalysis() {
  const tm = thisMonth();
  const [month, setMonth] = useState(shiftMonth(tm, -1));
  const [cmpMode, setCmpMode] = useState<'yoy' | 'mom'>('yoy');
  const cmpMonth = cmpMode === 'yoy' ? shiftMonth(month, -12) : shiftMonth(month, -1);

  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cmpHasData, setCmpHasData] = useState(false);
  const [excludeText, setExcludeText] = useState(EXCLUDE_DEFAULT.join(', '));
  const [threshold, setThreshold] = useState(2);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'yield' | 'lossAmt' | 'delta' | 'std'>('lossAmt');

  // 마스터 DB
  const [recipeMap, setRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [ambientRecipeMap, setAmbientRecipeMap] = useState<Map<string, AmbientRecipe>>(new Map());
  const [subRecipeMap, setSubRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [priceMap, setPriceMap] = useState<Map<string, number>>(new Map());
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => onSnapshot(collection(db, 'recipes'), (snap) => {
    const m = new Map<string, Recipe>();
    snap.forEach((d) => { const v = d.data() as Recipe; m.set(d.id, { ...v, code: d.id }); m.set(d.id.toLowerCase(), { ...v, code: d.id }); });
    setRecipeMap(m);
  }), []);
  useEffect(() => onSnapshot(collection(db, 'subRecipes'), (snap) => {
    const m = new Map<string, Recipe>();
    snap.forEach((d) => { const v = d.data() as Recipe; m.set(d.id, { ...v, code: d.id }); m.set(d.id.toLowerCase(), { ...v, code: d.id }); });
    setSubRecipeMap(m);
  }), []);
  useEffect(() => onSnapshot(collection(db, 'ambientRecipes'), (snap) => {
    const m = new Map<string, AmbientRecipe>();
    snap.forEach((d) => { const v = d.data() as AmbientRecipe; m.set(d.id, { ...v, batchPieces: Number(v.batchPieces) || 1 }); });
    setAmbientRecipeMap(m);
  }), []);
  useEffect(() => onSnapshot(collection(db, 'materialPricesInventory'), (snap) => {
    const m = new Map<string, number>();
    snap.forEach((d) => {
      const v = d.data() as { month?: string; name?: string; code?: string; pricePerGram?: number };
      if (!v.month) return;
      const p = Number(v.pricePerGram) || 0;
      if (v.name) m.set(monthPriceKey(v.month, normalizeMaterialName(v.name)), p);
      if (v.code) m.set(monthPriceKey(v.month, CODE_KEY_PREFIX + normalizeCode(v.code)), p);
    });
    setPriceMap(m);
  }), []);
  useEffect(() => onSnapshot(doc(db, 'materialInput', month), (snap) => {
    const d = snap.exists() ? (snap.data() as { notes?: Record<string, string> }) : {};
    setNotes(d.notes || {});
  }), [month]);

  const saveNote = async (key: string, v: string) => {
    const next = { ...notes, [key]: v };
    if (!v.trim()) delete next[key];
    setNotes(next);
    await setDoc(doc(db, 'materialInput', month), { notes: next, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  };

  const excludeTerms = useMemo(
    () => excludeText.split(/[,\n]/).map((t) => normalizeMaterialName(t)).filter(Boolean),
    [excludeText],
  );

  const run = async () => {
    setRunning(true); setErr(null);
    try {
      // 반제품은 항상 원물까지 펼친다 (반제품 자체는 매입이 없어 수율 대상이 아님)
      const eff = expandRecipeMap(recipeMap, subRecipeMap);
      const effAmb = expandAmbientRecipeMap(ambientRecipeMap, subRecipeMap);

      const [raw, rawC, inp, inpC] = await Promise.all([
        fetchMonth(month), fetchMonth(cmpMonth), fetchInputs(month), fetchInputs(cmpMonth),
      ]);

      const std = computeMonthlyUsage(month, raw.entries, raw.items, raw.ambient, raw.logistics,
        eff, effAmb, priceMap, undefined, raw.logisticsByCode);
      const stdC = computeMonthlyUsage(cmpMonth, rawC.entries, rawC.items, rawC.ambient, rawC.logistics,
        eff, effAmb, priceMap, undefined, rawC.logisticsByCode);

      const stdByKey = new Map(std.rows.map((r) => [r.key, r]));
      const stdCByKey = new Map(stdC.rows.map((r) => [r.key, r]));
      setCmpHasData(Object.keys(inpC.inputs).length > 0);

      // 표준소요 또는 실투입 어느 쪽이든 값이 있는 원재료를 모두 대상으로
      const keys = new Set<string>([...stdByKey.keys(), ...Object.keys(inp.inputs)]);
      const out: Row[] = [];
      keys.forEach((k) => {
        const sr = stdByKey.get(k);
        const nm = sr?.name || inp.names[k] || k.replace(CODE_KEY_PREFIX, '');
        const n = normalizeMaterialName(nm);
        if (excludeTerms.some((t) => n.includes(t))) return;   // 정제수 등 제외

        const stdG = sr?.grams || 0;
        const actG = inp.inputs[k] || 0;
        const y = actG > 0 && stdG > 0 ? stdG / actG : null;
        const lossG = actG > 0 && stdG > 0 ? actG - stdG : null;

        // 비교월 수율
        const srC = stdCByKey.get(k);
        const actC = inpC.inputs[k] || 0;
        const py = actC > 0 && (srC?.grams || 0) > 0 ? (srC!.grams) / actC : null;

        out.push({
          key: k,
          name: nm,
          code: sr?.code || k.replace(CODE_KEY_PREFIX, ''),
          stdG, actG,
          yield: y,
          lossG,
          lossRate: lossG !== null && actG > 0 ? lossG / actG : null,
          pricePerG: sr?.pricePerGram || 0,
          lossAmt: lossG !== null ? lossG * (sr?.pricePerGram || 0) : null,
          prevYield: py,
          deltaPP: y !== null && py !== null ? (y - py) * 100 : null,
          note: '',
        });
      });
      setRows(out);
    } catch (e: any) {
      console.error('[YieldAnalysis]', e);
      setErr(e?.message || '분석 중 오류가 발생했습니다');
    } finally { setRunning(false); }
  };

  /* ===== 집계 ===== */
  const stat = useMemo(() => {
    if (!rows) return null;
    const valid = rows.filter((r) => r.yield !== null);
    const sumStd = valid.reduce((s, r) => s + r.stdG, 0);
    const sumAct = valid.reduce((s, r) => s + r.actG, 0);
    const wYield = sumAct > 0 ? sumStd / sumAct : 0;
    const prevValid = valid.filter((r) => r.prevYield !== null);
    const pStd = prevValid.reduce((s, r) => s + r.stdG, 0);
    const pAct = prevValid.reduce((s, r) => s + r.actG, 0);
    // 비교월 가중평균은 비교월 자체 값으로
    const wPrev = prevValid.length > 0
      ? prevValid.reduce((s, r) => s + (r.prevYield || 0) * r.actG, 0) / (prevValid.reduce((s, r) => s + r.actG, 0) || 1)
      : null;
    return {
      count: valid.length,
      noInput: rows.filter((r) => r.stdG > 0 && r.actG <= 0).length,
      noStd: rows.filter((r) => r.actG > 0 && r.stdG <= 0).length,
      over100: valid.filter((r) => (r.yield || 0) > 1).length,
      wYield,
      wLoss: 1 - wYield,
      wPrev,
      deltaPP: wPrev !== null ? (wYield - wPrev) * 100 : null,
      dropCount: valid.filter((r) => r.deltaPP !== null && r.deltaPP <= -threshold).length,
      lossG: sumAct - sumStd,
      lossAmt: valid.reduce((s, r) => s + (r.lossAmt || 0), 0),
      pStd, pAct,
    };
  }, [rows, threshold]);

  const topDrop = useMemo(() => (rows || [])
    .filter((r) => r.deltaPP !== null)
    .sort((a, b) => (a.deltaPP || 0) - (b.deltaPP || 0)).slice(0, 3), [rows]);
  const topLoss = useMemo(() => (rows || [])
    .filter((r) => (r.lossAmt || 0) > 0)
    .sort((a, b) => (b.lossAmt || 0) - (a.lossAmt || 0)).slice(0, 3), [rows]);

  const view = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    const f = rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q));
    const s = [...f];
    if (sortBy === 'yield') s.sort((a, b) => (a.yield ?? 9) - (b.yield ?? 9));
    else if (sortBy === 'lossAmt') s.sort((a, b) => (b.lossAmt ?? -1) - (a.lossAmt ?? -1));
    else if (sortBy === 'delta') s.sort((a, b) => (a.deltaPP ?? 999) - (b.deltaPP ?? 999));
    else s.sort((a, b) => b.stdG - a.stdG);
    return s;
  }, [rows, search, sortBy]);

  const downloadXlsx = async () => {
    if (!rows) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${month} 원재료수율`);
    ws.columns = [
      { header: '원재료', key: 'n', width: 30 },
      { header: 'ERP코드', key: 'c', width: 14 },
      { header: '② 표준소요 (kg)', key: 's', width: 16 },
      { header: '① 실제투입 (kg)', key: 'a', width: 16 },
      { header: '③ 원재료수율', key: 'y', width: 14 },
      { header: `⑥ ${cmpMonth} 수율`, key: 'p', width: 16 },
      { header: '⑦ 증감(%p)', key: 'd', width: 13 },
      { header: '④ LOSS (kg)', key: 'l', width: 14 },
      { header: '⑤ LOSS율', key: 'lr', width: 12 },
      { header: 'LOSS 금액(원)', key: 'la', width: 15 },
      { header: '원인 점검 포인트', key: 'note', width: 34 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    view.forEach((r) => {
      const row = ws.addRow({
        n: r.name, c: r.code,
        s: kg(r.stdG), a: kg(r.actG),
        y: r.yield, p: r.prevYield, d: r.deltaPP,
        l: r.lossG === null ? null : kg(r.lossG), lr: r.lossRate,
        la: r.lossAmt === null ? null : Math.round(r.lossAmt),
        note: notes[r.key] || '',
      });
      ['s', 'a', 'l'].forEach((k) => { row.getCell(k).numFmt = '#,##0.0'; });
      ['y', 'p', 'lr'].forEach((k) => { row.getCell(k).numFmt = '0.0%'; });
      row.getCell('d').numFmt = '+0.0;-0.0';
      row.getCell('la').numFmt = '#,##0';
      if (r.deltaPP !== null && r.deltaPP <= -threshold) row.getCell('d').font = { bold: true, color: { argb: 'FFC00000' } };
      if ((r.yield || 0) > 1) row.getCell('y').font = { bold: true, color: { argb: 'FFC00000' } };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const buf = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url; a.download = `원재료수율_${month}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  const pct = (v: number | null, d = 1) => (v === null ? '—' : `${fmt(v * 100, d)}%`);

  return (
    <div className="space-y-5">
      {/* 상단 바 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-gray-800 text-lg">📉 원재료수율 분석</span>
        <span className="text-gray-300">|</span>
        <span className="text-xs text-gray-500">기준월</span>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="border rounded px-2 py-1 text-sm font-bold" />
        <div className="flex rounded border overflow-hidden text-xs">
          {([['yoy', '전년동월'], ['mom', '전월']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setCmpMode(k)}
              className={`px-3 py-1 font-semibold ${cmpMode === k ? 'bg-blue-600 text-white' : 'bg-white hover:bg-gray-50'}`}>{label}</button>
          ))}
        </div>
        <span className="text-xs text-gray-400">비교: {cmpMonth}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={downloadXlsx} disabled={!rows}
            className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:bg-gray-300">📥 엑셀</button>
          <button onClick={run} disabled={running}
            className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:bg-gray-300 shadow-sm">
            {running ? '분석 중...' : '🚀 분석 시작'}
          </button>
        </div>
      </div>

      {err && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-3 text-sm">⚠️ {err}</div>}

      {/* 계산 기준 */}
      <div className="bg-slate-50 border rounded-lg p-3 text-xs text-gray-700 space-y-1">
        <div>
          <b>원재료수율 = 표준소요량 ÷ 실제 투입중량</b>
          <span className="text-gray-400 ml-2">표준소요량 = 완제품 생산수량 × BOM 배합비 · LOSS = 실제투입 − 표준소요 · LOSS율 = 1 − 수율</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <span className="font-semibold">제외 원재료</span>
          <input value={excludeText} onChange={(e) => setExcludeText(e.target.value)}
            placeholder="정제수, ..." className="border rounded px-2 py-1 w-64" />
          <span className="text-gray-400">매입이 없는 자재(정제수 등). 반제품은 원물로 자동 분해되어 목록에 안 나옵니다</span>
          <span className="ml-auto font-semibold">이상 임계</span>
          <input type="number" value={threshold} step="0.5" min="0"
            onChange={(e) => setThreshold(Number(e.target.value) || 0)} className="border rounded px-2 py-1 w-16 text-right" />
          <span className="text-gray-400">%p 이상 하락 시 이상</span>
        </div>
      </div>

      {!rows && !running && (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-16 text-center text-gray-400 text-sm">
          기준월을 선택하고 <b className="text-blue-600">🚀 분석 시작</b> 을 눌러주세요.<br />
          <span className="text-xs">실제 투입중량은 <b>설정 › ⚖️ 실제 투입중량</b> 에서 월별로 입력합니다.</span>
        </div>
      )}

      {stat && (
        <>
          {/* 경고 */}
          {(stat.noInput > 0 || stat.over100 > 0 || stat.noStd > 0 || !cmpHasData) && (
            <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-3 text-sm space-y-1">
              <div className="font-bold text-amber-900">⚠️ 데이터 점검 (STEP 03 · 배합비·마스터 정합성)</div>
              {stat.noInput > 0 && (
                <div className="text-xs text-amber-800">
                  · <b>{stat.noInput}종</b> — 표준소요는 있는데 <b>실제 투입중량 미입력</b> (수율 계산 제외됨) → 설정에서 입력해 주세요
                </div>
              )}
              {stat.noStd > 0 && (
                <div className="text-xs text-amber-800">
                  · <b>{stat.noStd}종</b> — 실제 투입은 있는데 <b>표준소요량이 0</b> (레시피 미등록 또는 코드 불일치)
                </div>
              )}
              {stat.over100 > 0 && (
                <div className="text-xs text-red-700">
                  · <b>{stat.over100}종</b> — <b>수율 100% 초과</b>. 좋은 게 아니라 데이터·BOM 오류 신호입니다 (배합비·단위·코드 매핑 확인)
                </div>
              )}
              {!cmpHasData && (
                <div className="text-xs text-amber-800">
                  · <b>{cmpMonth}</b> 실제 투입중량이 없어 <b>비교 지표(⑥⑦)를 낼 수 없습니다</b>
                  {cmpMode === 'yoy' && ' → 전월 비교로 바꾸거나, 과거 데이터를 입력해 주세요'}
                </div>
              )}
            </div>
          )}

          {/* 요약 카드 */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Card label="대상 원재료" value={`${stat.count}`} unit="종" tone="slate" />
            <Card label="가중평균 수율" value={fmt(stat.wYield * 100)} unit="%" tone="blue" big />
            <Card label="가중평균 LOSS율" value={fmt(stat.wLoss * 100)} unit="%" tone="rose" big />
            <Card label={`${cmpMode === 'yoy' ? '전년동월' : '전월'} 대비`}
              value={stat.deltaPP === null ? '—' : `${stat.deltaPP > 0 ? '+' : ''}${fmt(stat.deltaPP, 1)}`}
              unit="%p" tone={stat.deltaPP !== null && stat.deltaPP < 0 ? 'rose' : 'emerald'} />
            <Card label={`${threshold}%p 이상 하락`} value={`${stat.dropCount}`} unit="종" tone="amber" />
            <Card label="LOSS 금액" value={Math.round(stat.lossAmt).toLocaleString()} unit="원" tone="rose" />
          </div>

          {/* TOP3 두 개 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopBox title={`이상 원재료 TOP 3 · ${cmpMode === 'yoy' ? '전년동월' : '전월'} 대비 하락폭`}
              hint="작년보다 나빠진 것 — 원인 규명 대상" accent="rose">
              {topDrop.length === 0 ? <Empty text="비교 데이터가 없습니다" /> : topDrop.map((r, i) => (
                <li key={r.key} className="flex items-center gap-2 py-1">
                  <span className="text-gray-400 w-4">{i + 1}.</span>
                  <span className="flex-1 truncate">{r.name}</span>
                  <b className={(r.deltaPP || 0) < 0 ? 'text-rose-600' : 'text-emerald-600'}>
                    {(r.deltaPP || 0) > 0 ? '+' : ''}{fmt(r.deltaPP || 0, 1)} %p
                  </b>
                </li>
              ))}
            </TopBox>
            <TopBox title="LOSS 금액 TOP 3 · 개선 우선순위"
              hint="지금 제일 많이 새는 것 — 고치면 바로 돈" accent="amber">
              {topLoss.length === 0 ? <Empty text="단가가 입력되어야 계산됩니다" /> : topLoss.map((r, i) => (
                <li key={r.key} className="flex items-center gap-2 py-1">
                  <span className="text-gray-400 w-4">{i + 1}.</span>
                  <span className="flex-1 truncate">{r.name}</span>
                  <span className="text-gray-400 text-xs">{fmt(kg(r.lossG || 0))} kg</span>
                  <b className="text-amber-700 w-24 text-right">{Math.round(r.lossAmt || 0).toLocaleString()} 원</b>
                </li>
              ))}
            </TopBox>
          </div>

          {/* 표 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
              <span className="font-bold text-sm text-gray-800">월별 원재료수율 관리표</span>
              <span className="text-xs text-gray-500">{month} · {view.length}종</span>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="원재료 검색"
                className="ml-2 border rounded px-2 py-1 text-sm w-48" />
              <div className="ml-auto flex rounded border overflow-hidden text-xs">
                {([['lossAmt', 'LOSS금액순'], ['yield', '수율낮은순'], ['delta', '하락폭순'], ['std', '표준소요순']] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setSortBy(k)}
                    className={`px-2.5 py-1 font-medium ${sortBy === k ? 'bg-blue-600 text-white' : 'bg-white hover:bg-gray-50'}`}>{l}</button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-white sticky top-0 border-b text-gray-600 z-10">
                  <tr>
                    <th className="px-3 py-2 text-left">원재료</th>
                    <th className="px-2 py-2 text-right w-24">② 표준소요<br /><span className="font-normal text-gray-400">kg</span></th>
                    <th className="px-2 py-2 text-right w-24">① 실제투입<br /><span className="font-normal text-gray-400">kg</span></th>
                    <th className="px-2 py-2 text-right w-20">③ 수율</th>
                    <th className="px-2 py-2 text-right w-20">⑥ {cmpMonth.slice(2)}</th>
                    <th className="px-2 py-2 text-right w-20">⑦ 증감</th>
                    <th className="px-2 py-2 text-right w-20">④ LOSS<br /><span className="font-normal text-gray-400">kg</span></th>
                    <th className="px-2 py-2 text-right w-20">⑤ LOSS율</th>
                    <th className="px-2 py-2 text-right w-24">LOSS 금액</th>
                    <th className="px-3 py-2 text-left w-56">원인 점검 포인트</th>
                  </tr>
                </thead>
                <tbody className="divide-y tabular-nums">
                  {view.map((r) => {
                    const bad = r.deltaPP !== null && r.deltaPP <= -threshold;
                    const over = (r.yield || 0) > 1;
                    return (
                      <tr key={r.key} className={`hover:bg-slate-50 ${over ? 'bg-red-50' : bad ? 'bg-amber-50' : ''}`}>
                        <td className="px-3 py-1.5">
                          <div className="font-medium text-gray-800">{r.name}</div>
                          <div className="text-[10px] text-gray-400 font-mono">{r.code}</div>
                        </td>
                        <td className="px-2 py-1.5 text-right">{r.stdG > 0 ? fmt(kg(r.stdG)) : <span className="text-red-500">0</span>}</td>
                        <td className="px-2 py-1.5 text-right">{r.actG > 0 ? fmt(kg(r.actG)) : <span className="text-amber-600">미입력</span>}</td>
                        <td className={`px-2 py-1.5 text-right font-bold ${over ? 'text-red-600' : ''}`}>{pct(r.yield)}</td>
                        <td className="px-2 py-1.5 text-right text-gray-500">{pct(r.prevYield)}</td>
                        <td className={`px-2 py-1.5 text-right font-semibold ${r.deltaPP === null ? 'text-gray-300' : r.deltaPP < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                          {r.deltaPP === null ? '—' : `${r.deltaPP > 0 ? '+' : ''}${fmt(r.deltaPP, 1)}`}
                        </td>
                        <td className="px-2 py-1.5 text-right">{r.lossG === null ? '—' : fmt(kg(r.lossG))}</td>
                        <td className="px-2 py-1.5 text-right">{pct(r.lossRate)}</td>
                        <td className="px-2 py-1.5 text-right font-semibold text-amber-700">
                          {r.lossAmt === null ? '—' : Math.round(r.lossAmt).toLocaleString()}
                        </td>
                        <td className="px-3 py-1">
                          <input defaultValue={notes[r.key] || ''} key={`${r.key}-${notes[r.key] || ''}`}
                            onBlur={(e) => { if (e.target.value !== (notes[r.key] || '')) saveNote(r.key, e.target.value); }}
                            placeholder={over ? '데이터·BOM 확인' : bad ? '원물/공정 점검' : ''}
                            className="w-full border rounded px-2 py-1 text-xs" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 border-t bg-slate-50 text-[11px] text-gray-500">
              진단 순서 — <b>① 데이터·마스터</b>(배합비·단위·코드 매핑) → <b>② 공정</b>(전처리·잔량·재작업) → <b>③ 원물</b>(산지·계절·수분·불량률).
              수율 100% 초과는 개선이 아니라 <b className="text-red-600">데이터 오류</b> 신호입니다.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Card({ label, value, unit, tone, big }: {
  label: string; value: string; unit: string; tone: 'slate' | 'blue' | 'rose' | 'emerald' | 'amber'; big?: boolean;
}) {
  const tones: Record<string, string> = {
    slate: 'border-slate-300 text-slate-700', blue: 'border-blue-400 text-blue-700',
    rose: 'border-rose-400 text-rose-700', emerald: 'border-emerald-400 text-emerald-700',
    amber: 'border-amber-400 text-amber-700',
  };
  return (
    <div className={`bg-white border-t-4 ${tones[tone]} border rounded-lg px-3 py-2.5`}>
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`font-bold ${big ? 'text-2xl' : 'text-xl'} tabular-nums`}>
        {value}<span className="text-[11px] font-normal text-gray-400 ml-1">{unit}</span>
      </div>
    </div>
  );
}

function TopBox({ title, hint, accent, children }: {
  title: string; hint: string; accent: 'rose' | 'amber'; children: React.ReactNode;
}) {
  const c = accent === 'rose' ? 'bg-rose-600' : 'bg-amber-600';
  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className={`${c} text-white px-4 py-2`}>
        <div className="font-bold text-sm">{title}</div>
        <div className="text-[11px] opacity-90">{hint}</div>
      </div>
      <ul className="px-4 py-2 text-sm divide-y">{children}</ul>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <li className="py-3 text-center text-xs text-gray-400">{text}</li>;
}
