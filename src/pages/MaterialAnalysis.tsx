import { Fragment as Fragment2, useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, doc, getDoc, getDocs, onSnapshot, query, setDoc, where } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import type { AmbientEntry, Item, MachineEntry } from '../types';
import type { AmbientRecipe, Recipe } from '../lib/wasteCompute';
import { CODE_KEY_PREFIX, monthPriceKey, normalizeCode, normalizeMaterialName } from '../lib/wasteCompute';
import { canonicalShort } from '../lib/codeUtil';
import { computeFlexedDiff, computeIngredientStageUsage, computeMonthlyUsage, diffUsage, computeProductCosts, contributionByProduct } from '../lib/materialUsage';
import type { DiffRow, FlexedRow, IngredientStageRow, UsageResult, ContribRow } from '../lib/materialUsage';
import { computeMonthlyProduction, filterProduction, STAGE_COLOR, STAGE_LETTERS } from '../lib/monthlyProduction';
import type { MonthlyProduction } from '../lib/monthlyProduction';
import { expandAmbientRecipeMap, expandRecipeMap } from '../lib/bomExpansion';

/* ===== 캐시 ===== */
const PREFIX = 'matAnalysis:';
const TTL_PAST = 30 * 24 * 60 * 60 * 1000;
const TTL_CURRENT = 5 * 60 * 1000;
function getCache<T>(key: string, ttl: number): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const p = JSON.parse(raw) as { ts: number; data: T };
    if (Date.now() - p.ts > ttl) return null;
    return p.data;
  } catch { return null; }
}
function setCache<T>(key: string, data: T) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify({ ts: Date.now(), data })); } catch {}
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

async function fetchMonthLogistics(month: string): Promise<Record<string, number>> {
  const [yy, mm] = month.split('-').map(Number);
  const lastDay = new Date(yy, mm, 0).getDate();
  const dates = Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const snaps = await Promise.all(dates.map((d) => getDocs(collection(db, 'days', d, 'logistics'))));
  const map: Record<string, number> = {};
  snaps.forEach((s, i) => {
    if (s.empty) return;
    let sum = 0;
    s.forEach((d) => { sum += (d.data().qty as number) || 0; });
    map[dates[i]] = sum;
  });
  return map;
}

