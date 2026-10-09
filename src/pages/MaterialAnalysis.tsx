import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, doc, getDoc, getDocs, onSnapshot, query, setDoc, where } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import type { AmbientEntry, Item, MachineEntry } from '../types';
import type { AmbientRecipe, Recipe } from '../lib/wasteCompute';
import { CODE_KEY_PREFIX, monthPriceKey, normalizeCode, normalizeMaterialName } from '../lib/wasteCompute';
import { canonicalShort } from '../lib/codeUtil';
import { computeFlexedDiff, computeMonthlyUsage, diffUsage } from '../lib/materialUsage';
import type { DiffRow, FlexedRow, UsageResult } from '../lib/materialUsage';
import { computeMonthlyProduction, filterProduction, STAGE_COLOR, STAGE_LETTERS } from '../lib/monthlyProduction';
import type { MonthlyProduction } from '../lib/monthlyProduction';
import { expandAmbientRecipeMap, expandRecipeMap } from '../lib/bomExpansion';
import { buildMaterialWorkbook, makePriceResolver } from '../lib/materialWorkbook';
import { PM_COL, toRawMonth } from '../lib/productionMonthly';
import type { ProductionMonthlyDoc } from '../lib/productionMonthly';
import { remapInputs } from '../lib/materialInputMap';
import { buildCategoryIndex, categoryOf } from '../lib/materialCategory';
import type { CategoryDoc } from '../lib/materialCategory';
import { buildDecompMaterials, buildDecompProducts, computeCostDecomp } from '../lib/costDecomp';
import CostDecompPanel from '../components/CostDecompPanel';
import type { DecompView } from '../components/CostDecompPanel';

