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
const CACHE_PREFIX = 'yieldStd:';
const TTL_PAST = 30 * 24 * 60 * 60 * 1000;   // 지난 달은 안 바뀜
const TTL_CURRENT = 5 * 60 * 1000;

interface StdRow { k: string; n: string; c: string; g: number; p: number }

function readCache(month: string): StdRow[] | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + month);
    if (!raw) return null;
    const o = JSON.parse(raw) as { ts: number; rows: StdRow[] };
    const ttl = month >= thisMonth() ? TTL_CURRENT : TTL_PAST;
    if (Date.now() - o.ts > ttl) return null;
    return o.rows;
  } catch { return null; }
}
function writeCache(month: string, rows: StdRow[]) {
  try { localStorage.setItem(CACHE_PREFIX + month, JSON.stringify({ ts: Date.now(), rows })); } catch { /* 용량 초과 */ }
}
export function clearYieldCache() {
  try {
    Object.keys(localStorage).forEach((k) => { if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k); });
  } catch { /* noop */ }
}

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

/** 그 달 표준소요량(원재료별 g) — 캐시 우선. force 면 새로 계산 */
async function stdForMonth(
  month: string,
  recipeMap: Map<string, Recipe>,
  ambientRecipeMap: Map<string, AmbientRecipe>,
  subRecipeMap: Map<string, Recipe>,
  priceMap: Map<string, number>,
  force: boolean,
): Promise<StdRow[]> {
  if (!force) {
    const c = readCache(month);
    if (c) return c;
  }
  const eff = expandRecipeMap(recipeMap, subRecipeMap);
  const effAmb = expandAmbientRecipeMap(ambientRecipeMap, subRecipeMap);
  const raw = await fetchMonth(month);
  const u = computeMonthlyUsage(month, raw.entries, raw.items, raw.ambient, raw.logistics,
    eff, effAmb, priceMap, undefined, raw.logisticsByCode);
  const rows: StdRow[] = u.rows.map((r) => ({ k: r.key, n: r.name, c: r.code || '', g: r.grams, p: r.pricePerGram }));
  writeCache(month, rows);
  return rows;
}

interface MonthStat {
  month: string;
  hasProd: boolean;     // 표준소요량(=생산+BOM)이 있나
  hasInput: boolean;    // 실투입을 입력했나
  stdKg: number;
  actKg: number;
  wYield: number | null;
}
interface TrendRow {
  key: string; name: string; code: string;
  byMonth: Record<string, number | null>;   // 월 → 지표(수율)
  avg: number | null;
  last: number | null;
  lastVsAvg: number | null;   // %p
  range: number | null;       // 최대-최소 %p
  lossAmtLast: number;
}
interface TrendResult { months: MonthStat[]; rows: TrendRow[] }

interface Row {
  key: string;
  name: string;
  code: string;
  stdG: number;        // 표준소요량 g
  actG: number;        // 실제 투입중량 g
  yield: number | null;
  lossG: number | null;
  lossRate: number | null;
  hasInput: boolean;      // 실투입을 '입력했는가' — 0 입력과 미입력은 다르다
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

  const [mode, setMode] = useState<'cmp' | 'trend'>('cmp');
  const [fromM, setFromM] = useState(() => shiftMonth(thisMonth(), -6));
  const [toM, setToM] = useState(() => shiftMonth(thisMonth(), -1));
  const [trend, setTrend] = useState<TrendResult | null>(null);
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
        const hasInput = Object.prototype.hasOwnProperty.call(inp.inputs, k);
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
          stdG, actG, hasInput,
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