interface RawMonth {
  entries: MachineEntry[];
  items: Item[];
  ambient: AmbientEntry[];
  logistics: Record<string, number>;
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
  const items: Item[] = its.docs.map((d) => d.data() as Item);
  const ambient: AmbientEntry[] = amb.docs.map((d) => d.data() as AmbientEntry);
  return { entries, items, ambient, logistics: log };
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
  const [aAmount, setAAmount] = useState<string>(''); // A월 생산금액 ₩ (선택)
  const [bAmount, setBAmount] = useState<string>('');
  const [scaleBy, setScaleBy] = useState<'qty' | 'amount'>('qty');
  const [aProd, setAProd] = useState<MonthlyProduction | null>(null);
  const [bProd, setBProd] = useState<MonthlyProduction | null>(null);
  const [aRaw, setARaw] = useState<RawMonth | null>(null);
  const [bRaw, setBRaw] = useState<RawMonth | null>(null);
  const [search, setSearch] = useState<string>('');
  const [searchFlexed, setSearchFlexed] = useState<boolean>(false);
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
  const saveNameOverride = (key: string, name: string, fallback: string) => {
    const trimmed = name.trim();
    const next = { ...nameOverrides };
    if (!trimmed || trimmed === fallback) delete next[key]; else next[key] = trimmed;
    setNameOverrides(next);  // 낙관적 업데이트
    // 전체 overrides 를 통째로 덮어써서 삭제도 반영 (merge 안 함 — 중첩 map 머지 회피)
    setDoc(doc(db, 'appMeta', 'materialAliases'), { overrides: next, updatedAt: new Date().toISOString() })
      .catch((e) => console.error('[materialAliases save]', e));
  };
  const displayName = (key: string, original: string) => nameOverrides[key] || original;
  const [expandStages, setExpandStages] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);

  // 마스터 DB 구독
  const [recipeMap, setRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [ambientRecipeMap, setAmbientRecipeMap] = useState<Map<string, AmbientRecipe>>(new Map());
  const [subRecipeMap, setSubRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [expandSub, setExpandSub] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem('matAnalysis:expandSub') || 'true'); } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem('matAnalysis:expandSub', JSON.stringify(expandSub)); } catch {} }, [expandSub]);
  const [priceMap, setPriceMap] = useState<Map<string, number>>(new Map());

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
      snap.forEach((d) => {
        const data = d.data() as { month?: string; name?: string; pricePerGram?: number; code?: string };
        const month = data.month || '';
        if (!month) return;
        const price = Number(data.pricePerGram) || 0;
        if (data.name) m.set(monthPriceKey(month, normalizeMaterialName(data.name)), price);
        if (data.code) m.set(monthPriceKey(month, CODE_KEY_PREFIX + normalizeCode(data.code)), price);
      });
      setPriceMap(m);
    });
  }, []);

  // monthlyMeta/{month}.productionAmount — 월별 생산금액 (다른 사용자 공유)
  useEffect(() => {
    let cancel = false;
    getDoc(doc(db, 'monthlyMeta', monthA)).then((snap) => {
      if (cancel) return;
      const v = snap.exists() ? (snap.data().productionAmount as number) : null;
      setAAmount(v && v > 0 ? String(v) : '');
    }).catch(() => {});
    return () => { cancel = true; };
  }, [monthA]);
  useEffect(() => {
    let cancel = false;
    getDoc(doc(db, 'monthlyMeta', monthB)).then((snap) => {
      if (cancel) return;
      const v = snap.exists() ? (snap.data().productionAmount as number) : null;
      setBAmount(v && v > 0 ? String(v) : '');
    }).catch(() => {});
    return () => { cancel = true; };
  }, [monthB]);
  const saveProductionAmount = (month: string, raw: string) => {
    const v = Number(raw) || 0;
    setDoc(doc(db, 'monthlyMeta', month), {
      productionAmount: v,
      updatedAt: new Date().toISOString(),
    }, { merge: true }).catch((e) => console.error('[monthlyMeta save]', e));
  };

  // 반제품 펼침 옵션 적용된 effective 레시피 맵
  const effRecipeMap = useMemo(() => (expandSub ? expandRecipeMap(recipeMap, subRecipeMap) : recipeMap), [recipeMap, subRecipeMap, expandSub]);
  const effAmbientRecipeMap = useMemo(() => (expandSub ? expandAmbientRecipeMap(ambientRecipeMap, subRecipeMap) : ambientRecipeMap), [ambientRecipeMap, subRecipeMap, expandSub]);

  const runAnalysis = async (bustCache = false) => {
    if (monthA === monthB) { setErr('A·B 월이 같습니다. 다른 월을 선택해주세요.'); return; }
    setRunning(true); setErr(null);
    try {
      const fetchOrCache = async (m: string): Promise<RawMonth> => {
        const ttl = m === tm ? TTL_CURRENT : TTL_PAST;
        if (!bustCache) {
          const c = getCache<RawMonth>(`raw:${m}`, ttl);
          if (c) return c;
        }
        const r = await fetchMonth(m);
        setCache(`raw:${m}`, r);
        return r;
      };
      const [aRaw, bRaw] = await Promise.all([fetchOrCache(monthA), fetchOrCache(monthB)]);
      // 분석 1 — 월별 생산 분해 (단계·품목·실온)
      const aProd_ = computeMonthlyProduction(aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics);
      const bProd_ = computeMonthlyProduction(bRaw.entries, bRaw.items, bRaw.ambient, bRaw.logistics);
      setAProd(aProd_); setBProd(bProd_);

      // 분석 2 — 각 월 자체 단가 결과 (기존 표)
      const aRes = computeMonthlyUsage(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap);
      const bRes = computeMonthlyUsage(monthB, bRaw.entries, bRaw.items, bRaw.ambient, bRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap);
      // A월 데이터를 B월 단가로 재평가 (Flexed Budget)
      const aResB = computeMonthlyUsage(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap, monthB);
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

  /** 제품군(냉장/실온)별 원재료비 분해.
   *  같은 계산기를 입력만 나눠서 두 번 돌린다 → 냉장만 / 실온만 재료비를 각각 산출.
   *  "실온 생산이 줄어 비싼 재료(한우 등)가 덜 들어간 것 아니냐" 같은 믹스 가설 검증용. */
  const mixSplit = useMemo(() => {
    if (!aRaw || !bRaw || !aProd || !bProd) return null;
    const usage = (
      m: string,
      raw: { entries: MachineEntry[]; items: Item[]; ambient: AmbientEntry[]; logistics: Record<string, number> },
      kind: 'cold' | 'ambient' | 'all',
      pm?: string,                       // 단가 기준 월 (지정 시 그 달 단가로 재평가 = 연동)
    ) => kind === 'cold'
      ? computeMonthlyUsage(m, raw.entries, raw.items, [], raw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap, pm)
      : kind === 'ambient'
      ? computeMonthlyUsage(m, [], [], raw.ambient, {}, effRecipeMap, effAmbientRecipeMap, priceMap, pm)
      : computeMonthlyUsage(m, raw.entries, raw.items, raw.ambient, raw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap, pm);

    const sumCost = (r: UsageResult) => r.rows.reduce((s, x) => s + x.cost, 0);
    const aCold = usage(monthA, aRaw, 'cold');
    const aAmb = usage(monthA, aRaw, 'ambient');
    const bCold = usage(monthB, bRaw, 'cold');
    const bAmb = usage(monthB, bRaw, 'ambient');

    // 원재료 A→B 금액 변동 — 전체/냉장/실온 각각 감소·증가 상위 (보고서에 양방향 사례 필요)
    const pair = (aR: UsageResult, bR: UsageResult) => {
      const all = diffUsage(aR, bR).filter((r) => r.aCost > 0 || r.bCost > 0);
      return {
        down: [...all].sort((x, y) => x.diffCost - y.diffCost).filter((r) => r.diffCost < 0).slice(0, 12),
        up: [...all].sort((x, y) => y.diffCost - x.diffCost).filter((r) => r.diffCost > 0).slice(0, 12),
      };
    };
    const aAll = usage(monthA, aRaw, 'all');
    const bAll = usage(monthB, bRaw, 'all');
    // 연동: A월 사용량을 B월 단가로 재평가 → 단가 변동 효과 제거, 사용량·믹스 효과만 남음
    const aAllP = usage(monthA, aRaw, 'all', monthB);
    const aColdP = usage(monthA, aRaw, 'cold', monthB);
    const aAmbP = usage(monthA, aRaw, 'ambient', monthB);
    const byScope = { all: pair(aAll, bAll), cold: pair(aCold, bCold), ambient: pair(aAmb, bAmb) };
    const byScopeFlexed = { all: pair(aAllP, bAll), cold: pair(aColdP, bCold), ambient: pair(aAmbP, bAmb) };

    return {
      a: { cold: sumCost(aCold), amb: sumCost(aAmb), coldQty: aProd.coldTotal, ambQty: aProd.ambientTotal },
      b: { cold: sumCost(bCold), amb: sumCost(bAmb), coldQty: bProd.coldTotal, ambQty: bProd.ambientTotal },
      byScope, byScopeFlexed,
    };
  }, [aRaw, bRaw, aProd, bProd, monthA, monthB, effRecipeMap, effAmbientRecipeMap, priceMap]);

  /** 품목별 원가 기여도 — EA당 재료비 변화를 품목 단위로 정확히 분해 */
  const costDrivers = useMemo(() => {
    if (!aRaw || !bRaw) return null;
    const aP = computeProductCosts(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap);
    const bP = computeProductCosts(monthB, bRaw.entries, bRaw.items, bRaw.ambient, bRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap);
    return contributionByProduct(aP, bP);
  }, [aRaw, bRaw, monthA, monthB, effRecipeMap, effAmbientRecipeMap, priceMap]);

  // 연동 비율 (A월 → B월 규모) — EA 기본, 생산금액 둘 다 입력 시 ₩ 토글 가능
  // 반제품 펼침 토글이나 레시피 DB 변경 시 분석 결과 자동 재계산 (raw 있을 때만)
  useEffect(() => {
    if (!aRaw || !bRaw) return;
    const aRes = computeMonthlyUsage(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap);
    const bRes = computeMonthlyUsage(monthB, bRaw.entries, bRaw.items, bRaw.ambient, bRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap);
    const aResB = computeMonthlyUsage(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, effRecipeMap, effAmbientRecipeMap, priceMap, monthB);
    setAResult(aRes); setBResult(bRes); setAResultBPrice(aResB);
    setDiff(diffUsage(aRes, bRes));
  }, [effRecipeMap, effAmbientRecipeMap, priceMap, aRaw, bRaw, monthA, monthB]);

  const ratio = useMemo(() => {
    const aAmt = Number(aAmount) || 0;
    const bAmt = Number(bAmount) || 0;
    const useAmount = scaleBy === 'amount' && aAmt > 0 && bAmt > 0;
    const aScale = useAmount ? aAmt : aQty;
    const bScale = useAmount ? bAmt : bQty;
    return aScale > 0 ? bScale / aScale : 1;
  }, [aQty, bQty, aAmount, bAmount, scaleBy]);

  // Flexed Budget — 입력 변화에 반응
  useEffect(() => {
    if (!aResultBPrice || !bResult) { setFlexed([]); return; }
    const aAmt = Number(aAmount) || 0;
    const bAmt = Number(bAmount) || 0;
    const useAmount = scaleBy === 'amount' && aAmt > 0 && bAmt > 0;
    const aScale = useAmount ? aAmt : aQty;
    const bScale = useAmount ? bAmt : bQty;
    setFlexed(computeFlexedDiff(aResultBPrice.rows, bResult.rows, aScale, bScale));
  }, [aResultBPrice, bResult, aQty, bQty, aAmount, bAmount, scaleBy]);

  const clearAll = () => {
    if (!confirm('분석 결과와 캐시를 모두 삭제할까요?')) return;
    clearAllCache();
    setAResult(null); setBResult(null); setAResultBPrice(null);
    setAProd(null); setBProd(null); setARaw(null); setBRaw(null);
    setDiff([]); setFlexed([]);
    setAQty(0); setBQty(0);
    // 생산금액(aAmount/bAmount)은 Firestore 공유값이라 분석결과 삭제로 지우지 않음
    setSearch(''); setErr(null);
  };

  // 검색: 원재료별 단계별 사용 (검색어 있을 때만 계산)
  const stageUsage = useMemo(() => {
    if (!search.trim() || !aRaw || !bRaw || !aProd || !bProd) return null;
    const q = search.trim().toLowerCase();
    const aRows = computeIngredientStageUsage(monthA, aProd.coldByCode, aRaw.ambient, effRecipeMap, effAmbientRecipeMap, priceMap);
    const bRows = computeIngredientStageUsage(monthB, bProd.coldByCode, bRaw.ambient, effRecipeMap, effAmbientRecipeMap, priceMap);
    const aFilt = aRows.filter((r) => r.name.toLowerCase().includes(q) || (r.code || '').toLowerCase().includes(q));
    const bFilt = bRows.filter((r) => r.name.toLowerCase().includes(q) || (r.code || '').toLowerCase().includes(q));
    // key 합집합
    const keys = Array.from(new Set([...aFilt.map((r) => r.key), ...bFilt.map((r) => r.key)]));
    const byKey = new Map<string, { a?: IngredientStageRow; b?: IngredientStageRow }>();
    aFilt.forEach((r) => { byKey.set(r.key, { ...(byKey.get(r.key) || {}), a: r }); });
    bFilt.forEach((r) => { byKey.set(r.key, { ...(byKey.get(r.key) || {}), b: r }); });
    return keys.map((k) => {
      const v = byKey.get(k)!;
      const name = v.b?.name || v.a?.name || k;
      const code = v.b?.code || v.a?.code;
      return { key: k, name, code, a: v.a, b: v.b };
    });
  }, [search, aRaw, bRaw, aProd, bProd, monthA, monthB, effRecipeMap, effAmbientRecipeMap, priceMap]);

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
    recipeMap.forEach((r) => scan(r.ingredients));
    ambientRecipeMap.forEach((r) => scan(r.ingredients));
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [prodSearch, recipeMap, ambientRecipeMap, nameOverrides]);

  // 포함(미제외) 원재료를 쓰는 제품 집합
  const prodFilter = useMemo(() => {
    const included = new Set(prodIngMatches.map((m) => m.key).filter((k) => !excludedIng.includes(k)));
    if (included.size === 0) return null;
    const coldCodes = new Set<string>();
    const ambientNames = new Set<string>();
    recipeMap.forEach((r) => {
      if (r.ingredients.some((ing) => included.has(ingKeyOf(ing.name, ing.code)))) {
        const k = canonicalShort(r.code || '');
        if (k) coldCodes.add(k);
      }
    });
    ambientRecipeMap.forEach((r, id) => {
      if (r.ingredients.some((ing) => included.has(ingKeyOf(ing.name, ing.code)))) {
        ambientNames.add(normalizeMaterialName(r.name || id));
      }
    });
    return { coldCodes, ambientNames };
  }, [prodIngMatches, excludedIng, recipeMap, ambientRecipeMap]);

  const aProdView = useMemo(
    () => (aProd && prodFilter ? filterProduction(aProd, prodFilter.coldCodes, prodFilter.ambientNames) : aProd),
    [aProd, prodFilter],
  );
  const bProdView = useMemo(
    () => (bProd && prodFilter ? filterProduction(bProd, prodFilter.coldCodes, prodFilter.ambientNames) : bProd),
    [bProd, prodFilter],
  );

  // 각 월 자체 단가 합계 (기존 비교용)
  const aTotal = aResult?.rows.reduce((s, r) => s + r.cost, 0) || 0;
  const bTotal = bResult?.rows.reduce((s, r) => s + r.cost, 0) || 0;
  const diffTotal = bTotal - aTotal;
  const diffPct = aTotal > 0 ? (diffTotal / aTotal) * 100 : 0;

  // 변동 범인 TOP 10
  // 연동: diffCost = flexedCost - bCost (양수=절감/효율↑, 음수=낭비). 절댓값 큰 순.
  const topFlexed = useMemo(
    () => [...flexed].sort((a, b) => Math.abs(b.diffCost) - Math.abs(a.diffCost)).slice(0, 10),
    [flexed],
  );
  // 실제(각 월 자체단가): diffCost = bCost - aCost (양수=증가, 음수=감소). 절댓값 큰 순.
  const topReal = useMemo(
    () => [...diff].filter((r) => r.aHasPrice || r.bHasPrice)
      .sort((a, b) => Math.abs(b.diffCost) - Math.abs(a.diffCost)).slice(0, 10),
    [diff],
  );

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
        {subRecipeMap.size > 0 && (
          <label className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border bg-emerald-50 cursor-pointer hover:bg-emerald-100" title="반제품(순수본베이스/디포리육수 등)을 원물 단위로 자동 분해해 계산. 끄면 반제품을 그대로 한 원재료로 봄">
            <input type="checkbox" checked={expandSub} onChange={(e) => setExpandSub(e.target.checked)} />
            <span className="font-semibold text-emerald-700">🧪 반제품 펼침</span>
            <span className="text-emerald-500">({expandSub ? '원물' : '반제품'})</span>
          </label>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => runAnalysis(true)} disabled={running} title="캐시 무시" className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50 disabled:opacity-50">🔄</button>
          <button onClick={downloadXlsx} disabled={!aResult || !bResult} className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:bg-gray-300">📥 엑셀</button>
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

      {/* 입력 패널 — 총생산량(자동, 수정가능) + 생산금액(선택) */}
      {aResult && bResult && (
        <div className="bg-white border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="font-bold text-gray-800 text-sm">📌 생산 규모 입력</span>
            <span className="text-xs text-gray-500">총생산량은 자동 계산됨 — 필요 시 직접 수정하세요</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-semibold text-blue-700">{monthA} 총생산량 (EA)</label>
              <input type="number" value={aQty} onChange={(e) => setAQty(Number(e.target.value) || 0)}
                className="mt-1 w-full border rounded px-2 py-1.5 text-sm text-right font-mono" />
            </div>
            <div>
              <label className="text-xs font-semibold text-rose-700">{monthB} 총생산량 (EA)</label>
              <input type="number" value={bQty} onChange={(e) => setBQty(Number(e.target.value) || 0)}
                className="mt-1 w-full border rounded px-2 py-1.5 text-sm text-right font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-600">{monthA} 생산금액 (₩, 선택)</label>
              <input type="number" value={aAmount} onChange={(e) => setAAmount(e.target.value)}
                onBlur={(e) => saveProductionAmount(monthA, e.target.value)} placeholder="직접 입력"
                className="mt-1 w-full border rounded px-2 py-1.5 text-sm text-right font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-600">{monthB} 생산금액 (₩, 선택)</label>
              <input type="number" value={bAmount} onChange={(e) => setBAmount(e.target.value)}
                onBlur={(e) => saveProductionAmount(monthB, e.target.value)} placeholder="직접 입력"
                className="mt-1 w-full border rounded px-2 py-1.5 text-sm text-right font-mono" />
            </div>
          </div>
          {Number(aAmount) > 0 && Number(bAmount) > 0 && (
            <div className="mt-3 flex items-center gap-3 text-xs">
              <span className="text-gray-600 font-semibold">연동 기준:</span>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" checked={scaleBy === 'qty'} onChange={() => setScaleBy('qty')} /> 총생산량(EA)
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" checked={scaleBy === 'amount'} onChange={() => setScaleBy('amount')} /> 생산금액(₩)
              </label>
            </div>
          )}
        </div>
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

      {/* ============================================================
          제품군(냉장/실온)별 원재료비 분해 — 믹스 변화가 원가에 준 영향
          ============================================================ */}
      {costDrivers && (
        <CostDriverPanel monthA={monthA} monthB={monthB} data={costDrivers} />
      )}

      {mixSplit && (
        <MixSplitPanel monthA={monthA} monthB={monthB} data={mixSplit} />
      )}

      {/* ============================================================
          분석 2: 원재료비 분석
          ============================================================ */}
      {aResult && bResult && (
        <div className="bg-white border-2 border-emerald-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-emerald-600 text-white font-bold text-sm flex items-center gap-2">
            <span>🎯 분석 2 — 원재료비 분석</span>
            <span className="text-xs font-normal text-emerald-100">연동 예산(Flexed Budget) + 각 월 단가 비교</span>
          </div>

          {/* 🔍 원재료 검색 */}
          <div className="border-b bg-slate-50 px-4 py-3 flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-gray-700">🔍 원재료 검색</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="예: 한우, 양파, 닭가슴살..."
              className="flex-1 min-w-[200px] max-w-md border rounded px-3 py-1.5 text-sm" />
            {search && <button onClick={() => setSearch('')} className="text-xs px-2 py-1 rounded border hover:bg-white">✕ 지우기</button>}
            {/* 실제 / 연동 토글 */}
            <div className="flex rounded border overflow-hidden text-xs">
              <button onClick={() => setSearchFlexed(false)}
                className={`px-2.5 py-1 ${!searchFlexed ? 'bg-blue-600 text-white font-semibold' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>실제 사용량</button>
              <button onClick={() => setSearchFlexed(true)}
                className={`px-2.5 py-1 border-l ${searchFlexed ? 'bg-indigo-600 text-white font-semibold' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                title={`${monthA}를 ${monthB} 생산규모로 환산 (×${ratio.toFixed(3)})`}>연동(생산량 보정)</button>
            </div>
            {stageUsage && <span className="text-xs text-gray-500">{stageUsage.length}건 매칭</span>}
          </div>

          {/* 검색 결과 — 단계별 사용량 비교 */}
          {stageUsage && stageUsage.length > 0 && (
            <div className="px-4 py-3 border-b bg-indigo-50/40">
              <div className="text-xs text-gray-600 mb-2">
                "<b>{search}</b>" 매칭 — 단계별 사용량(g) {monthA} vs {monthB}
                {searchFlexed
                  ? <span className="ml-1 text-indigo-700 font-semibold">· 연동 모드: {monthA} 사용량을 {monthB} 생산규모로 환산(×{ratio.toFixed(3)}) → 순수 효율차</span>
                  : <span className="ml-1 text-gray-400">· 실제 사용량 그대로</span>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs bg-white border">
                  <thead className="bg-slate-100 text-gray-600">
                    <tr>
                      <th className="border px-2 py-1 text-left">원재료</th>
                      <th className="border px-2 py-1">코드</th>
                      <th className="border px-2 py-1">월</th>
                      {STAGE_LETTERS.map((L) => (
                        <th key={L} className="border px-2 py-1 text-right w-16">{L}</th>
                      ))}
                      <th className="border px-2 py-1 text-right w-16">실온</th>
                      <th className="border px-2 py-1 text-right w-20 bg-amber-50">합계(g)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stageUsage.map((row) => {
                      const k = searchFlexed ? ratio : 1;   // A월 환산 계수
                      const aS = (L: string) => (row.a?.byStage[L] || 0) * k;
                      const aAmb = (row.a?.ambientGrams || 0) * k;
                      const aTot = (row.a?.totalGrams || 0) * k;
                      return (
                      <Fragment2 key={row.key}>
                        <tr className="border-t">
                          <td rowSpan={3} className="border px-2 py-1 align-top">
                            <input
                              key={`name-${row.key}-${nameOverrides[row.key] || ''}`}
                              defaultValue={displayName(row.key, row.name)}
                              onBlur={(e) => saveNameOverride(row.key, e.target.value, row.name)}
                              className="w-full bg-transparent font-semibold focus:bg-yellow-50 focus:ring-1 focus:ring-yellow-300 rounded px-1 py-0.5"
                              title={`원본: ${row.name} (코드 ${row.code || '-'})`}
                            />
                          </td>
                          <td rowSpan={3} className="border px-2 py-1 text-center font-mono text-gray-500 align-top">{row.code || '-'}</td>
                          <td className="border px-2 py-1 text-blue-700 font-semibold whitespace-nowrap">{monthA}{searchFlexed && <span className="text-[10px] text-indigo-500 ml-0.5">(연동)</span>}</td>
                          {STAGE_LETTERS.map((L) => (
                            <td key={L} className="border px-2 py-1 text-right">{Math.round(aS(L)).toLocaleString()}</td>
                          ))}
                          <td className="border px-2 py-1 text-right text-orange-700">{Math.round(aAmb).toLocaleString()}</td>
                          <td className="border px-2 py-1 text-right font-bold bg-amber-50">{Math.round(aTot).toLocaleString()}</td>
                        </tr>
                        <tr className="border-t">
                          <td className="border px-2 py-1 text-rose-700 font-semibold">{monthB}</td>
                          {STAGE_LETTERS.map((L) => (
                            <td key={L} className="border px-2 py-1 text-right">{Math.round(row.b?.byStage[L] || 0).toLocaleString()}</td>
                          ))}
                          <td className="border px-2 py-1 text-right text-orange-700">{Math.round(row.b?.ambientGrams || 0).toLocaleString()}</td>
                          <td className="border px-2 py-1 text-right font-bold bg-amber-50">{Math.round(row.b?.totalGrams || 0).toLocaleString()}</td>
                        </tr>
                        <tr className="border-t bg-slate-50">
                          <td className="border px-2 py-1 text-gray-600 font-semibold">증감</td>
                          {STAGE_LETTERS.map((L) => {
                            const d = (row.b?.byStage[L] || 0) - aS(L);
                            const cls = d > 0 ? 'text-rose-700' : d < 0 ? 'text-emerald-700' : 'text-gray-400';
                            return <td key={L} className={`border px-2 py-1 text-right font-semibold ${cls}`}>{d > 0 ? '+' : ''}{Math.round(d).toLocaleString()}</td>;
                          })}
                          {(() => {
                            const d = (row.b?.ambientGrams || 0) - aAmb;
                            const cls = d > 0 ? 'text-rose-700' : d < 0 ? 'text-emerald-700' : 'text-gray-400';
                            return <td className={`border px-2 py-1 text-right font-semibold ${cls}`}>{d > 0 ? '+' : ''}{Math.round(d).toLocaleString()}</td>;
                          })()}
                          {(() => {
                            const d = (row.b?.totalGrams || 0) - aTot;
                            const cls = d > 0 ? 'text-rose-700' : d < 0 ? 'text-emerald-700' : 'text-gray-400';
                            return <td className={`border px-2 py-1 text-right font-bold bg-amber-50 ${cls}`}>{d > 0 ? '+' : ''}{Math.round(d).toLocaleString()}</td>;
                          })()}
                        </tr>
                      </Fragment2>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {stageUsage && stageUsage.length === 0 && (
            <div className="px-4 py-6 border-b text-center text-sm text-gray-400">"{search}" 검색 결과가 없습니다</div>
          )}

          <div className="p-4 space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label={`${monthA} 원재료비 (B월단가)`} value={Math.round(flexAtotal).toLocaleString() + '원'} accent="slate" />
            <KpiCard label={`${monthB} 원재료비 (B월단가)`} value={Math.round(flexBtotal).toLocaleString() + '원'} accent="slate" />
            <KpiCard label="연동대비 총차액" value={(flexDiffTotal >= 0 ? '+' : '') + Math.round(flexDiffTotal).toLocaleString() + '원'} accent={flexDiffTotal >= 0 ? 'emerald' : 'rose'} />
            <KpiCard label="효율 변동률" value={(flexDiffPct >= 0 ? '+' : '') + flexDiffPct.toFixed(1) + '%'} accent={flexDiffPct >= 0 ? 'emerald' : 'rose'} />
          </div>

          {/* 🎯 Flexed Budget 연동 분석 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-indigo-50 font-bold text-gray-800 text-sm flex items-center gap-2 flex-wrap">
              <span>🎯 {monthA} vs {monthB} 연동 예산 차이 분석</span>
              <span className="text-xs text-indigo-600 font-normal">두 월 모두 {monthB} 단가 · {scaleBy === 'amount' ? '생산금액' : '총생산량'} 기준 연동</span>
              <span className="text-xs text-gray-400 font-normal ml-auto">＋효율↑ / －낭비</span>
            </div>
            <div className="overflow-x-auto max-h-[700px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-indigo-50 text-gray-600 sticky top-0 z-10">
                  <tr>
                    <th className="border px-2 py-1.5 w-10">순위</th>
                    <th className="border px-2 py-1.5 text-left">원재료</th>
                    <th className="border px-2 py-1.5 w-24">코드</th>
                    <th className="border px-2 py-1.5 text-right w-24">{monthA} 이론(g)</th>
                    <th className="border px-2 py-1.5 text-right w-24">{monthB} 이론(g)</th>
                    <th className="border px-2 py-1.5 text-right w-28">{monthA} 금액</th>
                    <th className="border px-2 py-1.5 text-right w-28">연동 금액</th>
                    <th className="border px-2 py-1.5 text-right w-28">{monthB} 금액</th>
                    <th className="border px-2 py-1.5 text-right w-28">연동 대비 차액</th>
                    <th className="border px-2 py-1.5 text-right w-20">차이율</th>
                    <th className="border px-2 py-1.5 text-right w-28">{monthA}→{monthB}<br/><span className="font-normal text-[10px] text-gray-400">전월대비(실제)</span></th>
                    <th className="border px-2 py-1.5 text-right w-24">원가율<br/><span className="font-normal text-[10px] text-gray-400">생산금액대비</span></th>
                    <th className="border px-2 py-1.5 text-right w-16">B비중</th>
                  </tr>
                </thead>
                <tbody>
                  {flexed.map((r, idx) => {
                    const noPrice = !r.hasPrice;
                    const diffClass = r.diffCost > 0 ? 'text-emerald-700 bg-emerald-50' : r.diffCost < 0 ? 'text-rose-700 bg-rose-50' : 'text-gray-400';
                    const realDiff = r.bCost - r.aCost;                 // 전월대비 실제 증감 (연동 X)
                    const realPct = r.aCost > 0 ? (realDiff / r.aCost) * 100 : (r.bCost > 0 ? 100 : 0);
                    const realCls = realDiff > 0 ? 'text-rose-700' : realDiff < 0 ? 'text-emerald-700' : 'text-gray-400';
                    const aAmt = Number(aAmount) || 0, bAmt = Number(bAmount) || 0;  // 생산금액
                    const aRate = aAmt > 0 ? (r.aCost / aAmt) * 100 : null;
                    const bRate = bAmt > 0 ? (r.bCost / bAmt) * 100 : null;
                    return (
                      <tr key={r.key} className="border-t">
                        <td className="border px-2 py-1 text-center text-gray-500">{idx + 1}</td>
                        <td className="border px-2 py-1">
                          {noPrice && <span className="text-amber-600 mr-1" title="단가 미입력">⚠️</span>}
                          {displayName(r.key, r.name)}
                        </td>
                        <td className="border px-2 py-1 text-center font-mono text-gray-500">{r.code || '-'}</td>
                        <td className="border px-2 py-1 text-right text-gray-500">{Math.round(r.aGrams).toLocaleString()}</td>
                        <td className="border px-2 py-1 text-right text-gray-500">{Math.round(r.bGrams).toLocaleString()}</td>
                        <td className="border px-2 py-1 text-right text-gray-600">{Math.round(r.aCost).toLocaleString()}</td>
                        <td className="border px-2 py-1 text-right font-semibold text-indigo-700">{Math.round(r.flexedCost).toLocaleString()}</td>
                        <td className="border px-2 py-1 text-right">{Math.round(r.bCost).toLocaleString()}</td>
                        <td className={`border px-2 py-1 text-right font-bold ${diffClass}`}>{r.diffCost > 0 ? '+' : ''}{Math.round(r.diffCost).toLocaleString()}</td>
                        <td className={`border px-2 py-1 text-right font-semibold ${diffClass}`}>{r.diffPct > 0 ? '+' : ''}{r.diffPct.toFixed(1)}%</td>
                        <td className={`border px-2 py-1 text-right ${realCls}`}>
                          <div className="font-semibold">{realDiff > 0 ? '+' : ''}{Math.round(realDiff).toLocaleString()}</div>
                          <div className="text-[10px]">{realPct > 0 ? '+' : ''}{realPct.toFixed(1)}%</div>
                        </td>
                        <td className="border px-2 py-1 text-right text-gray-600 whitespace-nowrap">
                          {aRate === null ? '-' : `${aRate.toFixed(1)}%`}<span className="text-gray-300 mx-0.5">→</span>{bRate === null ? '-' : `${bRate.toFixed(1)}%`}
                          {aRate !== null && bRate !== null && (
                            <div className={`text-[10px] ${bRate - aRate > 0 ? 'text-rose-600' : bRate - aRate < 0 ? 'text-emerald-600' : 'text-gray-400'}`}>{bRate - aRate > 0 ? '+' : ''}{(bRate - aRate).toFixed(1)}%p</div>
                          )}
                        </td>
                        <td className="border px-2 py-1 text-right text-gray-500">{r.bSharePct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-amber-50 font-bold sticky bottom-0">
                    <td className="border px-2 py-1.5 text-center" colSpan={3}>합계</td>
                    <td className="border px-2 py-1.5 text-right text-gray-500">{Math.round(flexed.reduce((s, r) => s + r.aGrams, 0)).toLocaleString()}</td>
                    <td className="border px-2 py-1.5 text-right text-gray-500">{Math.round(flexed.reduce((s, r) => s + r.bGrams, 0)).toLocaleString()}</td>
                    <td className="border px-2 py-1.5 text-right">{Math.round(flexAtotal).toLocaleString()}</td>
                    <td className="border px-2 py-1.5 text-right text-indigo-700">{Math.round(flexFlexedTotal).toLocaleString()}</td>
                    <td className="border px-2 py-1.5 text-right">{Math.round(flexBtotal).toLocaleString()}</td>
                    <td className={`border px-2 py-1.5 text-right ${flexDiffTotal >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{flexDiffTotal > 0 ? '+' : ''}{Math.round(flexDiffTotal).toLocaleString()}</td>
                    <td className={`border px-2 py-1.5 text-right ${flexDiffPct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{flexDiffPct > 0 ? '+' : ''}{flexDiffPct.toFixed(1)}%</td>
                    {(() => {
                      const realDiffTot = flexBtotal - flexAtotal;
                      const realPctTot = flexAtotal > 0 ? (realDiffTot / flexAtotal) * 100 : 0;
                      const aAmt = Number(aAmount) || 0, bAmt = Number(bAmount) || 0;
                      const aRate = aAmt > 0 ? (flexAtotal / aAmt) * 100 : null;
                      const bRate = bAmt > 0 ? (flexBtotal / bAmt) * 100 : null;
                      return <>
                        <td className={`border px-2 py-1.5 text-right ${realDiffTot > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                          <div>{realDiffTot > 0 ? '+' : ''}{Math.round(realDiffTot).toLocaleString()}</div>
                          <div className="text-[10px] font-normal">{realPctTot > 0 ? '+' : ''}{realPctTot.toFixed(1)}%</div>
                        </td>
                        <td className="border px-2 py-1.5 text-right text-gray-600 whitespace-nowrap">
                          {aRate === null ? '-' : `${aRate.toFixed(1)}%`}<span className="text-gray-300 mx-0.5">→</span>{bRate === null ? '-' : `${bRate.toFixed(1)}%`}
                        </td>
                      </>;
                    })()}
                    <td className="border"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* 🔎 변동 범인 TOP 10 — 연동 vs 실제 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* 연동 기준 */}
            <div className="border-2 border-indigo-200 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-indigo-50 border-b font-bold text-xs text-indigo-800 flex items-center gap-1.5 flex-wrap">
                <span>🎯 연동 기준 변동 TOP 10</span>
                <span className="text-[11px] font-normal text-indigo-500">생산량 보정 · {monthB}단가 고정 → 순수 효율</span>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-gray-500">
                  <tr>
                    <th className="px-2 py-1 text-left">원재료</th>
                    <th className="px-2 py-1 text-right">연동금액</th>
                    <th className="px-2 py-1 text-right">{monthB}금액</th>
                    <th className="px-2 py-1 text-right">차액</th>
                    <th className="px-2 py-1 text-right">사용량 g</th>
                  </tr>
                </thead>
                <tbody>
                  {topFlexed.map((r, i) => {
                    const waste = r.diffCost < 0;  // 음수 = 낭비
                    const cls = waste ? 'text-rose-700' : 'text-emerald-700';
                    const gDiff = r.bGrams - r.aGrams * ratio;
                    return (
                      <tr key={r.key} className="border-t">
                        <td className="px-2 py-1">
                          <div className="flex items-center gap-1">
                            <span className="text-gray-400">{i + 1}</span>
                            {!r.hasPrice && <span className="text-amber-600" title="단가 미입력">⚠️</span>}
                            <input
                              key={`flex-name-${r.key}-${nameOverrides[r.key] || ''}`}
                              defaultValue={displayName(r.key, r.name)}
                              onBlur={(e) => saveNameOverride(r.key, e.target.value, r.name)}
                              className="flex-1 min-w-0 bg-transparent focus:bg-yellow-50 focus:ring-1 focus:ring-yellow-300 rounded px-1 py-0.5"
                              title={`원본: ${r.name}`}
                            />
                          </div>
                          <div className="text-[10px] font-mono text-gray-400 pl-4">{r.code || '코드없음'}</div>
                        </td>
                        <td className="px-2 py-1 text-right text-indigo-700">{Math.round(r.flexedCost).toLocaleString()}</td>
                        <td className="px-2 py-1 text-right">{Math.round(r.bCost).toLocaleString()}</td>
                        <td className={`px-2 py-1 text-right font-bold ${cls}`}>{r.diffCost > 0 ? '+' : ''}{Math.round(r.diffCost).toLocaleString()}<div className="text-[10px] font-normal">{r.diffPct > 0 ? '+' : ''}{r.diffPct.toFixed(0)}%</div></td>
                        <td className="px-2 py-1 text-right text-gray-500 whitespace-nowrap">
                          {Math.round(r.aGrams * ratio).toLocaleString()}→{Math.round(r.bGrams).toLocaleString()}
                          <div className={`text-[10px] ${gDiff > 0 ? 'text-rose-600' : gDiff < 0 ? 'text-emerald-600' : 'text-gray-400'}`}>{gDiff > 0 ? '+' : ''}{Math.round(gDiff).toLocaleString()}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="px-3 py-1.5 bg-slate-50 border-t text-[11px] text-gray-500">🔴 빨강=낭비(효율↓) · 🟢 녹색=절감(효율↑)</div>
            </div>

            {/* 실제 기준 */}
            <div className="border-2 border-slate-200 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-slate-100 border-b font-bold text-xs text-slate-700 flex items-center gap-1.5 flex-wrap">
                <span>📊 실제 기준 변동 TOP 10</span>
                <span className="text-[11px] font-normal text-gray-500">각 월 자체단가 · 단가인상+생산량 다 포함</span>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-gray-500">
                  <tr>
                    <th className="px-2 py-1 text-left">원재료</th>
                    <th className="px-2 py-1 text-right">{monthA}금액</th>
                    <th className="px-2 py-1 text-right">{monthB}금액</th>
                    <th className="px-2 py-1 text-right">차액</th>
                    <th className="px-2 py-1 text-right">사용량 g</th>
                  </tr>
                </thead>
                <tbody>
                  {topReal.map((r, i) => {
                    const up = r.diffCost > 0;  // 양수 = 증가(더 씀)
                    const cls = up ? 'text-rose-700' : 'text-emerald-700';
                    const gDiff = r.bGrams - r.aGrams;
                    return (
                      <tr key={r.key} className="border-t">
                        <td className="px-2 py-1">
                          <div className="flex items-center gap-1">
                            <span className="text-gray-400">{i + 1}</span>
                            <input
                              key={`real-name-${r.key}-${nameOverrides[r.key] || ''}`}
                              defaultValue={displayName(r.key, r.name)}
                              onBlur={(e) => saveNameOverride(r.key, e.target.value, r.name)}
                              className="flex-1 min-w-0 bg-transparent focus:bg-yellow-50 focus:ring-1 focus:ring-yellow-300 rounded px-1 py-0.5"
                              title={`원본: ${r.name}`}
                            />
                          </div>
                          <div className="text-[10px] font-mono text-gray-400 pl-4">{r.code || '코드없음'}</div>
                        </td>
                        <td className="px-2 py-1 text-right text-gray-600">{Math.round(r.aCost).toLocaleString()}</td>
                        <td className="px-2 py-1 text-right">{Math.round(r.bCost).toLocaleString()}</td>
                        <td className={`px-2 py-1 text-right font-bold ${cls}`}>{r.diffCost > 0 ? '+' : ''}{Math.round(r.diffCost).toLocaleString()}<div className="text-[10px] font-normal">{r.diffPct > 0 ? '+' : ''}{r.diffPct.toFixed(0)}%</div></td>
                        <td className="px-2 py-1 text-right text-gray-500 whitespace-nowrap">
                          {Math.round(r.aGrams).toLocaleString()}→{Math.round(r.bGrams).toLocaleString()}
                          <div className={`text-[10px] ${gDiff > 0 ? 'text-rose-600' : gDiff < 0 ? 'text-emerald-600' : 'text-gray-400'}`}>{gDiff > 0 ? '+' : ''}{Math.round(gDiff).toLocaleString()}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="px-3 py-1.5 bg-slate-50 border-t text-[11px] text-gray-500">🔴 빨강=비용 증가 · 🟢 녹색=비용 감소 (실제 지갑 영향)</div>
            </div>
          </div>

          {/* 비교 표 (각 월 자체 단가) */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm flex items-center gap-2">
              <span>📊 원재료별 비교 (각 월 자체 단가)</span>
              <span className="text-xs text-gray-500 font-normal">{diff.length}종 · B월 사용량 내림차순 · 단가인상 포함</span>
            </div>
            <div className="overflow-x-auto max-h-[700px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-gray-600 sticky top-0 z-10">
                  <tr>
                    <th className="border px-2 py-1.5 w-10">순위</th>
                    <th className="border px-2 py-1.5 text-left">원재료</th>
                    <th className="border px-2 py-1.5 w-24">코드</th>
                    <th className="border px-2 py-1.5 text-right w-24">{monthA} g</th>
                    <th className="border px-2 py-1.5 text-right w-28">{monthA} 원</th>
                    <th className="border px-2 py-1.5 text-right w-24">{monthB} g</th>
                    <th className="border px-2 py-1.5 text-right w-28">{monthB} 원</th>
                    <th className="border px-2 py-1.5 text-right w-28">차액 (원)</th>
                    <th className="border px-2 py-1.5 text-right w-20">차이율</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.map((r, idx) => {
                    const noPrice = !r.aHasPrice && !r.bHasPrice;
                    const diffClass = r.diffCost > 0 ? 'text-rose-700 bg-rose-50' : r.diffCost < 0 ? 'text-emerald-700 bg-emerald-50' : 'text-gray-400';
                    return (
                      <tr key={r.key} className="border-t">
                        <td className="border px-2 py-1 text-center text-gray-500">{idx + 1}</td>
                        <td className="border px-2 py-1">
                          {noPrice && <span className="text-amber-600 mr-1" title="단가 미입력">⚠️</span>}
                          {displayName(r.key, r.name)}
                        </td>
                        <td className="border px-2 py-1 text-center font-mono text-gray-500">{r.code || '-'}</td>
                        <td className="border px-2 py-1 text-right">{Math.round(r.aGrams).toLocaleString()}</td>
                        <td className={`border px-2 py-1 text-right ${r.aHasPrice ? '' : 'text-amber-600'}`}>{r.aHasPrice ? Math.round(r.aCost).toLocaleString() : '-'}</td>
                        <td className="border px-2 py-1 text-right">{Math.round(r.bGrams).toLocaleString()}</td>
                        <td className={`border px-2 py-1 text-right ${r.bHasPrice ? '' : 'text-amber-600'}`}>{r.bHasPrice ? Math.round(r.bCost).toLocaleString() : '-'}</td>
                        <td className={`border px-2 py-1 text-right font-bold ${diffClass}`}>{r.diffCost > 0 ? '+' : ''}{Math.round(r.diffCost).toLocaleString()}</td>
                        <td className={`border px-2 py-1 text-right font-semibold ${diffClass}`}>{r.diffPct > 0 ? '+' : ''}{r.diffPct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-amber-50 font-bold sticky bottom-0">
                    <td className="border px-2 py-1.5 text-center" colSpan={4}>합계</td>
                    <td className="border px-2 py-1.5 text-right">{Math.round(aTotal).toLocaleString()}</td>
                    <td className="border"></td>
                    <td className="border px-2 py-1.5 text-right">{Math.round(bTotal).toLocaleString()}</td>
                    <td className="border px-2 py-1.5 text-right text-rose-700">{diffTotal > 0 ? '+' : ''}{Math.round(diffTotal).toLocaleString()}</td>
                    <td className="border px-2 py-1.5 text-right text-rose-700">{diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

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
          </div>
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
                          <td className="px-2 py-1 text-right text-gray-500 w-16">{a.count}회</td>
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
                    <td className="px-2 py-1 text-right text-gray-500 w-16">{a.count}회</td>
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

function KpiCard({ label, value, accent }: { label: string; value: string; accent: 'rose' | 'emerald' | 'slate' }) {
  const styles = {
    rose:    { box: 'bg-rose-50 border-rose-200',       txt: 'text-rose-700' },
    emerald: { box: 'bg-emerald-50 border-emerald-200', txt: 'text-emerald-700' },
    slate:   { box: 'bg-slate-50 border-slate-200',     txt: 'text-slate-700' },
  }[accent];
  return (
    <div className={`border rounded-lg p-3 ${styles.box}`}>
      <div className="text-xs text-gray-600">{label}</div>
      <div className={`mt-1 text-xl font-bold ${styles.txt}`}>{value}</div>
    </div>
  );
}

/* ============================================================
   제품군(냉장/실온)별 원재료비 분해 패널
   "생산량은 비슷한데 원재료비율이 왜 달라졌나" 를 믹스 관점에서 본다.
   ============================================================ */
function MixSplitPanel({
  monthA, monthB, data,
}: {
  monthA: string; monthB: string;
  data: {
    a: { cold: number; amb: number; coldQty: number; ambQty: number };
    b: { cold: number; amb: number; coldQty: number; ambQty: number };
    byScope: Record<'all' | 'cold' | 'ambient', { down: DiffRow[]; up: DiffRow[] }>;
    byScopeFlexed: Record<'all' | 'cold' | 'ambient', { down: DiffRow[]; up: DiffRow[] }>;
  };
}) {
  const [scope, setScope] = useState<'all' | 'cold' | 'ambient'>('all');
  const [flexed, setFlexed] = useState(false);   // true = B월 단가 고정(단가효과 제외)
  const set = (flexed ? data.byScopeFlexed : data.byScope)[scope];
  const won = (n: number) => Math.round(n).toLocaleString();
  const row = (d: { cold: number; amb: number; coldQty: number; ambQty: number }) => {
    const total = d.cold + d.amb;
    const qty = d.coldQty + d.ambQty;
    return {
      total, qty,
      ambSharePct: total > 0 ? (d.amb / total) * 100 : 0,      // 재료비 중 실온 비중
      ambQtySharePct: qty > 0 ? (d.ambQty / qty) * 100 : 0,    // 생산량 중 실온 비중
      perEa: qty > 0 ? total / qty : 0,                        // EA당 재료비
      ambPerEa: d.ambQty > 0 ? d.amb / d.ambQty : 0,
      coldPerEa: d.coldQty > 0 ? d.cold / d.coldQty : 0,
    };
  };
  const A = row(data.a), B = row(data.b);
  const delta = (b: number, a: number) => b - a;
  const arrow = (v: number) => (v > 0 ? '▲' : v < 0 ? '▼' : '–');
  const cls = (v: number) => (v > 0 ? 'text-rose-600' : v < 0 ? 'text-blue-600' : 'text-gray-400');

  return (
    <div className="bg-white border-2 border-indigo-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-indigo-600 text-white font-bold text-sm flex items-center gap-2 flex-wrap">
        <span>🧊🌡️ 제품군별 원재료비 분해</span>
        <span className="text-xs font-normal text-indigo-100">냉장 vs 실온 — 생산 믹스가 원가에 준 영향</span>
      </div>

      <div className="p-4 space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border">
            <thead className="bg-slate-50 text-xs text-gray-600">
              <tr>
                <th className="border px-3 py-2 text-left">구분</th>
                <th className="border px-3 py-2 text-right">{monthA}</th>
                <th className="border px-3 py-2 text-right">{monthB}</th>
                <th className="border px-3 py-2 text-right">증감</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              <tr>
                <td className="border px-3 py-1.5 font-semibold text-blue-700">냉장 재료비</td>
                <td className="border px-3 py-1.5 text-right">{won(data.a.cold)}</td>
                <td className="border px-3 py-1.5 text-right">{won(data.b.cold)}</td>
                <td className={`border px-3 py-1.5 text-right font-bold ${cls(delta(data.b.cold, data.a.cold))}`}>
                  {arrow(delta(data.b.cold, data.a.cold))} {won(Math.abs(delta(data.b.cold, data.a.cold)))}
                </td>
              </tr>
              <tr className="bg-amber-50/60">
                <td className="border px-3 py-1.5 font-semibold text-amber-700">실온 재료비</td>
                <td className="border px-3 py-1.5 text-right">{won(data.a.amb)}</td>
                <td className="border px-3 py-1.5 text-right">{won(data.b.amb)}</td>
                <td className={`border px-3 py-1.5 text-right font-bold ${cls(delta(data.b.amb, data.a.amb))}`}>
                  {arrow(delta(data.b.amb, data.a.amb))} {won(Math.abs(delta(data.b.amb, data.a.amb)))}
                </td>
              </tr>
              <tr className="bg-slate-50 font-bold">
                <td className="border px-3 py-1.5">합계 재료비</td>
                <td className="border px-3 py-1.5 text-right">{won(A.total)}</td>
                <td className="border px-3 py-1.5 text-right">{won(B.total)}</td>
                <td className={`border px-3 py-1.5 text-right ${cls(delta(B.total, A.total))}`}>
                  {arrow(delta(B.total, A.total))} {won(Math.abs(delta(B.total, A.total)))}
                </td>
              </tr>
              <tr>
                <td className="border px-3 py-1.5 text-gray-600">생산량 (EA)</td>
                <td className="border px-3 py-1.5 text-right">{A.qty.toLocaleString()}</td>
                <td className="border px-3 py-1.5 text-right">{B.qty.toLocaleString()}</td>
                <td className={`border px-3 py-1.5 text-right ${cls(delta(B.qty, A.qty))}`}>
                  {arrow(delta(B.qty, A.qty))} {Math.abs(delta(B.qty, A.qty)).toLocaleString()}
                </td>
              </tr>
              <tr className="bg-indigo-50/60">
                <td className="border px-3 py-1.5 font-bold text-indigo-800">EA당 재료비 (원/개)</td>
                <td className="border px-3 py-1.5 text-right font-bold">{A.perEa.toFixed(1)}</td>
                <td className="border px-3 py-1.5 text-right font-bold">{B.perEa.toFixed(1)}</td>
                <td className={`border px-3 py-1.5 text-right font-bold ${cls(delta(B.perEa, A.perEa))}`}>
                  {arrow(delta(B.perEa, A.perEa))} {Math.abs(delta(B.perEa, A.perEa)).toFixed(1)}
                </td>
              </tr>
              <tr>
                <td className="border px-3 py-1.5 text-gray-600">실온 비중 — 생산량</td>
                <td className="border px-3 py-1.5 text-right">{A.ambQtySharePct.toFixed(1)}%</td>
                <td className="border px-3 py-1.5 text-right">{B.ambQtySharePct.toFixed(1)}%</td>
                <td className={`border px-3 py-1.5 text-right ${cls(delta(B.ambQtySharePct, A.ambQtySharePct))}`}>
                  {arrow(delta(B.ambQtySharePct, A.ambQtySharePct))} {Math.abs(delta(B.ambQtySharePct, A.ambQtySharePct)).toFixed(1)}%p
                </td>
              </tr>
              <tr className="bg-amber-50/60">
                <td className="border px-3 py-1.5 font-semibold text-amber-700">실온 비중 — 재료비</td>
                <td className="border px-3 py-1.5 text-right">{A.ambSharePct.toFixed(1)}%</td>
                <td className="border px-3 py-1.5 text-right">{B.ambSharePct.toFixed(1)}%</td>
                <td className={`border px-3 py-1.5 text-right font-bold ${cls(delta(B.ambSharePct, A.ambSharePct))}`}>
                  {arrow(delta(B.ambSharePct, A.ambSharePct))} {Math.abs(delta(B.ambSharePct, A.ambSharePct)).toFixed(1)}%p
                </td>
              </tr>
              <tr>
                <td className="border px-3 py-1.5 text-gray-500 text-xs">EA당 재료비 — 냉장 / 실온</td>
                <td className="border px-3 py-1.5 text-right text-xs">{A.coldPerEa.toFixed(1)} / {A.ambPerEa.toFixed(1)}</td>
                <td className="border px-3 py-1.5 text-right text-xs">{B.coldPerEa.toFixed(1)} / {B.ambPerEa.toFixed(1)}</td>
                <td className="border px-3 py-1.5 text-right text-xs text-gray-400">
                  {(B.ambPerEa > B.coldPerEa) ? '실온이 더 비쌈' : (B.ambPerEa < B.coldPerEa ? '냉장이 더 비쌈' : '동일')}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="bg-indigo-50 border border-indigo-200 rounded p-3 text-xs text-indigo-900 leading-relaxed">
          <b>읽는 법</b> — 실온 EA당 재료비가 냉장보다 비싸고, {monthB}에 <b>실온 비중(생산량)이 줄었다면</b>,
          같은 생산량이라도 합계 재료비가 내려갑니다(믹스 효과). 아래 표에서 실온 재료 중
          <b> 금액이 크게 줄어든 항목</b>(한우 등)이 상단에 오면 그 가설이 뒷받침됩니다.
          <span className="text-indigo-600"> 단, 단가 변동 효과는 분석 2의 Flexed(연동예산)에서 따로 확인하세요.</span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-gray-700">원재료별 금액 변동</span>
          <div className="flex gap-1">
            {([['all', '전체 (냉장+실온)'], ['cold', '냉장만'], ['ambient', '실온만']] as const).map(([k, lab]) => (
              <button key={k} onClick={() => setScope(k)}
                className={`px-3 py-1 text-xs rounded font-medium ${scope === k ? 'bg-indigo-600 text-white' : 'border hover:bg-gray-50'}`}>
                {lab}
              </button>
            ))}
          </div>
          <span className="text-gray-300">|</span>
          <div className="flex gap-1">
            {([[false, '실적 그대로'], [true, `${monthB} 단가 고정`]] as const).map(([k, lab]) => (
              <button key={String(k)} onClick={() => setFlexed(k)}
                className={`px-3 py-1 text-xs rounded font-medium ${flexed === k ? 'bg-slate-700 text-white' : 'border hover:bg-gray-50'}`}>
                {lab}
              </button>
            ))}
          </div>
        </div>

        <div className={`border rounded p-2.5 text-xs leading-relaxed ${flexed ? 'bg-slate-50 border-slate-300 text-slate-700' : 'bg-amber-50 border-amber-300 text-amber-900'}`}>
          {flexed ? (
            <>🔒 <b>{monthB} 단가 고정(연동)</b> — {monthA} 사용량도 {monthB} 단가로 계산했습니다.
            단가 변동 효과가 빠져 <b>얼마나 쓰고 무엇을 만들었는지의 차이만</b> 남습니다.
            “제품 구성이 바뀌어서 줄었다”의 근거로 이 값을 쓰세요.</>
          ) : (
            <>📊 <b>실적 그대로</b> — 각 월의 실제 단가로 계산했습니다. 실제 지출 차이라 총액 설명에 맞지만,
            <b> 사용량 변화와 단가 변화가 섞여</b> 있습니다. 단가 효과를 빼려면 “{monthB} 단가 고정”을 누르세요.</>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="text-sm font-bold mb-1.5" style={{ color: '#2563eb' }}>
            ▼ 금액 감소 상위 <span className="text-xs font-normal text-gray-500">({monthA} → {monthB})</span>
          </div>
          <div className="border rounded overflow-hidden max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-gray-600 sticky top-0">
                <tr>
                  <th className="px-3 py-1.5 text-left">원재료</th>
                  <th className="px-3 py-1.5 text-right">{monthA} 사용(g)</th>
                  <th className="px-3 py-1.5 text-right">{monthB} 사용(g)</th>
                  <th className="px-3 py-1.5 text-right">{monthA} 금액</th>
                  <th className="px-3 py-1.5 text-right">{monthB} 금액</th>
                  <th className="px-3 py-1.5 text-right">증감</th>
                </tr>
              </thead>
              <tbody className="divide-y tabular-nums">
                {set.down.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">감소한 원재료가 없습니다.</td></tr>
                ) : set.down.map((r) => (
                  <tr key={r.key} className="hover:bg-slate-50/60">
                    <td className="px-3 py-1 text-gray-800">{r.name}{!r.aHasPrice && !r.bHasPrice && <span className="ml-1 text-amber-600">(단가없음)</span>}</td>
                    <td className="px-3 py-1 text-right text-gray-500">{Math.round(r.aGrams).toLocaleString()}</td>
                    <td className="px-3 py-1 text-right text-gray-500">{Math.round(r.bGrams).toLocaleString()}</td>
                    <td className="px-3 py-1 text-right">{won(r.aCost)}</td>
                    <td className="px-3 py-1 text-right">{won(r.bCost)}</td>
                    <td className={`px-3 py-1 text-right font-bold ${cls(r.diffCost)}`}>
                      {arrow(r.diffCost)} {won(Math.abs(r.diffCost))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="text-sm font-bold mb-1.5" style={{ color: '#e11d48' }}>
            ▲ 금액 증가 상위 <span className="text-xs font-normal text-gray-500">({monthA} → {monthB})</span>
          </div>
          <div className="border rounded overflow-hidden max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-gray-600 sticky top-0">
                <tr>
                  <th className="px-3 py-1.5 text-left">원재료</th>
                  <th className="px-3 py-1.5 text-right">{monthA} 사용(g)</th>
                  <th className="px-3 py-1.5 text-right">{monthB} 사용(g)</th>
                  <th className="px-3 py-1.5 text-right">{monthA} 금액</th>
                  <th className="px-3 py-1.5 text-right">{monthB} 금액</th>
                  <th className="px-3 py-1.5 text-right">증감</th>
                </tr>
              </thead>
              <tbody className="divide-y tabular-nums">
                {set.up.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">증가한 원재료가 없습니다.</td></tr>
                ) : set.up.map((r) => (
                  <tr key={r.key} className="hover:bg-slate-50/60">
                    <td className="px-3 py-1 text-gray-800">{r.name}{!r.aHasPrice && !r.bHasPrice && <span className="ml-1 text-amber-600">(단가없음)</span>}</td>
                    <td className="px-3 py-1 text-right text-gray-500">{Math.round(r.aGrams).toLocaleString()}</td>
                    <td className="px-3 py-1 text-right text-gray-500">{Math.round(r.bGrams).toLocaleString()}</td>
                    <td className="px-3 py-1 text-right">{won(r.aCost)}</td>
                    <td className="px-3 py-1 text-right">{won(r.bCost)}</td>
                    <td className={`px-3 py-1 text-right font-bold ${cls(r.diffCost)}`}>
                      {arrow(r.diffCost)} {won(Math.abs(r.diffCost))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   원가 변동 요인 — 품목별 워터폴
   "EA당 재료비가 A월 → B월로 왜 변했나" 를 품목 기여도로 한눈에.
   발산형 팔레트: 절감 #2563eb / 상승 #e11d48 / 총계·기타 중립 회색
   ============================================================ */
const C_DOWN = '#2563eb';   // 원가 절감
const C_UP = '#e11d48';     // 원가 상승
const C_TOTAL = '#334155';  // 총계 기둥
const C_OTHER = '#94a3b8';  // 기타(중립)

function CostWaterfall({
  monthA, monthB, aUnit, bUnit, rows, topN = 6,
}: {
  monthA: string; monthB: string; aUnit: number; bUnit: number; rows: ContribRow[]; topN?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  // 절감 상위 / 상승 상위 + 나머지는 '기타'로 접기 (색 순환 금지 규칙)
  const downs = rows.filter((r) => r.contrib < 0).slice(0, topN);
  const ups = [...rows].filter((r) => r.contrib > 0).sort((a, b) => b.contrib - a.contrib).slice(0, topN);
  const picked = new Set([...downs, ...ups].map((r) => r.key));
  const otherSum = rows.filter((r) => !picked.has(r.key)).reduce((s, r) => s + r.contrib, 0);

  type Step = { label: string; value: number; kind: 'total' | 'step' | 'other'; row?: ContribRow };
  const steps: Step[] = [
    { label: `${monthA}`, value: aUnit, kind: 'total' },
    ...downs.map((r) => ({ label: r.label, value: r.contrib, kind: 'step' as const, row: r })),
    ...ups.map((r) => ({ label: r.label, value: r.contrib, kind: 'step' as const, row: r })),
    ...(Math.abs(otherSum) > 0.01 ? [{ label: `기타 ${rows.length - picked.size}품목`, value: otherSum, kind: 'other' as const }] : []),
    { label: `${monthB}`, value: bUnit, kind: 'total' },
  ];

  // 누적 좌표
  let run = 0;
  const bars = steps.map((s) => {
    if (s.kind === 'total') { run = s.value; return { ...s, from: 0, to: s.value }; }
    const from = run; run += s.value; return { ...s, from, to: run };
  });
  // 총계(수백원)와 변화(수원)의 스케일 차가 커서 0부터 그리면 변화가 안 보인다.
  // → 실제 '수준(level)' 구간만 확대해서 표시하고, 0이 아님을 축에 명시한다.
  //   총계 기둥은 구간 계산에서 제외하고(바닥이 0이라 범위를 망침) 축 바닥부터 그린다.
  const vals = bars.flatMap((b) => (b.kind === 'total' ? [b.to] : [b.from, b.to]));
  const rawMax = Math.max(...vals), rawMin = Math.min(...vals);
  const pad = Math.max(0.5, (rawMax - rawMin) * 0.18);
  const maxV = rawMax + pad, minV = rawMin - pad;

  const W = 960, H = 340, padL = 56, padR = 16, padT = 22, padB = 92;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const band = innerW / bars.length;
  const barW = Math.min(46, band * 0.6);
  const span = Math.max(0.1, maxV - minV);
  const y = (v: number) => padT + innerH - ((v - minV) / span) * innerH;

  const fmt = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
        aria-label={`${monthA}에서 ${monthB}까지 EA당 재료비 변동 요인`}>
        {/* 격자 — 후퇴 */}
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <line key={p} x1={padL} x2={W - padR} y1={padT + innerH * p} y2={padT + innerH * p}
            stroke="#e2e8f0" strokeWidth={1} />
        ))}
        {[0, 0.5, 1].map((p) => (
          <text key={p} x={padL - 8} y={padT + innerH * p + 4} fontSize={11} textAnchor="end" fill="#94a3b8">
            {(maxV - span * p).toFixed(1)}
          </text>
        ))}
        <text x={padL - 8} y={padT + innerH + 26} fontSize={9} textAnchor="end" fill="#cbd5e1">축 0 아님</text>

        {bars.map((b, i) => {
          const cx = padL + band * i + band / 2;
          // 총계는 축 바닥부터, 단계는 from→to 구간만
          const floorY = padT + innerH;
          const top = b.kind === 'total' ? y(b.to) : Math.min(y(b.from), y(b.to));
          const h = b.kind === 'total'
            ? Math.max(2, floorY - y(b.to))
            : Math.max(2, Math.abs(y(b.to) - y(b.from)));
          const fill = b.kind === 'total' ? C_TOTAL : b.kind === 'other' ? C_OTHER : (b.value < 0 ? C_DOWN : C_UP);
          const isHover = hover === i;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* 히트 영역은 마크보다 크게 */}
              <rect x={cx - band / 2} y={padT} width={band} height={innerH} fill="transparent" />
              <rect x={cx - barW / 2} y={top} width={barW} height={h} rx={4} fill={fill}
                opacity={hover === null || isHover ? 1 : 0.45}
                stroke="#ffffff" strokeWidth={2} />
              {/* 연결선 */}
              {i < bars.length - 1 && b.kind !== 'total' && (
                <line x1={cx + barW / 2} x2={padL + band * (i + 1) + band / 2 - barW / 2}
                  y1={y(b.to)} y2={y(b.to)} stroke="#cbd5e1" strokeWidth={1} strokeDasharray="3 3" />
              )}
              {i === 0 && (
                <line x1={cx + barW / 2} x2={padL + band + band / 2 - barW / 2}
                  y1={y(b.to)} y2={y(b.to)} stroke="#cbd5e1" strokeWidth={1} strokeDasharray="3 3" />
              )}
              {/* 값 직접 라벨 */}
              <text x={cx} y={top - 6} fontSize={11} textAnchor="middle" fontWeight={700}
                fill={b.kind === 'total' ? '#334155' : b.value < 0 ? C_DOWN : b.kind === 'other' ? '#64748b' : C_UP}>
                {b.kind === 'total' ? b.value.toFixed(1) : fmt(b.value)}
              </text>
              {/* 품목명 — 회전 */}
              <text x={cx} y={padT + innerH + 12} fontSize={10} textAnchor="end" fill="#475569"
                transform={`rotate(-40 ${cx} ${padT + innerH + 12})`}>
                {b.label.length > 14 ? b.label.slice(0, 13) + '…' : b.label}
              </text>
            </g>
          );
        })}
        <line x1={padL} x2={W - padR} y1={padT + innerH} y2={padT + innerH} stroke="#cbd5e1" strokeWidth={1} />
      </svg>

      {hover !== null && bars[hover] && (
        <div className="absolute left-1/2 -translate-x-1/2 top-1 bg-slate-900 text-white text-xs rounded px-3 py-2 shadow-lg pointer-events-none z-10">
          <div className="font-bold">{bars[hover].label}</div>
          {bars[hover].kind === 'total' ? (
            <div>EA당 재료비 {bars[hover].value.toFixed(1)}원</div>
          ) : bars[hover].row ? (
            <>
              <div>EA당 영향 <b>{fmt(bars[hover].value)}원</b></div>
              <div className="text-slate-300">
                물량효과 {fmt(bars[hover].row!.mixEffect)} · 원가효과 {fmt(bars[hover].row!.rateEffect)}
              </div>
              <div className="text-slate-300">
                생산 {Math.round(bars[hover].row!.aQty).toLocaleString()} → {Math.round(bars[hover].row!.bQty).toLocaleString()} EA
                · 단가 {bars[hover].row!.aUnit.toFixed(0)} → {bars[hover].row!.bUnit.toFixed(0)}원
              </div>
            </>
          ) : <div>합계 {fmt(bars[hover].value)}원</div>}
        </div>
      )}

      {/* 범례 — 색 단독 식별 금지 */}
      <div className="flex items-center gap-4 justify-center text-xs text-gray-600 mt-1">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: C_DOWN }} />원가 절감</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: C_UP }} />원가 상승</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: C_OTHER }} />기타</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: C_TOTAL }} />월 합계</span>
      </div>
    </div>
  );
}

function CostDriverPanel({
  monthA, monthB, data,
}: {
  monthA: string; monthB: string;
  data: { rows: ContribRow[]; aUnitTotal: number; bUnitTotal: number; delta: number };
}) {
  const [tab, setTab] = useState<'chart' | 'table'>('chart');
  const { rows, aUnitTotal, bUnitTotal, delta } = data;
  const fmt = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1);
  const mixSum = rows.reduce((s, r) => s + r.mixEffect, 0);
  const rateSum = rows.reduce((s, r) => s + r.rateEffect, 0);
  const topDown = rows.filter((r) => r.contrib < 0).slice(0, 3);
  const topUp = [...rows].sort((a, b) => b.contrib - a.contrib).slice(0, 3).filter((r) => r.contrib > 0);

  return (
    <div className="bg-white border-2 border-slate-300 rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-slate-800 text-white font-bold text-sm flex items-center gap-2 flex-wrap">
        <span>📉 원가 변동 요인 — 품목별</span>
        <span className="text-xs font-normal text-slate-300">EA당 재료비가 왜 변했는지 한눈에</span>
      </div>

      <div className="p-4 space-y-4">
        {/* 헤드라인 */}
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <div className="text-xs text-gray-500">{monthA} → {monthB} · EA당 재료비</div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-gray-500 tabular-nums">{aUnitTotal.toFixed(1)}</span>
              <span className="text-gray-400">→</span>
              <span className="text-3xl font-extrabold tabular-nums" style={{ color: delta < 0 ? C_DOWN : C_UP }}>
                {bUnitTotal.toFixed(1)}
              </span>
              <span className="text-lg font-bold tabular-nums" style={{ color: delta < 0 ? C_DOWN : C_UP }}>
                ({fmt(delta)}원)
              </span>
            </div>
          </div>
          <div className="ml-auto text-xs text-gray-600 bg-slate-50 border rounded px-3 py-2">
            <div>물량(믹스)효과 합 <b className="tabular-nums" style={{ color: mixSum < 0 ? C_DOWN : C_UP }}>{fmt(mixSum)}원</b></div>
            <div>품목원가(요율)효과 합 <b className="tabular-nums" style={{ color: rateSum < 0 ? C_DOWN : C_UP }}>{fmt(rateSum)}원</b></div>
          </div>
        </div>

        {/* 한 줄 결론 */}
        <div className="bg-slate-50 border rounded p-3 text-sm text-gray-700 leading-relaxed">
          <b>요약</b> — EA당 재료비가 <b style={{ color: delta < 0 ? C_DOWN : C_UP }}>{fmt(delta)}원</b> 변했고,
          그중 <b>{Math.abs(mixSum) > Math.abs(rateSum) ? '무엇을 얼마나 만들었나(물량·믹스)' : '품목 자체의 원가(레시피·단가)'}</b> 쪽 영향이 더 큽니다.
          {topDown.length > 0 && <> 가장 크게 낮춘 품목: <b style={{ color: C_DOWN }}>{topDown.map((r) => r.label).join(', ')}</b>.</>}
          {topUp.length > 0 && <> 가장 크게 올린 품목: <b style={{ color: C_UP }}>{topUp.map((r) => r.label).join(', ')}</b>.</>}
        </div>

        <div className="flex gap-1">
          <button onClick={() => setTab('chart')}
            className={`px-3 py-1.5 text-xs rounded font-medium ${tab === 'chart' ? 'bg-slate-800 text-white' : 'border hover:bg-gray-50'}`}>그래프</button>
          <button onClick={() => setTab('table')}
            className={`px-3 py-1.5 text-xs rounded font-medium ${tab === 'table' ? 'bg-slate-800 text-white' : 'border hover:bg-gray-50'}`}>표로 보기</button>
        </div>

        {tab === 'chart' ? (
          <CostWaterfall monthA={monthA} monthB={monthB} aUnit={aUnitTotal} bUnit={bUnitTotal} rows={rows} />
        ) : (
          <div className="border rounded overflow-hidden max-h-96 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-gray-600 sticky top-0">
                <tr>
                  <th className="px-3 py-1.5 text-left">품목</th>
                  <th className="px-3 py-1.5 text-center">구분</th>
                  <th className="px-3 py-1.5 text-right">{monthA} EA</th>
                  <th className="px-3 py-1.5 text-right">{monthB} EA</th>
                  <th className="px-3 py-1.5 text-right">EA당 원가 A→B</th>
                  <th className="px-3 py-1.5 text-right">물량효과</th>
                  <th className="px-3 py-1.5 text-right">원가효과</th>
                  <th className="px-3 py-1.5 text-right">기여(원/EA)</th>
                </tr>
              </thead>
              <tbody className="divide-y tabular-nums">
                {rows.filter((r) => Math.abs(r.contrib) >= 0.01).map((r) => (
                  <tr key={r.key} className="hover:bg-slate-50/60">
                    <td className="px-3 py-1 text-gray-800">{r.label}</td>
                    <td className="px-3 py-1 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${r.kind === 'cold' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                        {r.kind === 'cold' ? '냉장' : '실온'}
                      </span>
                    </td>
                    <td className="px-3 py-1 text-right text-gray-500">{Math.round(r.aQty).toLocaleString()}</td>
                    <td className="px-3 py-1 text-right text-gray-500">{Math.round(r.bQty).toLocaleString()}</td>
                    <td className="px-3 py-1 text-right text-gray-500">
                      {r.aQty <= 0 ? <span className="text-emerald-600 font-bold">신규</span>
                        : r.bQty <= 0 ? <span className="text-rose-600 font-bold">중단</span>
                        : <>{r.aUnit.toFixed(0)}→{r.bUnit.toFixed(0)}</>}
                    </td>
                    <td className="px-3 py-1 text-right" style={{ color: r.mixEffect < 0 ? C_DOWN : r.mixEffect > 0 ? C_UP : '#94a3b8' }}>{fmt(r.mixEffect)}</td>
                    <td className="px-3 py-1 text-right" style={{ color: r.rateEffect < 0 ? C_DOWN : r.rateEffect > 0 ? C_UP : '#94a3b8' }}>{fmt(r.rateEffect)}</td>
                    <td className="px-3 py-1 text-right font-bold" style={{ color: r.contrib < 0 ? C_DOWN : r.contrib > 0 ? C_UP : '#94a3b8' }}>{fmt(r.contrib)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="text-xs text-gray-500 leading-relaxed">
          <b>물량효과</b> = 그 품목을 더/덜 만들어서 생긴 영향 (믹스). 신규 생산·생산 중단 품목은 전액 물량효과로 봅니다. · <b>원가효과</b> = 두 달 모두 만든 품목에서, 그 품목 자체의 EA당 재료비가 변해서 생긴 영향(레시피·단가).
          모든 품목 기여를 더하면 EA당 재료비 변화와 정확히 일치합니다.
        </div>
      </div>
    </div>
  );
}
