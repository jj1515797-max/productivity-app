import { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, collectionGroup, deleteDoc, doc, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { CODE_KEY_PREFIX, expandAll, expandWasteEntry, normalizeCode, normalizeMaterialName } from '../lib/wasteCompute';
import type { Recipe, WasteEntry } from '../lib/wasteCompute';

/* ===== 캐시 (월별) ===== */
const CACHE_PREFIX = 'waste:';
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

/** 데이터 입력 시작월 — 이 월부터 현재월까지만 표시 */
const DATA_START = '2026-05';

function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  // end 가 start 보다 과거면 start 한 개만
  if (end < start) return [start];
  while (cur <= end) {
    out.push(cur);
    cur = shiftMonthKey(cur, 1);
  }
  return out;
}

export default function Waste() {
  const todayMonth = thisMonthKey();
  const [selectedMonth, setSelectedMonth] = useState(todayMonth >= DATA_START ? todayMonth : DATA_START);

  /* 마스터 DB 구독 (recipes + materialPrices) */
  const [recipeMap, setRecipeMap] = useState<Map<string, Recipe>>(new Map());
  const [priceMap, setPriceMap] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    return onSnapshot(collection(db, 'recipes'), (snap) => {
      const map = new Map<string, Recipe>();
      snap.forEach((d) => {
        const data = d.data() as Recipe;
        map.set(d.id, { ...data, code: d.id });
      });
      setRecipeMap(map);
    });
  }, []);

  useEffect(() => {
    return onSnapshot(collection(db, 'materialPrices'), (snap) => {
      const map = new Map<string, number>();
      snap.forEach((d) => {
        const data = d.data() as { name?: string; pricePerGram?: number; code?: string };
        const price = Number(data.pricePerGram) || 0;
        // 이름 키 + 코드 키 둘 다 등록 (코드 우선 매칭)
        if (data.name) map.set(normalizeMaterialName(data.name), price);
        if (data.code) map.set(CODE_KEY_PREFIX + normalizeCode(data.code), price);
      });
      setPriceMap(map);
    });
  }, []);

  /* 월별 entries fetch (캐시) */
  const [entriesByMonth, setEntriesByMonth] = useState<Record<string, WasteEntry[]>>({});
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // 데이터 시작월(DATA_START) ~ 현재월 까지만 표시
  const months13 = useMemo(
    () => monthsBetween(DATA_START, todayMonth >= DATA_START ? todayMonth : DATA_START),
    [todayMonth]
  );

  useEffect(() => {
    let cancel = false;
    const neededMonths = Array.from(new Set([...months13, selectedMonth]));
    const hits: Record<string, WasteEntry[]> = {};
    const misses: string[] = [];
    neededMonths.forEach((m) => {
      const ttl = m === todayMonth ? TTL_CURRENT : TTL_PAST;
      const cached = refreshTick === 0 ? getCache<WasteEntry[]>(m, ttl) : null;
      if (cached) hits[m] = cached.data;
      else misses.push(m);
    });
    if (Object.keys(hits).length) setEntriesByMonth((p) => ({ ...p, ...hits }));

    if (misses.length === 0) return;
    setLoading(true);
    (async () => {
      try {
        const sortedMiss = misses.sort();
        const [from] = monthRange(sortedMiss[0]);
        const [, to] = monthRange(sortedMiss[sortedMiss.length - 1]);
        const snap = await getDocs(query(
          collectionGroup(db, 'entries'),
          where('date', '>=', from),
          where('date', '<=', to),
        ));
        if (cancel) return;
        const all: WasteEntry[] = [];
        snap.forEach((d) => {
          const data = d.data() as WasteEntry;
          // 폐기 entries 만 필터 (다른 컬렉션과 collectionGroup 충돌 방지)
          // — 폐기 entries 는 'cost', 'qty', 'code' 가짐. 호기 entries 는 'machine' 필드 있음.
          if ((data as any).machine !== undefined) return;
          if (!data.date || !data.code) return;
          all.push({ ...data, id: d.id });
        });
        const byMonth: Record<string, WasteEntry[]> = {};
        sortedMiss.forEach((m) => { byMonth[m] = []; });
        all.forEach((e) => {
          const m = e.date.slice(0, 7);
          if (byMonth[m]) byMonth[m].push(e);
        });
        Object.entries(byMonth).forEach(([m, list]) => {
          list.sort((a, b) => a.date.localeCompare(b.date));
          setCache(m, list);
        });
        if (!cancel) setEntriesByMonth((p) => ({ ...p, ...byMonth }));
      } catch (e) {
        console.error('[Waste] fetch failed:', e);
      } finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, [months13.join(','), selectedMonth, refreshTick, todayMonth]);

  /* 월별 합계 (확장 → cost 합) */
  const monthTotals = useMemo(() => {
    const map = new Map<string, { cost: number; count: number; qtySum: number }>();
    months13.forEach((m) => map.set(m, { cost: 0, count: 0, qtySum: 0 }));
    months13.forEach((m) => {
      const entries = entriesByMonth[m] || [];
      const rows = expandAll(entries, recipeMap, priceMap);
      const cost = rows.reduce((s, r) => s + r.cost, 0);
      const qtySum = entries.reduce((s, e) => s + (e.qty || 0), 0);
      map.set(m, { cost, count: entries.length, qtySum });
    });
    return map;
  }, [months13, entriesByMonth, recipeMap, priceMap]);

  const selEntries = entriesByMonth[selectedMonth] || [];
  const selRows = useMemo(
    () => expandAll(selEntries, recipeMap, priceMap),
    [selEntries, recipeMap, priceMap]
  );
  const selTotal = selRows.reduce((s, r) => s + r.cost, 0);

  /* 입력 모달 */
  const [showInput, setShowInput] = useState(false);
  const onSavedEntry = () => { clearAllCache(); setRefreshTick((t) => t + 1); };

  const shiftSel = (delta: number) => setSelectedMonth(shiftMonthKey(selectedMonth, delta));

  /* 엑셀 다운로드 */
  const downloadXlsx = async () => {
    const wb = new ExcelJS.Workbook();
    const thin = { style: 'thin' as const };
    const border = { top: thin, left: thin, right: thin, bottom: thin };
    const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
    const baseFont = { size: 11, name: '맑은 고딕' };

    // 시트 1: 월별 요약
    const ws1 = wb.addWorksheet('월별 요약');
    ws1.columns = [{ width: 12 }, { width: 14 }, { width: 14 }, { width: 18 }];
    ws1.mergeCells('A1:D1');
    const t1 = ws1.getCell('A1');
    t1.value = `폐기금액 — ${months13[0]} ~ ${months13[months13.length - 1]}`;
    t1.font = { size: 14, bold: true, name: '맑은 고딕' };
    t1.alignment = { horizontal: 'center', vertical: 'middle' };
    ['월', '폐기 건수', '폐기 갯수합', '폐기금액(₩)'].forEach((h, i) => {
      const c = ws1.getCell(3, i + 1);
      c.value = h; c.font = { ...baseFont, bold: true };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.fill = fill('FFFEF3C7'); c.border = border;
    });
    months13.forEach((m, i) => {
      const t = monthTotals.get(m) || { cost: 0, count: 0, qtySum: 0 };
      const r = 4 + i;
      ws1.getCell(r, 1).value = monthShort(m);
      ws1.getCell(r, 2).value = t.count;
      ws1.getCell(r, 3).value = t.qtySum;
      ws1.getCell(r, 4).value = Math.round(t.cost);
      for (let c = 1; c <= 4; c++) {
        const cell = ws1.getCell(r, c);
        cell.font = baseFont; cell.border = border;
        cell.alignment = { horizontal: c === 1 ? 'center' : 'right', vertical: 'middle' };
        if (c === 4) cell.numFmt = '#,##0';
      }
    });

    // 시트 2: 선택 월 상세
    const ws2 = wb.addWorksheet(`${selectedMonth} 상세`);
    ws2.columns = [
      { width: 12 }, { width: 10 }, { width: 22 }, { width: 6 },
      { width: 6 }, { width: 20 }, { width: 12 }, { width: 10 }, { width: 14 },
    ];
    ws2.mergeCells('A1:I1');
    const t2 = ws2.getCell('A1');
    t2.value = `${selectedMonth} 폐기 상세`;
    t2.font = { size: 14, bold: true, name: '맑은 고딕' };
    t2.alignment = { horizontal: 'center', vertical: 'middle' };
    ['일자', '코드', '제품', '갯수', '순번', '원재료', '중량(g)', '단가(₩/g)', '폐기금액(₩)'].forEach((h, i) => {
      const c = ws2.getCell(3, i + 1);
      c.value = h; c.font = { ...baseFont, bold: true };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.fill = fill('FFFEF3C7'); c.border = border;
    });
    selRows.forEach((row, i) => {
      const r = 4 + i;
      ws2.getCell(r, 1).value = row.date;
      ws2.getCell(r, 2).value = row.code;
      ws2.getCell(r, 3).value = row.productName;
      ws2.getCell(r, 4).value = row.qty;
      ws2.getCell(r, 5).value = row.seq;
      ws2.getCell(r, 6).value = row.ingredient;
      ws2.getCell(r, 7).value = Number(row.weight.toFixed(2));
      ws2.getCell(r, 8).value = row.price;
      ws2.getCell(r, 9).value = Math.round(row.cost);
      for (let c = 1; c <= 9; c++) {
        const cell = ws2.getCell(r, c);
        cell.font = baseFont; cell.border = border;
        cell.alignment = { horizontal: c === 3 || c === 6 ? 'left' : (c >= 7 ? 'right' : 'center'), vertical: 'middle' };
        if (c === 7) cell.numFmt = '#,##0.00';
        if (c === 8 || c === 9) cell.numFmt = '#,##0';
      }
    });
    const totRow = 4 + selRows.length;
    ws2.getCell(totRow, 1).value = '합계';
    ws2.mergeCells(totRow, 1, totRow, 8);
    ws2.getCell(totRow, 9).value = Math.round(selTotal);
    for (let c = 1; c <= 9; c++) {
      const cell = ws2.getCell(totRow, c);
      cell.font = { ...baseFont, bold: true }; cell.border = border;
      cell.fill = fill('FFFEF9C3');
      cell.alignment = { horizontal: c === 9 ? 'right' : 'center', vertical: 'middle' };
      if (c === 9) cell.numFmt = '#,##0';
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `폐기금액_${months13[0]}_${months13[months13.length - 1]}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  const recipeCount = recipeMap.size;
  const priceCount = priceMap.size;

  // 전체 13개월 데이터가 있는지 (없으면 차트 빈 상태로 표시)
  const hasAnyData = months13.some((m) => (monthTotals.get(m)?.count || 0) > 0);
  const yearTotal = months13.reduce((s, m) => s + (monthTotals.get(m)?.cost || 0), 0);
  const yearQty = months13.reduce((s, m) => s + (monthTotals.get(m)?.qtySum || 0), 0);

  return (
    <div className="space-y-5">
      {/* 상단 액션바 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-gray-800 text-lg">🗑️ 폐기금액</span>
        <span className="text-gray-300">|</span>
        <div className="flex items-center gap-1">
          <button onClick={() => shiftSel(-1)} className="w-8 h-8 rounded hover:bg-gray-100">◀</button>
          <input type="month" value={selectedMonth} onChange={(e) => e.target.value && setSelectedMonth(e.target.value)}
            className="border rounded px-2 py-1 text-sm font-bold" />
          <button onClick={() => shiftSel(1)} className="w-8 h-8 rounded hover:bg-gray-100">▶</button>
        </div>
        {loading && <span className="text-xs text-blue-600">불러오는 중...</span>}
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => { clearAllCache(); setRefreshTick((t) => t + 1); }} className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50" title="캐시 무시하고 다시 불러오기">🔄</button>
          <button onClick={() => setSelectedMonth(todayMonth >= DATA_START ? todayMonth : DATA_START)} className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50">이번 달</button>
          <button onClick={downloadXlsx} className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700">📥 엑셀</button>
          <button onClick={() => setShowInput(true)} className="px-4 py-1.5 text-sm rounded bg-rose-600 text-white font-semibold hover:bg-rose-700 shadow-sm">+ 폐기 등록</button>
        </div>
      </div>

      {/* DB 상태 알림 */}
      {(recipeCount === 0 || priceCount === 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          ⚠️ <b>설정</b> 페이지에서 레시피·원재료 단가 DB 를 먼저 입력해야 폐기금액이 계산됩니다.
          (현재 레시피 {recipeCount}건 / 단가 {priceCount}건)
        </div>
      )}

      {/* KPI 카드 — 한눈에 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label={`${selectedMonth.slice(5).replace(/^0/, '')}월 폐기금액`} value={Math.round(selTotal).toLocaleString() + '₩'} accent="rose" />
        <KpiCard label={`${selectedMonth.slice(5).replace(/^0/, '')}월 폐기 건수`} value={selEntries.length + '건'} accent="slate" />
        <KpiCard label="누적 폐기금액" value={Math.round(yearTotal).toLocaleString() + '₩'} accent="amber" />
        <KpiCard label="누적 폐기 갯수합" value={yearQty.toLocaleString() + '개'} accent="slate" />
      </div>

      {/* 선택 월 상세 (가장 중요 — 위로) */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b bg-rose-50 font-bold text-gray-800 flex items-center gap-2 flex-wrap">
          <span>📋 {selectedMonth} 폐기 상세</span>
          <span className="text-xs text-gray-500 font-normal">{selEntries.length}건 / 합계 <b className="text-rose-700">{Math.round(selTotal).toLocaleString()}₩</b></span>
        </div>
        <DetailTable entries={selEntries} recipeMap={recipeMap} priceMap={priceMap} onChanged={onSavedEntry} />
      </div>

      {/* 월별 요약 표 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm flex items-center gap-2">
          <span>📅 월별 요약</span>
          <span className="text-xs text-gray-500 font-normal">{months13[0]} ~ {months13[months13.length - 1]} · 행 클릭으로 해당월 보기</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-gray-600">
              <tr>
                <th className="border px-3 py-2 text-center">월</th>
                <th className="border px-3 py-2 text-right">폐기 건수</th>
                <th className="border px-3 py-2 text-right">폐기 갯수합</th>
                <th className="border px-3 py-2 text-right">폐기금액 (₩)</th>
              </tr>
            </thead>
            <tbody>
              {months13.map((m) => {
                const t = monthTotals.get(m) || { cost: 0, count: 0, qtySum: 0 };
                const isSel = m === selectedMonth;
                return (
                  <tr key={m} className={`border-t hover:bg-amber-50 cursor-pointer ${isSel ? 'bg-amber-100' : ''}`}
                    onClick={() => setSelectedMonth(m)}>
                    <td className="border px-3 py-1.5 text-center font-semibold">{monthShort(m)}</td>
                    <td className="border px-3 py-1.5 text-right">{t.count || '-'}</td>
                    <td className="border px-3 py-1.5 text-right">{t.qtySum || '-'}</td>
                    <td className="border px-3 py-1.5 text-right font-bold text-rose-700">{t.cost ? Math.round(t.cost).toLocaleString() : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 월별 차트 (맨 아래) */}
      <div className="bg-white border rounded-lg p-4">
        <h3 className="font-bold text-gray-800 mb-2 text-sm">📊 월별 폐기금액 추이 <span className="text-xs text-gray-500 font-normal">(막대 클릭으로 해당월 보기)</span></h3>
        {hasAnyData ? (
          <CostBars13
            data={months13.map((m) => ({ label: monthShort(m), value: monthTotals.get(m)?.cost || 0 }))}
            onBarClick={(idx) => setSelectedMonth(months13[idx])}
            selectedIdx={months13.indexOf(selectedMonth)}
          />
        ) : (
          <div className="py-12 text-center text-gray-400 text-sm">
            아직 폐기 등록 데이터가 없습니다. 위쪽 <b className="text-rose-600">+ 폐기 등록</b> 으로 첫 데이터를 입력해보세요.
          </div>
        )}
      </div>

      {/* 입력 모달 */}
      {showInput && (
        <WasteInputModal
          recipeMap={recipeMap}
          onClose={() => setShowInput(false)}
          onSaved={() => { setShowInput(false); onSavedEntry(); }}
        />
      )}
    </div>
  );
}

function KpiCard({ label, value, accent }: { label: string; value: string; accent: 'rose' | 'amber' | 'slate' }) {
  const styles = {
    rose:  { box: 'bg-rose-50 border-rose-200',   txt: 'text-rose-700'   },
    amber: { box: 'bg-amber-50 border-amber-200', txt: 'text-amber-700'  },
    slate: { box: 'bg-slate-50 border-slate-200', txt: 'text-slate-700'  },
  }[accent];
  return (
    <div className={`border rounded-lg p-3 ${styles.box}`}>
      <div className="text-xs text-gray-600">{label}</div>
      <div className={`mt-1 text-xl font-bold ${styles.txt}`}>{value}</div>
    </div>
  );
}

/* ===================== 일별 상세 표 (entry × ingredient) ===================== */
function DetailTable({
  entries, recipeMap, priceMap, onChanged,
}: {
  entries: WasteEntry[];
  recipeMap: Map<string, Recipe>;
  priceMap: Map<string, number>;
  onChanged: () => void;
}) {
  // 그룹: entry 별로 묶음
  const groups = entries.map((e) => ({
    entry: e,
    rows: expandWasteEntry(e, recipeMap.get(e.code), priceMap),
  }));

  const delEntry = async (e: WasteEntry) => {
    if (!e.id) return;
    if (!confirm(`${e.date} ${e.code} ${e.name} (×${e.qty}) 폐기 기록을 삭제할까요?`)) return;
    await deleteDoc(doc(db, 'waste', e.date, 'entries', e.id));
    onChanged();
  };

  if (entries.length === 0) {
    return <div className="px-4 py-10 text-center text-gray-400 text-sm">이 달에 등록된 폐기 기록이 없습니다 — "+ 폐기 등록" 으로 추가</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-gray-600">
          <tr>
            <th className="border px-2 py-1.5">일자</th>
            <th className="border px-2 py-1.5">코드</th>
            <th className="border px-2 py-1.5 text-left">제품</th>
            <th className="border px-2 py-1.5 text-right">갯수</th>
            <th className="border px-2 py-1.5 text-right">순번</th>
            <th className="border px-2 py-1.5 text-left">원재료</th>
            <th className="border px-2 py-1.5 text-right">중량(g)</th>
            <th className="border px-2 py-1.5 text-right">단가(₩/g)</th>
            <th className="border px-2 py-1.5 text-right">폐기금액(₩)</th>
            <th className="border px-2 py-1.5"></th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ entry, rows }, gi) => {
            const total = rows.reduce((s, r) => s + r.cost, 0);
            if (rows.length === 0) {
              return (
                <tr key={entry.id || gi} className="border-t bg-rose-50">
                  <td className="border px-2 py-1 text-center">{entry.date.slice(5)}</td>
                  <td className="border px-2 py-1 text-center font-mono">{entry.code}</td>
                  <td className="border px-2 py-1">{entry.name}</td>
                  <td className="border px-2 py-1 text-right">{entry.qty}</td>
                  <td className="border px-2 py-1 text-center text-amber-700" colSpan={5}>⚠️ 레시피 미등록</td>
                  <td className="border px-2 py-1 text-center">
                    <button onClick={() => delEntry(entry)} className="text-red-500 hover:underline">삭제</button>
                  </td>
                </tr>
              );
            }
            return rows.map((r, ri) => (
              <tr key={(entry.id || gi) + '-' + r.seq} className={`border-t ${ri === 0 ? 'border-t-2 border-t-gray-400' : ''}`}>
                {ri === 0 && (
                  <>
                    <td className="border px-2 py-1 text-center align-top" rowSpan={rows.length}>{entry.date.slice(5)}</td>
                    <td className="border px-2 py-1 text-center font-mono align-top" rowSpan={rows.length}>{entry.code}</td>
                    <td className="border px-2 py-1 align-top" rowSpan={rows.length}>{entry.name}</td>
                    <td className="border px-2 py-1 text-right align-top font-bold" rowSpan={rows.length}>{entry.qty}</td>
                  </>
                )}
                <td className="border px-2 py-1 text-right text-gray-500">{r.seq}</td>
                <td className="border px-2 py-1">{r.ingredient}</td>
                <td className="border px-2 py-1 text-right">{r.weight.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                <td className={`border px-2 py-1 text-right ${r.hasPrice ? '' : 'text-amber-600'}`}>
                  {r.hasPrice ? r.price.toLocaleString() : '단가 없음'}
                </td>
                <td className="border px-2 py-1 text-right font-bold text-rose-700">{Math.round(r.cost).toLocaleString()}</td>
                {ri === 0 && (
                  <td className="border px-2 py-1 text-center align-top" rowSpan={rows.length}>
                    <div className="font-bold text-rose-700">{Math.round(total).toLocaleString()}</div>
                    <button onClick={() => delEntry(entry)} className="text-xs text-red-500 hover:underline mt-1">삭제</button>
                  </td>
                )}
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ===================== 입력 모달 ===================== */
function WasteInputModal({
  recipeMap, onClose, onSaved,
}: {
  recipeMap: Map<string, Recipe>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(todayKey());
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Recipe | null>(null);
  const [qty, setQty] = useState<number>(1);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const recipes = useMemo(() => Array.from(recipeMap.values()), [recipeMap]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recipes.slice(0, 30);
    return recipes.filter((r) => r.code.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q)).slice(0, 60);
  }, [recipes, search]);

  const toggleIng = (name: string) => {
    const key = normalizeMaterialName(name);
    const next = new Set(excluded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExcluded(next);
  };

  const save = async () => {
    if (!selected || qty <= 0) return;
    setSaving(true);
    try {
      const excludedNames = (selected.ingredients || [])
        .filter((ing) => excluded.has(normalizeMaterialName(ing.name)))
        .map((ing) => ing.name);
      await addDoc(collection(db, 'waste', date, 'entries'), {
        date,
        code: selected.code,
        name: selected.name,
        qty,
        excludedIngredients: excludedNames,
        createdAt: new Date().toISOString(),
      });
      onSaved();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b bg-rose-50 flex items-center justify-between">
          <h3 className="font-bold text-gray-800">🗑️ 폐기 등록</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-sm font-medium text-gray-700">일자</label>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
            <label className="text-sm font-medium text-gray-700 ml-2">갯수</label>
            <input type="number" value={qty || ''} onChange={(e) => setQty(Number(e.target.value) || 0)} placeholder="0"
              className="w-24 border rounded px-2 py-1.5 text-sm text-right font-bold" />
          </div>

          {!selected ? (
            <div>
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="🔍 제품 코드/이름 검색 (예: F-001, 닭곰탕)"
                className="w-full border rounded-md px-3 py-2 text-sm" autoFocus />
              {recipes.length === 0 && (
                <div className="text-xs text-amber-700 mt-2">⚠️ 분석 → 설정 페이지에서 레시피를 먼저 등록하세요.</div>
              )}
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-72 overflow-y-auto">
                {filtered.map((r) => (
                  <button key={r.code} onClick={() => setSelected(r)}
                    className="text-left p-3 rounded border hover:bg-rose-50">
                    <div className="font-mono text-xs text-gray-500">{r.code}</div>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-gray-500">원재료 {r.ingredients?.length || 0}종</div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 p-3 bg-slate-50 rounded">
                <div className="flex-1">
                  <div className="font-mono text-xs text-gray-500">{selected.code}</div>
                  <div className="font-bold text-gray-800">{selected.name}</div>
                </div>
                <button onClick={() => { setSelected(null); setExcluded(new Set()); }} className="text-xs px-2 py-1 border rounded hover:bg-gray-100">다시 선택</button>
              </div>
              <div className="text-xs text-gray-500 mb-1">계산에 포함할 원재료 (체크 해제 시 제외)</div>
              <div className="max-h-72 overflow-y-auto border rounded">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-gray-600">
                    <tr>
                      <th className="px-2 py-1.5 w-10">포함</th>
                      <th className="px-2 py-1.5 w-10 text-right">순번</th>
                      <th className="px-2 py-1.5 text-left">원재료</th>
                      <th className="px-2 py-1.5 text-right">g/개</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selected.ingredients || []).map((ing) => {
                      const key = normalizeMaterialName(ing.name);
                      const checked = !excluded.has(key);
                      return (
                        <tr key={ing.seq} className="border-t">
                          <td className="px-2 py-1 text-center">
                            <input type="checkbox" checked={checked} onChange={() => toggleIng(ing.name)} className="w-4 h-4" />
                          </td>
                          <td className="px-2 py-1 text-right text-gray-500">{ing.seq}</td>
                          <td className="px-2 py-1">{ing.name}</td>
                          <td className="px-2 py-1 text-right">{(ing.gPerPiece || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-2 border rounded text-sm font-medium hover:bg-gray-100">취소</button>
          <button onClick={save} disabled={saving || !selected || qty <= 0}
            className="ml-auto px-5 py-2 bg-rose-600 text-white rounded font-medium hover:bg-rose-700 disabled:bg-gray-300">
            {saving ? '저장중...' : '등록'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===================== 13개월 차트 ===================== */
function CostBars13({
  data, onBarClick, selectedIdx,
}: {
  data: { label: string; value: number }[];
  onBarClick?: (idx: number) => void;
  selectedIdx?: number;
}) {
  const W = 900, H = 280, padL = 60, padR = 12, padT = 28, padB = 32;
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
            {fmtKR(niceMax * (1 - p))}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = padL + i * bandW + bandW / 2;
        const y = yFor(d.value);
        const sel = selectedIdx === i;
        return (
          <g key={i} onClick={() => onBarClick?.(i)} style={{ cursor: 'pointer' }}>
            <rect x={cx - barW / 2} y={y} width={barW} height={Math.max(0, innerH - (y - padT))}
              fill={sel ? '#be123c' : '#f43f5e'} opacity={d.value > 0 ? 1 : 0.2} />
            <text x={cx} y={H - 12} fontSize={11} textAnchor="middle" fill="#334155" fontWeight={sel ? 'bold' : '600'}>{d.label}</text>
            {d.value > 0 && (
              <text x={cx} y={y - 6} fontSize={11} textAnchor="middle" fill="#9f1239" fontWeight="bold"
                stroke="white" strokeWidth={1.5} paintOrder="stroke">
                {fmtKR(d.value)}
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
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / pow;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * pow;
}
function fmtKR(v: number): string {
  if (v >= 100_000_000) return (v / 100_000_000).toFixed(1) + '억';
  if (v >= 10_000) return (v / 10_000).toFixed(0) + '만';
  if (v >= 1000) return (v / 1000).toFixed(0) + '천';
  return String(Math.round(v));
}