  /* ===== 월별 추이 ===== */
  const runTrend = async (force = false) => {
    setRunning(true); setErr(null);
    try {
      if (fromM > toM) { setErr('시작월이 종료월보다 뒤입니다'); return; }
      const months: string[] = [];
      for (let m = fromM; m <= toM && months.length < 24; m = shiftMonth(m, 1)) months.push(m);

      const stds = await Promise.all(months.map((m) => stdForMonth(m, recipeMap, ambientRecipeMap, subRecipeMap, priceMap, force)));
      const inps = await Promise.all(months.map((m) => fetchInputs(m)));

      // 월별 상태
      const mstat: MonthStat[] = months.map((m, i) => {
        const stdMap = new Map(stds[i].map((r) => [r.k, r]));
        const inp = inps[i].inputs;
        let sStd = 0, sAct = 0;
        Object.keys(inp).forEach((k) => {
          const sr = stdMap.get(k);
          if (!sr || sr.g <= 0) return;
          const n = normalizeMaterialName(sr.n);
          if (excludeTerms.some((t) => n.includes(t))) return;
          if (!(inp[k] > 0)) return;
          sStd += sr.g; sAct += inp[k];
        });
        return {
          month: m,
          hasProd: stds[i].some((r) => r.g > 0),
          hasInput: Object.keys(inp).length > 0,
          stdKg: kg(stds[i].reduce((a, r) => a + r.g, 0)),
          actKg: kg(Object.values(inp).reduce((a: number, v) => a + (v || 0), 0)),
          wYield: sAct > 0 ? sStd / sAct : null,
        };
      });

      // 원재료별 추이
      const keys = new Set<string>();
      stds.forEach((rs) => rs.forEach((r) => { if (r.g > 0) keys.add(r.k); }));
      const nameOf = new Map<string, { n: string; c: string; p: number }>();
      stds.forEach((rs) => rs.forEach((r) => { if (!nameOf.has(r.k)) nameOf.set(r.k, { n: r.n, c: r.c, p: r.p }); }));

      const rowsT: TrendRow[] = [];
      keys.forEach((k) => {
        const meta = nameOf.get(k)!;
        const n = normalizeMaterialName(meta.n);
        if (excludeTerms.some((t) => n.includes(t))) return;
        const byMonth: Record<string, number | null> = {};
        const vals: number[] = [];
        let lossAmtLast = 0;
        months.forEach((m, i) => {
          const sr = stds[i].find((r) => r.k === k);
          const act = inps[i].inputs[k] || 0;
          const v = sr && sr.g > 0 && act > 0 ? sr.g / act : null;
          byMonth[m] = v;
          if (v !== null) vals.push(v);
          if (i === months.length - 1 && sr && act > 0) lossAmtLast = (act - sr.g) * (sr.p || 0);
        });
        if (vals.length === 0) return;
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        const last = byMonth[months[months.length - 1]];
        rowsT.push({
          key: k, name: meta.n, code: meta.c, byMonth, avg,
          last,
          lastVsAvg: last !== null ? (last - avg) * 100 : null,
          range: vals.length > 1 ? (Math.max(...vals) - Math.min(...vals)) * 100 : null,
          lossAmtLast,
        });
      });
      setTrend({ months: mstat, rows: rowsT });
    } catch (e: any) {
      console.error('[YieldTrend]', e);
      setErr(e?.message || '추이 분석 중 오류가 발생했습니다');
    } finally { setRunning(false); }
  };

  const trendView = useMemo(() => {
    if (!trend) return [];
    const q = search.trim().toLowerCase();
    return trend.rows
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
      .sort((a, b) => {
        if (sortBy === 'lossAmt') return b.lossAmtLast - a.lossAmtLast;
        if (sortBy === 'delta') return (a.lastVsAvg ?? 999) - (b.lastVsAvg ?? 999);
        if (sortBy === 'yield') return (a.last ?? 9) - (b.last ?? 9);
        return (b.range ?? -1) - (a.range ?? -1);
      });
  }, [trend, search, sortBy]);

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
      noInput: rows.filter((r) => r.stdG > 0 && !r.hasInput).length,
      zeroInput: rows.filter((r) => r.stdG > 0 && r.hasInput && r.actG <= 0).length,
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