/* ===== 캐시 ===== */
const PREFIX = 'matAnalysis:';
const TTL_PAST = 30 * 24 * 60 * 60 * 1000;
const TTL_CURRENT = 5 * 60 * 1000;
/** month 를 주면 '그 달이 끝나기 전에 저장한 캐시'는 버린다 — 진행 중이던 달의 부분 데이터가 달이 바뀐 뒤 30일짜리로 굳지 않게 */
function getCache<T>(key: string, ttl: number, month?: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const p = JSON.parse(raw) as { ts: number; data: T };
    let stale = Date.now() - p.ts > ttl;
    if (month) {
      const [y, m] = month.split('-').map(Number);
      const end = new Date(y, m, 1).getTime();   // 다음 달 1일 0시
      if (Date.now() >= end && p.ts < end) stale = true;   // 그 달이 끝났는데 끝나기 전에 저장한 것
    }
    if (stale) { localStorage.removeItem(PREFIX + key); return null; }
    return p.data;
  } catch { return null; }
}
function setCache<T>(key: string, data: T, keep: string[] = []) {
  const v = JSON.stringify({ ts: Date.now(), data });
  try { localStorage.setItem(PREFIX + key, v); } catch {
    // 한 달 원자료가 1MB 가 넘어 용량이 차기 쉽다 — 지금 쓰는 달 말고 다른 달 캐시를 지우고 한 번 더
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX + 'raw') && !keep.some((x) => k === PREFIX + x))
        .forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(PREFIX + key, v);
    } catch { /* 그래도 안 되면 캐시 없이 */ }
  }
}
function clearAllCache() {
  try { Object.keys(localStorage).forEach((k) => { if (k.startsWith(PREFIX)) localStorage.removeItem(k); }); } catch {}
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

/** 일자별 잔여량 합계 + 품목별 잔여량.
 *  품목별 값이 있으면 생산량을 계획비율로 안분하지 않고 품목별로 정확히 더할 수 있다. */
async function fetchMonthLogistics(month: string): Promise<{
  byDay: Record<string, number>;
  byDayCode: Record<string, Record<string, number>>;
}> {
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

interface RawMonth {
  entries: MachineEntry[];
  items: Item[];
  ambient: AmbientEntry[];
  logistics: Record<string, number>;
  logisticsByCode: Record<string, Record<string, number>>;
  /** 월별 생산수량(productionMonthly)으로 채운 달이면 그 문서의 updatedAt — 고치면 캐시를 버린다 */
  pmVer?: string;
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
  // entries 컬렉션그룹은 외포장(ambient)도 같이 잡힐 수 있어 machine 필드로 필터
  const entries: MachineEntry[] = [];
  ents.forEach((d) => {
    const data = d.data() as MachineEntry;
    if (!data.machine) return; // ambient 등 다른 entries 제외
    entries.push(data);
  });
  // 앱 생산 데이터가 하나도 없는 달(앱 도입 전)만 — 설정 › 월별 생산수량에 넣어 둔 마감 수량을 쓴다 (원재료수율과 같은 규칙)
  if (entries.length === 0 && its.empty && amb.empty && Object.keys(log.byDay).length === 0) {
    const pm = await getDoc(doc(db, PM_COL, month)).catch(() => null);
    if (pm?.exists()) {
      const d = pm.data() as ProductionMonthlyDoc;
      return { ...(toRawMonth(d) as RawMonth), pmVer: String(d.updatedAt || '') };
    }
  }
  const items: Item[] = its.docs.map((d) => d.data() as Item);
  const ambient: AmbientEntry[] = amb.docs.map((d) => d.data() as AmbientEntry);
  return { entries, items, ambient, logistics: log.byDay, logisticsByCode: log.byDayCode };
}

/** ERP 실투입 (설정 › 실제 투입중량) — 원재료수율 분석과 같은 문서 */
async function fetchInputs(month: string): Promise<{ inputs: Record<string, number>; names: Record<string, string> }> {
  const snap = await getDoc(doc(db, 'materialInput', month)).catch(() => null);
  const d = snap?.exists() ? (snap.data() as { inputs?: Record<string, number>; names?: Record<string, string> }) : {};
  return { inputs: d.inputs || {}, names: d.names || {} };
}

export default function MaterialAnalysis() {
  const tm = thisMonth();
  const [monthA, setMonthA] = useState(shiftMonth(tm, -2));
  const [monthB, setMonthB] = useState(shiftMonth(tm, -1));
  const [running, setRunning] = useState(false);
  const [aResult, setAResult] = useState<UsageResult | null>(null);
  const [bResult, setBResult] = useState<UsageResult | null>(null);
  const [aResultBPrice, setAResultBPrice] = useState<UsageResult | null>(null);
  const [diff, setDiff] = useState<DiffRow[]>([]);
  const [flexed, setFlexed] = useState<FlexedRow[]>([]);
  const [aQty, setAQty] = useState<number>(0);   // A월 총생산량 EA (자동 채움, 사용자 수정 가능)
  const [bQty, setBQty] = useState<number>(0);
  const [aProd, setAProd] = useState<MonthlyProduction | null>(null);
  const [bProd, setBProd] = useState<MonthlyProduction | null>(null);
  const [aRaw, setARaw] = useState<RawMonth | null>(null);
  const [bRaw, setBRaw] = useState<RawMonth | null>(null);
  // 분석1 — 원재료로 제품 필터
  const [prodSearch, setProdSearch] = useState<string>('');
  const [excludedIng, setExcludedIng] = useState<string[]>([]);
  // 원재료명 별칭 — Firestore 공유 (appMeta/materialAliases)
  //  - 기존 사용자의 localStorage 데이터는 처음 한 번 Firestore 로 자동 이전(merge)
  const NAME_OVERRIDE_KEY = PREFIX + 'nameOverrides';
  const NAME_OVERRIDE_MIGRATED_KEY = PREFIX + 'nameOverridesMigrated';
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>({});
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'appMeta', 'materialAliases'), (snap) => {
      const data = snap.exists() ? (snap.data() as { overrides?: Record<string, string> }) : {};
      setNameOverrides(data.overrides || {});
    });
    // 1회 이전: 기존 localStorage 의 별칭을 서버에 머지 (충돌은 서버 우선)
    try {
      if (!localStorage.getItem(NAME_OVERRIDE_MIGRATED_KEY)) {
        const local = JSON.parse(localStorage.getItem(NAME_OVERRIDE_KEY) || '{}');
        if (local && Object.keys(local).length > 0) {
          getDoc(doc(db, 'appMeta', 'materialAliases')).then((snap) => {
            const server = (snap.exists() && (snap.data() as { overrides?: Record<string, string> }).overrides) || {};
            const merged = { ...local, ...server };  // 서버값 우선
            setDoc(doc(db, 'appMeta', 'materialAliases'), { overrides: merged, updatedAt: new Date().toISOString() }, { merge: true })
              .then(() => { localStorage.setItem(NAME_OVERRIDE_MIGRATED_KEY, '1'); })
              .catch(() => {});
          }).catch(() => {});
        } else {
          localStorage.setItem(NAME_OVERRIDE_MIGRATED_KEY, '1');
        }
      }
    } catch {}
    return unsub;
  }, []);
  // 캐시 키를 raw3 로 올리면서 더는 안 읽는 옛 raw2 를 지운다 (한 달 1MB 넘어 용량을 막는다)
  useEffect(() => {
    try { Object.keys(localStorage).filter((k) => k.startsWith(PREFIX + 'raw2:')).forEach((k) => localStorage.removeItem(k)); } catch {}
  }, []);
  const [expandStages, setExpandStages] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  // 원가율 분해(화면) — 분석을 돌린 두 달의 실투입·원재료 분류
  const [decompSrc, setDecompSrc] = useState<{
    months: { a: string; b: string };
    a: { inputs: Record<string, number>; names: Record<string, string> };
    b: { inputs: Record<string, number>; names: Record<string, string> };
    cats: CategoryDoc[];
  } | null>(null);

  // 마스터 DB 구독
  const [recipeMap, setRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [ambientRecipeMap, setAmbientRecipeMap] = useState<Map<string, AmbientRecipe>>(new Map());
  const [subRecipeMap, setSubRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [expandSub, setExpandSub] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem('matAnalysis:expandSub') || 'true'); } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem('matAnalysis:expandSub', JSON.stringify(expandSub)); } catch {} }, [expandSub]);
  const [priceMap, setPriceMap] = useState<Map<string, number>>(new Map());
  const [priceNameByCode, setPriceNameByCode] = useState<Map<string, string>>(new Map());
  // 분석용(수율 전용) 레시피 — 원재료수율 분석과 같은 DB. 비어 있으면 현장 BOM 으로 폴백한다
  const [yRecipeMap, setYRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [ySubMap, setYSubMap] = useState<Map<string, Recipe>>(new Map());
  const [yAmbientMap, setYAmbientMap] = useState<Map<string, AmbientRecipe>>(new Map());
  const [recipeSrc, setRecipeSrc] = useState<'yield' | 'bom'>(() => {
    try { return localStorage.getItem(PREFIX + 'recipeSrc') === 'bom' ? 'bom' : 'yield'; } catch { return 'yield'; }
  });
  useEffect(() => { try { localStorage.setItem(PREFIX + 'recipeSrc', recipeSrc); } catch {} }, [recipeSrc]);
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
  // 실제로 쓸 레시피 — 원재료수율 분석과 같은 폴백 규칙
  const useYieldDb = recipeSrc === 'yield' && yRecipeMap.size > 0;
  const srcRecipe = useYieldDb ? yRecipeMap : recipeMap;
  const srcSub = useYieldDb && ySubMap.size > 0 ? ySubMap : subRecipeMap;
  const srcAmbient = useYieldDb && yAmbientMap.size > 0 ? yAmbientMap : ambientRecipeMap;
  const recipeLabel = useYieldDb ? '분석용 레시피 (원재료수율과 같음)' : '현장 BOM 레시피';

  useEffect(() => {
    return onSnapshot(collection(db, 'recipes'), (snap) => {
      const m = new Map<string, Recipe>();
      snap.forEach((d) => {
        const data = d.data() as Recipe;
        m.set(d.id, { ...data, code: d.id });
        m.set(d.id.toLowerCase(), { ...data, code: d.id }); // 대소문자 호환
      });
      setRecipeMap(m);
    });
  }, []);
  useEffect(() => {
    return onSnapshot(collection(db, 'subRecipes'), (snap) => {
      const m = new Map<string, Recipe>();
      snap.forEach((d) => {
        const data = d.data() as Recipe;
        m.set(d.id, { ...data, code: d.id });
        m.set(d.id.toLowerCase(), { ...data, code: d.id });
      });
      setSubRecipeMap(m);
    });
  }, []);
  useEffect(() => {
    return onSnapshot(collection(db, 'ambientRecipes'), (snap) => {
      const m = new Map<string, AmbientRecipe>();
      snap.forEach((d) => {
        const data = d.data() as AmbientRecipe;
        m.set(d.id, { ...data, batchPieces: Number(data.batchPieces) || 1 });
      });
      setAmbientRecipeMap(m);
    });
  }, []);
  useEffect(() => {
    // 단가: 재고평가현황(materialPricesInventory) — 출고금액÷출고수량 실측 평균단가
    return onSnapshot(collection(db, 'materialPricesInventory'), (snap) => {
      const m = new Map<string, number>();
      const nm = new Map<string, string>();   // 코드키 → 단가표상 정식 원재료명
      snap.forEach((d) => {
        const data = d.data() as { month?: string; name?: string; pricePerGram?: number; code?: string };
        const month = data.month || '';
        if (!month) return;
        const price = Number(data.pricePerGram) || 0;
        if (data.name) m.set(monthPriceKey(month, normalizeMaterialName(data.name)), price);
        if (data.code) {
          const ck = CODE_KEY_PREFIX + normalizeCode(data.code);
          m.set(monthPriceKey(month, ck), price);
          // 레시피엔 뭉뚱그린 이름(예: 한우(익,민찌))이 들어가도, 표시는 단가표의 정식명 사용
          if (data.name && !nm.has(ck)) nm.set(ck, data.name);
        }
      });
      setPriceMap(m);
      setPriceNameByCode(nm);
    });
  }, []);

  // 반제품 펼침 옵션 적용된 effective 레시피 맵
  const effRecipeMap = useMemo(() => (expandSub ? expandRecipeMap(srcRecipe, srcSub) : srcRecipe), [srcRecipe, srcSub, expandSub]);
  const effAmbientRecipeMap = useMemo(() => (expandSub ? expandAmbientRecipeMap(srcAmbient, srcSub) : srcAmbient), [srcAmbient, srcSub, expandSub]);

  const runAnalysis = async (bustCache = false) => {
    if (monthA === monthB) { setErr('A·B 월이 같습니다. 다른 월을 선택해주세요.'); return; }
    setRunning(true); setErr(null);
    try {
      const fetchOrCache = async (m: string): Promise<RawMonth> => {
        // 지난달도 월초 정정이 잦아 짧게 둔다 (원재료수율 화면과 같은 규칙)
        const ttl = m >= shiftMonth(tm, -1) ? TTL_CURRENT : TTL_PAST;
        if (!bustCache) {
          const c = getCache<RawMonth>(`raw3:${m}`, ttl, m);
          // 월별 생산수량으로 채운 달은 그 문서가 바뀌었으면 다시 읽는다. 빈 달도 나중에 수량을 넣었을 수 있으니 다시 읽는다.
          const empty = c && c.entries.length === 0 && c.items.length === 0 && c.ambient.length === 0 && Object.keys(c.logistics).length === 0;
          let stale = !!empty;
          if (c && c.pmVer !== undefined) {
            const now = await getDoc(doc(db, PM_COL, m)).then((x) => (x.exists() ? String((x.data() as ProductionMonthlyDoc).updatedAt || '') : '')).catch(() => c.pmVer);
            stale = now !== c.pmVer;
          }
          if (c && !stale) return c;
        }
        const r = await fetchMonth(m);
        setCache(`raw3:${m}`, r, [`raw3:${monthA}`, `raw3:${monthB}`]);
        return r;
      };
      const [aRaw, bRaw, inA, inB, cats] = await Promise.all([
        fetchOrCache(monthA), fetchOrCache(monthB), fetchInputs(monthA), fetchInputs(monthB),
        getDocs(collection(db, 'materialCategories'))
          .then((snap) => snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CategoryDoc, 'id'>) })))
          .catch(() => [] as CategoryDoc[]),
      ]);
      setDecompSrc({ months: { a: monthA, b: monthB }, a: inA, b: inB, cats });
      // 분석 1 — 월별 생산 분해 (단계·품목·실온)
      const aProd_ = computeMonthlyProduction(aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, aRaw.logisticsByCode);
      const bProd_ = computeMonthlyProduction(bRaw.entries, bRaw.items, bRaw.ambient, bRaw.logistics, bRaw.logisticsByCode);
      setAProd(aProd_); setBProd(bProd_);

      // 분석 2 — 각 월 자체 단가 결과 (기존 표)
      const aRes = computeMonthlyUsage(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap, undefined, aRaw.logisticsByCode);
      const bRes = computeMonthlyUsage(monthB, bRaw.entries, bRaw.items, bRaw.ambient, bRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap, undefined, bRaw.logisticsByCode);
      // A월 데이터를 B월 단가로 재평가 (Flexed Budget)
      const aResB = computeMonthlyUsage(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap, monthB, aRaw.logisticsByCode);
      setAResult(aRes); setBResult(bRes); setAResultBPrice(aResB);
      setDiff(diffUsage(aRes, bRes));

      // 총생산량 EA 자동 채움 (분석 1 결과 재사용 → 월별현황과 일치)
      setAQty(aProd_.total);
      setBQty(bProd_.total);
      setARaw(aRaw); setBRaw(bRaw);
    } catch (e: any) {
      console.error('[MaterialAnalysis] failed:', e);
      setErr(e?.message || '분석 중 오류 발생');
    } finally { setRunning(false); }
  };



  // 연동 비율 (A월 → B월 규모) — EA 기본, 생산금액 둘 다 입력 시 ₩ 토글 가능
  // 반제품 펼침 토글이나 레시피 DB 변경 시 분석 결과 자동 재계산 (raw 있을 때만)
  useEffect(() => {
    if (!aRaw || !bRaw) return;
    const aRes = computeMonthlyUsage(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap, undefined, aRaw.logisticsByCode);
    const bRes = computeMonthlyUsage(monthB, bRaw.entries, bRaw.items, bRaw.ambient, bRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap, undefined, bRaw.logisticsByCode);
    const aResB = computeMonthlyUsage(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap, monthB, aRaw.logisticsByCode);
    setAResult(aRes); setBResult(bRes); setAResultBPrice(aResB);
    setDiff(diffUsage(aRes, bRes));
  }, [effRecipeMap, effAmbientRecipeMap, priceMap, aRaw, bRaw, monthA, monthB]);


  // Flexed Budget — 입력 변화에 반응
  useEffect(() => {
    if (!aResultBPrice || !bResult) { setFlexed([]); return; }
    setFlexed(computeFlexedDiff(aResultBPrice.rows, bResult.rows, aQty, bQty));
  }, [aResultBPrice, bResult, aQty, bQty]);

  const clearAll = () => {
    if (!confirm('분석 결과와 캐시를 모두 삭제할까요?')) return;
    clearAllCache();
    setAResult(null); setBResult(null); setAResultBPrice(null);
    setAProd(null); setBProd(null); setARaw(null); setBRaw(null);
    setDiff([]); setFlexed([]);
    setAQty(0); setBQty(0);
    setProdSearch(''); setExcludedIng([]); setErr(null); setDecompSrc(null);
  };


  // ===== 분석1 원재료 필터 =====
  const ingKeyOf = (name: string, code?: string) =>
    code ? (CODE_KEY_PREFIX + normalizeCode(code)) : normalizeMaterialName(name);

  // 검색어로 매칭되는 원재료 후보 (별칭 포함). dedup by key
  const prodIngMatches = useMemo(() => {
    const q = prodSearch.trim().toLowerCase();
    if (!q) return [] as { key: string; name: string; code?: string }[];
    const seen = new Map<string, { key: string; name: string; code?: string }>();
    const scan = (ings: { name: string; code?: string }[]) => {
      ings.forEach((ing) => {
        const key = ingKeyOf(ing.name, ing.code);
        const disp = nameOverrides[key] || ing.name;
        if (ing.name.toLowerCase().includes(q) || (ing.code || '').toLowerCase().includes(q) || disp.toLowerCase().includes(q)) {
          if (!seen.has(key)) seen.set(key, { key, name: disp, code: ing.code });
        }
      });
    };
    srcRecipe.forEach((r) => scan(r.ingredients));
    srcAmbient.forEach((r) => scan(r.ingredients));
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [prodSearch, srcRecipe, srcAmbient, nameOverrides]);

  // 포함(미제외) 원재료를 쓰는 제품 집합
  const prodFilter = useMemo(() => {
    const included = new Set(prodIngMatches.map((m) => m.key).filter((k) => !excludedIng.includes(k)));
    if (included.size === 0) return null;
    const coldCodes = new Set<string>();
    const ambientNames = new Set<string>();
    srcRecipe.forEach((r) => {
      if (r.ingredients.some((ing) => included.has(ingKeyOf(ing.name, ing.code)))) {
        const k = canonicalShort(r.code || '');
        if (k) coldCodes.add(k);
      }
    });
    srcAmbient.forEach((r, id) => {
      if (r.ingredients.some((ing) => included.has(ingKeyOf(ing.name, ing.code)))) {
        ambientNames.add(normalizeMaterialName(r.name || id));
      }
    });
    return { coldCodes, ambientNames };
  }, [prodIngMatches, excludedIng, srcRecipe, srcAmbient]);

  const aProdView = useMemo(
    () => (aProd && prodFilter ? filterProduction(aProd, prodFilter.coldCodes, prodFilter.ambientNames) : aProd),
    [aProd, prodFilter],
  );
  const bProdView = useMemo(
    () => (bProd && prodFilter ? filterProduction(bProd, prodFilter.coldCodes, prodFilter.ambientNames) : bProd),
    [bProd, prodFilter],
  );

  // ===== 원가율 분해 (화면) =====
  // 반제품은 항상 원물로 펼친다 — 실투입(ERP)이 원물 기준이라 원재료수율 화면·수식 엑셀과 같은 기준이어야 한다
  const productNameByCode = useMemo(() => {
    const m = new Map<string, string>();
    [aRaw, bRaw].forEach((r) => r?.items.forEach((it) => {
      const k = canonicalShort(it.code || '');
      if (k && it.name && it.name !== it.code) m.set(k, it.name);
    }));
    return m;
  }, [aRaw, bRaw]);
  const decompOf = (useYield: boolean): DecompView | null => {
    if (!aRaw || !bRaw || !aProd || !bProd || !decompSrc) return null;
    const R = useYield ? yRecipeMap : recipeMap;
    const S = useYield && ySubMap.size > 0 ? ySubMap : subRecipeMap;
    const Am = useYield && yAmbientMap.size > 0 ? yAmbientMap : ambientRecipeMap;
    const eff = expandRecipeMap(R, S);
    const effA = expandAmbientRecipeMap(Am, S);
    const { a: mA, b: mB } = decompSrc.months;
    const ua = computeMonthlyUsage(mA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, eff, effA, priceMap, undefined, aRaw.logisticsByCode);
    const ub = computeMonthlyUsage(mB, bRaw.entries, bRaw.items, bRaw.ambient, bRaw.logistics, eff, effA, priceMap, undefined, bRaw.logisticsByCode);
    const catIdx = buildCategoryIndex(decompSrc.cats);
    const mats = buildDecompMaterials({
      monthA: mA, stdA: ua.rows, stdB: ub.rows, inputA: decompSrc.a, inputB: decompSrc.b,
      priceRes: makePriceResolver(priceMap, mB), priceNameByCode,
      categoryOf: (c, n) => categoryOf(catIdx, c, n), excludeTerms: ['정제수'],
    });
    const prods = buildDecompProducts({ aProd, bProd, recipeMap: eff, ambientRecipeMap: effA, productNameByCode });
    return {
      result: computeCostDecomp(mats, prods),
      recipeLabel: useYield ? '분석용 레시피' : '현장 BOM 레시피',
      coverage: { a: ua.coverage.coveredPct, b: ub.coverage.coveredPct, missingA: ua.coverage.missingQty, missingB: ub.coverage.missingQty },
      hasActualA: Object.values(decompSrc.a.inputs).some((g) => Number(g) > 0),
      hasActualB: Object.values(decompSrc.b.inputs).some((g) => Number(g) > 0),
    };
  };
  const decompDeps = [aRaw, bRaw, aProd, bProd, decompSrc, recipeMap, subRecipeMap, ambientRecipeMap, yRecipeMap, ySubMap, yAmbientMap, priceMap, priceNameByCode, productNameByCode];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const decompView = useMemo(() => decompOf(useYieldDb), [...decompDeps, useYieldDb]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const decompAlt = useMemo(() => (yRecipeMap.size > 0 ? decompOf(!useYieldDb) : null), [...decompDeps, useYieldDb]);

  // 각 월 자체 단가 합계 (기존 비교용)
  const aTotal = aResult?.rows.reduce((s, r) => s + r.cost, 0) || 0;
  const bTotal = bResult?.rows.reduce((s, r) => s + r.cost, 0) || 0;
  const diffTotal = bTotal - aTotal;
  const diffPct = aTotal > 0 ? (diffTotal / aTotal) * 100 : 0;


  // Flexed 합계
  const flexAtotal = flexed.reduce((s, r) => s + r.aCost, 0);
  const flexBtotal = flexed.reduce((s, r) => s + r.bCost, 0);
  const flexFlexedTotal = flexed.reduce((s, r) => s + r.flexedCost, 0);
  const flexDiffTotal = flexFlexedTotal - flexBtotal;
  const flexDiffPct = flexFlexedTotal > 0 ? (flexDiffTotal / flexFlexedTotal) * 100 : 0;

  const downloadXlsx = async () => {
    if (!aResult || !bResult) return;
    const wb = new ExcelJS.Workbook();
    const thin = { style: 'thin' as const };
    const border = { top: thin, left: thin, right: thin, bottom: thin };
    const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
    const baseFont = { size: 11, name: '맑은 고딕' };

    // ===== 시트 1: 연동 분석 (Flexed Budget) =====
    const wf = wb.addWorksheet('연동 분석');
    wf.columns = [
      { width: 6 }, { width: 24 }, { width: 12 },
      { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 },
    ];
    wf.mergeCells('A1:H1');
    const ft = wf.getCell('A1');
    ft.value = `연동 분석 (${monthB} 단가 기준) — ${monthA} vs ${monthB} | 연동대비 ${Math.round(flexDiffTotal).toLocaleString()}원 (${flexDiffPct >= 0 ? '+' : ''}${flexDiffPct.toFixed(1)}%)`;
    ft.font = { size: 14, bold: true, name: '맑은 고딕' };
    ft.alignment = { horizontal: 'center', vertical: 'middle' };
    ['순위', '원재료', '코드', `${monthA} 금액`, '연동 금액', `${monthB} 금액`, '연동대비차액', '차이율(%)']
      .forEach((h, i) => {
        const c = wf.getCell(3, i + 1);
        c.value = h; c.font = { ...baseFont, bold: true };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.fill = fill('FFE0E7FF'); c.border = border;
      });
    flexed.forEach((row, idx) => {
      const r = 4 + idx;
      wf.getCell(r, 1).value = idx + 1;
      wf.getCell(r, 2).value = row.name;
      wf.getCell(r, 3).value = row.code || '';
      // 원본 정밀도 그대로 — 표시 포맷만 적용, 셀 클릭 시 full 값
      wf.getCell(r, 4).value = row.aCost;
      wf.getCell(r, 5).value = row.flexedCost;
      wf.getCell(r, 6).value = row.bCost;
      wf.getCell(r, 7).value = row.diffCost;
      wf.getCell(r, 8).value = row.diffPct;
      for (let c = 1; c <= 8; c++) {
        const cell = wf.getCell(r, c);
        cell.font = baseFont; cell.border = border;
        cell.alignment = { horizontal: c <= 3 ? (c === 2 ? 'left' : 'center') : 'right', vertical: 'middle' };
        if (c >= 4 && c <= 7) cell.numFmt = '#,##0.00########';
        if (c === 8) cell.numFmt = '+#,##0.0000########;-#,##0.0000########;0';
      }
    });
    const fTotRow = 4 + flexed.length;
    wf.getCell(fTotRow, 1).value = '합계';
    wf.mergeCells(fTotRow, 1, fTotRow, 3);
    wf.getCell(fTotRow, 4).value = flexAtotal;
    wf.getCell(fTotRow, 5).value = flexFlexedTotal;
    wf.getCell(fTotRow, 6).value = flexBtotal;
    wf.getCell(fTotRow, 7).value = flexDiffTotal;
    wf.getCell(fTotRow, 8).value = flexDiffPct;
    for (let c = 1; c <= 8; c++) {
      const cell = wf.getCell(fTotRow, c);
      cell.font = { ...baseFont, bold: true }; cell.border = border; cell.fill = fill('FFFEF9C3');
      cell.alignment = { horizontal: c <= 3 ? 'center' : 'right', vertical: 'middle' };
      if (c >= 4 && c <= 7) cell.numFmt = '#,##0.00########';
      if (c === 8) cell.numFmt = '+#,##0.0000########;-#,##0.0000########;0';
    }

    const ws = wb.addWorksheet('원재료별 비교(각월단가)');
    ws.columns = [
      { width: 6 }, { width: 24 }, { width: 12 },
      { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
      { width: 14 }, { width: 10 },
    ];
    ws.mergeCells('A1:I1');
    const t = ws.getCell('A1');
    t.value = `원재료분석 — ${monthA} vs ${monthB} | 차액 ${Math.round(diffTotal).toLocaleString()}원 (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%)`;
    t.font = { size: 14, bold: true, name: '맑은 고딕' };
    t.alignment = { horizontal: 'center', vertical: 'middle' };

    ['순위', '원재료', '코드', `${monthA} 사용량(g)`, `${monthA} 금액(원)`, `${monthB} 사용량(g)`, `${monthB} 금액(원)`, '차액(원)', '차이율(%)']
      .forEach((h, i) => {
        const c = ws.getCell(3, i + 1);
        c.value = h; c.font = { ...baseFont, bold: true };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.fill = fill('FFE2E8F0'); c.border = border;
      });
    diff.forEach((row, idx) => {
      const r = 4 + idx;
      ws.getCell(r, 1).value = idx + 1;
      ws.getCell(r, 2).value = row.name;
      ws.getCell(r, 3).value = row.code || '';
      ws.getCell(r, 4).value = row.aGrams;
      ws.getCell(r, 5).value = row.aCost;
      ws.getCell(r, 6).value = row.bGrams;
      ws.getCell(r, 7).value = row.bCost;
      ws.getCell(r, 8).value = row.diffCost;
      ws.getCell(r, 9).value = row.diffPct;
      for (let c = 1; c <= 9; c++) {
        const cell = ws.getCell(r, c);
        cell.font = baseFont; cell.border = border;
        cell.alignment = { horizontal: c <= 3 ? (c === 2 ? 'left' : 'center') : 'right', vertical: 'middle' };
        if (c >= 4 && c <= 8) cell.numFmt = '#,##0.00########';
        if (c === 9) cell.numFmt = '+#,##0.0000########;-#,##0.0000########;0';
      }
    });
    // 합계 행
    const totRow = 4 + diff.length;
    ws.getCell(totRow, 1).value = '합계';
    ws.mergeCells(totRow, 1, totRow, 4);
    ws.getCell(totRow, 5).value = aTotal;
    ws.getCell(totRow, 6).value = '';
    ws.getCell(totRow, 7).value = bTotal;
    ws.getCell(totRow, 8).value = diffTotal;
    ws.getCell(totRow, 9).value = diffPct;
    for (let c = 1; c <= 9; c++) {
      const cell = ws.getCell(totRow, c);
      cell.font = { ...baseFont, bold: true }; cell.border = border; cell.fill = fill('FFFEF9C3');
      cell.alignment = { horizontal: c <= 4 ? 'center' : 'right', vertical: 'middle' };
      if (c === 5 || c === 7 || c === 8) cell.numFmt = '#,##0.00########';
      if (c === 9) cell.numFmt = '+#,##0.0000########;-#,##0.0000########;0';
    }

    // 미매칭 시트
    const ws2 = wb.addWorksheet('미매칭');
    ws2.columns = [{ width: 12 }, { width: 36 }];
    const writeMissing = (startRow: number, title: string, list: string[]) => {
      ws2.mergeCells(startRow, 1, startRow, 2);
      const c = ws2.getCell(startRow, 1);
      c.value = title; c.font = { ...baseFont, bold: true }; c.fill = fill('FFE2E8F0');
      list.forEach((v, i) => {
        ws2.getCell(startRow + 1 + i, 1).value = i + 1;
        ws2.getCell(startRow + 1 + i, 2).value = v;
      });
      return startRow + 1 + list.length + 1;
    };
    let r = 1;
    r = writeMissing(r, `${monthA} 냉장 - 레시피 미등록 코드`, aResult.missingColdCodes);
    r = writeMissing(r, `${monthB} 냉장 - 레시피 미등록 코드`, bResult.missingColdCodes);
    r = writeMissing(r, `${monthA} 실온 - 레시피 미등록 제품`, aResult.missingAmbientNames);
    r = writeMissing(r, `${monthB} 실온 - 레시피 미등록 제품`, bResult.missingAmbientNames);
    r = writeMissing(r, `${monthA} 단가 미입력 원재료`, aResult.missingPrices);
    r = writeMissing(r, `${monthB} 단가 미입력 원재료`, bResult.missingPrices);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `원재료분석_${monthA}_vs_${monthB}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  // 수식이 살아있는 엑셀 — 레시피/단가/생산량 DB를 그대로 넣고 엑셀에서 재계산되게 만든다
  const [wbBusy, setWbBusy] = useState(false);
  const downloadFormulaXlsx = async () => {
    if (!aProd || !bProd || !aResult || !bResult) return;
    setWbBusy(true);
    try {
      const productNameByCode = new Map<string, string>();
      [aRaw, bRaw].forEach((r) => r?.items.forEach((it) => {
        const k = canonicalShort(it.code || '');
        if (k && it.name && it.name !== it.code) productNameByCode.set(k, it.name);
      }));
      // 제품 DB(productSettings) 에서 전체 ERP 코드(A-001-01) 를 가져와 품목코드 표기에 사용
      // 부가정보 — 실패해도 워크북 생성은 계속한다
      const productCodes = await getDocs(collection(db, 'productSettings'))
        .then((snap) => snap.docs.map((d) => {
          const v = d.data() as { code?: string; name?: string };
          return { code: v.code || d.id, name: v.name };
        }))
        .catch((e) => { console.warn('[productSettings]', e); return [] as { code: string; name?: string }[]; });
      // ERP 마감 실제 출고 (materialOutflow/{month}) — 원재료별 실제 사용량·금액
      const fetchOutflow = (m: string) => getDoc(doc(db, 'materialOutflow', m))
        .then((snap) => {
          const d = snap.exists() ? (snap.data() as { outflowGrams?: Record<string, number>; outflowAmounts?: Record<string, number> }) : {};
          return { grams: d.outflowGrams || {}, amounts: d.outflowAmounts || {} };
        })
        .catch((e) => { console.warn('[materialOutflow]', m, e); return { grams: {}, amounts: {} }; });
      const [outA, outB] = await Promise.all([fetchOutflow(monthA), fetchOutflow(monthB)]);
      // ERP 실투입 — 원가율 분해(수율·제품구성)에 쓴다. 키는 원재료수율 분석과 같은 규칙으로 표준소요 키에 맞춘 뒤
      // 워크북 원재료키(코드는 접두사 없는 ERP 코드)로 바꾼다.
      const [inA, inB, catDocs] = await Promise.all([
        fetchInputs(monthA), fetchInputs(monthB),
        getDocs(collection(db, 'materialCategories'))
          .then((snap) => snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CategoryDoc, 'id'>) })))
          .catch(() => [] as CategoryDoc[]),
      ]);
      // 수식 엑셀은 반제품 펼침 체크와 무관하게 항상 원물로 펼친다 — 실투입(ERP)은 원물만 있어 원가율분해·수율이
      // 원재료수율 화면과 같은 기준이어야 한다. 체크를 끈 상태면 엑셀용으로 다시 계산한다.
      const wbRecipe = expandSub ? effRecipeMap : expandRecipeMap(srcRecipe, srcSub);
      const wbAmbient = expandSub ? effAmbientRecipeMap : expandAmbientRecipeMap(srcAmbient, srcSub);
      const usage = (m: string, raw: RawMonth) => computeMonthlyUsage(m, raw.entries, raw.items, raw.ambient, raw.logistics, wbRecipe, wbAmbient, priceMap, undefined, raw.logisticsByCode);
      const resA = expandSub || !aRaw ? aResult : usage(monthA, aRaw);
      const resB = expandSub || !bRaw ? bResult : usage(monthB, bRaw);
      const unionRows = [...resA.rows, ...resB.rows].map((r) => ({ key: r.key, name: r.name }));
      const wbKey = (k: string) => (k.startsWith(CODE_KEY_PREFIX) ? k.slice(CODE_KEY_PREFIX.length) : k);
      const toWb = (m: Record<string, number>) => {
        const o: Record<string, number> = {};
        Object.entries(m).forEach(([k, g]) => { const w = wbKey(k); o[w] = (o[w] || 0) + (Number(g) || 0); });
        return o;
      };
      const actualNames: Record<string, string> = {};
      [inA.names, inB.names].forEach((nm) => Object.entries(nm).forEach(([k, v]) => { if (v && !actualNames[wbKey(k)]) actualNames[wbKey(k)] = v; }));
      const catIdx = buildCategoryIndex(catDocs);
      // 검증 행(앱 vs 엑셀 ③)도 워크북과 같은 단가 규칙으로 — A월은 단가가 없으면 B월(없으면 가까운 달) 단가
      const res = makePriceResolver(priceMap, monthB);
      const ref = (r: { name: string; code?: string }) => {
        const code = r.code ? normalizeCode(r.code) : '';
        return { code, name: priceNameByCode.get(CODE_KEY_PREFIX + code) || r.name, matchName: r.name };
      };
      const appTotalA = resA.rows.reduce((s2, r) => s2 + r.grams * (res.lookup(monthA, ref(r)) ?? res.bApplied(ref(r)).price), 0);
      const appTotalB = resB.rows.reduce((s2, r) => s2 + r.grams * res.bApplied(ref(r)).price, 0);
      // 그 두 달 생산 데이터에 실제로 찍힌 원본 전체코드 (변형 -01/-51 구분용)
      const producedCodes = Array.from(new Set([
        ...(aRaw?.items || []).map((it) => it.code || ''),
        ...(bRaw?.items || []).map((it) => it.code || ''),
        ...(aRaw?.entries || []).map((e) => e.code || ''),
        ...(bRaw?.entries || []).map((e) => e.code || ''),
      ].filter(Boolean)));
      const blob = await buildMaterialWorkbook({
        monthA, monthB, aProd, bProd, productNameByCode,
        recipeMap: wbRecipe, ambientRecipeMap: wbAmbient,
        priceMap, priceNameByCode,
        appTotalA, appTotalB,
        productCodes, producedCodes,
        outflowA: outA, outflowB: outB,
        recipeLabel,
        actualA: toWb(remapInputs(unionRows, inA.inputs, inA.names).byStdKey),
        actualB: toWb(remapInputs(unionRows, inB.inputs, inB.names).byStdKey),
        actualNames,
        categoryOf: (code, name) => categoryOf(catIdx, code, name),
        categoryOrder: catIdx.categories,
        excludeTerms: ['정제수'],
        highCostTerms: ['한우', '전복', '게살', '관자'],
        highCostExcludes: ['사골육수'],
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `원재료비_계산서_${monthA}_vs_${monthB}${useYieldDb ? '_분석용레시피' : ''}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      console.error('[formula xlsx]', e);
      alert('엑셀 생성 실패: ' + (e?.message || e));
    } finally { setWbBusy(false); }
  };

  const missing = useMemo(() => {
    if (!aResult || !bResult) return null;
    const cold = Array.from(new Set([...aResult.missingColdCodes, ...bResult.missingColdCodes]));
    const ambient = Array.from(new Set([...aResult.missingAmbientNames, ...bResult.missingAmbientNames]));
    const prices = Array.from(new Set([...aResult.missingPrices, ...bResult.missingPrices]));
    return { cold, ambient, prices };
  }, [aResult, bResult]);

  return (
    <div className="space-y-5">
      {/* 상단 액션바 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-gray-800 text-lg">🧪 원재료분석</span>
        <span className="text-gray-300">|</span>
        <span className="text-xs text-gray-500">비교월</span>
        <span className="text-xs font-semibold text-blue-700">A</span>
        <input type="month" value={monthA} onChange={(e) => e.target.value && setMonthA(e.target.value)} className="border rounded px-2 py-1 text-sm font-bold" />
        <span className="text-gray-400">vs</span>
        <span className="text-xs font-semibold text-rose-700">B</span>
        <input type="month" value={monthB} onChange={(e) => e.target.value && setMonthB(e.target.value)} className="border rounded px-2 py-1 text-sm font-bold" />
        <div className="flex items-center text-xs rounded border overflow-hidden" title="원재료 계산에 쓸 레시피. 분석용 = 원재료수율 분석과 같은 레시피(설정 › 분석용 레시피)">
          <span className="px-2 py-1 bg-gray-50 text-gray-500">레시피</span>
          {([['yield', '분석용'], ['bom', '현장 BOM']] as const).map(([v, label]) => (
            <button key={v} onClick={() => setRecipeSrc(v)}
              className={`px-2 py-1 font-semibold ${recipeSrc === v ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{label}</button>
          ))}
        </div>
        {recipeSrc === 'yield' && yRecipeMap.size === 0 && (
          <span className="text-[11px] text-amber-700">분석용 레시피가 비어 있어 현장 BOM 으로 계산합니다</span>
        )}
        {(srcSub.size > 0) && (
          <label className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border bg-emerald-50 cursor-pointer hover:bg-emerald-100" title="반제품(순수본베이스/디포리육수 등)을 원물 단위로 자동 분해해 계산. 끄면 반제품을 그대로 한 원재료로 봄">
            <input type="checkbox" checked={expandSub} onChange={(e) => setExpandSub(e.target.checked)} />
            <span className="font-semibold text-emerald-700">🧪 반제품 펼침</span>
            <span className="text-emerald-500">({expandSub ? '원물' : '반제품'})</span>
          </label>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => runAnalysis(true)} disabled={running} title="캐시 무시" className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50 disabled:opacity-50">🔄</button>
          <button onClick={downloadXlsx} disabled={!aResult || !bResult} className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:bg-gray-300">📥 엑셀</button>
          <button onClick={downloadFormulaXlsx} disabled={!aResult || !bResult || !aProd || !bProd || wbBusy}
            title="레시피·단가·생산량·실투입 DB가 수식으로 연결된 엑셀. 첫 탭 「원가율분해」에서 생산금액만 넣으면 수율·제품구성·단가가 원재료비율을 얼마나 움직였는지 나옵니다"
            className="px-3 py-1.5 text-xs rounded bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:bg-gray-300">
            {wbBusy ? '만드는 중...' : '🧮 수식 엑셀'}
          </button>
          <button onClick={clearAll} className="px-3 py-1.5 text-xs rounded bg-red-600 text-white font-semibold hover:bg-red-700">🗑️ 분석결과 삭제</button>
          <button onClick={() => runAnalysis(false)} disabled={running}
            className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:bg-gray-300 shadow-sm">
            {running ? '분석 중...' : '🚀 분석 시작'}
          </button>
        </div>
      </div>

      {err && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-3 text-sm">⚠️ {err}</div>}

      {/* DB 상태 */}
      {(recipeMap.size === 0 && ambientRecipeMap.size === 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          ⚠️ 설정 페이지에서 레시피·실온이유식레시피·원재료단가를 먼저 입력해야 분석 가능합니다.
        </div>
      )}

      {decompView && decompSrc && (
        <CostDecompPanel monthA={decompSrc.months.a} monthB={decompSrc.months.b}
          view={decompView} alt={decompAlt}
          recipeSrc={recipeSrc} onRecipeSrc={setRecipeSrc} yieldDbReady={yRecipeMap.size > 0} />
      )}

      {/* ============================================================
          분석 1: 월별 생산 현황 (냉장 단계별 + 실온 제품별)
          ============================================================ */}
      {aProd && bProd && aProdView && bProdView && (
        <div className="bg-white border-2 border-indigo-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-indigo-600 text-white font-bold text-sm flex items-center gap-2">
            <span>🏭 분석 1 — 월별 생산 현황</span>
            <span className="text-xs font-normal text-indigo-100">냉장 단계·품목별 + 실온 제품별 · 월별현황과 동일 합계</span>
          </div>

          {/* 🔍 원재료로 제품 필터 */}
          <div className="border-b bg-indigo-50/60 px-4 py-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-gray-700">🔍 원재료로 제품 찾기</span>
              <input value={prodSearch} onChange={(e) => { setProdSearch(e.target.value); setExcludedIng([]); }}
                placeholder="예: 연어, 한우, 전복... (이 원재료 쓰는 제품만 추림)"
                className="flex-1 min-w-[220px] max-w-md border rounded px-3 py-1.5 text-sm" />
              {prodSearch && <button onClick={() => { setProdSearch(''); setExcludedIng([]); }} className="text-xs px-2 py-1 rounded border bg-white hover:bg-gray-50">✕ 전체보기</button>}
            </div>
            {prodSearch.trim() && (
              <div className="mt-2">
                {prodIngMatches.length === 0 ? (
                  <div className="text-xs text-gray-400">매칭되는 원재료가 없습니다</div>
                ) : (
                  <>
                    <div className="text-[11px] text-gray-500 mb-1">매칭 원재료 {prodIngMatches.length}개 — 칩을 클릭하면 제외/포함 토글 (제외 시 그 원재료 쓰는 제품 빠짐)</div>
                    <div className="flex flex-wrap gap-1.5">
                      {prodIngMatches.map((m) => {
                        const ex = excludedIng.includes(m.key);
                        return (
                          <button key={m.key}
                            onClick={() => setExcludedIng((p) => ex ? p.filter((k) => k !== m.key) : [...p, m.key])}
                            className={`text-xs px-2 py-1 rounded-full border transition ${ex ? 'bg-gray-100 text-gray-400 line-through border-gray-200' : 'bg-white text-indigo-700 border-indigo-300 hover:bg-indigo-50'}`}
                            title={m.code || ''}>
                            {ex ? '➕ ' : '✓ '}{m.name}{m.code ? <span className="text-[10px] text-gray-400 ml-1">{m.code}</span> : null}
                          </button>
                        );
                      })}
                    </div>
                    {prodFilter && (
                      <div className="text-[11px] text-indigo-600 mt-1.5">
                        → 해당 제품: {monthA} 냉장 {aProdView.stages.reduce((s, x) => s + x.count, 0)}품목·{aProdView.coldTotal.toLocaleString()}EA + 실온 {aProdView.ambient.length}종 / {monthB} 냉장 {bProdView.stages.reduce((s, x) => s + x.count, 0)}품목·{bProdView.coldTotal.toLocaleString()}EA + 실온 {bProdView.ambient.length}종
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 divide-y lg:divide-y-0 lg:divide-x">
            <ProductionPanel month={monthA} prod={aProdView} accent="blue"
              expandStages={expandStages} toggle={(k) => setExpandStages((p) => ({ ...p, [k]: !p[k] }))} />
            <ProductionPanel month={monthB} prod={bProdView} accent="rose"
              expandStages={expandStages} toggle={(k) => setExpandStages((p) => ({ ...p, [k]: !p[k] }))} />
          </div>
          {/* 단계별 비교 (한눈에) */}
          <div className="border-t bg-slate-50 p-4">
            <div className="font-bold text-xs text-gray-700 mb-2">📊 단계별 한눈 비교</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-gray-500">
                  <tr>
                    <th className="text-left px-2 py-1">단계</th>
                    <th className="text-right px-2 py-1">{monthA} EA</th>
                    <th className="text-right px-2 py-1">{monthA} 품목</th>
                    <th className="text-right px-2 py-1">{monthB} EA</th>
                    <th className="text-right px-2 py-1">{monthB} 품목</th>
                    <th className="text-right px-2 py-1">증감 EA</th>
                    <th className="text-right px-2 py-1">증감 %</th>
                  </tr>
                </thead>
                <tbody>
                  {STAGE_LETTERS.map((L) => {
                    const a = aProdView.stages.find((s) => s.letter === L)!;
                    const b = bProdView.stages.find((s) => s.letter === L)!;
                    const diff = b.total - a.total;
                    const pct = a.total > 0 ? (diff / a.total) * 100 : (b.total > 0 ? 100 : 0);
                    const cls = diff > 0 ? 'text-emerald-700' : diff < 0 ? 'text-rose-700' : 'text-gray-400';
                    return (
                      <tr key={L} className="border-t">
                        <td className="px-2 py-1 font-bold">
                          <span className={`inline-block w-6 h-6 rounded-full text-white text-[10px] font-bold flex items-center justify-center ${STAGE_COLOR[L]}`}>{L}</span>
                        </td>
                        <td className="text-right px-2 py-1">{a.total.toLocaleString()}</td>
                        <td className="text-right px-2 py-1 text-gray-500">{a.count}</td>
                        <td className="text-right px-2 py-1">{b.total.toLocaleString()}</td>
                        <td className="text-right px-2 py-1 text-gray-500">{b.count}</td>
                        <td className={`text-right px-2 py-1 font-semibold ${cls}`}>{diff > 0 ? '+' : ''}{diff.toLocaleString()}</td>
                        <td className={`text-right px-2 py-1 font-semibold ${cls}`}>{pct > 0 ? '+' : ''}{pct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                  {(() => {
                    const aT = aProdView.ambientTotal;
                    const bT = bProdView.ambientTotal;
                    const diff = bT - aT;
                    const pct = aT > 0 ? (diff / aT) * 100 : (bT > 0 ? 100 : 0);
                    const cls = diff > 0 ? 'text-emerald-700' : diff < 0 ? 'text-rose-700' : 'text-gray-400';
                    return (
                      <tr className="border-t">
                        <td className="px-2 py-1 font-bold">
                          <span className="inline-block w-6 h-6 rounded-full text-white text-[10px] font-bold flex items-center justify-center bg-orange-500">S</span>
                        </td>
                        <td className="text-right px-2 py-1">{aT.toLocaleString()}</td>
                        <td className="text-right px-2 py-1 text-gray-500">{aProdView.ambient.length}</td>
                        <td className="text-right px-2 py-1">{bT.toLocaleString()}</td>
                        <td className="text-right px-2 py-1 text-gray-500">{bProdView.ambient.length}</td>
                        <td className={`text-right px-2 py-1 font-semibold ${cls}`}>{diff > 0 ? '+' : ''}{diff.toLocaleString()}</td>
                        <td className={`text-right px-2 py-1 font-semibold ${cls}`}>{pct > 0 ? '+' : ''}{pct.toFixed(1)}%</td>
                      </tr>
                    );
                  })()}
                  <tr className="border-t bg-amber-50 font-bold">
                    <td className="px-2 py-1.5">합계(냉장+실온)</td>
                    <td className="text-right px-2 py-1.5">{aProdView.total.toLocaleString()}</td>
                    <td className="text-right px-2 py-1.5 text-gray-500">—</td>
                    <td className="text-right px-2 py-1.5">{bProdView.total.toLocaleString()}</td>
                    <td className="text-right px-2 py-1.5 text-gray-500">—</td>
                    <td className={`text-right px-2 py-1.5 ${bProdView.total - aProdView.total > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {(bProdView.total - aProdView.total) > 0 ? '+' : ''}{(bProdView.total - aProdView.total).toLocaleString()}
                    </td>
                    <td className="text-right px-2 py-1.5"></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 계산 신뢰도 확인 — 레시피 커버리지 / 미매칭 */}
        {aResult && bResult && (
          <div className={`border-2 rounded-lg p-3 text-sm ${aResult.coverage.missingQty === 0 && bResult.coverage.missingQty === 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-300'}`}>
            <div className="font-bold text-gray-800 mb-1">🧾 레시피 커버리지 <span className="text-xs font-normal text-gray-500">· {recipeLabel}</span></div>
            <div className="text-xs text-gray-700 flex flex-wrap gap-x-5 gap-y-1">
              {[{ m: monthA, c: aResult.coverage }, { m: monthB, c: bResult.coverage }].map(({ m, c }) => (
                <span key={m}>
                  <b>{m}</b> 생산 {Math.round(c.totalQty).toLocaleString()} EA 중 레시피 반영{' '}
                  <b className={c.missingQty === 0 ? 'text-emerald-700' : 'text-red-700'}>{c.coveredPct.toFixed(1)}%</b>
                  {c.missingQty > 0 && <span className="text-red-700"> (미반영 {Math.round(c.missingQty).toLocaleString()} EA → 그만큼 원재료비 과소계상)</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 매칭 실패 안내 */}
        {missing && (missing.cold.length > 0 || missing.ambient.length > 0 || missing.prices.length > 0) && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm space-y-2">
            <div className="font-bold text-amber-800">⚠️ 매칭/단가 미입력 항목 (계산에서 제외됨)</div>
            {missing.cold.length > 0 && (
              <div><b>레시피 미등록 냉장 코드 ({missing.cold.length}건):</b> <span className="text-amber-700 break-all">{missing.cold.join(', ')}</span></div>
            )}
            {missing.ambient.length > 0 && (
              <div><b>레시피 미등록 실온 제품 ({missing.ambient.length}건):</b> <span className="text-amber-700 break-all">{missing.ambient.join(', ')}</span></div>
            )}
            {missing.prices.length > 0 && (
              <div><b>단가 미입력 원재료 ({missing.prices.length}건):</b> <span className="text-amber-700 break-all">{missing.prices.join(', ')}</span></div>
            )}
          </div>
        )}

      {!aResult && !bResult && !running && (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-16 text-center text-gray-400 text-sm">
          비교할 두 월을 선택하고 우측 상단 <b className="text-blue-600">🚀 분석 시작</b> 버튼을 눌러주세요.
        </div>
      )}
    </div>
  );
}

function ProductionPanel({ month, prod, accent, expandStages, toggle }: {
  month: string;
  prod: MonthlyProduction;
  accent: 'blue' | 'rose';
  expandStages: Record<string, boolean>;
  toggle: (k: string) => void;
}) {
  const accentCls = accent === 'blue' ? 'text-blue-700' : 'text-rose-700';
  const accentBg = accent === 'blue' ? 'bg-blue-50' : 'bg-rose-50';
  const prefix = `${month}-${accent}`;
  return (
    <div className="p-4 space-y-3">
      <div className={`flex items-baseline gap-2 ${accentBg} -mx-4 -mt-4 px-4 py-2 border-b`}>
        <span className={`font-bold text-sm ${accentCls}`}>{month}</span>
        <span className="text-xs text-gray-500">총 {prod.total.toLocaleString()} EA · 냉장 {prod.coldTotal.toLocaleString()} + 실온 {prod.ambientTotal.toLocaleString()}</span>
      </div>

      {/* 단계별 막대 */}
      <div className="space-y-1.5">
        {(() => {
          const maxAll = Math.max(prod.maxStage, prod.ambientTotal, 1);
          return <>
        {prod.stages.map((s) => {
          const k = `${prefix}-${s.letter}`;
          const open = !!expandStages[k];
          const pct = (s.total / maxAll) * 100;
          return (
            <div key={s.letter}>
              <button onClick={() => toggle(k)}
                className="w-full flex items-center gap-2 hover:bg-slate-50 rounded px-1 py-0.5 text-left">
                <span className={`w-8 h-6 rounded text-white text-xs font-bold flex items-center justify-center ${STAGE_COLOR[s.letter]}`}>{s.letter}</span>
                <div className="flex-1 bg-gray-100 rounded h-5 overflow-hidden">
                  <div className={`${STAGE_COLOR[s.letter]} h-full transition-all`} style={{ width: `${pct}%` }} />
                </div>
                <div className="w-32 text-right text-xs">
                  <span className="font-bold">{s.total.toLocaleString()}</span>
                  <span className="text-gray-500 ml-1">EA</span>
                  <span className="text-gray-400 ml-1">({s.count})</span>
                </div>
                <span className="text-xs text-gray-400 w-3">{open ? '▾' : '▸'}</span>
              </button>
              {open && s.items.length > 0 && (
                <div className="ml-10 mt-1 mb-2 border rounded bg-slate-50">
                  <table className="w-full text-xs">
                    <tbody>
                      {s.items.map((it) => (
                        <tr key={it.code} className="border-t border-gray-200">
                          <td className="px-2 py-1 font-mono text-gray-500 w-24">{it.code}</td>
                          <td className="px-2 py-1">{it.name}</td>
                          <td className="px-2 py-1 text-right font-semibold w-20">{it.qty.toLocaleString()}</td>
                          <td className="px-2 py-1 text-gray-400 text-xs w-8">EA</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
        {/* S = 실온이유식 막대 (I 아래) */}
        {(() => {
          const k = `${prefix}-S`;
          const open = !!expandStages[k];
          const pct = (prod.ambientTotal / maxAll) * 100;
          return (
            <div key="S">
              <button onClick={() => toggle(k)}
                className="w-full flex items-center gap-2 hover:bg-slate-50 rounded px-1 py-0.5 text-left">
                <span className="w-8 h-6 rounded text-white text-xs font-bold flex items-center justify-center bg-orange-500">S</span>
                <div className="flex-1 bg-gray-100 rounded h-5 overflow-hidden">
                  <div className="bg-orange-500 h-full transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="w-32 text-right text-xs">
                  <span className="font-bold">{prod.ambientTotal.toLocaleString()}</span>
                  <span className="text-gray-500 ml-1">EA</span>
                  <span className="text-gray-400 ml-1">({prod.ambient.length})</span>
                </div>
                <span className="text-xs text-gray-400 w-3">{open ? '▾' : '▸'}</span>
              </button>
              {open && prod.ambient.length > 0 && (
                <div className="ml-10 mt-1 mb-2 border rounded bg-slate-50">
                  <table className="w-full text-xs">
                    <tbody>
                      {prod.ambient.map((a) => (
                        <tr key={a.productName} className="border-t border-gray-200">
                          <td className="px-2 py-1">{a.productName}</td>
                          <td className="px-2 py-1 text-right text-gray-400 w-16" title="해당 월에 이 제품을 생산 등록한 날짜 수 (원재료 계산과 무관)">{a.count}일</td>
                          <td className="px-2 py-1 text-right font-semibold w-20">{a.qty.toLocaleString()}</td>
                          <td className="px-2 py-1 text-gray-400 w-8">EA</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })()}
        </>;
        })()}
      </div>

      {/* 실온 제품별 */}
      <div className="mt-3">
        <div className="font-bold text-xs text-orange-700 mb-1.5">🍱 실온 이유식 ({prod.ambient.length}종 · {prod.ambientTotal.toLocaleString()} EA)</div>
        {prod.ambient.length === 0 ? (
          <div className="text-xs text-gray-400 italic">생산 없음</div>
        ) : (
          <div className="border rounded bg-slate-50 max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <tbody>
                {prod.ambient.map((a) => (
                  <tr key={a.productName} className="border-t border-gray-200">
                    <td className="px-2 py-1">{a.productName}</td>
                    <td className="px-2 py-1 text-right text-gray-400 w-16" title="해당 월에 이 제품을 생산 등록한 날짜 수 (원재료 계산과 무관)">{a.count}일</td>
                    <td className="px-2 py-1 text-right font-semibold w-20">{a.qty.toLocaleString()}</td>
                    <td className="px-2 py-1 text-gray-400 w-8">EA</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   제품군(냉장/실온)별 원재료비 분해 패널
   "생산량은 비슷한데 원재료비율이 왜 달라졌나" 를 믹스 관점에서 본다.
   ============================================================ */

/* ============================================================
   원재료 투입 제품의 생산 비중
   "전체 생산량 중 한우가 들어간 품목 비중이 몇%에서 몇%로 바뀌었나"
   ============================================================ */
