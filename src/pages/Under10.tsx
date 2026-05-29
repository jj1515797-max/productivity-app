import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, doc, getDocs, query, setDoc, where } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import type { Item, ProductSetting } from '../types';
import { canonicalShort, convertErpCode, normalizeCode } from '../lib/codeUtil';

/* ===== 캐시 ===== */
const CACHE_PREFIX = 'under10:';
const TTL_PAST = 24 * 60 * 60 * 1000;
const TTL_CURRENT = 5 * 60 * 1000;
function getCache<T>(key: string, ttl: number): { data: T; ts: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; data: T };
    if (Date.now() - parsed.ts > ttl) return null;
    return parsed;
  } catch { return null; }
}
function setCache<T>(key: string, data: T) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}
function clearAllCache() {
  try { Object.keys(localStorage).forEach((k) => { if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k); }); } catch {}
}

/* ===== 타입 ===== */
interface MonthAgg {
  month: string;
  daysWorked: number;
  under10Count: number;
  under10Qty: number;
  itemCountAvgPerDay: number;
  ckCount: number; // 취반기 (바트)
  flCount: number; // 화구 (냄비)
  byDay: { date: string; count: number; qty: number }[];
  topCodes: { code: string; name: string; freq: number; qty: number }[];
  totalProduction: number;
  logisticsSum: number;
  totalItems: number;
}
interface ManualOverride {
  under10Count?: number | null;
  under10Qty?: number | null;
  itemCountAvg?: number | null;
  totalProduction?: number | null;
  ckCount?: number | null;
  flCount?: number | null;
  note?: string;
}

/* ===== 유틸 ===== */
function thisMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonthKey(m: string, delta: number): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthRange(m: string): [string, string] {
  const [y, mm] = m.split('-').map(Number);
  const last = new Date(y, mm, 0).getDate();
  return [`${m}-01`, `${m}-${String(last).padStart(2, '0')}`];
}
function monthShort(m: string): string {
  const [y, mm] = m.split('-').map(Number);
  const thisY = new Date().getFullYear();
  return y === thisY ? `${mm}월` : `${String(y).slice(2)}년${mm}월`;
}

async function loadSettings(): Promise<Map<string, ProductSetting>> {
  const snap = await getDocs(collection(db, 'productSettings'));
  const map = new Map<string, ProductSetting>();
  snap.forEach((d) => {
    const s = d.data() as ProductSetting;
    map.set(normalizeCode(d.id), s);
    map.set(normalizeCode(convertErpCode(d.id)), s);
    map.set(normalizeCode(canonicalShort(d.id)), s);
  });
  return map;
}

/** 월별 logistics(잔여량 수정값) 합산: days/{date}/logistics 일별 fetch */
async function fetchMonthLogisticsSum(month: string): Promise<number> {
  const [y, mm] = month.split('-').map(Number);
  const lastDay = new Date(y, mm, 0).getDate();
  const dates = Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const snaps = await Promise.all(dates.map((d) => getDocs(collection(db, 'days', d, 'logistics'))));
  let sum = 0;
  snaps.forEach((s) => s.forEach((d) => { sum += (d.data().qty as number) || 0; }));
  return sum;
}

