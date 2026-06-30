/** 잔여량 추세 분석 (수율조정 도우미)
 *  - 최근 N일의 days/{date} 데이터를 한 번에 읽어 품목 × 날짜 격자로 잔여량을 펼친다.
 *  - 임계치(기본 10개) 이상이 며칠 연속되는 품목 = 수율조정 후보 → 상단 정렬.
 *  - 잔여량 계산은 잔여량/대시보드 페이지와 동일: 물류 등록수량 우선, 없으면 (실제생산 - 목표).
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { shiftDateKey, todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { Item, MachineEntry } from '../types';

const MACHINES: MachineEntry['machine'][] = ['1호기', '2호기', '3호기'];

// 비교용: 대시·공백 제거 + 소문자
function normalize(code: string): string {
  return code.toLowerCase().replace(/[-\s]/g, '');
}

type DayRemainMap = Map<string, { code: string; name: string; remain: number }>;

// 하루치 잔여량 맵: normalize(code) → { code, name, remain }
async function fetchDayRemainMap(date: string): Promise<DayRemainMap> {
  const result: DayRemainMap = new Map();
  const snaps = await Promise.all([
    getDocs(collection(db, 'days', date, 'items')),
    getDocs(collection(db, 'days', date, 'logistics')),
    ...MACHINES.map((m) => getDocs(collection(db, 'days', date, 'machines', m, 'entries'))),
  ]);
  const itemsSnap = snaps[0];
  const logSnap = snaps[1];
  const machineSnaps = snaps.slice(2);

  // 기기별 실제 생산량 합산 (코드 소문자 키)
  const actual: Record<string, number> = {};
  machineSnaps.forEach((s) =>
    s.forEach((d) => {
      const e = d.data() as MachineEntry;
      const key = String(e.code || '').toLowerCase();
      actual[key] = (actual[key] || 0) + (e.actualProduction || 0) + (e.additionalProduction || 0);
    })
  );

  // 물류 등록수량 (normalize 키)
  const logMap: Record<string, number> = {};
  logSnap.forEach((d) => { logMap[normalize(d.id)] = (d.data().qty as number) || 0; });
  const hasLog = logSnap.size > 0;

  itemsSnap.forEach((d) => {
    const it = d.data() as Item;
    const norm = normalize(it.code);
    if (hasLog) {
      const lq = logMap[norm];
      if (lq === undefined) return;            // 물류 모드: 등록 안 된 품목은 제외
      result.set(norm, { code: it.code, name: it.name || '', remain: lq });
    } else {
      const act = actual[it.code.toLowerCase()] || 0;
      if (act <= 0) return;                    // 생산 안 한 품목 제외
      result.set(norm, { code: it.code, name: it.name || '', remain: act - (it.totalQty || 0) });
    }
  });

  // items 에 없지만 물류엔 있는 코드도 포함
  if (hasLog) {
    logSnap.forEach((d) => {
      const norm = normalize(d.id);
      if (!result.has(norm)) {
        result.set(norm, { code: d.id, name: '', remain: (d.data().qty as number) || 0 });
      }
    });
  }
  return result;
}

interface AnalysisRow {
  code: string;
  name: string;
  cells: (number | null)[];   // 날짜별 잔여량 (없는 날 = null)
  overDays: number;           // 임계 이상 일수
  streak: number;             // 최근(마지막 등장일 기준) 연속 임계 이상
  maxStreak: number;          // 등장일 중 최대 연속 임계 이상
}

export default function RemainAnalysis() {
  const [endDate, setEndDate] = useState(loadViewDate);
  const [rangeDays, setRangeDays] = useState(14);
  const [threshold, setThreshold] = useState(10);
  const [minOverDays, setMinOverDays] = useState(2);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [dayData, setDayData] = useState<DayRemainMap[]>([]);

  useEffect(() => { saveViewDate(endDate); }, [endDate]);
  const today = todayKey();
  const isToday = endDate === today;

  // 끝 날짜(endDate)에서 과거로 rangeDays일 — 오래된→최신 순
  const dates = useMemo(
    () => Array.from({ length: rangeDays }, (_, i) => shiftDateKey(endDate, -(rangeDays - 1 - i))),
    [endDate, rangeDays]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const maps = await Promise.all(dates.map((d) => fetchDayRemainMap(d)));
        if (!cancelled) setDayData(maps);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dates]);

  const rows = useMemo<AnalysisRow[]>(() => {
    const byCode = new Map<string, { code: string; name: string; cells: (number | null)[] }>();
    dayData.forEach((map, di) => {
      map.forEach((v, norm) => {
        if (!byCode.has(norm)) {
          byCode.set(norm, { code: v.code, name: v.name, cells: Array(dates.length).fill(null) });
        }
        const row = byCode.get(norm)!;
        row.cells[di] = v.remain;
        row.code = v.code;
        if (v.name) row.name = v.name;   // 최신 이름 유지
      });
    });

    const arr: AnalysisRow[] = Array.from(byCode.values()).map((r) => {
      const overDays = r.cells.filter((c) => c !== null && c >= threshold).length;
      const appear = r.cells.filter((c) => c !== null) as number[];   // 등장일만 (시간순)
      let streak = 0;
      for (let k = appear.length - 1; k >= 0; k--) {
        if (appear[k] >= threshold) streak++; else break;
      }
      let maxStreak = 0, cur = 0;
      appear.forEach((c) => { if (c >= threshold) { cur++; if (cur > maxStreak) maxStreak = cur; } else cur = 0; });
      return { ...r, overDays, streak, maxStreak };
    });

    // 검색 중이면 임계 필터 무시하고 이름/코드 일치 품목 전부 (잔여 적게 나온 날까지 확인용)
    const q = search.trim().toLowerCase();
    return arr
      .filter((r) => q
        ? (r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
        : r.overDays >= minOverDays)
      .sort((a, b) => b.streak - a.streak || b.overDays - a.overDays || b.maxStreak - a.maxStreak);
  }, [dayData, dates.length, threshold, minOverDays, search]);
  const searching = search.trim().length > 0;

  const fmtHead = (key: string) => {
    const [, m, d] = key.split('-');
    return `${Number(m)}/${Number(d)}`;
  };

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-gray-800">잔여량 분석 <span className="text-rose-600 text-sm font-semibold">— 수율조정 도우미</span></h2>
          <input
            type="date"
            value={endDate}
            onChange={(e) => e.target.value && setEndDate(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
          />
          {!isToday && (
            <button
              onClick={() => setEndDate(today)}
              className="px-3 py-1 text-xs rounded bg-blue-100 text-blue-700 font-medium hover:bg-blue-200"
            >오늘로</button>
          )}
        </div>
        <span className="text-sm text-gray-500">{searching ? '검색결과' : '후보'} <b className="text-rose-600">{rows.length}</b>품목</span>
      </div>

      <p className="text-xs text-gray-500">
        끝 날짜에서 과거로 {rangeDays}일간 같은 품목의 잔여량을 펼칩니다. 임계 {threshold}개 이상이 연속되는 품목이 위로 올라옵니다.
      </p>

      {/* 컨트롤 */}
      <div className="bg-white border rounded-lg px-4 py-3 flex items-center gap-4 flex-wrap text-sm">
        <div className="relative flex-1 min-w-[220px]">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 품목명·코드 검색 (검색하면 임계와 무관하게 매일 잔여량 표시)"
            className="w-full border rounded-md px-3 py-1.5 text-sm"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">×</button>
          )}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="text-gray-600">기간</span>
          <select value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))}
            className="border rounded px-2 py-1 text-sm">
            <option value={7}>7일</option>
            <option value={14}>14일</option>
            <option value={30}>30일</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-gray-600">임계(잔여)</span>
          <input type="number" inputMode="numeric" value={threshold}
            onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 border rounded px-2 py-1 text-sm text-center" />
          <span className="text-gray-400">개 이상</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-gray-600">최소</span>
          <select value={minOverDays} onChange={(e) => setMinOverDays(Number(e.target.value))}
            className="border rounded px-2 py-1 text-sm">
            <option value={1}>1일 이상</option>
            <option value={2}>2일 이상</option>
            <option value={3}>3일 이상</option>
            <option value={4}>4일 이상</option>
          </select>
          <span className="text-gray-400">임계 초과한 품목만</span>
        </label>
      </div>

      {/* 본문 */}
      <div className="bg-white border rounded-lg overflow-auto" style={{ maxHeight: '70vh' }}>
        {loading ? (
          <div className="p-16 text-center text-gray-400 text-sm">최근 {rangeDays}일 데이터 불러오는 중…</div>
        ) : rows.length === 0 ? (
          <div className="p-16 text-center text-gray-400 text-sm">
            {searching
              ? `'${search}' 와 일치하는 품목이 최근 ${rangeDays}일간 생산 기록이 없습니다.`
              : `조건에 맞는 품목이 없습니다 — 최근 ${rangeDays}일간 잔여량 ${threshold}개 이상이 ${minOverDays}일 이상인 품목이 없어요.`}
          </div>
        ) : (
          <table className="w-full border-collapse table-fixed">
            <thead className="sticky top-0 z-10">
              <tr className="bg-gray-100 text-sm text-gray-600">
                <th className="px-3 py-2.5 text-left sticky left-0 bg-gray-100 z-20 w-[200px]">품목</th>
                <th className="px-2 py-2.5 text-center bg-gray-100 w-[70px]">연속</th>
                <th className="px-2 py-2.5 text-center bg-gray-100 w-[64px]">{threshold}↑일</th>
                {dates.map((d) => (
                  <th key={d} className={`px-1 py-2.5 text-center font-semibold whitespace-nowrap ${d === today ? 'bg-rose-100 text-rose-700' : 'bg-gray-100'}`}>
                    {fmtHead(d)}{d === today ? <div className="text-[10px] font-bold">오늘</div> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} className="border-t border-gray-100 hover:bg-slate-50/60">
                  <td className="px-3 py-2.5 sticky left-0 bg-white z-10">
                    <div className="font-semibold text-gray-800 truncate max-w-[190px]">{r.name || r.code}</div>
                    <div className="font-mono text-[11px] text-gray-400">{r.code}</div>
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    {r.streak >= 2 ? (
                      <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white text-sm font-bold">{r.streak}연속</span>
                    ) : (
                      <span className="text-gray-400 text-sm">{r.streak || '-'}</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-center text-base font-bold text-rose-600">{r.overDays}</td>
                  {r.cells.map((c, i) => {
                    if (c === null) {
                      return <td key={i} className="px-1 py-2.5 text-center text-gray-300 bg-gray-50/60 text-lg">·</td>;
                    }
                    const over = c >= threshold;
                    return (
                      <td key={i}
                        className={`px-1 py-2.5 text-center font-bold tabular-nums text-base ${
                          over ? 'bg-red-300 text-red-900'
                          : c > 0 ? 'text-green-700'
                          : c < 0 ? 'text-gray-500'
                          : 'text-blue-500'
                        }`}>
                        {c}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 범례 */}
      <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-4 rounded bg-red-300" /> 잔여 {threshold}개 이상</span>
        <span className="flex items-center gap-1"><span className="text-green-600 font-bold">＋</span> 잔여 있음(임계 미만)</span>
        <span className="flex items-center gap-1"><span className="text-gray-300">·</span> 그날 생산 없음</span>
        <span className="ml-auto">정렬: 최근 연속 → 임계초과 일수 순</span>
      </div>
    </div>
  );
}