  const downloadTrendXlsx = async () => {
    if (!trend) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${fromM}~${toM} 수율추이`);
    ws.columns = [
      { header: '원재료', key: 'n', width: 30 },
      { header: 'ERP코드', key: 'c', width: 14 },
      ...trend.months.map((m) => ({ header: m.month.slice(2), key: m.month, width: 10 })),
      { header: '평균', key: 'avg', width: 10 },
      { header: '최근-평균(%p)', key: 'lv', width: 14 },
      { header: '변동폭(%p)', key: 'rg', width: 12 },
      { header: '최근월 LOSS금액', key: 'la', width: 16 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    trendView.forEach((r) => {
      const o: Record<string, unknown> = { n: r.name, c: r.code, avg: r.avg, lv: r.lastVsAvg, rg: r.range, la: Math.round(r.lossAmtLast) };
      trend.months.forEach((m) => { o[m.month] = r.byMonth[m.month]; });
      const row = ws.addRow(o);
      trend.months.forEach((m) => { row.getCell(m.month).numFmt = '0.0%'; });
      row.getCell('avg').numFmt = '0.0%';
      row.getCell('lv').numFmt = '+0.0;-0.0';
      row.getCell('rg').numFmt = '0.0';
      row.getCell('la').numFmt = '#,##0';
      if ((r.lastVsAvg ?? 0) <= -threshold) row.getCell('lv').font = { bold: true, color: { argb: 'FFC00000' } };
    });
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
    const buf = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url; a.download = `원재료수율추이_${fromM}_${toM}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  const pct = (v: number | null, d = 1) => (v === null ? '—' : `${fmt(v * 100, d)}%`);

  return (
    <div className="space-y-5">
      {/* 상단 바 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-gray-800 text-lg">📉 원재료수율 분석</span>
        <div className="flex rounded border overflow-hidden text-xs">
          {([['cmp', '월 비교'], ['trend', '월별 추이']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
              className={`px-3 py-1.5 font-bold ${mode === k ? 'bg-slate-800 text-white' : 'bg-white hover:bg-gray-50'}`}>{label}</button>
          ))}
        </div>
        <span className="text-gray-300">|</span>
        {mode === 'cmp' ? (
          <>
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
          </>
        ) : (
          <>
            <span className="text-xs text-gray-500">기간</span>
            <input type="month" value={fromM} onChange={(e) => e.target.value && setFromM(e.target.value)}
              className="border rounded px-2 py-1 text-sm font-bold" />
            <span className="text-gray-400">~</span>
            <input type="month" value={toM} onChange={(e) => e.target.value && setToM(e.target.value)}
              className="border rounded px-2 py-1 text-sm font-bold" />
            <button onClick={() => { clearYieldCache(); runTrend(true); }} disabled={running}
              title="캐시 무시하고 다시 계산" className="px-2 py-1 text-xs rounded border hover:bg-gray-50 disabled:opacity-50">🔄</button>
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={mode === 'cmp' ? downloadXlsx : downloadTrendXlsx} disabled={mode === 'cmp' ? !rows : !trend}
            className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:bg-gray-300">📥 엑셀</button>
          <button onClick={() => (mode === 'cmp' ? run() : runTrend())} disabled={running}
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

      {mode === 'trend' && !trend && !running && (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-16 text-center text-gray-400 text-sm">
          기간을 선택하고 <b className="text-blue-600">🚀 분석 시작</b> 을 눌러주세요.<br />
          <span className="text-xs">생산 데이터와 실제 투입중량이 <b>둘 다</b> 있는 달만 수율이 계산됩니다.</span>
        </div>
      )}

      {mode === 'trend' && trend && (
        <>
          {/* 월별 데이터 점검 — 어느 달이 계산 가능한지 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-sm text-gray-800">
              📅 월별 데이터 점검
              <span className="ml-2 text-xs font-normal text-gray-500">생산 데이터와 실투입이 둘 다 있어야 수율이 나옵니다</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-white border-b text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left w-28">구분</th>
                    {trend.months.map((m) => <th key={m.month} className="px-2 py-2 text-center">{m.month.slice(2)}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y tabular-nums">
                  <tr>
                    <td className="px-3 py-1.5 font-semibold text-gray-700">생산 데이터</td>
                    {trend.months.map((m) => (
                      <td key={m.month} className={`px-2 py-1.5 text-center font-bold ${m.hasProd ? 'text-emerald-600' : 'text-red-500'}`}>
                        {m.hasProd ? 'O' : '없음'}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="px-3 py-1.5 font-semibold text-gray-700">실투입 입력</td>
                    {trend.months.map((m) => (
                      <td key={m.month} className={`px-2 py-1.5 text-center font-bold ${m.hasInput ? 'text-emerald-600' : 'text-amber-600'}`}>
                        {m.hasInput ? 'O' : '없음'}
                      </td>
                    ))}
                  </tr>
                  <tr className="bg-slate-50">
                    <td className="px-3 py-1.5 font-semibold text-gray-700">전체 수율</td>
                    {trend.months.map((m) => (
                      <td key={m.month} className={`px-2 py-1.5 text-center font-bold ${m.wYield === null ? 'text-gray-300' : 'text-blue-700'}`}>
                        {m.wYield === null ? '—' : `${fmt(m.wYield * 100)}%`}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {trend.months.some((m) => !m.hasProd || !m.hasInput) && (
              <div className="px-4 py-2 border-t bg-amber-50 text-[11px] text-amber-800">
                ⚠️ <b>없음</b> 인 달은 수율이 계산되지 않습니다 —
                생산 데이터가 없으면 그 달은 앱 도입 전이라 표준소요량을 낼 수 없고,
                실투입이 없으면 설정 › ⚖️ 실제 투입중량 에서 입력하셔야 합니다.
              </div>
            )}
          </div>

          {/* 원재료별 추이 히트맵 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
              <span className="font-bold text-sm text-gray-800">원재료별 수율 추이</span>
              <span className="text-xs text-gray-500">{trendView.length}종 · 평균 대비 편차로 음영 표시</span>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="원재료 검색"
                className="ml-2 border rounded px-2 py-1 text-sm w-44" />
              <div className="ml-auto flex rounded border overflow-hidden text-xs">
                {([['std', '변동폭순'], ['delta', '최근하락순'], ['lossAmt', 'LOSS금액순'], ['yield', '수율낮은순']] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setSortBy(k)}
                    className={`px-2.5 py-1 font-medium ${sortBy === k ? 'bg-blue-600 text-white' : 'bg-white hover:bg-gray-50'}`}>{l}</button>
                ))}
              </div>
            </div>
            <div className="overflow-auto max-h-[640px]">
              <table className="w-full text-xs">
                <thead className="bg-white sticky top-0 border-b text-gray-600 z-10">
                  <tr>
                    <th className="px-3 py-2 text-left sticky left-0 bg-white z-20 min-w-[180px]">원재료</th>
                    {trend.months.map((m) => <th key={m.month} className="px-2 py-2 text-center w-16">{m.month.slice(2)}</th>)}
                    <th className="px-2 py-2 text-center w-16 bg-slate-50">평균</th>
                    <th className="px-2 py-2 text-center w-20 bg-slate-50">최근−평균</th>
                    <th className="px-2 py-2 text-center w-16 bg-slate-50">변동폭</th>
                    <th className="px-2 py-2 text-right w-24 bg-slate-50">최근 LOSS</th>
                  </tr>
                </thead>
                <tbody className="divide-y tabular-nums">
                  {trendView.map((r) => (
                    <tr key={r.key} className="hover:bg-slate-50">
                      <td className="px-3 py-1.5 sticky left-0 bg-white">
                        <div className="font-medium text-gray-800 truncate max-w-[180px]">{r.name}</div>
                        <div className="text-[10px] text-gray-400 font-mono">{r.code}</div>
                      </td>
                      {trend.months.map((m) => {
                        const v = r.byMonth[m.month];
                        const d = v !== null && r.avg !== null ? (v - r.avg) * 100 : null;
                        const bg = d === null ? '' : d <= -threshold ? 'bg-rose-100 text-rose-800 font-bold'
                          : d >= threshold ? 'bg-violet-100 text-violet-800 font-bold' : '';
                        return (
                          <td key={m.month} className={`px-2 py-1.5 text-center ${bg}`}
                            title={d === null ? '' : `평균 대비 ${d > 0 ? '+' : ''}${fmt(d, 1)}%p`}>
                            {v === null ? <span className="text-gray-300">—</span> : fmt(v * 100)}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1.5 text-center bg-slate-50 font-semibold">{pct(r.avg)}</td>
                      <td className={`px-2 py-1.5 text-center bg-slate-50 font-bold ${r.lastVsAvg === null ? 'text-gray-300' : r.lastVsAvg <= -threshold ? 'text-rose-600' : r.lastVsAvg >= threshold ? 'text-violet-700' : 'text-gray-500'}`}>
                        {r.lastVsAvg === null ? '—' : `${r.lastVsAvg > 0 ? '+' : ''}${fmt(r.lastVsAvg, 1)}`}
                      </td>
                      <td className="px-2 py-1.5 text-center bg-slate-50 text-gray-600">{r.range === null ? '—' : fmt(r.range, 1)}</td>
                      <td className="px-2 py-1.5 text-right bg-slate-50 font-semibold text-amber-700">
                        {r.lossAmtLast > 0 ? Math.round(r.lossAmtLast).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 border-t bg-slate-50 text-[11px] text-gray-500">
              절대값이 100%가 아니어도 됩니다 — BOM 기준과 매입 기준이 다르면 원재료마다 고유한 기준선이 생깁니다.
              <b className="text-rose-600 ml-1">붉은 칸</b>(평균보다 {threshold}%p 이상 낮음) = 그 달에 표준보다 더 씀,
              <b className="text-violet-700 ml-1">보라 칸</b> = 덜 씀. <b>변동폭이 큰 원재료부터</b> 보세요.
            </div>
          </div>
        </>
      )}

      {mode === 'cmp' && !rows && !running && (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-16 text-center text-gray-400 text-sm">
          기준월을 선택하고 <b className="text-blue-600">🚀 분석 시작</b> 을 눌러주세요.<br />
          <span className="text-xs">실제 투입중량은 <b>설정 › ⚖️ 실제 투입중량</b> 에서 월별로 입력합니다.</span>
        </div>
      )}

      {mode === 'cmp' && stat && (
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
              {stat.zeroInput > 0 && (
                <div className="text-xs text-amber-800">
                  · <b>{stat.zeroInput}종</b> — 실투입 <b>0 으로 입력</b>됨 (그 달 미사용). 표준소요가 있다면 레시피·생산 데이터를 확인해 주세요
                </div>
              )}
              {stat.noStd > 0 && (
                <div className="text-xs text-amber-800">
                  · <b>{stat.noStd}종</b> — 실제 투입은 있는데 <b>표준소요량이 0</b> (레시피 미등록 또는 코드 불일치)
                </div>
              )}
              {stat.over100 > 0 && (
                <div className="text-xs text-amber-800">
                  · <b>{stat.over100}종</b> — <b>수율 100% 초과</b> · 확인 필요.
                  BOM 기준과 매입 기준이 다르면(예: 불린 쌀로 등록 / 건조 쌀로 매입) 정상적으로 100%를 넘습니다.
                  이런 원재료는 <b>절대값보다 전월·전년 대비 증감</b>으로 보세요. 갑자기 넘기 시작했다면 배합비·단위·코드 매핑을 확인해야 합니다.
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
                      <tr key={r.key} className={`hover:bg-slate-50 ${over ? 'bg-violet-50' : bad ? 'bg-amber-50' : ''}`}>
                        <td className="px-3 py-1.5">
                          <div className="font-medium text-gray-800">{r.name}</div>
                          <div className="text-[10px] text-gray-400 font-mono">{r.code}</div>
                        </td>
                        <td className="px-2 py-1.5 text-right">{r.stdG > 0 ? fmt(kg(r.stdG)) : <span className="text-red-500">0</span>}</td>
                        <td className="px-2 py-1.5 text-right">
                          {r.actG > 0 ? fmt(kg(r.actG))
                            : r.hasInput ? <span className="text-gray-400">0</span>
                              : <span className="text-amber-600">미입력</span>}
                        </td>
                        <td className={`px-2 py-1.5 text-right font-bold ${over ? 'text-violet-700' : ''}`}
                          title={over ? 'BOM 기준과 매입 기준이 다르면 정상적으로 100%를 넘습니다. 증감(%p)으로 보세요' : undefined}>
                          {pct(r.yield)}{over && ' *'}
                        </td>
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
                            placeholder={over ? '기준 확인 (불린/건조 등)' : bad ? '원물/공정 점검' : ''}
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
              <b className="text-violet-700">*</b> 수율 100% 초과 — BOM 기준(불린 쌀 등)과 매입 기준(건조 쌀)이 다르면 정상입니다.
              그런 원재료는 절대값이 아니라 <b>증감(%p)</b> 으로 판단하세요.
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