function aggregateMonth(month: string, items: Item[], settingsByNorm: Map<string, ProductSetting>, logisticsSum: number): MonthAgg {
  const byDay: Record<string, { count: number; qty: number }> = {};
  const itemsByDay: Record<string, Set<string>> = {};
  const codeFreq: Record<string, { name: string; freq: number; qty: number }> = {};
  let totalProduction = 0;
  let ckCount = 0, flCount = 0;
  const distinctCodes = new Set<string>();

  items.forEach((it) => {
    if (!it.date || !it.date.startsWith(month)) return;
    const qty = it.totalQty || 0;
    if (qty <= 0) return;
    totalProduction += qty;
    distinctCodes.add(it.code.toLowerCase());
    if (!itemsByDay[it.date]) itemsByDay[it.date] = new Set();
    itemsByDay[it.date].add(it.code.toLowerCase());

    if (qty >= 1 && qty < 10) {
      if (!byDay[it.date]) byDay[it.date] = { count: 0, qty: 0 };
      byDay[it.date].count++;
      byDay[it.date].qty += qty;
      const k = it.code.toLowerCase();
      if (!codeFreq[k]) codeFreq[k] = { name: it.name || '', freq: 0, qty: 0 };
      codeFreq[k].freq++;
      codeFreq[k].qty += qty;

      const s =
        settingsByNorm.get(normalizeCode(it.code)) ||
        settingsByNorm.get(normalizeCode(convertErpCode(it.code))) ||
        settingsByNorm.get(normalizeCode(canonicalShort(it.code)));
      if (s?.type === '바트') ckCount++;
      else if (s?.type === '냄비') flCount++;
    }
  });

  const dayList = Object.keys(byDay).sort().map((date) => ({
    date, count: byDay[date].count, qty: byDay[date].qty,
  }));
  const daysWorked = Object.keys(itemsByDay).length;
  const under10Count = dayList.reduce((s, d) => s + d.count, 0);
  const under10Qty = dayList.reduce((s, d) => s + d.qty, 0);
  const itemCountAvgPerDay = daysWorked
    ? Object.values(itemsByDay).reduce((s, set) => s + set.size, 0) / daysWorked
    : 0;
  const topCodes = Object.entries(codeFreq)
    .map(([code, info]) => ({ code, ...info }))
    .sort((a, b) => b.freq - a.freq)
    .slice(0, 10);

  return {
    month, daysWorked, under10Count, under10Qty, itemCountAvgPerDay,
    ckCount, flCount, byDay: dayList, topCodes,
    totalProduction: totalProduction + logisticsSum,
    logisticsSum,
    totalItems: distinctCodes.size,
  };
}

