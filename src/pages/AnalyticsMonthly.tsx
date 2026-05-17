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

// ===== localStorage 캐시 (Firestore 읽기 절감) =====
const CACHE_PREFIX = 'analyticsMonthly:';
function getCache<T>(key: string, ttlMs: number): { data: T; ts: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; data: T };
    if (Date.now() - parsed.ts > ttlMs) return null;
    return parsed;
  } catch { return null; }
}
function setCache<T>(key: string, data: T) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}
function clearCache(key: string) {
  try { localStorage.removeItem(CACHE_PREFIX + key); } catch {}
}

function thisMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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
  const [prev3Tick, setPrev3Tick] = useState(0);
  const [prev3Refreshing, setPrev3Refreshing] = useState(false);
  const [prev3CachedAt, setPrev3CachedAt] = useState<number | null>(null);
  const [prevMonthData, setPrevMonthData] = useState<{ entries: MachineEntry[]; ambient: AmbientEntry[]; items: Item[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ambientModalOpen, setAmbientModalOpen] = useState(false);
  const [logisticsModalOpen, setLogisticsModalOpen] = useState(false);
  const [compareMode, setCompareMode] = useState<'full' | 'sameDays'>('full');
  const [cacheInfo, setCacheInfo] = useState<{ age: number; isCached: boolean }>({ age: 0, isCached: false });
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);

    // 현재월: 진행중이라 짧은 TTL, 과거월은 길게 (데이터 확정)
    const isCurrent = month === thisMonthKey();
    const ttlCurrent = isCurrent ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000;  // 5분 / 24시간
    const ttlPrev = 24 * 60 * 60 * 1000;                                  // 24시간

    type Snapshot = {
      entries: MachineEntry[];
      items: Item[];
      ambient: AmbientEntry[];
      logistics: Record<string, number>;
    };

    const cacheKey = `m:${month}`;
    const cached = refreshTick === 0 ? getCache<Snapshot>(cacheKey, ttlCurrent) : null;
    if (cached) {
      // 캐시 히트 — Firestore 읽기 0건
      setEntries(cached.data.entries);
      setItems(cached.data.items);
      setAmbient(cached.data.ambient);
      setLogisticsByDay(cached.data.logistics);
      const map = new Map<string, string>();
      cached.data.items.forEach((it) => {
        if (it.code && it.name) map.set(it.code.toLowerCase(), it.name);
      });
      setNameMap(map);
      setCacheInfo({ age: Date.now() - cached.ts, isCached: true });
      setLoading(false);
    } else {
      setCacheInfo({ age: 0, isCached: false });
      const start = `${month}-01`;
      const end = `${month}-31`;
      Promise.all([
        getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', start), where('date', '<=', end))),
        getDocs(query(collectionGroup(db, 'items'), where('date', '>=', start), where('date', '<=', end))),
        getDocs(query(collectionGroup(db, 'ambient'), where('date', '>=', start), where('date', '<=', end))),
        fetchMonthLogistics(month),
      ])
        .then(([entriesSnap, itemsSnap, ambientSnap, logMap]) => {
          if (cancelled) return;
          const ents = entriesSnap.docs.map((d) => d.data() as MachineEntry);
          const its = itemsSnap.docs.map((d) => d.data() as Item);
          const ambs = ambientSnap.docs.map((d) => d.data() as AmbientEntry);
          setEntries(ents);
          setItems(its);
          setAmbient(ambs);
          setLogisticsByDay(logMap);
          const map = new Map<string, string>();
          its.forEach((it) => { if (it.code && it.name) map.set(it.code.toLowerCase(), it.name); });
          setNameMap(map);
          setCache(cacheKey, { entries: ents, items: its, ambient: ambs, logistics: logMap });
        })
        .catch((e) => { if (!cancelled) setErr(e.message || String(e)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }

    // 전월 데이터 (확정 데이터라 길게 캐시)
    setPrevMonthData(null);
    setPrevLogisticsByDay({});
    const prevM = prevMonths(month, 1)[0];
    type PrevSnapshot = {
      entries: MachineEntry[];
      ambient: AmbientEntry[];
      items: Item[];
      logistics: Record<string, number>;
    };
    const prevCacheKey = `pm:${prevM}`;
    const prevCached = refreshTick === 0 ? getCache<PrevSnapshot>(prevCacheKey, ttlPrev) : null;
    if (prevCached) {
      setPrevLogisticsByDay(prevCached.data.logistics);
      setPrevMonthData({
        entries: prevCached.data.entries,
        ambient: prevCached.data.ambient,
        items: prevCached.data.items,
      });
    } else {
      Promise.all([
        getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', `${prevM}-01`), where('date', '<=', `${prevM}-31`))),
        getDocs(query(collectionGroup(db, 'ambient'), where('date', '>=', `${prevM}-01`), where('date', '<=', `${prevM}-31`))),
        getDocs(query(collectionGroup(db, 'items'), where('date', '>=', `${prevM}-01`), where('date', '<=', `${prevM}-31`))),
        fetchMonthLogistics(prevM),
      ])
        .then((arr) => {
          if (cancelled) return;
          const ents = arr[0].docs.map((d) => d.data() as MachineEntry);
          const ambs = arr[1].docs.map((d) => d.data() as AmbientEntry);
          const prevItems = arr[2].docs.map((d) => d.data() as Item);
          const prevLogMap = arr[3] as Record<string, number>;
          setPrevLogisticsByDay(prevLogMap);
          setPrevMonthData({ entries: ents, ambient: ambs, items: prevItems });
          setCache(prevCacheKey, { entries: ents, ambient: ambs, items: prevItems, logistics: prevLogMap });
        })
        .catch(() => {});
    }

    return () => { cancelled = true; };
  }, [month, refreshTick]);

  // 직전 3개월 일평균: 30일 캐시 (수동 갱신 가능)
  useEffect(() => {
    let cancelled = false;
    const key = `prev3avg:${month}`;
    const TTL = 30 * 24 * 60 * 60 * 1000; // 30일
    const cached = prev3Tick === 0 ? getCache<{ avg: number }>(key, TTL) : null;
    if (cached) {
      setPrev3Avg(cached.data.avg);
      setPrev3CachedAt(cached.ts);
      return () => { cancelled = true; };
    }
    setPrev3Refreshing(true);
    const prevMs = prevMonths(month, 3);
    Promise.all(
      prevMs.flatMap((pm) => [
        getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', `${pm}-01`), where('date', '<=', `${pm}-31`))),
        getDocs(query(collectionGroup(db, 'ambient'), where('date', '>=', `${pm}-01`), where('date', '<=', `${pm}-31`))),
      ])
    )
      .then((snaps) => {
        if (cancelled) return;
        const avgs: number[] = [];
        for (let i = 0; i < prevMs.length; i++) {
          const ents = snaps[i * 2].docs.map((d) => d.data() as MachineEntry);
          const ambs = snaps[i * 2 + 1].docs.map((d) => d.data() as AmbientEntry);
          const ms = computeMonthStats(ents, ambs);
          if (ms.daysWorked > 0) avgs.push(ms.totalAvg);
        }
        const avg = avgs.length ? avgs.reduce((s, a) => s + a, 0) / avgs.length : 0;
        setPrev3Avg(avg);
        setCache(key, { avg });
        setPrev3CachedAt(Date.now());
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPrev3Refreshing(false); });
    return () => { cancelled = true; };
  }, [month, prev3Tick]);

  const forceRefresh = () => {
    clearCache(`m:${month}`);
    clearCache(`pm:${prevMonths(month, 1)[0]}`);
    setRefreshTick((t) => t + 1);
  };

  const refreshPrev3 = () => {
    clearCache(`prev3avg:${month}`);
    setPrev3Tick((t) => t + 1);
  };

  const stats = useMemo(() => {
    const qty = (e: MachineEntry) => (e.actualProduction || 0) + (e.additionalProduction || 0);

    // 일별 raw 합계
    const rawColdByDay: Record<string, number> = {};
    entries.forEach((e) => { rawColdByDay[e.date] = (rawColdByDay[e.date] || 0) + qty(e); });
    const totalQtyByDay: Record<string, number> = {};
    items.forEach((it) => { totalQtyByDay[it.date] = (totalQtyByDay[it.date] || 0) + (it.totalQty || 0); });

    // 냉장 생산량: 잔여량 수정값이 있는 날은 totalQty + logQty 사용 (사용자 입력 우선)
    const coldByDay: Record<string, number> = {};
    const allColdDates = new Set<string>([
      ...Object.keys(rawColdByDay),
      ...Object.keys(logisticsByDay),
      ...Object.keys(totalQtyByDay),
    ]);
    allColdDates.forEach((d) => {
      if (logisticsByDay[d] !== undefined) {
        coldByDay[d] = (totalQtyByDay[d] || 0) + logisticsByDay[d];
      } else {
        coldByDay[d] = rawColdByDay[d] || 0;
      }
    });
    const coldTotal = Object.values(coldByDay).reduce((s, v) => s + v, 0);
    const ambientTotal = ambient.reduce((s, a) => s + (a.qty || 0), 0);
    const total = coldTotal + ambientTotal;

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

    // 10EA 미만 발주 품목 건수 (items.totalQty 가 1~9 EA 인 건수)
    let under10Count = 0;
    items.forEach((it) => {
      const q = it.totalQty || 0;
      if (q >= 1 && q < 10) under10Count++;
    });

    return {
      total, coldTotal, ambientTotal,
      totalRemaining: ms.totalRemaining,
      remainingRatio: ms.remainingRatio,
      under10Count,
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
        {!loading && cacheInfo.isCached && (
          <span className="text-[11px] text-gray-400 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            캐시 ({Math.max(1, Math.floor(cacheInfo.age / 1000))}초 전)
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={forceRefresh}
            disabled={loading}
            className="px-3 py-2 bg-white border hover:bg-gray-50 text-gray-700 rounded-md font-medium text-sm shadow-sm disabled:opacity-50"
            title="캐시 무시하고 다시 불러오기"
          >🔄</button>
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
        <Card
          label="10EA 미만 생산 품목"
          value={stats.under10Count.toLocaleString()}
          unit="건"
          color="amber"
          aux={{
            label: '일평균',
            value: `${stats.daysWorked > 0 ? (stats.under10Count / stats.daysWorked).toFixed(1) : '0.0'}건`,
          }}
        />
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
        onRefreshPrev3={refreshPrev3}
        prev3Refreshing={prev3Refreshing}
        prev3CachedAt={prev3CachedAt}
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
        onClose={() => { setLogisticsModalOpen(false); forceRefresh(); }}
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
  monthLabel, days, avg, prev3Avg, onRefreshPrev3, prev3Refreshing, prev3CachedAt,
}: {
  monthLabel: string;
  days: { day: number; label: string; cold: number; ambient: number; isSunday: boolean }[];
  avg: number;
  prev3Avg: number;
  onRefreshPrev3?: () => void;
  prev3Refreshing?: boolean;
  prev3CachedAt?: number | null;
}) {
  const cachedAgo = prev3CachedAt
    ? (() => {
        const days = Math.floor((Date.now() - prev3CachedAt) / (24 * 60 * 60 * 1000));
        if (days === 0) return '오늘';
        return `${days}일 전`;
      })()
    : null;
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
      <div className="px-5 py-3 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-gray-800">{monthLabel} 일별 생산량</span>
        {onRefreshPrev3 && (
          <div className="ml-auto flex items-center gap-2">
            {cachedAgo && (
              <span className="text-[11px] text-gray-400">
                직전 3개월 평균 갱신: <b className="text-gray-600">{cachedAgo}</b>
              </span>
            )}
            <button
              onClick={onRefreshPrev3}
              disabled={prev3Refreshing}
              className="px-2.5 py-1 bg-white border hover:bg-yellow-50 hover:border-yellow-300 text-gray-700 rounded text-xs font-medium shadow-sm disabled:opacity-50 flex items-center gap-1"
              title="직전 3개월 일평균을 다시 계산합니다 (한 달에 한 번만 누르면 됩니다)"
            >
              <span className={prev3Refreshing ? 'animate-spin inline-block' : 'inline-block'}>🔄</span>
              {prev3Refreshing ? '갱신중' : '평균 갱신'}
            </button>
          </div>
        )}
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
  label, value, unit, color, sub, aux,
}: { label: string; value: string; unit: string; color: keyof typeof COLOR_MAP; sub?: string; aux?: { label: string; value: string } }) {
  const cls = COLOR_MAP[color];
  return (
    <div className={`bg-white border-l-4 ${cls} rounded-lg shadow-sm p-4`}>
      <div className="text-xs text-gray-500 mb-1 flex items-baseline gap-1.5">
        {label}
        {sub && <span className="text-[10px] text-gray-400">({sub})</span>}
      </div>
      <div className="flex items-baseline gap-1 flex-wrap">
        <span className={`text-2xl font-bold ${cls}`}>{value}</span>
        <span className="text-xs text-gray-500">{unit}</span>
        {aux && (
          <span className="ml-auto text-xs text-gray-500">
            <span className="text-gray-400">{aux.label}</span>{' '}
            <span className="font-bold text-gray-700">{aux.value}</span>
          </span>
        )}
      </div>
    </div>
  );
}
