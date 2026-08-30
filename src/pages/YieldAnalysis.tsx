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
import type { CategoryDoc } from '../lib/materialCategory';
import { UNCLASSIFIED, buildCategoryIndex, categoryOf, sortCategories } from '../lib/materialCategory';
import { computeMonthlyUsage } from '../lib/materialUsage';
import { computeMonthlyProduction } from '../lib/monthlyProduction';
import { expandAmbientRecipeMap, expandRecipeMap } from '../lib/bomExpansion';

const EXCLUDE_DEFAULT = ['정제수'];
// 레시피 소스(분석용 DB)가 도입되면서 기준이 바뀌므로 버전을 올린다.
// 키에 소스를 넣어 '분석용/현장 BOM' 값이 서로 덮어쓰지 않게 한다.
const CACHE_PREFIX = 'yieldStd3:';
const TTL_PAST = 30 * 24 * 60 * 60 * 1000;   // 지난 달은 안 바뀜
const TTL_CURRENT = 5 * 60 * 1000;

interface StdRow { k: string; n: string; c: string; g: number; p: number }
interface MonthStd { rows: StdRow[]; cold: number; ambient: number; total: number }
/** 수율이 이 범위를 벗어나면 데이터 이상으로 보고 TOP3 에서 제외 */
const RANGE_LO = 0.2;
const RANGE_HI = 2.0;
/** 수율이 정상 범위인가 (데이터 이상 격리용) — 화면·엑셀·추이 전부 이 기준 하나만 쓴다 */
const inRangeV = (v: number | null | undefined): v is number => v !== null && v !== undefined && v >= RANGE_LO && v <= RANGE_HI;

function readCache(ck: string, month: string): MonthStd | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + ck);
    if (!raw) return null;
    const o = JSON.parse(raw) as { ts: number; v: MonthStd; partial?: boolean };
    // 진행 중이던 달에 저장한 캐시는 그 달이 지나도 '부분 데이터' 다.
    // 쓴 시점 기준으로 판단하지 않으면 미완성 월이 다음 달에 30일짜리로 굳어버린다.
    if (o.partial && month < thisMonth()) return null;
    const ttl = month >= thisMonth() ? TTL_CURRENT : TTL_PAST;
    if (Date.now() - o.ts > ttl) return null;
    return o.v;
  } catch { return null; }
}
function writeCache(ck: string, month: string, v: MonthStd) {
  try {
    localStorage.setItem(CACHE_PREFIX + ck,
      JSON.stringify({ ts: Date.now(), v, partial: month >= thisMonth() }));
  } catch { /* 용량 초과 */ }
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
  srcTag: string,
): Promise<MonthStd> {
  const ck = `${srcTag}:${month}`;
  if (!force) {
    const c = readCache(ck, month);
    if (c) return c;
  }
  const eff = expandRecipeMap(recipeMap, subRecipeMap);
  const effAmb = expandAmbientRecipeMap(ambientRecipeMap, subRecipeMap);
  const raw = await fetchMonth(month);
  const u = computeMonthlyUsage(month, raw.entries, raw.items, raw.ambient, raw.logistics,
    eff, effAmb, priceMap, undefined, raw.logisticsByCode);
  // 월별현황과 대조할 수 있도록 생산량도 같은 원천으로 계산해 둔다
  const prod = computeMonthlyProduction(raw.entries, raw.items, raw.ambient, raw.logistics, raw.logisticsByCode);
  const v: MonthStd = {
    rows: u.rows.map((r) => ({ k: r.key, n: r.name, c: r.code || '', g: r.grams, p: r.pricePerGram })),
    cold: prod.coldTotal, ambient: prod.ambientTotal, total: prod.total,
  };
  writeCache(ck, month, v);
  return v;
}

interface MonthStat {
  month: string;
  hasProd: boolean;     // 표준소요량(=생산+BOM)이 있나
  hasInput: boolean;    // 실투입을 입력했나
  stdKg: number;
  actKg: number;
  wYield: number | null;
  wCommon: number | null;   // 전 기간 계산 가능한 원재료만으로 낸 수율 (월 간 비교용)
  cold: number; ambient: number; total: number;   // 생산량 (월별현황 대조용)
}
interface TrendRow {
  key: string; name: string; code: string;
  byMonth: Record<string, number | null>;   // 월 → 지표(수율)
  avg: number | null;         // 전체 평균 (기준선)
  prevAvg: number | null;     // 최근월을 뺀 이전 평균
  last: number | null;
  lastVsAvg: number | null;   // 최근 − 이전평균 (%p)
  months: number;             // 통계에 쓴 달 수 (이상치 제외)
  outMonths: number;          // 이상치로 통계에서 뺀 달 수
  range: number | null;       // 최대-최소 %p
  lossAmtLast: number;
}
interface CatTrendRow {
  name: string;
  byMonth: Record<string, number | null>;   // 월 → 그 분류의 가중 수율
  count: number;            // 최근월 집계 종수
  last: number | null;
  prevAvg: number | null;   // 최근월을 뺀 이전 평균
  lastVsAvg: number | null; // %p
  lossAmtLast: number;      // 최근월 LOSS 금액
  impactAmt: number;        // 최근월 악화 영향액 (이전평균 대비)
  actAmtLast: number;
}
interface TrendResult {
  months: MonthStat[]; rows: TrendRow[]; commonCount: number; outCount: number;
  cats: CatTrendRow[];
}

/** 실투입 키를 표준소요 키에 맞춰 재매핑.
 *  BOM 에 코드가 없는 원재료인데 실투입엔 코드를 넣었거나(그 반대) 하면 같은 원재료가
 *  두 키로 갈라져 '표준소요 0' + '실투입 미입력' 두 행이 되어버린다. 이름으로 2차 매칭한다.
 *
 *  ⚠ stdRows 는 반드시 '비교 대상 전 기간의 표준소요 행 합집합' 을 넘겨야 한다.
 *     한 달 것만 넘기면 그 달 생산 믹스에 따라 매칭 여부가 달라져(이름이 유일했다가 중복이 됨)
 *     두 달의 분모가 서로 다른 규칙으로 만들어지고, 증감(%p)이 수율이 아니라 매핑 변화를 재게 된다. */
