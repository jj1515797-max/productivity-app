import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, doc, getDoc, getDocs, onSnapshot, query, setDoc, where } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import type { AmbientEntry, Item, MachineEntry } from '../types';
import type { AmbientRecipe, Recipe } from '../lib/wasteCompute';
import { CODE_KEY_PREFIX, monthPriceKey, normalizeCode, normalizeMaterialName } from '../lib/wasteCompute';
import { canonicalShort } from '../lib/codeUtil';
import { computeMonthlyProduction } from '../lib/monthlyProduction';
import type { MonthlyProduction } from '../lib/monthlyProduction';
import { allocateActualOutflow, computeTheoreticalByProduct } from '../lib/materialAllocation';
import type { AllocationResult, IngTheoretical } from '../lib/materialAllocation';

/* ===== 캐시 ===== */
const PREFIX = 'matAnalysis2:';
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
  const entries: MachineEntry[] = [];
  ents.forEach((d) => {
    const data = d.data() as MachineEntry;
    if (!data.machine) return;
    entries.push(data);
  });
  const items: Item[] = its.docs.map((d) => d.data() as Item);
  const ambient: AmbientEntry[] = amb.docs.map((d) => d.data() as AmbientEntry);
  return { entries, items, ambient, logistics: log };
}

export default function MaterialAnalysis2() {
  const tm = thisMonth();
  const [month, setMonth] = useState(shiftMonth(tm, -1));
  const [running, setRunning] = useState(false);
  const [, setRaw] = useState<RawMonth | null>(null);
  const [, setProd] = useState<MonthlyProduction | null>(null);
  const [byIng, setByIng] = useState<Map<string, IngTheoretical> | null>(null);
  const [result, setResult] = useState<AllocationResult | null>(null);
  const [outflowG, setOutflowG] = useState<Record<string, number>>({});
  const [outflowAmt, setOutflowAmt] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [expand, setExpand] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);

  // 분석1과 동일하게 마스터 DB 구독
  const [recipeMap, setRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [ambientRecipeMap, setAmbientRecipeMap] = useState<Map<string, AmbientRecipe>>(new Map());
  const [basePriceMap, setBasePriceMap] = useState<Map<string, number>>(new Map());  // 기초단가 (materialPricesInventory)

  // 이름 별칭 — 분석1과 동일 키 (localStorage matAnalysis:nameOverrides)
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('matAnalysis:nameOverrides') || '{}'); } catch { return {}; }
  });
  const saveNameOverride = (key: string, name: string, fallback: string) => {
    setNameOverrides((prev) => {
      const next = { ...prev };
      const trimmed = name.trim();
      if (!trimmed || trimmed === fallback) delete next[key]; else next[key] = trimmed;
      try { localStorage.setItem('matAnalysis:nameOverrides', JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const displayName = (key: string, original: string) => nameOverrides[key] || original;

  useEffect(() => {
    return onSnapshot(collection(db, 'recipes'), (snap) => {
      const m = new Map<string, Recipe>();
      snap.forEach((d) => {
        const data = d.data() as Recipe;
        m.set(d.id, { ...data, code: d.id });
        m.set(d.id.toLowerCase(), { ...data, code: d.id });
      });
      setRecipeMap(m);
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
    return onSnapshot(collection(db, 'materialPricesInventory'), (snap) => {
      const m = new Map<string, number>();
      snap.forEach((d) => {
        const data = d.data() as { month?: string; name?: string; pricePerGram?: number; code?: string };
        const mo = data.month || '';
        if (!mo) return;
        const price = Number(data.pricePerGram) || 0;
        if (data.name) m.set(monthPriceKey(mo, normalizeMaterialName(data.name)), price);
        if (data.code) m.set(monthPriceKey(mo, CODE_KEY_PREFIX + normalizeCode(data.code)), price);
      });
      setBasePriceMap(m);
    });
  }, []);

  // 월별 기초단가 → 이번달 단가 슬라이스 (key without month prefix → 통일 키)
  const monthBasePrice = useMemo(() => {
    const out = new Map<string, number>();
    basePriceMap.forEach((v, k) => {
      const prefix = `${month}__`;
      if (!k.startsWith(prefix)) return;
      out.set(k.slice(prefix.length), v);
    });
    return out;
  }, [basePriceMap, month]);

  // 사용자 입력 출고량 Firestore 로드 (월별)
  useEffect(() => {
    let cancel = false;
    getDoc(doc(db, 'materialOutflow', month)).then((snap) => {
      if (cancel) return;
      const d = snap.data() as { outflowGrams?: Record<string, number>; outflowAmounts?: Record<string, number> } | undefined;
      setOutflowG(d?.outflowGrams || {});
      setOutflowAmt(d?.outflowAmounts || {});
    }).catch(() => {});
    return () => { cancel = true; };
  }, [month]);
  const saveOutflow = (next: { outflowGrams?: Record<string, number>; outflowAmounts?: Record<string, number> }) => {
    setDoc(doc(db, 'materialOutflow', month), { ...next, updatedAt: new Date().toISOString() }, { merge: true })
      .catch((e) => console.error('[materialOutflow save]', e));
  };

  const runAnalysis = async (bustCache = false) => {
    setRunning(true); setErr(null);
    try {
      const fetchOrCache = async (): Promise<RawMonth> => {
        const ttl = month === tm ? TTL_CURRENT : TTL_PAST;
        if (!bustCache) {
          const c = getCache<RawMonth>(`raw:${month}`, ttl);
          if (c) return c;
        }
        const r = await fetchMonth(month);
        setCache(`raw:${month}`, r);
        return r;
      };
      const r = await fetchOrCache();
      setRaw(r);
      const p = computeMonthlyProduction(r.entries, r.items, r.ambient, r.logistics);
      setProd(p);
      // 코드 → 표시명 매핑 (items 우선)
      const nameByCode = new Map<string, string>();
      r.items.forEach((it) => {
        const k = canonicalShort(it.code || '');
        if (k && it.name) nameByCode.set(k, it.name);
      });
      const ing = computeTheoreticalByProduct(p.coldByCode, r.ambient, recipeMap, ambientRecipeMap, nameByCode);
      setByIng(ing);
    } catch (e: any) {
      console.error('[MaterialAnalysis2]', e);
      setErr(e?.message || '분석 중 오류');
    } finally { setRunning(false); }
  };

  // 자동 채움: 이론사용량으로 출고량 채우기
  const fillTheoretical = () => {
    if (!byIng) return;
    const next: Record<string, number> = {};
    byIng.forEach((v, k) => { next[k] = Math.round(v.theoreticalGrams); });
    setOutflowG(next);
    saveOutflow({ outflowGrams: next });
  };
  const clearOutflow = () => {
    if (!confirm('실제 출고량 입력을 모두 지울까요?')) return;
    setOutflowG({}); setOutflowAmt({});
    saveOutflow({ outflowGrams: {}, outflowAmounts: {} });
  };

  // 결과 재계산 (byIng + outflow + price 변화 시)
  useEffect(() => {
    if (!byIng) { setResult(null); return; }
    const r = allocateActualOutflow(byIng, outflowG, outflowAmt, monthBasePrice);
    setResult(r);
  }, [byIng, outflowG, outflowAmt, monthBasePrice]);

  // 입력 onBlur 핸들러
  const updateG = (key: string, val: number) => {
    const next = { ...outflowG };
    if (val > 0) next[key] = val; else delete next[key];
    setOutflowG(next);
    saveOutflow({ outflowGrams: next });
  };
  const updateAmt = (key: string, val: number) => {
    const next = { ...outflowAmt };
    if (val > 0) next[key] = val; else delete next[key];
    setOutflowAmt(next);
    saveOutflow({ outflowAmounts: next });
  };

  const filteredPerIng = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    if (!q) return result.perIng;
    return result.perIng.filter((r) => r.name.toLowerCase().includes(q) || (r.code || '').toLowerCase().includes(q) || displayName(r.key, r.name).toLowerCase().includes(q));
  }, [result, search, nameOverrides]);

  // 검색 필터된 원재료 키 집합 (제품 표 필터링용)
  const filteredIngKeys = useMemo(() => new Set(filteredPerIng.map((r) => r.key)), [filteredPerIng]);
  const filteredPerProduct = useMemo(() => {
    if (!result) return [];
    const q = search.trim();
    if (!q) return result.perProduct;
    return result.perProduct.filter((p) => p.breakdown.some((b) => filteredIngKeys.has(b.ingKey)));
  }, [result, search, filteredIngKeys]);

  const downloadXlsx = async () => {
    if (!result) return;
    const wb = new ExcelJS.Workbook();
    const baseFont = { size: 11, name: '맑은 고딕' };
    const thin = { style: 'thin' as const };
    const border = { top: thin, left: thin, right: thin, bottom: thin };
    const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });

    // 시트 1: 원재료별 출고
    const ws1 = wb.addWorksheet('원재료별 출고');
    ws1.columns = [
      { width: 24 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 12 }, { width: 14 }, { width: 14 },
    ];
    ['원재료', '코드', '이론사용량(g)', '실제출고(g)', '수율%', '단위원가(₩/g)', '실측원가(₩)', '이론원가(₩)']
      .forEach((h, i) => {
        const c = ws1.getCell(1, i + 1);
        c.value = h; c.font = { ...baseFont, bold: true }; c.alignment = { horizontal: 'center' };
        c.fill = fill('FFE2E8F0'); c.border = border;
      });
    result.perIng.forEach((r, idx) => {
      const row = 2 + idx;
      ws1.getCell(row, 1).value = displayName(r.key, r.name);
      ws1.getCell(row, 2).value = r.code || '';
      ws1.getCell(row, 3).value = Math.round(r.theoreticalG);
      ws1.getCell(row, 4).value = Math.round(r.actualG);
      ws1.getCell(row, 5).value = Number(r.yieldPct.toFixed(1));
      ws1.getCell(row, 6).value = Number(r.unitCost.toFixed(2));
      ws1.getCell(row, 7).value = Math.round(r.totalCost);
      ws1.getCell(row, 8).value = Math.round(r.theoreticalG * r.unitCost);
      for (let c = 1; c <= 8; c++) {
        const cell = ws1.getCell(row, c);
        cell.font = baseFont; cell.border = border;
        cell.alignment = { horizontal: c <= 2 ? (c === 1 ? 'left' : 'center') : 'right' };
        if (c >= 3 && c !== 5) cell.numFmt = '#,##0';
        if (c === 5) cell.numFmt = '0.0';
      }
    });

    // 시트 2: 제품별 원재료원가
    const ws2 = wb.addWorksheet('제품별 원재료원가');
    ws2.columns = [
      { width: 14 }, { width: 36 }, { width: 12 }, { width: 14 }, { width: 14 },
    ];
    ['제품코드', '제품명', '생산수량(EA)', '원재료비(₩)', 'EA당 원가(₩)'].forEach((h, i) => {
      const c = ws2.getCell(1, i + 1);
      c.value = h; c.font = { ...baseFont, bold: true }; c.alignment = { horizontal: 'center' };
      c.fill = fill('FFE2E8F0'); c.border = border;
    });
    result.perProduct.forEach((p, idx) => {
      const row = 2 + idx;
      ws2.getCell(row, 1).value = p.code;
      ws2.getCell(row, 2).value = p.productName;
      ws2.getCell(row, 3).value = p.productionQty;
      ws2.getCell(row, 4).value = Math.round(p.materialCost);
      ws2.getCell(row, 5).value = Math.round(p.materialCostPerEA);
      for (let c = 1; c <= 5; c++) {
        const cell = ws2.getCell(row, c);
        cell.font = baseFont; cell.border = border;
        cell.alignment = { horizontal: c === 2 ? 'left' : c === 1 ? 'center' : 'right' };
        if (c >= 3) cell.numFmt = '#,##0';
      }
    });

    // 시트 3: 분배 불가
    if (result.orphans.length > 0) {
      const ws3 = wb.addWorksheet('분배 불가');
      ws3.columns = [{ width: 24 }, { width: 14 }, { width: 14 }];
      ['원재료', '출고량(g)', '금액(₩)'].forEach((h, i) => {
        const c = ws3.getCell(1, i + 1);
        c.value = h; c.font = { ...baseFont, bold: true };
        c.fill = fill('FFFEE2E2'); c.border = border;
      });
      result.orphans.forEach((o, idx) => {
        ws3.getCell(2 + idx, 1).value = o.name;
        ws3.getCell(2 + idx, 2).value = Math.round(o.actualG);
        ws3.getCell(2 + idx, 3).value = Math.round(o.totalCost);
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `원재료분석2_${month}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  // KPI 집계
  const kpi = useMemo(() => {
    if (!result) return null;
    const totalActualG = result.perIng.reduce((s, r) => s + r.actualG, 0);
    const totalTheoG = result.perIng.reduce((s, r) => s + r.theoreticalG, 0);
    const loss = result.ingTotalCost - result.theoTotalCost;
    return {
      totalTheoG, totalActualG,
      yieldPct: totalActualG > 0 ? (totalTheoG / totalActualG) * 100 : 0,
      theoTotalCost: result.theoTotalCost,
      actualTotalCost: result.ingTotalCost,
      lossCost: loss,
    };
  }, [result]);

  return (
    <div className="space-y-5">
      {/* 상단 액션바 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-gray-800 text-lg">🧪 원재료분석2 <span className="text-xs font-normal text-gray-500">— 실측 출고량 역배분</span></span>
        <span className="text-gray-300">|</span>
        <span className="text-xs text-gray-500">기준월</span>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="border rounded px-2 py-1 text-sm font-bold" />
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => runAnalysis(true)} disabled={running} title="캐시 무시" className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50 disabled:opacity-50">🔄</button>
          <button onClick={downloadXlsx} disabled={!result} className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:bg-gray-300">📥 엑셀</button>
          <button onClick={() => runAnalysis(false)} disabled={running}
            className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:bg-gray-300 shadow-sm">
            {running ? '분석 중...' : '🚀 분석 시작'}
          </button>
        </div>
      </div>

      {err && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-3 text-sm">⚠️ {err}</div>}

      {/* DB 상태 */}
      {(recipeMap.size === 0 || basePriceMap.size === 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          ⚠️ 설정 페이지에서 <b>레시피</b> + <b>원재료단가(재고평가현황 기초단가)</b> 를 먼저 입력해야 분석이 정확합니다.
          {basePriceMap.size === 0 && <span className="ml-1 text-rose-600">(기초단가 비어있음)</span>}
        </div>
      )}

      {/* KPI */}
      {kpi && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="이론 원재료비" value={Math.round(kpi.theoTotalCost).toLocaleString() + '원'} accent="slate" />
          <KpiCard label="실측 원재료비" value={Math.round(kpi.actualTotalCost).toLocaleString() + '원'} accent="slate" />
          <KpiCard label="수율 손실 금액" value={(kpi.lossCost >= 0 ? '+' : '') + Math.round(kpi.lossCost).toLocaleString() + '원'} accent={kpi.lossCost >= 0 ? 'rose' : 'emerald'} sub={kpi.lossCost >= 0 ? '실측이 이론보다 더 씀' : '이론보다 적게 씀'} />
          <KpiCard label="전체 수율" value={kpi.yieldPct.toFixed(1) + '%'} accent={kpi.yieldPct >= 95 ? 'emerald' : 'rose'} sub="이론g/실측g" />
        </div>
      )}

      {/* 원재료별 출고 입력 표 */}
      {result && (
        <div className="bg-white border-2 border-indigo-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-indigo-600 text-white font-bold text-sm flex items-center gap-2 flex-wrap">
            <span>📌 원재료별 실제 출고 입력 ({result.perIng.length}건)</span>
            <span className="text-xs font-normal text-indigo-100">자동 채움 후 ERP 재고평가 실측치로 수정 → 자동 저장</span>
            <div className="ml-auto flex gap-1.5">
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="🔍 원재료/코드 검색"
                className="text-gray-800 text-xs rounded px-2 py-1 border-0" />
              <button onClick={fillTheoretical} className="px-2 py-1 text-xs rounded bg-white text-indigo-700 font-semibold hover:bg-indigo-50">📋 이론사용량으로 채우기</button>
              <button onClick={clearOutflow} className="px-2 py-1 text-xs rounded bg-rose-500 text-white font-semibold hover:bg-rose-600">🗑️ 입력 초기화</button>
            </div>
          </div>
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-gray-600 sticky top-0 z-10">
                <tr>
                  <th className="border px-2 py-1.5 text-left">원재료</th>
                  <th className="border px-2 py-1.5 w-24">코드</th>
                  <th className="border px-2 py-1.5 text-right w-28">이론사용량(g)</th>
                  <th className="border px-2 py-1.5 text-right w-32">실제 출고(g)</th>
                  <th className="border px-2 py-1.5 text-right w-20">수율%</th>
                  <th className="border px-2 py-1.5 text-right w-28">기초단가(₩/g)</th>
                  <th className="border px-2 py-1.5 text-right w-32">실제 출고금액(₩)</th>
                  <th className="border px-2 py-1.5 text-right w-28">실측원가(₩)</th>
                </tr>
              </thead>
              <tbody>
                {filteredPerIng.map((r) => {
                  const yld = r.yieldPct;
                  const yClass = r.actualG === 0 ? 'text-gray-300' : yld >= 100 ? 'text-emerald-600' : yld >= 90 ? 'text-gray-600' : 'text-rose-600 font-bold';
                  return (
                    <tr key={r.key} className="border-t">
                      <td className="border px-2 py-1">
                        <input
                          key={`name-${r.key}-${nameOverrides[r.key] || ''}`}
                          defaultValue={displayName(r.key, r.name)}
                          onBlur={(e) => saveNameOverride(r.key, e.target.value, r.name)}
                          className="w-full bg-transparent focus:bg-yellow-50 focus:ring-1 focus:ring-yellow-300 rounded px-1 py-0.5"
                          title={`원본: ${r.name}`}
                        />
                      </td>
                      <td className="border px-2 py-1 text-center font-mono text-gray-500">{r.code || '-'}</td>
                      <td className="border px-2 py-1 text-right">{Math.round(r.theoreticalG).toLocaleString()}</td>
                      <td className="border px-2 py-0">
                        <input type="number" defaultValue={r.actualG || ''}
                          key={`g-${r.key}-${r.actualG}`}
                          onBlur={(e) => updateG(r.key, Number(e.target.value) || 0)}
                          className="w-full px-2 py-1 text-right border-0 focus:bg-yellow-50 focus:ring-1 focus:ring-yellow-300 rounded" />
                      </td>
                      <td className={`border px-2 py-1 text-right ${yClass}`}>{r.actualG > 0 ? yld.toFixed(1) + '%' : '-'}</td>
                      <td className={`border px-2 py-1 text-right ${r.hasPrice ? 'text-gray-600' : 'text-amber-600'}`}>{r.hasPrice ? r.unitCost.toFixed(2) : '⚠️ 없음'}</td>
                      <td className="border px-2 py-0">
                        <input type="number" defaultValue={outflowAmt[r.key] || ''}
                          key={`amt-${r.key}-${outflowAmt[r.key] || 0}`}
                          placeholder="선택"
                          onBlur={(e) => updateAmt(r.key, Number(e.target.value) || 0)}
                          className="w-full px-2 py-1 text-right border-0 focus:bg-yellow-50 focus:ring-1 focus:ring-yellow-300 rounded text-gray-500" />
                      </td>
                      <td className="border px-2 py-1 text-right font-semibold">{Math.round(r.totalCost).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 분배 불가 */}
      {result && result.orphans.length > 0 && (
        <div className="bg-rose-50 border-2 border-rose-300 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 bg-rose-200 font-bold text-rose-900 text-sm">⚠️ 분배 불가 — 이론사용량 0 인데 실측 출고 입력됨 (BOM 누락/타 라인/입력 오류 가능)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-rose-100 text-gray-700">
                <tr>
                  <th className="border px-2 py-1.5 text-left">키</th>
                  <th className="border px-2 py-1.5 text-right w-28">출고(g)</th>
                  <th className="border px-2 py-1.5 text-right w-28">금액(₩)</th>
                </tr>
              </thead>
              <tbody>
                {result.orphans.map((o) => (
                  <tr key={o.key} className="border-t">
                    <td className="border px-2 py-1 font-mono">{o.key}</td>
                    <td className="border px-2 py-1 text-right">{Math.round(o.actualG).toLocaleString()}</td>
                    <td className="border px-2 py-1 text-right">{Math.round(o.totalCost).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 제품별 원재료 원가 */}
      {result && (
        <div className="bg-white border-2 border-emerald-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-emerald-600 text-white font-bold text-sm flex items-center gap-2 flex-wrap">
            <span>🍱 제품별 원재료 원가 ({filteredPerProduct.length}품목)</span>
            <span className="text-xs font-normal text-emerald-100">실측 출고 역배분 기준 · 원가 큰 순</span>
            <span className="ml-auto text-xs text-emerald-100">행 클릭 → 원재료별 상세</span>
          </div>
          <div className="overflow-x-auto max-h-[700px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-gray-600 sticky top-0 z-10">
                <tr>
                  <th className="border px-2 py-1.5 w-10">순위</th>
                  <th className="border px-2 py-1.5 w-24">코드</th>
                  <th className="border px-2 py-1.5 text-left">제품명</th>
                  <th className="border px-2 py-1.5 text-right w-24">생산 EA</th>
                  <th className="border px-2 py-1.5 text-right w-32">원재료비(₩)</th>
                  <th className="border px-2 py-1.5 text-right w-28">EA당(₩)</th>
                  <th className="border px-2 py-1.5 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {filteredPerProduct.map((p, idx) => {
                  const open = !!expand[p.code + (p.isAmbient ? '_A' : '_C')];
                  const k = p.code + (p.isAmbient ? '_A' : '_C');
                  return (
                    <Fragment key={k}>
                      <tr className="border-t hover:bg-slate-50 cursor-pointer"
                        onClick={() => setExpand((prev) => ({ ...prev, [k]: !prev[k] }))}>
                        <td className="border px-2 py-1 text-center text-gray-500">{idx + 1}</td>
                        <td className="border px-2 py-1 font-mono text-gray-500">{p.code}{p.isAmbient && <span className="ml-1 text-orange-500">S</span>}</td>
                        <td className="border px-2 py-1">{p.productName}</td>
                        <td className="border px-2 py-1 text-right">{p.productionQty.toLocaleString()}</td>
                        <td className="border px-2 py-1 text-right font-semibold">{Math.round(p.materialCost).toLocaleString()}</td>
                        <td className="border px-2 py-1 text-right font-bold text-emerald-700">{Math.round(p.materialCostPerEA).toLocaleString()}</td>
                        <td className="border px-2 py-1 text-center text-gray-400">{open ? '▾' : '▸'}</td>
                      </tr>
                      {open && (
                        <tr className="bg-slate-50">
                          <td colSpan={7} className="border px-2 py-2">
                            <table className="w-full text-xs">
                              <thead className="text-gray-500">
                                <tr>
                                  <th className="text-left px-2">원재료</th>
                                  <th className="text-right px-2 w-28">분배 g</th>
                                  <th className="text-right px-2 w-28">원가(₩)</th>
                                  <th className="text-right px-2 w-20">EA당(₩)</th>
                                </tr>
                              </thead>
                              <tbody>
                                {p.breakdown.map((b) => (
                                  <tr key={b.ingKey} className="border-t border-gray-200">
                                    <td className="px-2 py-0.5">{displayName(b.ingKey, b.name)}</td>
                                    <td className="px-2 py-0.5 text-right">{Math.round(b.actualG).toLocaleString()}</td>
                                    <td className="px-2 py-0.5 text-right">{Math.round(b.cost).toLocaleString()}</td>
                                    <td className="px-2 py-0.5 text-right">{p.productionQty > 0 ? Math.round(b.cost / p.productionQty).toLocaleString() : '-'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!result && !running && (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-16 text-center text-gray-400 text-sm">
          기준월을 선택하고 우측 상단 <b className="text-blue-600">🚀 분석 시작</b> 을 누른 뒤,<br />
          원재료별 실제 출고량(g)을 ERP 재고평가 데이터로 입력하세요.<br />
          → 제품별 원재료 원가가 자동 산출됩니다.
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, value, accent, sub }: { label: string; value: string; accent: 'rose' | 'emerald' | 'slate'; sub?: string }) {
  const styles = {
    rose:    { box: 'bg-rose-50 border-rose-200',       txt: 'text-rose-700' },
    emerald: { box: 'bg-emerald-50 border-emerald-200', txt: 'text-emerald-700' },
    slate:   { box: 'bg-slate-50 border-slate-200',     txt: 'text-slate-700' },
  }[accent];
  return (
    <div className={`border rounded-lg p-3 ${styles.box}`}>
      <div className="text-xs text-gray-600">{label}</div>
      <div className={`mt-1 text-xl font-bold ${styles.txt}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

import { Fragment } from 'react';