/* ===== 메인 ===== */
export default function Under10() {
  const todayMonth = thisMonthKey();
  const [baseMonth, setBaseMonth] = useState(todayMonth);
  const [selectedMonth, setSelectedMonth] = useState(todayMonth);
  const [aggByMonth, setAggByMonth] = useState<Record<string, MonthAgg>>({});
  const [manualByMonth, setManualByMonth] = useState<Record<string, ManualOverride>>({});
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [editTarget, setEditTarget] = useState<string | null>(null);

  const months13 = useMemo(
    () => Array.from({ length: 13 }, (_, i) => shiftMonthKey(baseMonth, -12 + i)),
    [baseMonth]
  );

  // 데이터 fetch (월별 캐시)
  useEffect(() => {
    let cancel = false;
    const neededMonths = Array.from(new Set([...months13, selectedMonth]));
    const hits: Record<string, MonthAgg> = {};
    const manualHits: Record<string, ManualOverride> = {};
    const misses: string[] = [];
    neededMonths.forEach((m) => {
      const ttl = m === todayMonth ? TTL_CURRENT : TTL_PAST;
      const cached = refreshTick === 0 ? getCache<MonthAgg>(m, ttl) : null;
      const manualCached = refreshTick === 0 ? getCache<ManualOverride>(`manual:${m}`, ttl) : null;
      if (cached) hits[m] = cached.data;
      else misses.push(m);
      if (manualCached) manualHits[m] = manualCached.data;
    });
    if (Object.keys(hits).length) setAggByMonth((p) => ({ ...p, ...hits }));
    if (Object.keys(manualHits).length) setManualByMonth((p) => ({ ...p, ...manualHits }));

    if (misses.length === 0) return;
    setLoading(true);
    (async () => {
      try {
        const settingsByNorm = await loadSettings();
        const sortedMiss = misses.sort();
        const [fromMonth, toMonth] = [sortedMiss[0], sortedMiss[sortedMiss.length - 1]];
        const [from] = monthRange(fromMonth);
        const [, to] = monthRange(toMonth);
        const [itemsSnap, manualSnap, ...logSums] = await Promise.all([
          getDocs(query(collectionGroup(db, 'items'),
            where('date', '>=', from), where('date', '<=', to))),
          getDocs(collection(db, 'under10Manual')),
          ...sortedMiss.map((m) => fetchMonthLogisticsSum(m)),
        ]);
        if (cancel) return;
        const items: Item[] = [];
        itemsSnap.forEach((d) => items.push(d.data() as Item));
        const manualMap: Record<string, ManualOverride> = {};
        manualSnap.forEach((d) => { manualMap[d.id] = d.data() as ManualOverride; });

        const newAgg: Record<string, MonthAgg> = {};
        sortedMiss.forEach((m, i) => {
          const agg = aggregateMonth(m, items, settingsByNorm, logSums[i]);
          newAgg[m] = agg;
          setCache(m, agg);
        });
        // 수동 overrides
        Object.entries(manualMap).forEach(([m, override]) => {
          setCache(`manual:${m}`, override);
        });
        if (!cancel) {
          setAggByMonth((p) => ({ ...p, ...newAgg }));
          setManualByMonth((p) => ({ ...p, ...manualMap }));
        }
      } catch (e) {
        console.error('[Under10] fetch failed:', e);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [months13.join(','), selectedMonth, refreshTick, todayMonth]);

  // 표시값 (수동 override 우선)
  const display = (m: string) => {
    const agg = aggByMonth[m];
    const ov = manualByMonth[m] || {};
    const u10Count = ov.under10Count ?? agg?.under10Count ?? 0;
    const u10Qty = ov.under10Qty ?? agg?.under10Qty ?? 0;
    const itemAvg = ov.itemCountAvg ?? agg?.itemCountAvgPerDay ?? 0;
    const totalProd = ov.totalProduction ?? agg?.totalProduction ?? 0;
    const ckCount = ov.ckCount ?? agg?.ckCount ?? 0;
    const flCount = ov.flCount ?? agg?.flCount ?? 0;
    const dw = agg?.daysWorked || 0;
    const avgPerDay = dw > 0 ? u10Count / dw : 0;
    return { agg, ov, u10Count, u10Qty, itemAvg, totalProd, ckCount, flCount, avgPerDay, daysWorked: dw };
  };

  const selDisp = display(selectedMonth);

  const saveManual = async (m: string, ov: ManualOverride) => {
    await setDoc(doc(db, 'under10Manual', m), { ...ov, month: m }, { merge: true });
    setManualByMonth((p) => ({ ...p, [m]: { ...p[m], ...ov } }));
    setCache(`manual:${m}`, { ...manualByMonth[m], ...ov });
  };

  /* ===== 엑셀 다운로드 ===== */
  const downloadXlsx = async () => {
    const wb = new ExcelJS.Workbook();
    const baseFont = { size: 11, name: '맑은 고딕' };
    const thin = { style: 'thin' as const };
    const border = { top: thin, left: thin, right: thin, bottom: thin };
    const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });

    // 시트 1: 13개월 요약
    const ws1 = wb.addWorksheet('13개월 요약');
    ws1.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 };
    ws1.columns = [
      { width: 10 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 14 },
      { width: 12 }, { width: 12 }, { width: 14 },
    ];
    ws1.mergeCells('A1:H1');
    const t1 = ws1.getCell('A1');
    t1.value = `10EA 미만 생산 — ${months13[0]} ~ ${months13[12]}`;
    t1.font = { size: 14, bold: true, name: '맑은 고딕' };
    t1.alignment = { horizontal: 'center', vertical: 'middle' };

    const head1 = ['월', '월 생산량(ea)', '10EA 미만 건수(건)', '10EA 미만 수량(ea)',
      '생산량 비율', '취반기 건수', '화구 건수', '품목수(평균/일)'];
    head1.forEach((h, i) => {
      const c = ws1.getCell(3, i + 1);
      c.value = h; c.font = { ...baseFont, bold: true };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.fill = fill('FFFEF3C7'); c.border = border;
    });
    months13.forEach((m, i) => {
      const r = 4 + i;
      const dsp = display(m);
      const ratio = dsp.totalProd > 0 ? (dsp.u10Qty / dsp.totalProd) : 0;
      const cells: (number | string)[] = [
        monthShort(m), dsp.totalProd, dsp.u10Count, dsp.u10Qty,
        ratio, dsp.ckCount, dsp.flCount, Math.round(dsp.itemAvg),
      ];
      cells.forEach((v, ci) => {
        const c = ws1.getCell(r, ci + 1);
        c.value = v; c.font = baseFont; c.border = border;
        c.alignment = { horizontal: ci === 0 ? 'center' : 'right', vertical: 'middle' };
        if (ci === 1 || ci === 3) c.numFmt = '#,##0';
        if (ci === 4) c.numFmt = '0.0%';
      });
    });

    // 시트 2: 선택 월 일별
    const ws2 = wb.addWorksheet(`${selectedMonth} 일별`);
    ws2.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 };
    ws2.columns = [{ width: 12 }, { width: 18 }, { width: 16 }];
    ws2.mergeCells('A1:C1');
    const t2 = ws2.getCell('A1');
    t2.value = `${selectedMonth} — 일별 10EA 미만 생산 건수`;
    t2.font = { size: 14, bold: true, name: '맑은 고딕' };
    t2.alignment = { horizontal: 'center', vertical: 'middle' };
    ['날짜', '10EA 미만 건수', '10EA 미만 수량'].forEach((h, i) => {
      const c = ws2.getCell(3, i + 1);
      c.value = h; c.font = { ...baseFont, bold: true };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.fill = fill('FFFEF3C7'); c.border = border;
    });
    (selDisp.agg?.byDay || []).forEach((d, i) => {
      const r = 4 + i;
      ws2.getCell(r, 1).value = d.date.slice(5);
      ws2.getCell(r, 2).value = d.count;
      ws2.getCell(r, 3).value = d.qty;
      for (let c = 1; c <= 3; c++) {
        const cell = ws2.getCell(r, c);
        cell.font = baseFont; cell.border = border;
        cell.alignment = { horizontal: c === 1 ? 'center' : 'right', vertical: 'middle' };
        if (c === 3) cell.numFmt = '#,##0';
      }
    });
    const lastRow = 4 + (selDisp.agg?.byDay.length || 0);
    ws2.getCell(lastRow, 1).value = '합계';
    ws2.getCell(lastRow, 2).value = selDisp.u10Count;
    ws2.getCell(lastRow, 3).value = selDisp.u10Qty;
    for (let c = 1; c <= 3; c++) {
      const cell = ws2.getCell(lastRow, c);
      cell.font = { ...baseFont, bold: true }; cell.border = border;
      cell.fill = fill('FFFEF9C3');
      cell.alignment = { horizontal: c === 1 ? 'center' : 'right', vertical: 'middle' };
      if (c === 3) cell.numFmt = '#,##0';
    }

    // 시트 3: Top 10
    const ws3 = wb.addWorksheet(`${selectedMonth} Top 10`);
    ws3.columns = [{ width: 6 }, { width: 14 }, { width: 30 }, { width: 12 }, { width: 14 }];
    ws3.mergeCells('A1:E1');
    const t3 = ws3.getCell('A1');
    t3.value = `${selectedMonth} — 10EA 미만 빈도 Top 10`;
    t3.font = { size: 14, bold: true, name: '맑은 고딕' };
    t3.alignment = { horizontal: 'center', vertical: 'middle' };
    ['#', '코드', '품목명', '횟수(건)', '총 수량(ea)'].forEach((h, i) => {
      const c = ws3.getCell(3, i + 1);
      c.value = h; c.font = { ...baseFont, bold: true };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.fill = fill('FFFEF3C7'); c.border = border;
    });
    (selDisp.agg?.topCodes || []).forEach((tc, i) => {
      const r = 4 + i;
      ws3.getCell(r, 1).value = i + 1;
      ws3.getCell(r, 2).value = tc.code;
      ws3.getCell(r, 3).value = tc.name;
      ws3.getCell(r, 4).value = tc.freq;
      ws3.getCell(r, 5).value = tc.qty;
      for (let c = 1; c <= 5; c++) {
        const cell = ws3.getCell(r, c);
        cell.font = baseFont; cell.border = border;
        cell.alignment = { horizontal: c === 3 ? 'left' : 'center', vertical: 'middle' };
      }
    });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `10ea미만_${baseMonth}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ===== 렌더 ===== */
  const shiftSelMonth = (delta: number) => setSelectedMonth(shiftMonthKey(selectedMonth, delta));
  const shiftBase = (delta: number) => setBaseMonth(shiftMonthKey(baseMonth, delta));

  return (
    <div className="space-y-5">
      {/* 상단 컨트롤 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-gray-800">⚠️ 10EA 미만 생산 분석</span>
        <span className="text-gray-300">|</span>
        <label className="text-xs text-gray-600">기준월 (13개월 범위)</label>
        <button onClick={() => shiftBase(-1)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100">◀</button>
        <input type="month" value={baseMonth} onChange={(e) => e.target.value && setBaseMonth(e.target.value)}
          className="border rounded px-2 py-1 text-sm font-bold" />
        <button onClick={() => shiftBase(1)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100">▶</button>
        <span className="text-xs text-gray-500">{months13[0]} ~ {months13[12]}</span>
        {loading && <span className="text-xs text-blue-600">불러오는 중...</span>}
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => { clearAllCache(); setRefreshTick((t) => t + 1); }}
            className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50" title="캐시 무시하고 다시 불러오기">🔄</button>
          <button onClick={() => { setBaseMonth(todayMonth); setSelectedMonth(todayMonth); }}
            className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50">이번 달</button>
          <button onClick={downloadXlsx}
            className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700">📥 엑셀 다운로드</button>
        </div>
      </div>

      {/* 13개월 차트 — 10EA미만 평균/일 */}
      <div className="bg-white border rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-bold text-gray-800">10EA 미만 생산 건수 <span className="text-xs text-gray-500 font-normal">(13개월 · 평균/일)</span></h3>
          <button onClick={() => setEditTarget(months13[12])}
            className="text-xs px-2 py-1 border rounded hover:bg-gray-50">✎ 수동 입력</button>
        </div>
        <Bars13
          color="#10b981"
          data={months13.map((m) => {
            const d = display(m);
            return { label: monthShort(m), value: d.avgPerDay, manual: !!manualByMonth[m]?.under10Count };
          })}
          decimals={1}
          onBarClick={(idx) => setEditTarget(months13[idx])}
        />
      </div>

      {/* 13개월 차트 — 품목수 평균/일 */}
      <div className="bg-white border rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-bold text-gray-800">월별 품목 수 <span className="text-xs text-gray-500 font-normal">(13개월 · 평균/일)</span></h3>
        </div>
        <Bars13
          color="#f97316"
          data={months13.map((m) => {
            const d = display(m);
            return { label: monthShort(m), value: d.itemAvg, manual: !!manualByMonth[m]?.itemCountAvg };
          })}
          decimals={0}
          onBarClick={(idx) => setEditTarget(months13[idx])}
        />
      </div>

      {/* 13개월 요약표 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">13개월 월별 요약</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-gray-600">
              <tr>
                <th className="border px-3 py-2 text-center">월</th>
                <th className="border px-3 py-2 text-right">월 생산량(ea)</th>
                <th className="border px-3 py-2 text-right">10EA 미만 건수</th>
                <th className="border px-3 py-2 text-right">10EA 미만 수량(ea)</th>
                <th className="border px-3 py-2 text-right">생산량 비율</th>
                <th className="border px-3 py-2 text-right text-rose-600">취반기 건수</th>
                <th className="border px-3 py-2 text-right text-amber-600">화구 건수</th>
                <th className="border px-3 py-2 text-right">품목수(평균/일)</th>
                <th className="border px-3 py-2 text-center">수정</th>
              </tr>
            </thead>
            <tbody>
              {months13.map((m) => {
                const d = display(m);
                const ratio = d.totalProd > 0 ? (d.u10Qty / d.totalProd) * 100 : 0;
                const isSel = m === selectedMonth;
                const hasManual = !!manualByMonth[m] && (
                  manualByMonth[m].under10Count != null ||
                  manualByMonth[m].under10Qty != null ||
                  manualByMonth[m].itemCountAvg != null ||
                  manualByMonth[m].totalProduction != null
                );
                return (
                  <tr key={m} className={`border-t hover:bg-amber-50 ${isSel ? 'bg-amber-100' : ''}`}
                    onClick={() => setSelectedMonth(m)} style={{ cursor: 'pointer' }}>
                    <td className="border px-3 py-1.5 text-center font-semibold">
                      {monthShort(m)}
                    </td>
                    <td className="border px-3 py-1.5 text-right">{d.totalProd ? d.totalProd.toLocaleString() : '-'}</td>
                    <td className="border px-3 py-1.5 text-right font-bold">{d.u10Count || '-'}</td>
                    <td className="border px-3 py-1.5 text-right">{d.u10Qty ? d.u10Qty.toLocaleString() : '-'}</td>
                    <td className="border px-3 py-1.5 text-right">{ratio > 0 ? `${ratio.toFixed(2)}%` : '-'}</td>
                    <td className="border px-3 py-1.5 text-right text-rose-600">{d.ckCount || '-'}</td>
                    <td className="border px-3 py-1.5 text-right text-amber-600">{d.flCount || '-'}</td>
                    <td className="border px-3 py-1.5 text-right">{d.itemAvg ? Math.round(d.itemAvg) : '-'}</td>
                    <td className="border px-3 py-1.5 text-center">
                      <button onClick={(e) => { e.stopPropagation(); setEditTarget(m); }}
                        className="text-xs text-blue-600 hover:underline">✎</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 선택 월 상세 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm flex items-center gap-2">
            <span>📋 {selectedMonth} 일별 — 10EA 미만 건수</span>
            <span className="text-xs text-gray-500 font-normal">{selDisp.agg?.byDay.length || 0}일</span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => shiftSelMonth(-1)} className="text-xs px-2 py-0.5 rounded border hover:bg-gray-50">◀</button>
              <input type="month" value={selectedMonth} onChange={(e) => e.target.value && setSelectedMonth(e.target.value)}
                className="border rounded px-2 py-0.5 text-xs" />
              <button onClick={() => shiftSelMonth(1)} className="text-xs px-2 py-0.5 rounded border hover:bg-gray-50">▶</button>
            </div>
          </div>
          <div className="overflow-y-auto max-h-96">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-gray-600 sticky top-0">
                <tr>
                  <th className="border px-3 py-1.5 text-center">날짜</th>
                  <th className="border px-3 py-1.5 text-right">건수</th>
                  <th className="border px-3 py-1.5 text-right">수량(ea)</th>
                </tr>
              </thead>
              <tbody>
                {(selDisp.agg?.byDay || []).map((d) => (
                  <tr key={d.date} className="border-t">
                    <td className="border px-3 py-1 text-center font-mono">{d.date.slice(5)}</td>
                    <td className="border px-3 py-1 text-right font-semibold">{d.count}</td>
                    <td className="border px-3 py-1 text-right text-gray-600">{d.qty.toLocaleString()}</td>
                  </tr>
                ))}
                {(selDisp.agg?.byDay.length || 0) === 0 && (
                  <tr><td colSpan={3} className="text-center text-gray-400 py-6">데이터 없음</td></tr>
                )}
              </tbody>
              <tfoot className="bg-amber-50 font-bold">
                <tr>
                  <td className="border px-3 py-1.5 text-center">합계</td>
                  <td className="border px-3 py-1.5 text-right">{selDisp.u10Count}</td>
                  <td className="border px-3 py-1.5 text-right">{selDisp.u10Qty.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className="border px-3 py-1.5 text-center text-xs text-gray-500">평균/일</td>
                  <td className="border px-3 py-1.5 text-right text-xs text-gray-700">{selDisp.avgPerDay.toFixed(2)}</td>
                  <td className="border px-3 py-1.5 text-right text-xs text-gray-700">{selDisp.daysWorked > 0 ? Math.round(selDisp.u10Qty / selDisp.daysWorked).toLocaleString() : '-'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Top 10 */}
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">
            🏆 {selectedMonth} 10EA 미만 빈도 Top 10
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-gray-600">
              <tr>
                <th className="border px-3 py-1.5 text-center w-10">#</th>
                <th className="border px-3 py-1.5 text-left">코드</th>
                <th className="border px-3 py-1.5 text-left">품목명</th>
                <th className="border px-3 py-1.5 text-right">횟수</th>
                <th className="border px-3 py-1.5 text-right">총수량</th>
              </tr>
            </thead>
            <tbody>
              {(selDisp.agg?.topCodes || []).map((tc, i) => (
                <tr key={tc.code} className="border-t">
                  <td className="border px-3 py-1 text-center text-gray-500">{i + 1}</td>
                  <td className="border px-3 py-1 font-mono text-sm font-bold">{tc.code}</td>
                  <td className="border px-3 py-1">{tc.name}</td>
                  <td className="border px-3 py-1 text-right font-bold text-rose-600">{tc.freq}건</td>
                  <td className="border px-3 py-1 text-right text-gray-600">{tc.qty} ea</td>
                </tr>
              ))}
              {(selDisp.agg?.topCodes.length || 0) === 0 && (
                <tr><td colSpan={5} className="text-center text-gray-400 py-6">데이터 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 수동 입력 모달 */}
      {editTarget && (
        <ManualEditModal
          month={editTarget}
          current={manualByMonth[editTarget] || {}}
          autoValue={{
            u10Count: display(editTarget).u10Count,
            u10Qty: display(editTarget).u10Qty,
            itemAvg: display(editTarget).itemAvg,
            totalProd: display(editTarget).totalProd,
            ckCount: display(editTarget).ckCount,
            flCount: display(editTarget).flCount,
          }}
          onClose={() => setEditTarget(null)}
          onSave={async (ov) => {
            await saveManual(editTarget, ov);
            setEditTarget(null);
          }}
        />
      )}
    </div>
  );
}

/* ===== Bar Chart (13개월) ===== */
function Bars13({ data, color, decimals, onBarClick }: {
  data: { label: string; value: number; manual?: boolean }[];
  color: string;
  decimals: number;
  onBarClick?: (idx: number) => void;
}) {
  const W = 900, H = 280, padL = 36, padR = 12, padT = 28, padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxVal = Math.max(1, ...data.map((d) => d.value));
  const niceMax = niceCeil(maxVal);
  const bandW = innerW / data.length;
  const barW = bandW * 0.62;
  const yFor = (v: number) => padT + innerH - (v / niceMax) * innerH;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {[0, 0.25, 0.5, 0.75, 1].map((p) => (
        <g key={p}>
          <line x1={padL} x2={W - padR} y1={padT + innerH * p} y2={padT + innerH * p} stroke="#cbd5e1" strokeWidth={0.8} />
          <text x={padL - 4} y={padT + innerH * p + 3} fontSize={10} textAnchor="end" fill="#64748b">
            {fmtVal(niceMax * (1 - p), decimals)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = padL + i * bandW + bandW / 2;
        const y = yFor(d.value);
        return (
          <g key={i} onClick={() => onBarClick?.(i)} style={{ cursor: 'pointer' }}>
            <rect
              x={cx - barW / 2}
              y={y}
              width={barW}
              height={Math.max(0, innerH - (y - padT))}
              fill={color}
              opacity={d.value > 0 ? 1 : 0.2}
            />
            <text x={cx} y={H - 12} fontSize={11} textAnchor="middle" fill="#334155" fontWeight="600">{d.label}</text>
            {d.value > 0 && (
              <text x={cx} y={y - 6} fontSize={11} textAnchor="middle" fill="#1f2937" fontWeight="bold"
                stroke="white" strokeWidth={1.5} paintOrder="stroke">
                {fmtVal(d.value, decimals)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function niceCeil(v: number): number {
  if (v <= 1) return 1;
  if (v <= 10) return Math.ceil(v);
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / pow;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * pow;
}
function fmtVal(v: number, decimals: number): string {
  return decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString();
}

/* ===== 수동 입력 모달 ===== */
function ManualEditModal({ month, current, autoValue, onClose, onSave }: {
  month: string;
  current: ManualOverride;
  autoValue: { u10Count: number; u10Qty: number; itemAvg: number; totalProd: number; ckCount: number; flCount: number };
  onClose: () => void;
  onSave: (ov: ManualOverride) => Promise<void>;
}) {
  const [u10Count, setU10Count] = useState<string>(current.under10Count != null ? String(current.under10Count) : '');
  const [u10Qty, setU10Qty] = useState<string>(current.under10Qty != null ? String(current.under10Qty) : '');
  const [itemAvg, setItemAvg] = useState<string>(current.itemCountAvg != null ? String(current.itemCountAvg) : '');
  const [totalProd, setTotalProd] = useState<string>(current.totalProduction != null ? String(current.totalProduction) : '');
  const [ckCount, setCkCount] = useState<string>(current.ckCount != null ? String(current.ckCount) : '');
  const [flCount, setFlCount] = useState<string>(current.flCount != null ? String(current.flCount) : '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const parse = (s: string): number | null => s.trim() === '' ? null : (Number(s) || 0);
      await onSave({
        under10Count: parse(u10Count),
        under10Qty: parse(u10Qty),
        itemCountAvg: parse(itemAvg),
        totalProduction: parse(totalProd),
        ckCount: parse(ckCount),
        flCount: parse(flCount),
      });
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-5 py-4 border-b bg-amber-50 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-800">{month} — 수동 입력</h3>
            <p className="text-xs text-gray-500 mt-0.5">빈 칸은 자동 계산값 사용</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="p-5 space-y-3">
          <Field label="월 생산량 (ea)" value={totalProd} onChange={setTotalProd} auto={autoValue.totalProd} />
          <Field label="10EA 미만 건수" value={u10Count} onChange={setU10Count} auto={autoValue.u10Count} />
          <Field label="10EA 미만 수량 (ea)" value={u10Qty} onChange={setU10Qty} auto={autoValue.u10Qty} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="취반기 건수" value={ckCount} onChange={setCkCount} auto={autoValue.ckCount} />
            <Field label="화구 건수" value={flCount} onChange={setFlCount} auto={autoValue.flCount} />
          </div>
          <Field label="품목수 (평균/일)" value={itemAvg} onChange={setItemAvg} auto={Math.round(autoValue.itemAvg)} />
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-2 border rounded text-sm font-medium hover:bg-gray-100">취소</button>
          <button onClick={save} disabled={saving}
            className="ml-auto px-5 py-2 bg-amber-600 text-white rounded font-medium hover:bg-amber-700 disabled:bg-gray-300">
            {saving ? '저장중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, auto }: { label: string; value: string; onChange: (v: string) => void; auto: number }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1 flex items-center gap-2">
        <span>{label}</span>
        <span className="text-[10px] text-gray-400">자동: {auto.toLocaleString()}</span>
      </label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`자동값 ${auto.toLocaleString()}`}
        className="w-full border rounded-md px-3 py-2 text-sm"
      />
    </div>
  );
}
