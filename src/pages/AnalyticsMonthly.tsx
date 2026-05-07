import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import type { AmbientEntry, Item, MachineEntry } from '../types';
import AmbientInputModal from '../components/AmbientInputModal';
import LogisticsInputModal from '../components/LogisticsInputModal';
import { todayKey } from '../lib/dateUtil';

const MACHINES: MachineEntry['machine'][] = ['1호기', '2호기', '3호기'];

function thisMonth() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function prevMonths(month: string, count: number): string[] {
  const [y, m] = month.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(y, m - 2 - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

async function fetchMonthLogistics(month: string): Promise<Record<string, number>> {
  const [yy, mm] = month.split('-').map(Number);
  const lastDay = new Date(yy, mm, 0).getDate();
  const dates = Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const snaps = await Promise.all(
    dates.map((d) => getDocs(collection(db, 'days', d, 'logistics')))
  );
  const map: Record<string, number> = {};
  snaps.forEach((s, i) => {
    if (s.empty) return;
    let sum = 0;
    s.forEach((d) => { sum += (d.data().qty as number) || 0; });
    map[dates[i]] = sum;
  });
  return map;
}

type MonthStats = {
  daysWorked: number;
  totalAvg: number;
  coldAvg: number;
  ambientAvg: number;
  itemsAvgPerDay: number;
  total: number;
  coldTotal: number;
  ambientTotal: number;
  totalRemaining: number;
  remainingRatio: number;
};

type MonthStatsLite = Omit<MonthStats, never>;

function computeMonthStats(
  entries: MachineEntry[],
  ambient: AmbientEntry[],
  items: Item[] = [],
  logisticsByDay: Record<string, number> = {},
  limitDays?: number,
): MonthStats {
  const qty = (e: MachineEntry) => (e.actualProduction || 0) + (e.additionalProduction || 0);
  let useEntries = entries;
  let useAmbient = ambient;
  let useItems = items;
  let useLogistics = logisticsByDay;
  if (limitDays !== undefined) {
    const allDates = Array.from(new Set([...entries.map((e) => e.date), ...ambient.map((a) => a.date)])).sort();
    const allowed = new Set(allDates.slice(0, limitDays));
    useEntries = entries.filter((e) => allowed.has(e.date));
    useAmbient = ambient.filter((a) => allowed.has(a.date));
    useItems = items.filter((i) => allowed.has(i.date));
    useLogistics = Object.fromEntries(Object.entries(logisticsByDay).filter(([d]) => allowed.has(d)));
  }
  const coldByDay: Record<string, number> = {};
  useEntries.forEach((e) => { coldByDay[e.date] = (coldByDay[e.date] || 0) + qty(e); });
  const ambByDay: Record<string, number> = {};
  useAmbient.forEach((a) => { ambByDay[a.date] = (ambByDay[a.date] || 0) + (a.qty || 0); });
  const allDays = new Set([...Object.keys(coldByDay), ...Object.keys(ambByDay)]);
  const coldTotal = Object.values(coldByDay).reduce((s, v) => s + v, 0);
  const ambientTotal = Object.values(ambByDay).reduce((s, v) => s + v, 0);
  const total = coldTotal + ambientTotal;
  const daysWorked = allDays.size;
  const coldDaysN = Object.keys(coldByDay).length;
  const ambDaysN = Object.keys(ambByDay).length;

  // 품목수는 냉장만 카운트
  const itemsByDay: Record<string, Set<string>> = {};
  useEntries.forEach((e) => {
    if (!itemsByDay[e.date]) itemsByDay[e.date] = new Set();
    itemsByDay[e.date].add(e.code.toLowerCase());
  });
  const counts = Object.values(itemsByDay).map((s) => s.size);
  const itemsAvgPerDay = counts.length ? counts.reduce((s, v) => s + v, 0) / counts.length : 0;

  // 잔여량: items+entries로 일별 surplus 계산, logistics 입력이 있는 일자는 override
  const itemsByDateCode: Record<string, number> = {};
  useItems.forEach((it) => {
    const k = `${it.date}|${it.code.toLowerCase()}`;
    itemsByDateCode[k] = (itemsByDateCode[k] || 0) + (it.totalQty || 0);
  });
  const actualByDateCode: Record<string, number> = {};
  useEntries.forEach((e) => {
    const k = `${e.date}|${e.code.toLowerCase()}`;
    actualByDateCode[k] = (actualByDateCode[k] || 0) + qty(e);
  });
  const surplusByDay: Record<string, number> = {};
  Object.entries(itemsByDateCode).forEach(([k, planned]) => {
    const actual = actualByDateCode[k] || 0;
    const surplus = Math.max(0, actual - planned);
    const date = k.split('|')[0];
    surplusByDay[date] = (surplusByDay[date] || 0) + surplus;
  });
  let totalRemaining = 0;
  const remainDays = new Set<string>([...Object.keys(surplusByDay), ...Object.keys(useLogistics)]);
  remainDays.forEach((day) => {
    if (useLogistics[day] !== undefined) totalRemaining += useLogistics[day];
    else totalRemaining += surplusByDay[day] || 0;
  });
  const remainingRatio = coldTotal > 0 ? (totalRemaining / coldTotal) * 100 : 0;

  return {
    daysWorked,
    totalAvg: daysWorked ? total / daysWorked : 0,
    coldAvg: coldDaysN ? coldTotal / coldDaysN : 0,
    ambientAvg: ambDaysN ? ambientTotal / ambDaysN : 0,
    itemsAvgPerDay,
    total, coldTotal, ambientTotal,
    totalRemaining, remainingRatio,
  };
}

export default function AnalyticsMonthly() {
  const [month, setMonth] = useState(thisMonth());
  const [entries, setEntries] = useState<MachineEntry[]>([]);
  const [ambient, setAmbient] = useState<AmbientEntry[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [logisticsByDay, setLogisticsByDay] = useState<Record<string, number>>({});
  const [prevLogisticsByDay, setPrevLogisticsByDay] = useState<Record<string, number>>({});
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map());
  const [prev3Avg, setPrev3Avg] = useState<number>(0);
  const [prevMonthData, setPrevMonthData] = useState<{ entries: MachineEntry[]; ambient: AmbientEntry[]; items: Item[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ambientModalOpen, setAmbientModalOpen] = useState(false);
  const [logisticsModalOpen, setLogisticsModalOpen] = useState(false);
  const [compareMode, setCompareMode] = useState<'full' | 'sameDays'>('full');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setPrev3Avg(0);
    const start = `${month}-01`;
    const end = `${month}-31`;

    Promise.all([
      getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', start), where('date', '<=', end))),
      getDocs(query(collectionGroup(db, 'items'), where('date', '>=', start), where('date', '<=', end))),
      getDocs(query(collectionGroup(db, 'ambient'), where('date', '>=', start), where('date', '<=', end))),
    ])
      .then(([entriesSnap, itemsSnap, ambientSnap]) => {
        if (cancelled) return;
        setEntries(entriesSnap.docs.map((d) => d.data() as MachineEntry));
        const itemsList = itemsSnap.docs.map((d) => d.data() as Item);
        setItems(itemsList);
        const map = new Map<string, string>();
        itemsList.forEach((it) => {
          if (it.code && it.name) map.set(it.code.toLowerCase(), it.name);
        });
        setNameMap(map);
        setAmbient(ambientSnap.docs.map((d) => d.data() as AmbientEntry));
      })
      .catch((e) => {
        if (!cancelled) setErr(e.message || String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    setLogisticsByDay({});
    fetchMonthLogistics(month).then((map) => {
      if (!cancelled) setLogisticsByDay(map);
    }).catch(() => {});

    // 직전 3개월 평균 + 전월 통계 백그라운드 fetch
    setPrevMonthData(null);
    setPrevLogisticsByDay({});
    const prevMs = prevMonths(month, 3);
    Promise.all(
      prevMs.flatMap((pm) => [
        getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', `${pm}-01`), where('date', '<=', `${pm}-31`))),
        getDocs(query(collectionGroup(db, 'ambient'), where('date', '>=', `${pm}-01`), where('date', '<=', `${pm}-31`))),
        getDocs(query(collectionGroup(db, 'items'), where('date', '>=', `${pm}-01`), where('date', '<=', `${pm}-31`))),
      ])
    )
      .then(async (snaps) => {
        if (cancelled) return;
        const monthAvgs: number[] = [];
        for (let i = 0; i < prevMs.length; i++) {
          const ents = snaps[i * 3].docs.map((d) => d.data() as MachineEntry);
          const ambs = snaps[i * 3 + 1].docs.map((d) => d.data() as AmbientEntry);
          const ms = computeMonthStats(ents, ambs);
          if (ms.daysWorked > 0) monthAvgs.push(ms.totalAvg);
          if (i === 0) {
            const prevItems = snaps[i * 3 + 2].docs.map((d) => d.data() as Item);
            const prevLogMap = await fetchMonthLogistics(prevMs[0]).catch(() => ({} as Record<string, number>));
            if (cancelled) return;
            setPrevLogisticsByDay(prevLogMap);
            setPrevMonthData({ entries: ents, ambient: ambs, items: prevItems });
          }
        }
        setPrev3Avg(monthAvgs.length ? monthAvgs.reduce((s, a) => s + a, 0) / monthAvgs.length : 0);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [month]);

  const stats = useMemo(() => {
    const qty = (e: MachineEntry) => (e.actualProduction || 0) + (e.additionalProduction || 0);

    const coldTotal = entries.reduce((s, e) => s + qty(e), 0);
    const ambientTotal = ambient.reduce((s, a) => s + (a.qty || 0), 0);
    const total = coldTotal + ambientTotal;

    const coldByDay: Record<string, number> = {};
    entries.forEach((e) => { coldByDay[e.date] = (coldByDay[e.date] || 0) + qty(e); });
    const ambientByDay: Record<string, number> = {};
    ambient.forEach((a) => { ambientByDay[a.date] = (ambientByDay[a.date] || 0) + (a.qty || 0); });

    const allDates = new Set<string>([...Object.keys(coldByDay), ...Object.keys(ambientByDay)]);
    const daysWorked = allDates.size;
    const coldDays = Object.keys(coldByDay).length;
    const ambientDays = Object.keys(ambientByDay).length;
    const coldAvg = coldDays ? coldTotal / coldDays : 0;
    const ambientAvg = ambientDays ? ambientTotal / ambientDays : 0;
    const avgPerDay = daysWorked ? total / daysWorked : 0;

    // 일별 평균 품목 수: 냉장 품목만 카운트 (상온 제외)
    const itemsByDay: Record<string, Set<string>> = {};
    entries.forEach((e) => {
      if (!itemsByDay[e.date]) itemsByDay[e.date] = new Set();
      itemsByDay[e.date].add(e.code.toLowerCase());
    });
    const dailyItemCounts = Object.values(itemsByDay).map((s) => s.size);
    const avgItemsPerDay = dailyItemCounts.length
      ? dailyItemCounts.reduce((s, v) => s + v, 0) / dailyItemCounts.length
      : 0;

    const byMachine = MACHINES.map((m) => ({
      machine: m,
      total: entries.filter((e) => e.machine === m).reduce((s, e) => s + qty(e), 0),
      count: entries.filter((e) => e.machine === m).length,
    }));

    const [yy, mm] = month.split('-').map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const allDays = Array.from({ length: lastDay }, (_, i) => {
      const day = i + 1;
      const dateStr = `${month}-${String(day).padStart(2, '0')}`;
      const dow = new Date(yy, mm - 1, day).getDay();
      return {
        day,
        dateStr,
        label: `${day}(${dayNames[dow]})`,
        cold: coldByDay[dateStr] || 0,
        ambient: ambientByDay[dateStr] || 0,
        dow,
        isSunday: dow === 0,
      };
    }).filter((d) => d.dow !== 6);

    const byCode: Record<string, number> = {};
    entries.forEach((e) => { byCode[e.code] = (byCode[e.code] || 0) + qty(e); });
    const topCodes = Object.entries(byCode)
      .map(([code, total]) => ({ code, name: nameMap.get(code.toLowerCase()) || '', total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // 잔여량/비율은 computeMonthStats를 통해 (current도 동일 로직)
    const ms = computeMonthStats(entries, ambient, items, logisticsByDay);

    // 10EA 미만 생산 수량 합계 (일자별 코드 합산이 1~9인 경우만)
    const actualByDateCode: Record<string, number> = {};
    entries.forEach((e) => {
      const k = `${e.date}|${e.code.toLowerCase()}`;
      actualByDateCode[k] = (actualByDateCode[k] || 0) + qty(e);
    });
    let under10Sum = 0;
    Object.values(actualByDateCode).forEach((v) => {
      if (v >= 1 && v < 10) under10Sum += v;
    });

    return {
      total, coldTotal, ambientTotal,
      totalRemaining: ms.totalRemaining,
      remainingRatio: ms.remainingRatio,
      under10Sum,
      daysWorked, coldDays, ambientDays,
      avgPerDay, coldAvg, ambientAvg,
      avgItemsPerDay,
      byMachine, allDays, topCodes,
    };
  }, [entries, ambient, items, nameMap, month, logisticsByDay]);

  const shiftMonth = (delta: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  const monthLabel = `${month.split('-')[0]}년 ${Number(month.split('-')[1])}월`;

  // 모달 기본 날짜: 이번 달이면 오늘, 아니면 해당 월의 1일
  const today = todayKey();
  const defaultModalDate = today.startsWith(month) ? today : `${month}-01`;

  return (
    <div className="space-y-5">
      <div className="bg-white border rounded-lg p-4 flex items-center gap-4 flex-wrap">
        <button
          onClick={() => shiftMonth(-1)}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-700"
          aria-label="이전 달"
        >◀</button>
        <div className="font-bold text-lg text-gray-800 min-w-[140px] text-center">{monthLabel}</div>
        <button
          onClick={() => shiftMonth(1)}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-700"
          aria-label="다음 달"
        >▶</button>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="border rounded px-2 py-1 text-sm ml-2"
        />
        {loading && <span className="text-sm text-gray-500">불러오는 중...</span>}
        {err && <span className="text-sm text-red-500">에러: {err}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setLogisticsModalOpen(true)}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-md font-medium text-sm shadow-sm flex items-center gap-2"
          >
            <span className="w-2 h-2 rounded-full bg-white" /> 잔여량 수정
          </button>
          <button
            onClick={() => setAmbientModalOpen(true)}
            className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-md font-medium text-sm shadow-sm flex items-center gap-2"
          >
            <span className="w-2 h-2 rounded-full bg-white" /> 상온 입력
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="총 생산량" value={stats.total.toLocaleString()} unit="EA" color="indigo" sub="냉장 + 상온" />
        <Card label="냉장 생산량" value={stats.coldTotal.toLocaleString()} unit="EA" color="blue" />
        <Card label="상온 생산량" value={stats.ambientTotal.toLocaleString()} unit="EA" color="orange" />
        <Card label="작업일 수" value={stats.daysWorked.toString()} unit="일" color="green" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="일평균 생산량" value={Math.round(stats.avgPerDay).toLocaleString()} unit="EA" color="purple" sub="냉장 + 상온" />
        <Card label="잔여량 비율" value={stats.remainingRatio.toFixed(2)} unit="%" color="rose" sub={`잔여 ${stats.totalRemaining.toLocaleString()} / 냉장 ${stats.coldTotal.toLocaleString()}`} />
        <Card label="10EA 미만 생산" value={stats.under10Sum.toLocaleString()} unit="EA" color="amber" sub="일별 코드합 1~9 인 항목 합계" />
        <Card label="일별 평균 품목 수" value={Math.round(stats.avgItemsPerDay).toLocaleString()} unit="개" color="teal" />
      </div>

      {/* 호기별 + 전월비교 (차트 위) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-5 bg-white border rounded-lg overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b bg-slate-50 font-semibold text-gray-800 text-sm flex items-center justify-between">
            <span>호기별 생산량 <span className="text-xs text-gray-500 font-normal">(냉장)</span></span>
            <span className="text-xs text-gray-500 font-normal">합계 <span className="font-bold text-blue-700">{stats.coldTotal.toLocaleString()}</span> EA</span>
          </div>
          <div className="p-4 space-y-3">
            {/* 가로 누적 막대 */}
            <div className="w-full h-7 rounded-md overflow-hidden flex bg-gray-100">
              {stats.byMachine.map((row, i) => {
                const pct = stats.coldTotal ? (row.total / stats.coldTotal) * 100 : 0;
                if (pct === 0) return null;
                const colors = ['bg-blue-500', 'bg-emerald-500', 'bg-violet-500'];
                return (
                  <div
                    key={row.machine}
                    className={`${colors[i]} h-full flex items-center justify-center text-[11px] text-white font-semibold`}
                    style={{ width: `${pct}%` }}
                    title={`${row.machine}: ${row.total.toLocaleString()} (${pct.toFixed(1)}%)`}
                  >
                    {pct >= 8 ? `${pct.toFixed(1)}%` : ''}
                  </div>
                );
              })}
            </div>
            {/* 범례 + 수치 */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              {stats.byMachine.map((row, i) => {
                const pct = stats.coldTotal ? (row.total / stats.coldTotal) * 100 : 0;
                const colors = ['bg-blue-500', 'bg-emerald-500', 'bg-violet-500'];
                return (
                  <div key={row.machine} className="border rounded px-2.5 py-2">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`w-2 h-2 rounded-full ${colors[i]}`} />
                      <span className="font-medium text-gray-700">{row.machine}</span>
                      <span className="ml-auto text-gray-400">{pct.toFixed(1)}%</span>
                    </div>
                    <div className="font-bold text-gray-900 text-sm">{row.total.toLocaleString()}<span className="text-[10px] text-gray-500 ml-1 font-normal">EA</span></div>
                    <div className="text-[10px] text-gray-400 mt-0.5">{row.count}건 입력</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="lg:col-span-7">
          <PrevMonthCompare
            month={month}
            mode={compareMode}
            onModeChange={setCompareMode}
            current={{
              daysWorked: stats.daysWorked,
              totalAvg: stats.avgPerDay,
              coldAvg: stats.coldAvg,
              ambientAvg: stats.ambientAvg,
              itemsAvgPerDay: stats.avgItemsPerDay,
              total: stats.total,
              coldTotal: stats.coldTotal,
              ambientTotal: stats.ambientTotal,
              totalRemaining: stats.totalRemaining,
              remainingRatio: stats.remainingRatio,
            }}
            prevData={prevMonthData}
            prevLogisticsByDay={prevLogisticsByDay}
          />
        </div>
      </div>

      <DailyChart
        monthLabel={monthLabel}
        days={stats.allDays}
        avg={stats.avgPerDay}
        prev3Avg={prev3Avg}
      />

      {/* Top 5 - 맨 아래 */}
      {stats.topCodes.length > 0 && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800 text-sm">
            상위 생산 품목 <span className="text-xs text-gray-500 font-normal">(Top 5 · 냉장)</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-gray-100">
            {stats.topCodes.slice(0, 5).map((row, i) => (
              <div key={row.code} className="p-4 text-center">
                <div className="text-[11px] font-bold text-gray-400 mb-1">{i + 1}위</div>
                <div className="font-mono text-[11px] text-gray-500">{row.code}</div>
                <div className="text-sm font-medium mt-1 text-gray-800 truncate" title={row.name}>{row.name || '-'}</div>
                <div className="text-xl font-bold text-blue-700 mt-2">{row.total.toLocaleString()}</div>
                <div className="text-[10px] text-gray-400 mt-0.5">EA</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <AmbientInputModal
        open={ambientModalOpen}
        onClose={() => setAmbientModalOpen(false)}
        defaultDate={defaultModalDate}
      />
      <LogisticsInputModal
        open={logisticsModalOpen}
        onClose={() => setLogisticsModalOpen(false)}
        defaultDate={defaultModalDate}
      />
    </div>
  );
}

function niceScale(maxValue: number): { max: number; step: number } {
  if (maxValue <= 0) return { max: 10, step: 2 };
  const targetTicks = 6;
  const rawStep = maxValue / targetTicks;
  const exp = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const n = rawStep / exp;
  let niceN;
  if (n <= 1) niceN = 1;
  else if (n <= 2) niceN = 2;
  else if (n <= 2.5) niceN = 2.5;
  else if (n <= 5) niceN = 5;
  else niceN = 10;
  const step = niceN * exp;
  const niceMaxVal = Math.ceil(maxValue / step) * step;
  return { max: niceMaxVal, step };
}

function DailyChart({
  monthLabel, days, avg, prev3Avg,
}: {
  monthLabel: string;
  days: { day: number; label: string; cold: number; ambient: number; isSunday: boolean }[];
  avg: number;
  prev3Avg: number;
}) {
  const totalsPerDay = days.map((d) => d.cold + d.ambient);
  const maxRaw = Math.max(avg, prev3Avg, ...totalsPerDay);
  const { max: yMax, step: tickStep } = niceScale(maxRaw * 1.18);
  const tickCount = Math.round(yMax / tickStep);

  const padL = 90, padR = 110, padT = 50, padB = 60;
  const innerW = 1280;
  const innerH = 540;
  const W = padL + innerW + padR;
  const H = padT + innerH + padB;

  const bandW = innerW / days.length;
  const barW = Math.min(36, bandW * 0.74);
  const yFor = (v: number) => padT + innerH - (v / yMax) * innerH;

  const avgY = avg > 0 ? yFor(avg) : 0;
  const prev3Y = prev3Avg > 0 ? yFor(prev3Avg) : 0;
  let avgLabelY = avgY;
  let prev3LabelY = prev3Y;
  if (avg > 0 && prev3Avg > 0 && Math.abs(avgY - prev3Y) < 24) {
    if (avg < prev3Avg) { avgLabelY = avgY + 14; prev3LabelY = prev3Y - 14; }
    else { avgLabelY = avgY - 14; prev3LabelY = prev3Y + 14; }
  }

  const noData = days.every((d) => d.cold + d.ambient === 0);

  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">
        {monthLabel} 일별 생산량
      </div>
      {noData ? (
        <div className="p-12 text-center text-gray-400 text-sm">해당 월에 생산 내역이 없습니다</div>
      ) : (
        <div className="p-4">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="w-full h-auto block">
            <text x={W / 2} y={26} textAnchor="middle" fill="#1f2937" fontSize="18" fontWeight="bold">
              생산팀 {monthLabel} 생산량 집계현황
            </text>

            {Array.from({ length: tickCount + 1 }).map((_, i) => {
              const v = tickStep * i;
              const y = yFor(v);
              return (
                <g key={i}>
                  <line x1={padL} y1={y} x2={padL + innerW} y2={y} stroke="#e5e7eb" strokeWidth={1} />
                  <text x={padL - 10} y={y + 4} textAnchor="end" fontSize="12" fill="#6b7280">
                    {Math.round(v).toLocaleString()}
                  </text>
                </g>
              );
            })}

            {days.map((d, i) => {
              const cx = padL + bandW * i + bandW / 2;
              return (
                <text key={`x-${d.day}`} x={cx} y={padT + innerH + 20} textAnchor="middle" fontSize="11"
                  fill={d.isSunday ? '#ef4444' : '#4b5563'}>
                  {d.label}
                </text>
              );
            })}

            {days.map((d, i) => {
              if (d.cold + d.ambient <= 0) return null;
              const cx = padL + bandW * i + bandW / 2;
              const yCold = yFor(d.cold);
              const hCold = padT + innerH - yCold;
              const yAmb = yFor(d.cold + d.ambient);
              const hAmb = yCold - yAmb;

              const coldText = d.cold > 0 ? d.cold.toLocaleString() : '';
              const ambText = d.ambient > 0 ? d.ambient.toLocaleString() : '';
              const coldTW = coldText.length * 7 + 10;
              const ambTW = ambText.length * 7 + 10;

              const coldInside = hCold >= 28;
              const ambInside = hAmb >= 24;
              const coldLabelY = coldInside ? yCold + hCold / 2 : yCold - 10;
              const ambLabelY = ambInside ? yAmb + hAmb / 2 : yAmb - 10;

              return (
                <g key={`bar-${d.day}`}>
                  {d.cold > 0 && (
                    <rect x={cx - barW / 2} y={yCold} width={barW} height={hCold} fill="#2563eb" rx={2} />
                  )}
                  {d.ambient > 0 && (
                    <rect x={cx - barW / 2} y={yAmb} width={barW} height={hAmb} fill="#ea580c" rx={2} />
                  )}
                  {ambText && (
                    <g>
                      <rect x={cx - ambTW / 2} y={ambLabelY - 9} width={ambTW} height={16}
                        fill="#ffedd5" fillOpacity={0.95} stroke="#fb923c" strokeWidth={0.7} rx={3} />
                      <text x={cx} y={ambLabelY + 3} textAnchor="middle" fontSize="11"
                        fill="#9a3412" fontWeight="bold">
                        {ambText}
                      </text>
                    </g>
                  )}
                  {coldText && (
                    <g>
                      <rect x={cx - coldTW / 2} y={coldLabelY - 9} width={coldTW} height={16}
                        fill="white" fillOpacity={0.92} stroke="#cbd5e1" strokeWidth={0.5} rx={3} />
                      <text x={cx} y={coldLabelY + 3} textAnchor="middle" fontSize="11"
                        fill="#1f2937" fontWeight="bold">
                        {coldText}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {avg > 0 && (
              <g>
                <line x1={padL} y1={avgY} x2={padL + innerW} y2={avgY}
                  stroke="#6b7280" strokeWidth={2.5} />
                <rect x={padL + innerW + 4} y={avgLabelY - 11} width={92} height={22}
                  fill="#f3f4f6" stroke="#9ca3af" rx={2} />
                <text x={padL + innerW + 50} y={avgLabelY + 4} textAnchor="middle" fontSize="12"
                  fill="#374151" fontWeight="bold">
                  {Math.round(avg).toLocaleString()}
                </text>
              </g>
            )}
            {prev3Avg > 0 && (
              <g>
                <line x1={padL} y1={prev3Y} x2={padL + innerW} y2={prev3Y}
                  stroke="#eab308" strokeWidth={2.5} />
                <rect x={padL + innerW + 4} y={prev3LabelY - 11} width={92} height={22}
                  fill="#fefce8" stroke="#eab308" rx={2} />
                <text x={padL + innerW + 50} y={prev3LabelY + 4} textAnchor="middle" fontSize="12"
                  fill="#854d0e" fontWeight="bold">
                  {Math.round(prev3Avg).toLocaleString()}
                </text>
              </g>
            )}

            <line x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} stroke="#9ca3af" />
            <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="#9ca3af" />
          </svg>

          <div className="flex items-center justify-center gap-6 mt-4 text-sm text-gray-700 flex-wrap">
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 inline-block bg-blue-600 rounded-sm" /> 냉장
            </span>
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 inline-block rounded-sm" style={{ backgroundColor: '#ea580c' }} /> 상온
            </span>
            <span className="flex items-center gap-2">
              <span className="w-6 border-t-[2.5px] border-gray-500 inline-block" /> 일 평균 생산량
            </span>
            <span className="flex items-center gap-2">
              <span className="w-6 border-t-[2.5px] border-yellow-500 inline-block" /> 직전 3개월 일평균 생산량
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function PrevMonthCompare({
  month, mode, onModeChange, current, prevData, prevLogisticsByDay,
}: {
  month: string;
  mode: 'full' | 'sameDays';
  onModeChange: (m: 'full' | 'sameDays') => void;
  current: MonthStatsLite;
  prevData: { entries: MachineEntry[]; ambient: AmbientEntry[]; items: Item[] } | null;
  prevLogisticsByDay: Record<string, number>;
}) {
  const [y, m] = month.split('-').map(Number);
  const prevDate = new Date(y, m - 2, 1);
  const prevLabel = `${prevDate.getMonth() + 1}월`;
  const currLabel = `${m}월`;

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === y && today.getMonth() + 1 === m;

  const prev: MonthStats | null = useMemo(() => {
    if (!prevData) return null;
    if (mode === 'full') {
      return computeMonthStats(prevData.entries, prevData.ambient, prevData.items, prevLogisticsByDay);
    }
    return computeMonthStats(prevData.entries, prevData.ambient, prevData.items, prevLogisticsByDay, current.daysWorked);
  }, [prevData, prevLogisticsByDay, mode, current.daysWorked]);

  const rows: { label: string; cur: number; prv: number; unit: string; bold?: boolean; pp?: boolean; inverse?: boolean }[] = mode === 'full'
    ? [
        { label: '총 생산량', cur: current.total, prv: prev?.total || 0, unit: 'EA', bold: true },
        { label: '냉장 생산량', cur: current.coldTotal, prv: prev?.coldTotal || 0, unit: 'EA' },
        { label: '상온 생산량', cur: current.ambientTotal, prv: prev?.ambientTotal || 0, unit: 'EA' },
        { label: '잔여량', cur: current.totalRemaining, prv: prev?.totalRemaining || 0, unit: 'EA', inverse: true },
        { label: '잔여량 비율(%)', cur: current.remainingRatio, prv: prev?.remainingRatio || 0, unit: '%', pp: true, inverse: true },
        { label: '일평균 생산량', cur: current.totalAvg, prv: prev?.totalAvg || 0, unit: 'EA' },
        { label: '일별 평균 품목수', cur: current.itemsAvgPerDay, prv: prev?.itemsAvgPerDay || 0, unit: '개' },
        { label: '작업일 수', cur: current.daysWorked, prv: prev?.daysWorked || 0, unit: '일' },
      ]
    : [
        { label: '총 생산량', cur: current.total, prv: prev?.total || 0, unit: 'EA', bold: true },
        { label: '냉장 생산량', cur: current.coldTotal, prv: prev?.coldTotal || 0, unit: 'EA' },
        { label: '상온 생산량', cur: current.ambientTotal, prv: prev?.ambientTotal || 0, unit: 'EA' },
        { label: '잔여량', cur: current.totalRemaining, prv: prev?.totalRemaining || 0, unit: 'EA', inverse: true },
        { label: '잔여량 비율(%)', cur: current.remainingRatio, prv: prev?.remainingRatio || 0, unit: '%', pp: true, inverse: true },
        { label: '일평균 생산량', cur: current.totalAvg, prv: prev?.totalAvg || 0, unit: 'EA' },
        { label: '일별 평균 품목수', cur: current.itemsAvgPerDay, prv: prev?.itemsAvgPerDay || 0, unit: '개' },
      ];

  return (
    <div className="bg-white border rounded-lg overflow-hidden h-full flex flex-col">
      <div className="px-3 py-2 border-b bg-amber-50 flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-gray-800 text-sm">전월 비교</span>
        {isCurrentMonth && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-800 font-medium">
            진행중 {current.daysWorked}일
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => onModeChange('full')}
            className={`px-2.5 py-1 text-[11px] rounded font-medium ${
              mode === 'full' ? 'bg-amber-500 text-white' : 'bg-white border text-gray-600 hover:bg-gray-100'
            }`}
          >월 전체</button>
          <button
            onClick={() => onModeChange('sameDays')}
            className={`px-2.5 py-1 text-[11px] rounded font-medium ${
              mode === 'sameDays' ? 'bg-amber-500 text-white' : 'bg-white border text-gray-600 hover:bg-gray-100'
            }`}
          >동일 작업일수</button>
        </div>
      </div>
      <table className="w-full text-xs">
        <thead className="bg-gray-50 text-[10px] text-gray-500">
          <tr>
            <th className="px-3 py-1.5 text-left">항목</th>
            <th className="px-3 py-1.5 text-right">{prevLabel}</th>
            <th className="px-3 py-1.5 text-right">{currLabel}</th>
            <th className="px-3 py-1.5 text-right">증감</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const diff = r.cur - r.prv;
            const pct = r.prv > 0 ? (diff / r.prv) * 100 : (r.cur > 0 ? 100 : 0);
            const up = diff > 0, down = diff < 0;
            const arrow = up ? '▲' : down ? '▼' : '–';
            // inverse: 줄어드는 게 좋은 지표 (잔여량 등) → 색깔 반전
            const good = r.inverse ? down : up;
            const bad = r.inverse ? up : down;
            const cls = good ? 'text-emerald-600' : bad ? 'text-red-600' : 'text-gray-400';
            const fmt = (v: number) => r.pp ? v.toFixed(2) : Math.round(v).toLocaleString();
            return (
              <tr key={r.label} className={`border-t ${r.bold ? 'bg-slate-50/60' : ''}`}>
                <td className={`px-3 py-1.5 text-gray-700 ${r.bold ? 'font-bold' : ''}`}>{r.label}</td>
                <td className="px-3 py-1.5 text-right text-gray-600">
                  {prev ? fmt(r.prv) : <span className="text-gray-300">···</span>}
                </td>
                <td className={`px-3 py-1.5 text-right font-bold text-gray-800 ${r.bold ? 'text-sm' : ''}`}>
                  {fmt(r.cur)}
                </td>
                <td className={`px-3 py-1.5 text-right font-semibold ${cls}`}>
                  {prev ? (
                    r.pp ? (
                      <span>{up ? '+' : down ? '−' : ''}{Math.abs(diff).toFixed(2)}%p</span>
                    ) : (
                      <><span>{arrow}</span><span className="ml-0.5">{Math.abs(pct).toFixed(1)}%</span></>
                    )
                  ) : (
                    <span className="text-gray-300">···</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!prev && (
        <div className="px-4 py-3 text-center text-xs text-gray-400 border-t bg-slate-50">
          {prevLabel} 데이터 불러오는 중...
        </div>
      )}
    </div>
  );
}

const COLOR_MAP = {
  blue:   'border-blue-500 text-blue-700',
  green:  'border-green-500 text-green-700',
  purple: 'border-purple-500 text-purple-700',
  orange: 'border-orange-500 text-orange-700',
  rose:   'border-rose-500 text-rose-700',
  indigo: 'border-indigo-500 text-indigo-700',
  teal:   'border-teal-500 text-teal-700',
  amber:  'border-amber-500 text-amber-700',
} as const;

function Card({
  label, value, unit, color, sub,
}: { label: string; value: string; unit: string; color: keyof typeof COLOR_MAP; sub?: string }) {
  const cls = COLOR_MAP[color];
  return (
    <div className={`bg-white border-l-4 ${cls} rounded-lg shadow-sm p-4`}>
      <div className="text-xs text-gray-500 mb-1 flex items-baseline gap-1.5">
        {label}
        {sub && <span className="text-[10px] text-gray-400">({sub})</span>}
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl font-bold ${cls}`}>{value}</span>
        <span className="text-xs text-gray-500">{unit}</span>
      </div>
    </div>
  );
}
