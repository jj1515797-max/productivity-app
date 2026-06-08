import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import type { AmbientEntry, Item, MachineEntry } from '../types';
import type { AmbientRecipe, Recipe } from '../lib/wasteCompute';
import { CODE_KEY_PREFIX, monthPriceKey, normalizeCode, normalizeMaterialName } from '../lib/wasteCompute';
import { computeColdProductionByCode, computeFlexedDiff, computeMonthlyUsage, diffUsage } from '../lib/materialUsage';
import type { DiffRow, FlexedRow, UsageResult } from '../lib/materialUsage';

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
  const [err, setErr] = useState<string | null>(null);

  // 마스터 DB 구독
  const [recipeMap, setRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [ambientRecipeMap, setAmbientRecipeMap] = useState<Map<string, AmbientRecipe>>(new Map());
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
    return onSnapshot(collection(db, 'materialPricesMonthly'), (snap) => {
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
      // 각 월 자체 단가 결과 (보조 비교용 — 기존 표)
      const aRes = computeMonthlyUsage(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, recipeMap, ambientRecipeMap, priceMap);
      const bRes = computeMonthlyUsage(monthB, bRaw.entries, bRaw.items, bRaw.ambient, bRaw.logistics, recipeMap, ambientRecipeMap, priceMap);
      // A월 데이터를 B월 단가로 재평가 (Flexed Budget — 단가 인상 노이즈 제거)
      const aResB = computeMonthlyUsage(monthA, aRaw.entries, aRaw.items, aRaw.ambient, aRaw.logistics, recipeMap, ambientRecipeMap, priceMap, monthB);
      setAResult(aRes); setBResult(bRes); setAResultBPrice(aResB);
      setDiff(diffUsage(aRes, bRes));

      // 총생산량 EA 자동 채움 (냉장 + 실온)
      const totalProd = (raw: RawMonth): number => {
        const cold = computeColdProductionByCode(raw.entries, raw.items, raw.logistics);
        let sum = 0;
        cold.forEach((n) => { sum += n; });
        raw.ambient.forEach((a) => { sum += a.qty || 0; });
        return Math.round(sum);
      };
      setAQty(totalProd(aRaw));
      setBQty(totalProd(bRaw));
    } catch (e: any) {
      console.error('[MaterialAnalysis] failed:', e);
      setErr(e?.message || '분석 중 오류 발생');
    } finally { setRunning(false); }
  };

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
    setDiff([]); setFlexed([]);
    setAQty(0); setBQty(0); setAAmount(''); setBAmount('');
    setErr(null);
  };

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
      wf.getCell(r, 4).value = Math.round(row.aCost);
      wf.getCell(r, 5).value = Math.round(row.flexedCost);
      wf.getCell(r, 6).value = Math.round(row.bCost);
      wf.getCell(r, 7).value = Math.round(row.diffCost);
      wf.getCell(r, 8).value = Number(row.diffPct.toFixed(1));
      for (let c = 1; c <= 8; c++) {
        const cell = wf.getCell(r, c);
        cell.font = baseFont; cell.border = border;
        cell.alignment = { horizontal: c <= 3 ? (c === 2 ? 'left' : 'center') : 'right', vertical: 'middle' };
        if (c >= 4 && c <= 7) cell.numFmt = '#,##0';
        if (c === 8) cell.numFmt = '+#,##0.0;-#,##0.0;0';
      }
    });
    const fTotRow = 4 + flexed.length;
    wf.getCell(fTotRow, 1).value = '합계';
    wf.mergeCells(fTotRow, 1, fTotRow, 3);
    wf.getCell(fTotRow, 4).value = Math.round(flexAtotal);
    wf.getCell(fTotRow, 5).value = Math.round(flexFlexedTotal);
    wf.getCell(fTotRow, 6).value = Math.round(flexBtotal);
    wf.getCell(fTotRow, 7).value = Math.round(flexDiffTotal);
    wf.getCell(fTotRow, 8).value = Number(flexDiffPct.toFixed(1));
    for (let c = 1; c <= 8; c++) {
      const cell = wf.getCell(fTotRow, c);
      cell.font = { ...baseFont, bold: true }; cell.border = border; cell.fill = fill('FFFEF9C3');
      cell.alignment = { horizontal: c <= 3 ? 'center' : 'right', vertical: 'middle' };
      if (c >= 4 && c <= 7) cell.numFmt = '#,##0';
      if (c === 8) cell.numFmt = '+#,##0.0;-#,##0.0;0';
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
      ws.getCell(r, 4).value = Math.round(row.aGrams);
      ws.getCell(r, 5).value = Math.round(row.aCost);
      ws.getCell(r, 6).value = Math.round(row.bGrams);
      ws.getCell(r, 7).value = Math.round(row.bCost);
      ws.getCell(r, 8).value = Math.round(row.diffCost);
      ws.getCell(r, 9).value = Number(row.diffPct.toFixed(1));
      for (let c = 1; c <= 9; c++) {
        const cell = ws.getCell(r, c);
        cell.font = baseFont; cell.border = border;
        cell.alignment = { horizontal: c <= 3 ? (c === 2 ? 'left' : 'center') : 'right', vertical: 'middle' };
        if (c >= 4 && c <= 8) cell.numFmt = '#,##0';
        if (c === 9) cell.numFmt = '+#,##0.0;-#,##0.0;0';
      }
    });
    // 합계 행
    const totRow = 4 + diff.length;
    ws.getCell(totRow, 1).value = '합계';
    ws.mergeCells(totRow, 1, totRow, 4);
    ws.getCell(totRow, 5).value = Math.round(aTotal);
    ws.getCell(totRow, 6).value = '';
    ws.getCell(totRow, 7).value = Math.round(bTotal);
    ws.getCell(totRow, 8).value = Math.round(diffTotal);
    ws.getCell(totRow, 9).value = Number(diffPct.toFixed(1));
    for (let c = 1; c <= 9; c++) {
      const cell = ws.getCell(totRow, c);
      cell.font = { ...baseFont, bold: true }; cell.border = border; cell.fill = fill('FFFEF9C3');
      cell.alignment = { horizontal: c <= 4 ? 'center' : 'right', vertical: 'middle' };
      if (c === 5 || c === 7 || c === 8) cell.numFmt = '#,##0';
      if (c === 9) cell.numFmt = '+#,##0.0;-#,##0.0;0';
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
              <input type="number" value={aAmount} onChange={(e) => setAAmount(e.target.value)} placeholder="직접 입력"
                className="mt-1 w-full border rounded px-2 py-1.5 text-sm text-right font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-600">{monthB} 생산금액 (₩, 선택)</label>
              <input type="number" value={bAmount} onChange={(e) => setBAmount(e.target.value)} placeholder="직접 입력"
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

      {/* KPI 카드 — Flexed Budget 기준 */}
      {aResult && bResult && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label={`${monthA} 원재료비 (B월단가)`} value={Math.round(flexAtotal).toLocaleString() + '원'} accent="slate" />
            <KpiCard label={`${monthB} 원재료비 (B월단가)`} value={Math.round(flexBtotal).toLocaleString() + '원'} accent="slate" />
            <KpiCard label="연동대비 총차액" value={(flexDiffTotal >= 0 ? '+' : '') + Math.round(flexDiffTotal).toLocaleString() + '원'} accent={flexDiffTotal >= 0 ? 'emerald' : 'rose'} />
            <KpiCard label="효율 변동률" value={(flexDiffPct >= 0 ? '+' : '') + flexDiffPct.toFixed(1) + '%'} accent={flexDiffPct >= 0 ? 'emerald' : 'rose'} />
          </div>

          {/* 🎯 Flexed Budget 연동 분석 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-indigo-50 font-bold text-gray-800 text-sm flex items-center gap-2 flex-wrap">
              <span>🎯 전월 대비 연동 예산 차이 분석</span>
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
                    <th className="border px-2 py-1.5 text-right w-28">{monthA} 금액</th>
                    <th className="border px-2 py-1.5 text-right w-28">연동 금액</th>
                    <th className="border px-2 py-1.5 text-right w-28">{monthB} 금액</th>
                    <th className="border px-2 py-1.5 text-right w-28">연동 대비 차액</th>
                    <th className="border px-2 py-1.5 text-right w-20">차이율</th>
                    <th className="border px-2 py-1.5 text-right w-16">B비중</th>
                  </tr>
                </thead>
                <tbody>
                  {flexed.map((r, idx) => {
                    const noPrice = !r.hasPrice;
                    const diffClass = r.diffCost > 0 ? 'text-emerald-700 bg-emerald-50' : r.diffCost < 0 ? 'text-rose-700 bg-rose-50' : 'text-gray-400';
                    return (
                      <tr key={r.key} className="border-t">
                        <td className="border px-2 py-1 text-center text-gray-500">{idx + 1}</td>
                        <td className="border px-2 py-1">
                          {noPrice && <span className="text-amber-600 mr-1" title="단가 미입력">⚠️</span>}
                          {r.name}
                        </td>
                        <td className="border px-2 py-1 text-center font-mono text-gray-500">{r.code || '-'}</td>
                        <td className="border px-2 py-1 text-right text-gray-600">{Math.round(r.aCost).toLocaleString()}</td>
                        <td className="border px-2 py-1 text-right font-semibold text-indigo-700">{Math.round(r.flexedCost).toLocaleString()}</td>
                        <td className="border px-2 py-1 text-right">{Math.round(r.bCost).toLocaleString()}</td>
                        <td className={`border px-2 py-1 text-right font-bold ${diffClass}`}>{r.diffCost > 0 ? '+' : ''}{Math.round(r.diffCost).toLocaleString()}</td>
                        <td className={`border px-2 py-1 text-right font-semibold ${diffClass}`}>{r.diffPct > 0 ? '+' : ''}{r.diffPct.toFixed(1)}%</td>
                        <td className="border px-2 py-1 text-right text-gray-500">{r.bSharePct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-amber-50 font-bold sticky bottom-0">
                    <td className="border px-2 py-1.5 text-center" colSpan={3}>합계</td>
                    <td className="border px-2 py-1.5 text-right">{Math.round(flexAtotal).toLocaleString()}</td>
                    <td className="border px-2 py-1.5 text-right text-indigo-700">{Math.round(flexFlexedTotal).toLocaleString()}</td>
                    <td className="border px-2 py-1.5 text-right">{Math.round(flexBtotal).toLocaleString()}</td>
                    <td className={`border px-2 py-1.5 text-right ${flexDiffTotal >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{flexDiffTotal > 0 ? '+' : ''}{Math.round(flexDiffTotal).toLocaleString()}</td>
                    <td className={`border px-2 py-1.5 text-right ${flexDiffPct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{flexDiffPct > 0 ? '+' : ''}{flexDiffPct.toFixed(1)}%</td>
                    <td className="border"></td>
                  </tr>
                </tfoot>
              </table>
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
                          {r.name}
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
        </>
      )}

      {!aResult && !bResult && !running && (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-16 text-center text-gray-400 text-sm">
          비교할 두 월을 선택하고 우측 상단 <b className="text-blue-600">🚀 분석 시작</b> 버튼을 눌러주세요.
        </div>
      )}
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