function remapInputs(
  stdRows: { key: string; name: string }[],
  inputs: Record<string, number>,
  names: Record<string, string>,
): { byStdKey: Record<string, number>; remapped: string[] } {
  // 같은 키가 여러 번 들어와도 1건으로 센다 (여러 달 행을 합쳐서 넘기므로 필수)
  const uniq = new Map<string, string>();     // 표준 키 → 이름
  stdRows.forEach((r) => { if (r.key && !uniq.has(r.key)) uniq.set(r.key, r.name); });
  const stdKeys = new Set(uniq.keys());
  // 같은 이름에 코드가 여러 개인 원재료가 실제로 있다(한우(익,민찌) → 11320010/11/12).
  // 이름이 유일할 때만 매칭한다. 중복이면 엉뚱한 코드에 붙어 조용히 틀린다.
  const nameCount = new Map<string, number>();
  uniq.forEach((nm) => {
    const n = normalizeMaterialName(nm);
    if (n) nameCount.set(n, (nameCount.get(n) || 0) + 1);
  });
  const byName = new Map<string, string>();   // 정규화 이름 → 표준 키 (유일한 것만)
  uniq.forEach((nm, key) => {
    const n = normalizeMaterialName(nm);
    if (n && nameCount.get(n) === 1 && !byName.has(n)) byName.set(n, key);
  });
  const byStdKey: Record<string, number> = {};
  const remapped: string[] = [];
  Object.entries(inputs).forEach(([k, g]) => {
    let rk = k;
    if (!stdKeys.has(k)) {
      const nm = names[k];
      const hit = (nm && byName.get(normalizeMaterialName(nm)))
        || (!k.startsWith(CODE_KEY_PREFIX) ? byName.get(k) : undefined);
      if (hit) { rk = hit; remapped.push(nm || k); }
    }
    byStdKey[rk] = (byStdKey[rk] ?? 0) + g;
  });
  return { byStdKey, remapped };
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
  hasInput: boolean;      // 실투입을 '입력했는가' — 0 입력과 미입력은 다르다
  pricePerG: number;
  lossAmt: number | null;
  prevYield: number | null;
  prevStdG: number;
  prevActG: number;
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
  const [coverage, setCoverage] = useState<{ pct: number; missingQty: number; totalQty: number; missingCold: number; missingAmbient: number } | null>(null);
  const [catSort, setCatSort] = useState<'impact' | 'loss' | 'delta' | 'yield' | 'name'>('impact');
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [cmpDiag, setCmpDiag] = useState<{ hasInput: boolean; qty: number; baseQty: number; partial: boolean }>(
    { hasInput: false, qty: 0, baseQty: 0, partial: false });
  const cmpHasData = cmpDiag.hasInput && cmpDiag.qty > 0;
  const [remapCount, setRemapCount] = useState(0);
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
  // 분석용(수율 전용) 레시피 — 비어 있으면 현장 BOM 으로 폴백한다
  const [yRecipeMap, setYRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [ySubMap, setYSubMap] = useState<Map<string, Recipe>>(new Map());
  const [yAmbientMap, setYAmbientMap] = useState<Map<string, AmbientRecipe>>(new Map());
  useEffect(() => onSnapshot(collection(db, 'recipesYield'), (snap) => {
    const m = new Map<string, Recipe>();
    snap.forEach((d) => { const v = d.data() as Recipe; m.set(d.id, { ...v, code: d.id }); m.set(d.id.toLowerCase(), { ...v, code: d.id }); });
    setYRecipeMap(m);
  }, () => {}), []);
  useEffect(() => onSnapshot(collection(db, 'subRecipesYield'), (snap) => {
    const m = new Map<string, Recipe>();
    snap.forEach((d) => { const v = d.data() as Recipe; m.set(d.id, { ...v, code: d.id }); m.set(d.id.toLowerCase(), { ...v, code: d.id }); });
    setYSubMap(m);
  }, () => {}), []);
  useEffect(() => onSnapshot(collection(db, 'ambientRecipesYield'), (snap) => {
    const m = new Map<string, AmbientRecipe>();
    snap.forEach((d) => { const v = d.data() as AmbientRecipe; m.set(d.id, { ...v, batchPieces: Number(v.batchPieces) || 1 }); });
    setYAmbientMap(m);
  }, () => {}), []);

  // 원재료 카테고리
  const [catDocs, setCatDocs] = useState<CategoryDoc[]>([]);
  useEffect(() => onSnapshot(collection(db, 'materialCategories'), (snap) => {
    const list: CategoryDoc[] = [];
    snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<CategoryDoc, 'id'>) }));
    setCatDocs(list);
  }, () => {}), []);
  const catIndex = useMemo(() => buildCategoryIndex(catDocs), [catDocs]);

  // 실제로 쓸 레시피 소스 — 분석용이 비어 있으면 현장 BOM
  const useYieldDb = yRecipeMap.size > 0;
  const srcRecipe = useYieldDb ? yRecipeMap : recipeMap;
  const srcSub = useYieldDb && ySubMap.size > 0 ? ySubMap : subRecipeMap;
  const srcAmbient = useYieldDb && yAmbientMap.size > 0 ? yAmbientMap : ambientRecipeMap;
  const srcTag = useYieldDb ? 'yield' : 'bom';
  // recipeMap 은 'A01' 과 'a01' 을 둘 다 등록하므로 size 를 그대로 쓰면 품목 수가 2배로 보인다
  const yRecipeCount = useMemo(() => {
    const s2 = new Set<string>();
    yRecipeMap.forEach((r) => { const k = canonicalShort(r.code || ''); if (k) s2.add(k); });
    return s2.size;
  }, [yRecipeMap]);

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
      const eff = expandRecipeMap(srcRecipe, srcSub);
      const effAmb = expandAmbientRecipeMap(srcAmbient, srcSub);

      const [raw, rawC, inp, inpC] = await Promise.all([
        fetchMonth(month), fetchMonth(cmpMonth), fetchInputs(month), fetchInputs(cmpMonth),
      ]);

      const std = computeMonthlyUsage(month, raw.entries, raw.items, raw.ambient, raw.logistics,
        eff, effAmb, priceMap, undefined, raw.logisticsByCode);
      const stdC = computeMonthlyUsage(cmpMonth, rawC.entries, rawC.items, rawC.ambient, rawC.logistics,
        eff, effAmb, priceMap, undefined, rawC.logisticsByCode);

      const stdByKey = new Map(std.rows.map((r) => [r.key, r]));
      const stdCByKey = new Map(stdC.rows.map((r) => [r.key, r]));

      // 비교월을 쓸 수 있는지 판정.
      // 실투입만 보면 안 된다 — 앱 도입 전이라 '생산 데이터가 없는 달' 도 ERP 수불로
      // 실투입만 채워 넣을 수 있고, 그러면 표준소요가 0/과소라 수율이 통째로 낮게 나온다.
      // 그 값이 20~200% 안에 들어오면 정상값으로 섞여 '수율효과' 카드에 허위 개선이 찍힌다.
      setCoverage({
        pct: std.coverage?.coveredPct ?? 100,
        missingQty: std.coverage?.missingQty || 0,
        totalQty: std.coverage?.totalQty || 0,
        missingCold: std.missingColdCodes?.length || 0,
        missingAmbient: std.missingAmbientNames?.length || 0,
      });
      const cmpQty = stdC.coverage?.totalQty || 0;
      const baseQty = std.coverage?.totalQty || 0;
      const cmpUsable = Object.keys(inpC.inputs).length > 0 && cmpQty > 0;
      setCmpDiag({
        hasInput: Object.keys(inpC.inputs).length > 0,
        qty: cmpQty,
        baseQty,
        // 생산량이 기준월의 70% 에 못 미치면 '그 달 데이터가 덜 쌓인' 것으로 보고 경고
        partial: cmpUsable && baseQty > 0 && cmpQty < baseQty * 0.7,
      });

      // 실투입 키를 표준소요 키에 맞춘다 (코드↔이름 불일치로 갈라지는 것 방지)
      // 두 달의 표준소요 행을 '합쳐서' 넘겨야 매핑 규칙이 월에 무관하게 같아진다.
      const unionRows = [...std.rows, ...stdC.rows].map((r) => ({ key: r.key, name: r.name }));
      const mapped = remapInputs(unionRows, inp.inputs, inp.names);
      const mappedC = remapInputs(unionRows, inpC.inputs, inpC.names);
      setRemapCount(new Set(mapped.remapped).size);
      const inpNow = mapped.byStdKey;
      const inpPrev = mappedC.byStdKey;

      // 표준소요 또는 실투입 어느 쪽이든 값이 있는 원재료를 모두 대상으로
      const keys = new Set<string>([...stdByKey.keys(), ...Object.keys(inpNow)]);
      const out: Row[] = [];
      keys.forEach((k) => {
        const sr = stdByKey.get(k);
        const nm = sr?.name || inp.names[k] || k.replace(CODE_KEY_PREFIX, '');
        const n = normalizeMaterialName(nm);
        if (excludeTerms.some((t) => n.includes(t))) return;   // 정제수 등 제외

        const stdG = sr?.grams || 0;
        const hasInput = Object.prototype.hasOwnProperty.call(inpNow, k);
        const actG = inpNow[k] || 0;
        const y = actG > 0 && stdG > 0 ? stdG / actG : null;
        const lossG = actG > 0 && stdG > 0 ? actG - stdG : null;

        // 비교월 수율
        const srC = stdCByKey.get(k);
        const actC = cmpUsable ? (inpPrev[k] || 0) : 0;
        const pStd = cmpUsable ? (srC?.grams || 0) : 0;
        const py = actC > 0 && pStd > 0 ? pStd / actC : null;

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
          prevStdG: pStd,
          prevActG: actC,
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
      if (months.length === 24 && months[23] < toM) {
        setErr(`기간이 24개월을 넘어 ${months[0]} ~ ${months[23]} 까지만 계산했습니다`);
      }

      const stds = await Promise.all(months.map((m) => stdForMonth(m, srcRecipe, srcAmbient, srcSub, priceMap, force, srcTag)));
      const inpsRaw = await Promise.all(months.map((m) => fetchInputs(m)));
      // 매핑 규칙은 전 기간 합집합으로 한 번만 만든다 (월마다 다르면 추이가 흔들린다)
      const unionRows = stds.flatMap((v) => v.rows.map((r) => ({ key: r.k, name: r.n })));
      const inps = inpsRaw.map((x) => ({
        inputs: remapInputs(unionRows, x.inputs, x.names).byStdKey,
        names: x.names,
      }));

      // 월별 상태
      const mstat: MonthStat[] = months.map((m, i) => {
        const stdMap = new Map(stds[i].rows.map((r) => [r.k, r]));
        const inp = inps[i].inputs;
        let sStd = 0, sAct = 0;
        Object.keys(inp).forEach((k) => {
          const sr = stdMap.get(k);
          if (!sr || sr.g <= 0) return;
          const n = normalizeMaterialName(sr.n);
          if (excludeTerms.some((t) => n.includes(t))) return;
          if (!(inp[k] > 0)) return;
          if (!inRangeV(sr.g / inp[k])) return;   // 데이터 이상 제외
          sStd += sr.g; sAct += inp[k];
        });
        return {
          month: m,
          hasProd: stds[i].total > 0,
          hasInput: Object.keys(inp).length > 0,
          stdKg: kg(stds[i].rows.reduce((a, r) => a + r.g, 0)),
          actKg: kg(Object.values(inp).reduce((a: number, v) => a + (v || 0), 0)),
          wYield: sAct > 0 ? sStd / sAct : null,
          wCommon: null,
          cold: stds[i].cold, ambient: stds[i].ambient, total: stds[i].total,
        };
      });

      // 원재료별 추이
      const keys = new Set<string>();
      stds.forEach((v) => v.rows.forEach((r) => { if (r.g > 0) keys.add(r.k); }));
      const nameOf = new Map<string, { n: string; c: string; p: number }>();
      stds.forEach((v) => v.rows.forEach((r) => { if (!nameOf.has(r.k)) nameOf.set(r.k, { n: r.n, c: r.c, p: r.p }); }));

      const rowsT: TrendRow[] = [];
      keys.forEach((k) => {
        const meta = nameOf.get(k)!;
        const n = normalizeMaterialName(meta.n);
        if (excludeTerms.some((t) => n.includes(t))) return;
        const byMonth: Record<string, number | null> = {};
        const vals: number[] = [];      // 통계용 — 이상치(20~200% 밖) 제외
        let anyVal = false;
        let outMonths = 0;
        let lossAmtLast = 0;
        months.forEach((m, i) => {
          const sr = stds[i].rows.find((r) => r.k === k);
          const act = inps[i].inputs[k] || 0;
          const v = sr && sr.g > 0 && act > 0 ? sr.g / act : null;
          byMonth[m] = v;              // 표시용은 원값 그대로 (점검하려면 보여야 한다)
          if (v !== null) {
            anyVal = true;
            if (inRangeV(v)) vals.push(v); else outMonths++;
          }
          if (i === months.length - 1 && sr && act > 0) lossAmtLast = (act - sr.g) * (sr.p || 0);
        });
        if (!anyVal) return;
        // 평균·변동폭·증감은 전부 이상치를 뺀 값으로 낸다.
        // (한 달 자릿수 오입력이 그 원재료의 평균·이전평균·변동폭을 통째로 왜곡하는 것 방지)
        const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        const lastRaw = byMonth[months[months.length - 1]];
        const last = inRangeV(lastRaw) ? lastRaw : null;
        // 최근월을 뺀 '이전 평균' 과 비교해야 변화폭이 축소되지 않는다.
        // (평균에 최근월이 섞이면 2개월일 때 하락폭이 정확히 절반으로 보인다)
        const prior = months.slice(0, -1).map((m) => byMonth[m]).filter(inRangeV);
        const prevAvg = prior.length > 0 ? prior.reduce((a, b) => a + b, 0) / prior.length : null;
        rowsT.push({
          key: k, name: meta.n, code: meta.c, byMonth, avg, prevAvg,
          last,
          // 비교할 이전 데이터가 없으면(값이 최근월 하나뿐) 판단 불가 → null
          lastVsAvg: last !== null && prevAvg !== null ? (last - prevAvg) * 100 : null,
          range: vals.length > 1 ? (Math.max(...vals) - Math.min(...vals)) * 100 : null,
          months: vals.length,
          outMonths,
          lossAmtLast,
        });
      });
      // 전 기간 내내 계산 가능한 원재료만 골라 '공통 기준 수율' 을 낸다.
      // 달마다 모수가 달라지면 월 간 비교가 엄밀하지 않기 때문.
      // 한 달이라도 이상치인 원재료는 통째로 뺀다.
      // (넣으면 '전체 수율' 행은 그 달을 빼고 '공통 기준 수율' 행은 넣어 같은 표의 두 행이 어긋난다)
      const commonKeys = rowsT
        .filter((r) => months.every((m) => inRangeV(r.byMonth[m])))
        .map((r) => r.key);
      const commonSet = new Set(commonKeys);
      months.forEach((_m, i) => {
        const stdMap = new Map(stds[i].rows.map((r) => [r.k, r]));
        let cs = 0, ca = 0;
        commonSet.forEach((k) => {
          const sr = stdMap.get(k);
          const act = inps[i].inputs[k] || 0;
          if (!sr || sr.g <= 0 || act <= 0) return;
          if (!inRangeV(sr.g / act)) return;
          cs += sr.g; ca += act;
        });
        mstat[i].wCommon = ca > 0 ? cs / ca : null;
      });

      /* ===== 카테고리별 월별 추이 =====
         추이 모드는 이미 전 기간 표준소요·실투입을 다 불러왔으므로
         분류별 집계는 추가 읽기 없이 그대로 낼 수 있다.
         월 비교 화면과 같은 규칙: 가중평균(Σ표준÷Σ실투입) + 이상치 제외. */
      const catAgg = new Map<string, {
        byMonth: Record<string, { s: number; a: number; amt: number; n: number }>;
      }>();
      months.forEach((m, i) => {
        const inp = inps[i].inputs;
        stds[i].rows.forEach((r) => {
          const n = normalizeMaterialName(r.n);
          if (excludeTerms.some((t) => n.includes(t))) return;
          const act = inp[r.k] || 0;
          if (!(r.g > 0) || !(act > 0)) return;
          if (!inRangeV(r.g / act)) return;
          const cat = categoryOf(catIndex, r.c || '', r.n);
          let e = catAgg.get(cat);
          if (!e) { e = { byMonth: {} }; catAgg.set(cat, e); }
          if (!e.byMonth[m]) e.byMonth[m] = { s: 0, a: 0, amt: 0, n: 0 };
          const b = e.byMonth[m];
          b.s += r.g; b.a += act; b.amt += act * (r.p || 0); b.n++;
        });
      });
      const lastM = months[months.length - 1];
      const catRows: CatTrendRow[] = [...catAgg.entries()].map(([name, e]) => {
        const byMonth: Record<string, number | null> = {};
        months.forEach((m) => {
          const b = e.byMonth[m];
          byMonth[m] = b && b.a > 0 ? b.s / b.a : null;
        });
        const last = byMonth[lastM];
        const prior = months.slice(0, -1).map((m) => byMonth[m]).filter((v): v is number => v !== null);
        const prevAvg = prior.length > 0 ? prior.reduce((x, y) => x + y, 0) / prior.length : null;
        const lastVsAvg = last !== null && prevAvg !== null ? (last - prevAvg) * 100 : null;
        const lb = e.byMonth[lastM];
        return {
          name, byMonth,
          count: lb?.n || 0,
          last, prevAvg, lastVsAvg,
          lossAmtLast: lb ? (lb.a - lb.s) * (lb.amt > 0 && lb.a > 0 ? lb.amt / lb.a : 0) : 0,
          actAmtLast: lb?.amt || 0,
          impactAmt: lastVsAvg !== null && lastVsAvg < 0 ? (-lastVsAvg / 100) * (lb?.amt || 0) : 0,
        };
      });
      const catOrder = sortCategories(catIndex, catRows.map((c) => c.name));
      const catRank = new Map(catOrder.map((n, i) => [n, i]));
      catRows.sort((a, b) => {
        if (a.name === UNCLASSIFIED) return 1;
        if (b.name === UNCLASSIFIED) return -1;
        return b.impactAmt - a.impactAmt
          || (a.lastVsAvg ?? 999) - (b.lastVsAvg ?? 999)
          || (catRank.get(a.name) ?? 999) - (catRank.get(b.name) ?? 999);
      });

      setTrend({
        months: mstat, rows: rowsT, commonCount: commonSet.size,
        outCount: rowsT.filter((r) => r.outMonths > 0).length,
        cats: catRows,
      });
    } catch (e: any) {
      console.error('[YieldTrend]', e);
      setErr(e?.message || '추이 분석 중 오류가 발생했습니다');
    } finally { setRunning(false); }
  };

  const trendView = useMemo(() => {
    if (!trend) return [];
    const q = search.trim().toLowerCase();
    return trend.rows
      // 카테고리 타일을 누르면 히트맵도 그 분류만 남는다 (타일 → 상세의 흐름)
      .filter((r) => !openCat || categoryOf(catIndex, r.code, r.name) === openCat)
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
      .sort((a, b) => {
        if (sortBy === 'lossAmt') return b.lossAmtLast - a.lossAmtLast;
        if (sortBy === 'delta') return (a.lastVsAvg ?? 999) - (b.lastVsAvg ?? 999);
        if (sortBy === 'yield') return (a.last ?? 9) - (b.last ?? 9);
        return (b.range ?? -1) - (a.range ?? -1);
      });
  }, [trend, search, sortBy, openCat, catIndex]);

  /* ===== 집계 ===== */
  const stat = useMemo(() => {
    if (!rows) return null;
    // 데이터 이상(범위 밖)은 집계에서 제외해야 가중평균·증감이 오염되지 않는다
    const valid = rows.filter((r) => r.yield !== null && r.yield >= RANGE_LO && r.yield <= RANGE_HI);
    const sumStd = valid.reduce((s, r) => s + r.stdG, 0);
    const sumAct = valid.reduce((s, r) => s + r.actG, 0);
    const wYield = sumAct > 0 ? sumStd / sumAct : null;
    // 두 달 모두 정상 범위인 원재료만으로 비교해야 like-for-like 가 된다
    const prevValid = valid.filter((r) => r.prevYield !== null && r.prevYield >= RANGE_LO && r.prevYield <= RANGE_HI);
    const cStd = prevValid.reduce((s2, r) => s2 + r.stdG, 0);
    const cAct = prevValid.reduce((s2, r) => s2 + r.actG, 0);
    const pStd = prevValid.reduce((s2, r) => s2 + r.prevStdG, 0);
    const pAct = prevValid.reduce((s2, r) => s2 + r.prevActG, 0);
    const wCur = cAct > 0 ? cStd / cAct : null;          // 당월 (비교 가능 집합)
    const wPrevRaw = pAct > 0 ? pStd / pAct : null;      // 비교월 자체 가중
    // 원재료마다 기준선이 달라(멥쌀 120% / 채소 80%) 각 달의 자기 가중으로 비교하면
    // 수율이 하나도 안 변해도 '배합 비중'만 바뀌어 증감이 생긴다(믹스 효과).
    // → 비교월 수율을 '당월 가중치'로 재평가해 순수 수율효과만 남긴다.
    const wPrevAdj = cAct > 0
      ? prevValid.reduce((s2, r) => s2 + (r.prevYield || 0) * r.actG, 0) / cAct
      : null;
    const yieldEff = wCur !== null && wPrevAdj !== null ? (wCur - wPrevAdj) * 100 : null;   // 수율효과
    const mixEff = wPrevAdj !== null && wPrevRaw !== null ? (wPrevAdj - wPrevRaw) * 100 : null; // 배합효과
    return {
      count: valid.length,
      excluded: rows.filter((r) => r.yield !== null && (r.yield < RANGE_LO || r.yield > RANGE_HI)).length,
      noInput: rows.filter((r) => r.stdG > 0 && !r.hasInput).length,
      zeroInput: rows.filter((r) => r.stdG > 0 && r.hasInput && r.actG <= 0).length,
      noStd: rows.filter((r) => r.actG > 0 && r.stdG <= 0).length,
      over100: valid.filter((r) => (r.yield || 0) > 1).length,
      wYield,
      wLoss: wYield === null ? null : 1 - wYield,
      wPrev: wPrevRaw,
      wCur,
      wPrevAdj,
      cmpCount: prevValid.length,
      yieldEff,
      mixEff,
      // 대표 지표는 '순수 수율 변화' 로 한다 (배합 이동은 따로 보여준다)
      deltaPP: yieldEff,
      // TOP3 와 같은 규칙(두 달 모두 정상 범위)이어야 종수와 목록이 어긋나지 않는다
      dropCount: prevValid.filter((r) => r.deltaPP !== null && r.deltaPP <= -threshold).length,
      lossG: sumAct - sumStd,
      lossAmt: valid.reduce((s, r) => s + (r.lossAmt || 0), 0),
      pStd, pAct, cStd, cAct,
    };
  }, [rows, threshold]);

  /* ===== 카테고리 집계 =====
     타일 하나 = 그 분류 전체를 '가중평균' 한 값.
     원재료별 수율을 단순평균하면 월 3kg 쓰는 향신료가 300kg 짜리 한우와 같은 무게로
     들어가 분류를 통째로 흔든다. 반드시 Σ표준 ÷ Σ실투입 이어야 한다.
     이상치(20~200% 밖)는 화면 다른 곳과 같은 규칙으로 뺀다 — 안 그러면 카테고리
     레벨에서 같은 왜곡이 그대로 재발한다. */
  const catStats = useMemo(() => {
    if (!rows) return null;
    interface Agg {
      name: string; count: number; outCount: number; naCount: number;
      stdG: number; actG: number; lossAmt: number; actAmt: number;
      pStdW: number;            // 비교월 수율 × 당월 실투입 (당월 가중으로 재평가)
      cmpAct: number;           // 위 가중의 분모
      cmpCount: number;
    }
    const m = new Map<string, Agg>();
    const get = (k: string): Agg => {
      let a = m.get(k);
      if (!a) { a = { name: k, count: 0, outCount: 0, naCount: 0, stdG: 0, actG: 0, lossAmt: 0, actAmt: 0, pStdW: 0, cmpAct: 0, cmpCount: 0 }; m.set(k, a); }
      return a;
    };
    rows.forEach((r) => {
      const a = get(categoryOf(catIndex, r.code, r.name));
      if (r.yield === null) { a.naCount++; return; }   // 미입력 등 계산 불가 — 종수엔 안 넣되 있다는 건 알린다
      if (!inRangeV(r.yield)) { a.outCount++; return; }
      a.count++;
      a.stdG += r.stdG; a.actG += r.actG;
      a.lossAmt += r.lossAmt || 0;
      a.actAmt += r.actG * (r.pricePerG || 0);
      if (inRangeV(r.prevYield)) { a.pStdW += r.prevYield * r.actG; a.cmpAct += r.actG; a.cmpCount++; }
    });
    const list = [...m.values()].map((a) => {
      const y = a.actG > 0 ? a.stdG / a.actG : null;
      // 비교월도 '당월 가중치' 로 재평가해야 배합 이동이 수율 변화로 안 보인다 (전체 카드와 같은 규칙)
      const pAdj = a.cmpAct > 0 ? a.pStdW / a.cmpAct : null;
      const deltaPP = y !== null && pAdj !== null ? (y - pAdj) * 100 : null;
      return {
        ...a,
        yield: y,
        lossG: a.actG - a.stdG,
        deltaPP,
        // ★ 악화 영향액 — '비교월 수율을 그대로 유지했다면 안 썼을 금액'.
        //   LOSS 금액은 BOM 기준(전처리 후 실량)이면 대부분 음수라 규모 비교에 못 쓴다.
        //   이건 '변화' 라서 어느 기준에서든 그대로 유효하고, 곧바로 개선 목표 금액이 된다.
        impactAmt: deltaPP !== null && deltaPP < 0 ? (-deltaPP / 100) * a.actAmt : 0,
      };
    });
    const order = sortCategories(catIndex, list.map((l) => l.name));
    const rank = new Map(order.map((n, i) => [n, i]));
    return list.sort((a, b) => {
      if (a.name === UNCLASSIFIED) return 1;
      if (b.name === UNCLASSIFIED) return -1;
      if (catSort === 'impact') return b.impactAmt - a.impactAmt;
      if (catSort === 'loss') return b.lossAmt - a.lossAmt;
      if (catSort === 'delta') return (a.deltaPP ?? 999) - (b.deltaPP ?? 999);
      if (catSort === 'yield') return (a.yield ?? 9) - (b.yield ?? 9);
      return (rank.get(a.name) ?? 999) - (rank.get(b.name) ?? 999);
    });
  }, [rows, catIndex, catSort]);

  const inRange = (v: number | null) => v !== null && v >= RANGE_LO && v <= RANGE_HI;
  // 데이터 이상(수율 20% 미만·200% 초과)은 TOP3 에서 빼야 진짜 문제가 가려지지 않는다
  const topDrop = useMemo(() => (rows || [])
    .filter((r) => r.deltaPP !== null && inRange(r.yield) && inRange(r.prevYield))
    .sort((a, b) => (a.deltaPP || 0) - (b.deltaPP || 0)).slice(0, 3), [rows]);
  const outOfRange = useMemo(() => (rows || [])
    .filter((r) => (r.yield !== null && !inRange(r.yield)) || (r.prevYield !== null && !inRange(r.prevYield)))
    .sort((a, b) => (b.yield ?? 0) - (a.yield ?? 0)), [rows]);
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
    // 이상치(범위 밖)는 하락폭 정렬 맨 뒤로 — 데이터 오류가 1위를 차지하면 안 된다
    else if (sortBy === 'delta') {
      const key = (r: Row) => (r.deltaPP !== null && inRange(r.yield) && inRange(r.prevYield) ? r.deltaPP : 999);
      s.sort((a, b) => key(a) - key(b));
    }
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
      const oddRow = (r.yield !== null && !inRange(r.yield)) || (r.prevYield !== null && !inRange(r.prevYield));
      if (oddRow) row.getCell('d').font = { color: { argb: 'FF999999' } };   // 데이터 이상 → 회색
      else if (r.deltaPP !== null && r.deltaPP <= -threshold) row.getCell('d').font = { bold: true, color: { argb: 'FFC00000' } };
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
      { header: '이전평균', key: 'pavg', width: 10 },
      { header: '최근-이전평균(%p)', key: 'lv', width: 18 },
      { header: '값 있는 달', key: 'mn', width: 10 },
      { header: '변동폭(%p)', key: 'rg', width: 12 },
      { header: '최근월 LOSS금액', key: 'la', width: 16 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    trendView.forEach((r) => {
      const o: Record<string, unknown> = { n: r.name, c: r.code, avg: r.avg, pavg: r.prevAvg, lv: r.lastVsAvg, mn: r.months, rg: r.range, la: Math.round(r.lossAmtLast) };
      trend.months.forEach((m) => { o[m.month] = r.byMonth[m.month]; });
      const row = ws.addRow(o);
      trend.months.forEach((m) => { row.getCell(m.month).numFmt = '0.0%'; });
      row.getCell('avg').numFmt = '0.0%';
      row.getCell('pavg').numFmt = '0.0%';
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

      {/* 어느 레시피 DB 로 계산했는지 항상 보이게 — 숫자 기준이 바뀌는 지점이라 숨기면 안 된다 */}
      {useYieldDb ? (
        <div className="bg-teal-50 border border-teal-200 rounded-lg px-3 py-2 text-xs text-teal-900 flex items-center gap-2 flex-wrap">
          <span className="bg-teal-600 text-white rounded px-2 py-0.5 font-bold">분석용 레시피</span>
          배합비 % 기준 <b>순 이론 투입량</b>으로 계산했습니다 ({yRecipeCount}품목)
          {ySubMap.size === 0 && <span className="text-teal-700">· 반제품은 기존 반제품 레시피 DB 사용</span>}
          {yAmbientMap.size === 0 && <span className="text-teal-700">· 실온은 기존 실온 레시피 DB 사용</span>}
        </div>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900 flex items-center gap-2 flex-wrap">
          <span className="bg-amber-600 text-white rounded px-2 py-0.5 font-bold">현장 BOM</span>
          <b>분석용 레시피 DB 가 비어 있어</b> 기존 현장 BOM 으로 계산했습니다.
          현장 BOM 은 전처리 후 실제 투입량이라 <b>수율이 구조적으로 100%를 넘습니다</b> — 절대값 대신 증감으로 보세요.
          <span className="text-amber-700">설정 › 원재료분석용 DB 에 입력하면 자동으로 전환됩니다.</span>
        </div>
      )}

      {/* 레시피 커버리지.
          실투입(ERP 수불)은 전 품목분이 다 들어오는데 표준소요는 레시피가 등록된 품목만 잡힌다.
          → 분자만 작아져 수율이 실제보다 '낮게' 나온다. 채우는 도중에 이걸 모르면
             멀쩡한 원재료가 전부 로스 나는 것처럼 보인다. */}
      {mode === 'cmp' && coverage && coverage.pct < 99.5 && (
        <div className={`border rounded-lg px-3 py-2 text-xs ${coverage.pct < 90
          ? 'bg-rose-50 border-rose-300 text-rose-900' : 'bg-amber-50 border-amber-200 text-amber-900'}`}>
          {coverage.pct < 90 ? '🚨' : '⚠️'} <b>레시피 커버리지 {fmt(coverage.pct, 1)}%</b>
          {' — '}{month} 생산 {coverage.totalQty.toLocaleString()}EA 중
          <b> {coverage.missingQty.toLocaleString()}EA</b> 가 레시피 미등록이라 표준소요에서 빠졌습니다
          {(coverage.missingCold > 0 || coverage.missingAmbient > 0) &&
            ` (냉장 ${coverage.missingCold}품목 · 실온 ${coverage.missingAmbient}품목)`}.
          {' '}표준소요가 과소계상되어 <b>수율이 실제보다 낮게</b> 나옵니다.
          {coverage.pct < 90 && <b> 이 상태의 숫자는 보고자료에 쓰지 마세요.</b>}
        </div>
      )}

      {/* 계산 기준 */}
      <div className="bg-slate-50 border rounded-lg p-3 text-xs text-gray-700 space-y-1">
        <div>
          <b>원재료수율 = 표준소요량 ÷ 실제 투입중량</b>
          <span className="text-gray-400 ml-2">표준소요량 = 완제품 생산수량 × {useYieldDb ? '배합비(%)' : 'BOM 배합비'} · LOSS = 실제투입 − 표준소요 · LOSS율 = 1 − 수율</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <span className="font-semibold">제외 원재료</span>
          <input value={excludeText} onChange={(e) => setExcludeText(e.target.value)}
            placeholder="정제수, ..." className="border rounded px-2 py-1 w-64" />
          <span className="text-gray-400">매입이 없는 자재(정제수 등). 반제품은 원물로 자동 분해되어 목록에 안 나옵니다</span>
          <span className="ml-auto font-semibold">이상 임계</span>
          <input type="number" value={threshold} step="0.5" min="0"
            onChange={(e) => setThreshold(Math.max(0.1, Number(e.target.value) || 0.1))}
            className="border rounded px-2 py-1 w-16 text-right" />
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
          {/* ===== 카테고리별 수율 추이 =====
              여기가 본진이다. 추이 모드는 전 기간 데이터를 이미 불러왔으므로
              분류별 집계와 미니 그래프를 추가 읽기 없이 낼 수 있다. */}
          {trend.cats.length > 0 && (() => {
            const ms = trend.months.map((m) => m.month);
            const catOrderIdx = new Map(catIndex.categories.map((n, i) => [n, i]));
            const real = trend.cats.filter((c) => c.name !== UNCLASSIFIED).slice().sort((a, b) => {
              if (catSort === 'delta') return (a.lastVsAvg ?? 999) - (b.lastVsAvg ?? 999);
              if (catSort === 'yield') return (a.last ?? 9) - (b.last ?? 9);
              if (catSort === 'name') return (catOrderIdx.get(a.name) ?? 999) - (catOrderIdx.get(b.name) ?? 999);
              return b.impactAmt - a.impactAmt;   // 기본: 영향액순
            });
            const unc = trend.cats.find((c) => c.name === UNCLASSIFIED);
            const maxImpact = Math.max(0, ...real.map((c) => c.impactAmt));
            // 임계 미만의 미세 변동은 '봐야 할 곳' 이 아니다 — 진짜 신호가 묻힌다
            const focus = real.filter((c) => c.lastVsAvg !== null && c.lastVsAvg <= -threshold)
              .slice().sort((a, b) => b.impactAmt - a.impactAmt).slice(0, 3);
            return (
              <div className="bg-white border rounded-xl shadow-sm">
                <div className="px-4 py-2.5 border-b flex items-start justify-between gap-2 flex-wrap">
                  <div>
                  <div className="font-bold text-gray-900 text-sm">카테고리별 수율 추이</div>
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    {ms[0]} ~ {ms[ms.length - 1]} · 큰 숫자는 <b>최근월 − 이전평균(%p)</b>, 그래프는 월별 수율 ·
                    왼쪽 막대 = <b>악화 영향액</b> 규모 · 분류를 누르면 아래 히트맵이 그 분류만 남습니다
                    {catIndex.categories.length === 0 && (
                      <span className="text-amber-700"> · 카테고리 DB 가 비어 있어 전부 ‘{UNCLASSIFIED}’ 입니다</span>
                    )}
                  </div>
                  </div>
                  <div className="flex items-center gap-1 text-[11px]">
                    <span className="text-gray-400">정렬</span>
                    {([['impact', '영향액'], ['delta', '증감'], ['yield', '수율'], ['name', '등록순']] as const).map(([k, label]) => (
                      <button key={k} onClick={() => setCatSort(k)}
                        className={`border rounded-md px-2 py-1 ${catSort === k ? 'bg-slate-900 text-white border-slate-900' : 'hover:bg-gray-50'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {focus.length > 0 && (
                  <div className="px-4 py-2.5 bg-rose-50/60 border-b border-rose-100 text-xs">
                    <span className="font-bold text-rose-900">지금 봐야 할 곳</span>
                    <span className="text-rose-700 ml-2">
                      {focus.map((c, i) => (
                        <span key={c.name}>
                          {i > 0 && <span className="text-rose-300 mx-1.5">·</span>}
                          <button onClick={() => setOpenCat(c.name)} className="underline underline-offset-2 hover:text-rose-900">
                            <b>{c.name}</b> {c.lastVsAvg !== null && `${fmt(c.lastVsAvg, 1)}%p`} → <b>{Math.round(c.impactAmt).toLocaleString()}원</b>
                          </button>
                        </span>
                      ))}
                    </span>
                    <div className="text-[11px] text-rose-800/80 mt-1">
                      <b>악화 영향액</b> = 이전 평균 수율을 유지했다면 최근월에 안 썼을 금액. 개선 목표 금액으로 그대로 쓰면 됩니다.
                    </div>
                  </div>
                )}

                <div className="p-3 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
                  {real.map((c) => (
                    <CatTile
                      key={c.name}
                      name={c.name}
                      count={c.count}
                      threshold={threshold}
                      // 비교값이 없으면 큰 숫자를 '—' 로 비워두지 말고 수율을 주인공으로 되돌린다
                      headline={c.lastVsAvg !== null
                        ? `${c.lastVsAvg > 0 ? '+' : ''}${fmt(c.lastVsAvg, 1)}`
                        : c.last !== null ? fmt(c.last * 100) : '—'}
                      headlineUnit={c.lastVsAvg !== null ? '%p' : '%'}
                      sub={c.lastVsAvg !== null
                        ? (c.last === null ? '—' : `수율 ${fmt(c.last * 100)}%`)
                        : '비교할 이전 달 없음'}
                      subLabel="최근월 가중평균 수율"
                      delta={c.lastVsAvg}
                      deltaLabel="최근월 − 이전평균"
                      barRatio={maxImpact > 0 ? c.impactAmt / maxImpact : 0}
                      impactAmt={c.impactAmt}
                      spark={ms.map((m) => c.byMonth[m])}
                      footL={c.prevAvg === null ? '이전 비교 없음' : `이전평균 ${fmt(c.prevAvg * 100)}%`}
                      footR={c.impactAmt > 0 ? `영향 ${Math.round(c.impactAmt).toLocaleString()}원` : '악화 없음'}
                      open={openCat === c.name}
                      onClick={() => setOpenCat(openCat === c.name ? null : c.name)}
                    />
                  ))}
                </div>

                {unc && (
                  <button onClick={() => setOpenCat(openCat === UNCLASSIFIED ? null : UNCLASSIFIED)}
                    className={`w-full text-left px-4 py-2 border-t text-xs flex items-center gap-2 flex-wrap
                      ${openCat === UNCLASSIFIED ? 'bg-slate-900 text-white' : 'bg-gray-50 hover:bg-gray-100 text-gray-600'}`}>
                    <b>{UNCLASSIFIED}</b>
                    <span>{unc.count}종</span>
                    {unc.last !== null && <span>최근 수율 {fmt(unc.last * 100)}%</span>}
                    <span className={openCat === UNCLASSIFIED ? 'text-gray-300' : 'text-gray-400'}>
                      — 설정 › 원재료 카테고리 DB 에서 분류를 지정하면 위 타일로 올라갑니다
                    </span>
                  </button>
                )}
              </div>
            );
          })()}

          {/* 월별 데이터 점검 — 어느 달이 계산 가능한지 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-sm text-gray-800">
              📅 월별 데이터 점검
              <span className="ml-2 text-xs font-normal text-gray-500">
                생산량은 월별현황 합계(냉장+실온)와 같아야 정상 ·
                <b className="text-indigo-700 ml-1">월 간 비교는 '공통 기준 수율' 로 보세요</b>
                (전체 수율은 달마다 대상 원재료가 달라질 수 있습니다)
              </span>
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
                  <tr>
                    <td className="px-3 py-1.5 font-semibold text-gray-700">생산량 (EA)</td>
                    {trend.months.map((m) => (
                      <td key={m.month} className="px-2 py-1.5 text-center text-gray-700"
                        title={`냉장 ${Math.round(m.cold).toLocaleString()} + 실온 ${Math.round(m.ambient).toLocaleString()}`}>
                        {m.total > 0 ? Math.round(m.total).toLocaleString() : '—'}
                      </td>
                    ))}
                  </tr>
                  <tr className="bg-slate-50">
                    <td className="px-3 py-1.5 font-semibold text-gray-700">
                      전체 수율
                      <div className="text-[10px] font-normal text-gray-400">그 달 계산 가능한 전 원재료</div>
                    </td>
                    {trend.months.map((m) => (
                      <td key={m.month} className={`px-2 py-1.5 text-center font-bold ${m.wYield === null ? 'text-gray-300' : 'text-blue-700'}`}>
                        {m.wYield === null ? '—' : `${fmt(m.wYield * 100)}%`}
                      </td>
                    ))}
                  </tr>
                  <tr className="bg-indigo-50">
                    <td className="px-3 py-1.5 font-semibold text-gray-800">
                      공통 기준 수율
                      <div className="text-[10px] font-normal text-indigo-600">
                        전 기간 <b>정상범위</b>로 계산되는 {trend.commonCount}종 고정 · 월 간 비교용
                        {trend.outCount > 0 && ` (이상치 있는 ${trend.outCount}종 제외)`}
                      </div>
                    </td>
                    {trend.months.map((m) => (
                      <td key={m.month} className={`px-2 py-1.5 text-center font-bold ${m.wCommon === null ? 'text-gray-300' : 'text-indigo-700'}`}>
                        {m.wCommon === null ? '—' : `${fmt(m.wCommon * 100)}%`}
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
              {openCat && (
                <button onClick={() => setOpenCat(null)}
                  className="inline-flex items-center gap-1 bg-slate-900 text-white rounded-full px-2.5 py-0.5 text-xs hover:bg-slate-700">
                  {openCat} <span className="text-slate-400">✕</span>
                </button>
              )}
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
                    <th className="px-2 py-2 text-center w-20 bg-slate-50">이전평균</th>
                    <th className="px-2 py-2 text-center w-24 bg-slate-50">최근−이전평균<br /><span className="font-normal text-gray-400">%p</span></th>
                    <th className="px-2 py-2 text-center w-16 bg-slate-50">변동폭<br /><span className="font-normal text-gray-400">%p</span></th>
                    <th className="px-2 py-2 text-right w-24 bg-slate-50">최근월 LOSS<br /><span className="font-normal text-gray-400">그 달 단가</span></th>
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
                        const odd = v !== null && !inRangeV(v);
                        const d = !odd && v !== null && r.avg !== null ? (v - r.avg) * 100 : null;
                        const bg = odd ? 'bg-gray-100 text-gray-400'
                          : d === null ? '' : d <= -threshold ? 'bg-rose-100 text-rose-800 font-bold'
                            : d >= threshold ? 'bg-violet-100 text-violet-800 font-bold' : '';
                        return (
                          <td key={m.month} className={`px-2 py-1.5 text-center ${bg}`}
                            title={odd ? `${RANGE_LO * 100}~${RANGE_HI * 100}% 범위를 벗어나 평균·증감 계산에서 제외했습니다`
                              : d === null ? '' : `전체 평균 대비 ${d > 0 ? '+' : ''}${fmt(d, 1)}%p`}>
                            {v === null ? <span className="text-gray-300">—</span> : odd ? `⚠${fmt(v * 100)}` : fmt(v * 100)}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1.5 text-center bg-slate-50 font-semibold">
                        {pct(r.avg)}
                        <span className="text-[10px] text-gray-400 ml-1">{r.months}개월</span>
                      </td>
                      <td className="px-2 py-1.5 text-center bg-slate-50 text-gray-600">{pct(r.prevAvg)}</td>
                      <td className={`px-2 py-1.5 text-center bg-slate-50 font-bold ${r.lastVsAvg === null ? 'text-gray-300' : r.lastVsAvg <= -threshold ? 'text-rose-600' : r.lastVsAvg >= threshold ? 'text-violet-700' : 'text-gray-500'}`}
                        title={r.lastVsAvg === null ? '비교할 이전 달 데이터가 없습니다' : undefined}>
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
          {/* 요약 카드 */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Card label={stat.excluded > 0 ? `대상 원재료 (이상 ${stat.excluded}종 제외)` : '대상 원재료'}
              value={`${stat.count}`} unit="종" tone="slate" />
            <Card label={`가중평균 수율 (${stat.count}종)`}
              value={stat.wYield === null ? '—' : fmt(stat.wYield * 100)} unit="%" tone="blue" big />
            <Card label="LOSS율 (= 1 − 수율)"
              value={stat.wLoss === null ? '—' : fmt(stat.wLoss * 100)} unit="%" tone="rose" big />
            <Card label={`${cmpMode === 'yoy' ? '전년동월' : '전월'} 대비 · 수율효과 (${stat.cmpCount}종)`}
              value={stat.deltaPP === null ? '—' : `${stat.deltaPP > 0 ? '+' : ''}${fmt(stat.deltaPP, 1)}`}
              unit="%p" tone={stat.deltaPP !== null && stat.deltaPP < 0 ? 'rose' : 'emerald'} />
            <Card label={`${cmpMode === 'yoy' ? '전년동월' : '전월'} 대비 ${threshold}%p 이상 하락`}
              value={`${stat.dropCount}`} unit="종" tone="amber" />
            <Card label={stat.lossAmt < 0 ? 'LOSS 금액 (음수=표준보다 덜 씀)' : 'LOSS 금액'}
              value={Math.round(stat.lossAmt).toLocaleString()} unit="원" tone="rose" />
          </div>

          {stat.mixEff !== null && Math.abs(stat.mixEff) >= 0.05 && (
            <div className="bg-slate-50 border rounded-lg px-4 py-2 text-xs text-gray-700">
              <b>수율효과 {stat.deltaPP === null ? '—' : `${stat.deltaPP > 0 ? '+' : ''}${fmt(stat.deltaPP, 1)}%p`}</b>
              <span className="text-gray-400 mx-1">+</span>
              <b>배합효과 {`${stat.mixEff > 0 ? '+' : ''}${fmt(stat.mixEff, 1)}%p`}</b>
              <span className="text-gray-400 mx-1">=</span>
              단순 비교 {stat.wPrev !== null && stat.wCur !== null ? `${((stat.wCur - stat.wPrev) * 100) > 0 ? '+' : ''}${fmt((stat.wCur - stat.wPrev) * 100, 1)}%p` : '—'}
              <span className="text-gray-400 ml-1">({stat.cmpCount}종 기준)</span>
              <span className="ml-2 text-gray-500">
                — 배합효과는 원재료별 수율이 그대로여도 <b>어느 원재료를 많이 썼는지</b>가 바뀌어 생기는 몫입니다. 관리 대상은 <b>수율효과</b> 입니다.
              </span>
            </div>
          )}

          {/* ===== 카테고리 타일 (월 비교) =====
              1차 스크리닝용. 분류를 눌러 그 안의 원재료를 바로 아래에서 펼쳐 본다. */}
          {catStats && catStats.length > 0 && (() => {
            const real = catStats.filter((c) => c.name !== UNCLASSIFIED);
            const unc = catStats.find((c) => c.name === UNCLASSIFIED);
            const maxImpact = Math.max(0, ...real.map((c) => c.impactAmt));
            const focus = real.filter((c) => c.deltaPP !== null && c.deltaPP <= -threshold)
              .slice().sort((a, b) => b.impactAmt - a.impactAmt).slice(0, 3);
            const totalImpact = real.reduce((s2, c) => s2 + c.impactAmt, 0);
            return (
              <div className="bg-white border rounded-xl shadow-sm">
                <div className="flex items-start justify-between gap-2 flex-wrap px-4 py-2.5 border-b">
                  <div>
                    <div className="font-bold text-gray-900 text-sm">카테고리별 수율</div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      수율은 <b>가중평균</b>(Σ표준소요 ÷ Σ실투입) · 왼쪽 세로 막대 = <b>악화 영향액</b> 규모 · 분류를 눌러 원재료를 펼치세요
                      {catIndex.categories.length === 0 && (
                        <span className="text-amber-700"> · 설정 › 원재료 카테고리 DB 가 비어 있어 전부 ‘{UNCLASSIFIED}’ 입니다</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-[11px]">
                    <span className="text-gray-400">정렬</span>
                    {([['impact', '영향액'], ['loss', 'LOSS 금액'], ['delta', '증감'], ['yield', '수율'], ['name', '등록순']] as const).map(([k, label]) => (
                      <button key={k} onClick={() => setCatSort(k)}
                        className={`border rounded-md px-2 py-1 ${catSort === k ? 'bg-slate-900 text-white border-slate-900' : 'hover:bg-gray-50'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 지금 봐야 할 곳 — 화면이 우선순위를 정해준다 */}
                {focus.length > 0 && (
                  <div className="px-4 py-2.5 bg-rose-50/60 border-b border-rose-100 text-xs">
                    <span className="font-bold text-rose-900">지금 봐야 할 곳</span>
                    <span className="text-rose-700 ml-2">
                      {focus.map((c, i) => (
                        <span key={c.name}>
                          {i > 0 && <span className="text-rose-300 mx-1.5">·</span>}
                          <button onClick={() => setOpenCat(c.name)} className="underline underline-offset-2 hover:text-rose-900">
                            <b>{c.name}</b> {c.deltaPP !== null && `${fmt(c.deltaPP, 1)}%p`} → <b>{Math.round(c.impactAmt).toLocaleString()}원</b>
                          </button>
                        </span>
                      ))}
                    </span>
                    <div className="text-[11px] text-rose-800/80 mt-1">
                      <b>악화 영향액</b> = {cmpMode === 'yoy' ? '전년동월' : '전월'} 수율을 그대로 유지했다면 안 썼을 금액.
                      LOSS 금액은 BOM 기준에 따라 음수가 되지만 이 값은 <b>‘변화’ 라서 어느 기준에서든 그대로 유효</b>합니다.
                      {totalImpact > 0 && <> 전 분류 합계 <b>{Math.round(totalImpact).toLocaleString()}원</b>.</>}
                    </div>
                  </div>
                )}

                <div className="p-3 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
                  {real.map((c) => (
                    <CatTile
                      key={c.name}
                      name={c.name}
                      count={c.count}
                      threshold={threshold}
                      headline={c.deltaPP !== null
                        ? `${c.deltaPP > 0 ? '+' : ''}${fmt(c.deltaPP, 1)}`
                        : c.yield !== null ? fmt(c.yield * 100) : '—'}
                      headlineUnit={c.deltaPP !== null ? '%p' : '%'}
                      sub={c.deltaPP !== null
                        ? (c.yield === null ? '—' : `수율 ${fmt(c.yield * 100)}%`)
                        : `${cmpMode === 'yoy' ? '전년동월' : '전월'} 비교 없음`}
                      subLabel="가중평균 수율"
                      delta={c.deltaPP}
                      deltaLabel={`${cmpMode === 'yoy' ? '전년동월' : '전월'} 대비 증감`}
                      barRatio={maxImpact > 0 ? c.impactAmt / maxImpact : 0}
                      impactAmt={c.impactAmt}
                      footL={`LOSS ${fmt(kg(c.lossG))}kg · ${Math.round(c.lossAmt).toLocaleString()}원`}
                      footR={c.impactAmt > 0 ? `영향 ${Math.round(c.impactAmt).toLocaleString()}원` : '악화 없음'}
                      note={[
                        c.outCount > 0 ? `⚠ 이상치 ${c.outCount}종` : '',
                        c.naCount > 0 ? `미입력 ${c.naCount}종` : '',
                      ].filter(Boolean).join(' · ') || undefined}
                      open={openCat === c.name}
                      onClick={() => setOpenCat(openCat === c.name ? null : c.name)}
                    />
                  ))}
                </div>

                {/* 미분류는 타일 한 칸을 차지할 가치가 없다 — 있다는 사실만 알리면 된다 */}
                {unc && (unc.count > 0 || unc.naCount > 0 || unc.outCount > 0) && (
                  <button onClick={() => setOpenCat(openCat === UNCLASSIFIED ? null : UNCLASSIFIED)}
                    className={`w-full text-left px-4 py-2 border-t text-xs flex items-center gap-2 flex-wrap
                      ${openCat === UNCLASSIFIED ? 'bg-slate-900 text-white' : 'bg-gray-50 hover:bg-gray-100 text-gray-600'}`}>
                    <b>{UNCLASSIFIED}</b>
                    <span>{unc.count}종{unc.naCount > 0 && ` · 미입력 ${unc.naCount}종`}{unc.outCount > 0 && ` · 이상치 ${unc.outCount}종`}</span>
                    {unc.yield !== null && <span>수율 {fmt(unc.yield * 100)}%</span>}
                    <span className={openCat === UNCLASSIFIED ? 'text-gray-300' : 'text-gray-400'}>
                      — 설정 › 원재료 카테고리 DB 에서 분류를 지정하면 위 타일로 올라갑니다
                    </span>
                  </button>
                )}

              {/* 아코디언 — 선택한 분류의 원재료 상세 */}
              {openCat && (() => {
                const list = (rows || [])
                  .filter((r) => categoryOf(catIndex, r.code, r.name) === openCat)
                  .sort((a, b) => (b.lossAmt ?? -1) - (a.lossAmt ?? -1));
                const c = catStats.find((x) => x.name === openCat);
                return (
                  <div className="border-t bg-slate-50 px-3 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-bold text-gray-800">
                        {openCat}
                        <span className="ml-2 text-xs font-normal text-gray-500">
                          {list.length}종
                          {c && c.count !== list.length && ` (집계 ${c.count}종)`}
                          {c && c.yield !== null && ` · 가중평균 ${fmt(c.yield * 100)}%`}
                          {c && c.deltaPP !== null && ` · ${c.deltaPP > 0 ? '+' : ''}${fmt(c.deltaPP, 1)}%p`}
                        </span>
                      </div>
                      <button onClick={() => setOpenCat(null)} className="text-xs text-gray-500 hover:text-gray-800">닫기 ✕</button>
                    </div>
                    <div className="overflow-x-auto bg-white border rounded">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 text-gray-600">
                          <tr>
                            <th className="px-2 py-1.5 text-left">원재료</th>
                            <th className="px-2 py-1.5 text-right">표준소요(kg)</th>
                            <th className="px-2 py-1.5 text-right">실투입(kg)</th>
                            <th className="px-2 py-1.5 text-right">수율(%)</th>
                            <th className="px-2 py-1.5 text-right">증감(%p)</th>
                            <th className="px-2 py-1.5 text-right">LOSS(kg)</th>
                            <th className="px-2 py-1.5 text-right">LOSS(원)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y tabular-nums">
                          {list.map((r) => {
                            const odd = (r.yield !== null && !inRangeV(r.yield))
                              || (r.prevYield !== null && !inRangeV(r.prevYield));
                            const showDelta = r.deltaPP !== null && inRangeV(r.yield) && inRangeV(r.prevYield);
                            return (
                              <tr key={r.key} className={odd ? 'text-gray-400' : 'hover:bg-slate-50'}>
                                <td className="px-2 py-1">
                                  <div className="truncate max-w-[220px] text-gray-800">{odd && '⚠ '}{r.name}</div>
                                  <div className="text-[10px] text-gray-400 font-mono">{r.code}</div>
                                </td>
                                <td className="px-2 py-1 text-right text-gray-600">{fmt(kg(r.stdG))}</td>
                                <td className="px-2 py-1 text-right text-gray-600">
                                  {r.hasInput ? fmt(kg(r.actG)) : <span className="text-amber-600">미입력</span>}
                                </td>
                                <td className="px-2 py-1 text-right font-bold text-blue-700">
                                  {r.yield === null ? '—' : fmt(r.yield * 100)}
                                </td>
                                <td className={`px-2 py-1 text-right font-semibold ${!showDelta ? 'text-gray-300'
                                  : (r.deltaPP || 0) <= -threshold ? 'text-rose-600'
                                    : (r.deltaPP || 0) >= threshold ? 'text-emerald-600' : 'text-gray-500'}`}>
                                  {!showDelta ? '—' : `${(r.deltaPP || 0) > 0 ? '+' : ''}${fmt(r.deltaPP || 0, 1)}`}
                                </td>
                                <td className="px-2 py-1 text-right text-gray-600">{r.lossG === null ? '—' : fmt(kg(r.lossG))}</td>
                                <td className="px-2 py-1 text-right font-semibold text-amber-700">
                                  {r.lossAmt === null ? '—' : Math.round(r.lossAmt).toLocaleString()}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
              </div>
            );
          })()}

          {/* TOP3 두 개 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopBox title={`이상 원재료 TOP 3 · ${cmpMode === 'yoy' ? '전년동월' : '전월'} 대비 하락폭`}
              hint={`${cmpMode === 'yoy' ? '전년동월' : '전월'}보다 나빠진 것 — 원인 규명 대상`} accent="rose">
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
              hint={`지금 제일 많이 새는 것 — ${month} 재고평가 단가 기준`} accent="amber">
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
                    <th className="px-2 py-2 text-right w-20">⑦ 증감<br /><span className="font-normal text-gray-400">%p</span></th>
                    <th className="px-2 py-2 text-right w-20">④ LOSS<br /><span className="font-normal text-gray-400">kg</span></th>
                    <th className="px-2 py-2 text-right w-20">⑤ LOSS율</th>
                    <th className="px-2 py-2 text-right w-24">LOSS 금액<br /><span className="font-normal text-gray-400">{month} 단가</span></th>
                    <th className="px-3 py-2 text-left w-56">원인 점검 포인트</th>
                  </tr>
                </thead>
                <tbody className="divide-y tabular-nums">
                  {view.map((r) => {
                    const bad = r.deltaPP !== null && r.deltaPP <= -threshold
                      && inRange(r.yield) && inRange(r.prevYield);
                    const over = (r.yield || 0) > 1;
                    const odd = (r.yield !== null && !inRange(r.yield)) || (r.prevYield !== null && !inRange(r.prevYield));
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
                        <td className={`px-2 py-1.5 text-right font-semibold ${odd ? 'text-gray-400' : r.deltaPP === null ? 'text-gray-300' : r.deltaPP < 0 ? 'text-rose-600' : 'text-emerald-600'}`}
                          title={odd ? '수율이 정상 범위를 벗어나 집계·TOP3 에서 제외했습니다 — 실투입 값을 확인하세요' : undefined}>
                          {r.deltaPP === null ? '—' : `${r.deltaPP > 0 ? '+' : ''}${fmt(r.deltaPP, 1)}`}{odd && ' ⚠'}
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
              {remapCount > 0 && (
                <div className="text-xs text-amber-800">
                  · <b>{remapCount}종</b> — 실투입 키가 BOM 키와 달라 <b>원재료명으로 매칭</b>했습니다
                  (실투입은 코드로, BOM 은 이름으로 등록된 경우 등). 코드를 맞춰두시면 더 안전합니다
                </div>
              )}
              {stat.noStd > 0 && (
                <div className="text-xs text-amber-800">
                  · <b>{stat.noStd}종</b> — 실제 투입은 있는데 <b>표준소요량이 0</b> (레시피 미등록 또는 코드 불일치)
                </div>
              )}
              {outOfRange.length > 0 && (
                <div className="text-xs text-red-700">
                  · <b>{outOfRange.length}종</b> — 수율이 <b>{RANGE_LO * 100}~{RANGE_HI * 100}% 범위를 벗어남</b> · 데이터 이상으로 보고 TOP3 에서 제외했습니다.
                  <div className="mt-0.5 text-[11px] text-red-600">
                    {outOfRange.slice(0, 10).map((r) => `${r.name}(${r.yield === null ? '—' : fmt(r.yield * 100)}%${r.prevYield !== null && !inRange(r.prevYield) ? ` / 전월 ${fmt(r.prevYield * 100)}%` : ''})`).join(', ')}
                    {outOfRange.length > 10 ? ` 외 ${outOfRange.length - 10}종` : ''}
                  </div>
                  <div className="mt-0.5 text-[11px] text-red-600">
                    → 실투입 값이 잘못 저장됐을 가능성이 큽니다. 설정 › ⚖️ 실제 투입중량 에서 해당 월 값을 확인해 주세요.
                  </div>
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
                  · <b>{cmpMonth}</b> {!cmpDiag.hasInput ? '실제 투입중량이 없어' : '생산 데이터(레시피 기준 표준소요)가 없어'} <b>비교 지표(⑥⑦)를 낼 수 없습니다</b>
                  {cmpDiag.hasInput && cmpDiag.qty === 0 && (
                    <span className="block ml-2 text-[11px] text-amber-700">
                      실투입은 입력돼 있지만 그 달 생산 실적이 없습니다. 표준소요가 0이라 비교했다면 수율이 통째로 낮게 나왔을 값이라 비교를 껐습니다.
                    </span>
                  )}
                  {cmpMode === 'yoy' && ' → 전월 비교로 바꾸거나, 과거 데이터를 입력해 주세요'}
                </div>
              )}
              {cmpHasData && cmpDiag.partial && (
                <div className="text-xs text-rose-800">
                  · ⚠ <b>{cmpMonth} 생산량이 {month}의 {Math.round((cmpDiag.qty / cmpDiag.baseQty) * 100)}%</b> 뿐입니다
                  ({cmpDiag.qty.toLocaleString()} vs {cmpDiag.baseQty.toLocaleString()} EA).
                  그 달 데이터가 덜 쌓인 것이라면 표준소요가 과소계상돼 <b>비교월 수율이 실제보다 낮게</b> 나오고,
                  그만큼 증감(%p)이 <b>개선된 것처럼</b> 보입니다. 보고자료에 쓰기 전 그 달 생산 데이터가 온전한지 확인하세요.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 미니 추이 그래프 — 라이브러리 없이 SVG 로 직접 그린다 (번들 증가 0) */
function Sparkline({ values, tone = 'flat', width = 132, height = 30 }: {
  values: (number | null)[]; tone?: 'up' | 'down' | 'flat'; width?: number; height?: number;
}) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  if (pts.length < 2) return <div style={{ width, height }} />;
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs); let hi = Math.max(...vs);
  // 변화가 거의 없으면 평평하게 보여야 한다. 강제로 늘리면 잡음이 추세처럼 보인다.
  const pad = Math.max((hi - lo) * 0.15, 0.02);
  lo -= pad; hi += pad;
  const n = values.length - 1 || 1;
  const x = (i: number) => (i / n) * (width - 4) + 2;
  const y = (v: number) => height - 3 - ((v - lo) / (hi - lo || 1)) * (height - 6);
  const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${d} L${x(pts[pts.length - 1].i).toFixed(1)},${height} L${x(pts[0].i).toFixed(1)},${height} Z`;
  // 색은 타일과 '같은 신호'(최근 vs 이전평균)를 써야 한다.
  // 첫값·끝값으로 따로 정하면 배경은 빨간데 그래프는 초록인 모순이 생긴다.
  const stroke = tone === 'up' ? '#059669' : tone === 'down' ? '#e11d48' : '#64748b';
  const fill = tone === 'up' ? '#05966912' : tone === 'down' ? '#e11d4812' : '#64748b0d';
  return (
    <svg width={width} height={height} className="block overflow-visible">
      <path d={area} fill={fill} />
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {/* 결측월은 점을 안 찍는다 — 선만 이어져 있으면 '데이터 없음' 이 안 보인다 */}
      {pts.map((p) => (
        <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={p.i === pts[pts.length - 1].i ? 2.4 : 1.2}
          fill={p.i === pts[pts.length - 1].i ? stroke : '#cbd5e1'} />
      ))}
    </svg>
  );
}

/** 카테고리 타일 — 월 비교 / 월별 추이 공용
 *  · 왼쪽 세로 막대 = 악화 영향액 규모 (가장 큰 것 대비 비율)
 *  · 배경색 = 증감 방향, 막대 = 규모. 둘을 나눠야 '금액 큰데 흰 타일' 같은 배신이 없다. */
function CatTile({
  name, count, headline, headlineUnit, sub, subLabel, delta, deltaLabel,
  barRatio, impactAmt, footL, footR, note, open, onClick, spark, muted, threshold,
}: {
  name: string; count: number;
  headline: string; headlineUnit: string;
  sub: string; subLabel: string;
  delta: number | null; deltaLabel: string;
  /** 이 값 미만의 증감은 '변화 없음' 으로 본다 — 잡음을 위험색으로 칠하지 않기 위해 */
  threshold: number;
  barRatio: number; impactAmt: number;
  footL: string; footR: string; footRTone?: string;
  note?: string; open: boolean; onClick: () => void;
  spark?: (number | null)[]; muted?: boolean;
}) {
  // 임계 미만은 '변화 없음'. -0.2%p 를 빨갛게 칠하면 진짜 신호가 묻힌다.
  const sig: 'up' | 'down' | 'flat' = delta === null || Math.abs(delta) < threshold
    ? 'flat' : delta < 0 ? 'down' : 'up';
  const bg = muted ? 'bg-gray-50 border-gray-200'
    : sig === 'down' ? 'bg-rose-50/70 border-rose-200'
      : sig === 'up' ? 'bg-emerald-50/60 border-emerald-200'
        : 'bg-white border-slate-200';
  const numColor = muted ? 'text-gray-400'
    : sig === 'down' ? 'text-rose-700' : sig === 'up' ? 'text-emerald-700' : 'text-slate-600';
  const barColor = muted ? 'bg-gray-300' : sig === 'down' ? 'bg-rose-500' : 'bg-slate-300';
  // 한 분류가 압도적이면 선형 비율은 나머지를 전부 0 으로 만들어 인코딩이 죽는다.
  // 제곱근으로 눌러 순서는 지키되 작은 것도 보이게 한다.
  const barH = barRatio > 0 ? Math.max(Math.sqrt(barRatio) * 100, 8) : 0;
  return (
    <button onClick={onClick}
      className={`relative text-left border rounded-xl pl-4 pr-3 py-2.5 overflow-hidden transition
        ${open ? 'ring-2 ring-slate-900 border-slate-900 shadow-md' : `${bg} hover:shadow-md hover:-translate-y-px`}`}>
      {/* 규모 막대 — 악화 영향액이 있을 때만 채운다 */}
      <span className="absolute left-0 top-0 bottom-0 w-1.5 bg-slate-100" />
      {impactAmt <= 0 && <span className="absolute left-0 bottom-0 w-1.5 h-0" />}
      <span className={`absolute left-0 bottom-0 w-1.5 ${barColor} transition-all`}
        style={{ height: `${barH}%` }} />

      <div className="flex items-baseline justify-between gap-1">
        <span className={`font-bold text-[13px] truncate ${muted ? 'text-gray-500' : 'text-gray-900'}`}>{name}</span>
        <span className="text-[10px] text-gray-400 shrink-0">{count}종</span>
      </div>

      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={`text-[26px] leading-none font-extrabold tabular-nums tracking-tight ${numColor}`}>
          {headline}
        </span>
        <span className="text-[11px] text-gray-400">{headlineUnit}</span>
        <span className="ml-auto text-[11px] text-gray-500 tabular-nums" title={subLabel}>{sub}</span>
      </div>

      {spark && spark.filter((v) => v !== null).length >= 2 && (
        <div className="mt-1 -mx-0.5"><Sparkline values={spark} tone={sig} /></div>
      )}

      <div className="mt-1 flex items-center justify-between text-[10.5px] tabular-nums">
        <span className="text-gray-400">{footL}</span>
        <span className={sig === 'down' ? 'text-rose-700 font-bold' : 'text-gray-400'}>{footR}</span>
      </div>
      {note && <div className="mt-0.5 text-[10px] text-amber-700 truncate">{note}</div>}
      <span className="sr-only">{deltaLabel}</span>
    </button>
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
