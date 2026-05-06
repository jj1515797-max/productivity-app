import { useEffect, useMemo, useState } from 'react';
import { collectionGroup, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import type { Item, MachineEntry } from '../types';

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

export default function AnalyticsMonthly() {
  const [month, setMonth] = useState(thisMonth());
  const [entries, setEntries] = useState<MachineEntry[]>([]);
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map());
  const [prev3Avg, setPrev3Avg] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const start = `${month}-01`;
    const end = `${month}-31`;
    const qty = (e: MachineEntry) => (e.actualProduction || 0) + (e.additionalProduction || 0);

    const prevMs = prevMonths(month, 3);
    const prevQueries = prevMs.map((pm) =>
      getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', `${pm}-01`), where('date', '<=', `${pm}-31`)))
    );

    Promise.all([
      getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', start), where('date', '<=', end))),
      getDocs(query(collectionGroup(db, 'items'), where('date', '>=', start), where('date', '<=', end))),
      ...prevQueries,
    ])
      .then(([entriesSnap, itemsSnap, ...prevSnaps]) => {
        if (cancelled) return;
        setEntries(entriesSnap.docs.map((d) => d.data() as MachineEntry));
        const map = new Map<string, string>();
        itemsSnap.forEach((d) => {
          const it = d.data() as Item;
          if (it.code && it.name) map.set(it.code.toLowerCase(), it.name);
        });
        setNameMap(map);

        const monthAvgs = prevSnaps.map((snap) => {
          const ents = snap.docs.map((d) => d.data() as MachineEntry);
          const days = new Set(ents.map((e) => e.date));
          const total = ents.reduce((s, e) => s + qty(e), 0);
          return days.size ? total / days.size : 0;
        }).filter((a) => a > 0);
        setPrev3Avg(monthAvgs.length ? monthAvgs.reduce((s, a) => s + a, 0) / monthAvgs.length : 0);
      })
      .catch((e) => {
        if (!cancelled) setErr(e.message || String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  const stats = useMemo(() => {
    const qty = (e: MachineEntry) => (e.actualProduction || 0) + (e.additionalProduction || 0);
    const total = entries.reduce((s, e) => s + qty(e), 0);
    const days = new Set(entries.map((e) => e.date));
    const daysWorked = days.size;
    const avgPerDay = daysWorked ? total / daysWorked : 0;
    const items = new Set(entries.map((e) => e.code));

    const byMachine = MACHINES.map((m) => ({
      machine: m,
      total: entries.filter((e) => e.machine === m).reduce((s, e) => s + qty(e), 0),
      count: entries.filter((e) => e.machine === m).length,
    }));

    const byDay: Record<string, number> = {};
    entries.forEach((e) => {
      byDay[e.date] = (byDay[e.date] || 0) + qty(e);
    });
    const dayList = Object.entries(byDay)
      .map(([date, total]) => ({ date, total }))
      .sort((a, b) => a.date.localeCompare(b.date));

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
        total: byDay[dateStr] || 0,
        dow,
        isSunday: dow === 0,
      };
    }).filter((d) => d.dow !== 6); // 토요일 제외

    const byCode: Record<string, number> = {};
    entries.forEach((e) => {
      byCode[e.code] = (byCode[e.code] || 0) + qty(e);
    });
    const topCodes = Object.entries(byCode)
      .map(([code, total]) => ({ code, name: nameMap.get(code.toLowerCase()) || '', total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    const maxDayTotal = Math.max(1, ...dayList.map((d) => d.total));

    return { total, daysWorked, avgPerDay, itemsCount: items.size, byMachine, dayList, allDays, topCodes, maxDayTotal };
  }, [entries, nameMap]);

  const shiftMonth = (delta: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  const monthLabel = `${month.split('-')[0]}년 ${Number(month.split('-')[1])}월`;

  return (
    <div className="space-y-5">
      <div className="bg-white border rounded-lg p-4 flex items-center justify-center gap-4">
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
          className="border rounded px-2 py-1 text-sm ml-3"
        />
        {loading && <span className="text-sm text-gray-500">불러오는 중...</span>}
        {err && <span className="text-sm text-red-500">에러: {err}</span>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="총 생산량" value={stats.total.toLocaleString()} unit="EA" color="blue" />
        <Card label="작업일 수" value={stats.daysWorked.toString()} unit="일" color="green" />
        <Card label="일평균 생산량" value={Math.round(stats.avgPerDay).toLocaleString()} unit="EA" color="purple" />
        <Card label="생산 품목 수" value={stats.itemsCount.toString()} unit="개" color="orange" />
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">호기별 생산량</div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">호기</th>
              <th className="px-4 py-2 text-right">총 생산량</th>
              <th className="px-4 py-2 text-right">입력 건수</th>
              <th className="px-4 py-2 text-right">비율</th>
            </tr>
          </thead>
          <tbody>
            {stats.byMachine.map((row) => (
              <tr key={row.machine} className="border-t">
                <td className="px-4 py-2 font-medium">{row.machine}</td>
                <td className="px-4 py-2 text-right font-bold">{row.total.toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-gray-600">{row.count}</td>
                <td className="px-4 py-2 text-right text-gray-600">
                  {stats.total ? `${((row.total / stats.total) * 100).toFixed(1)}%` : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DailyChart
        monthLabel={monthLabel}
        days={stats.allDays}
        avg={stats.avgPerDay}
        prev3Avg={prev3Avg}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">상위 생산 품목 (Top 10)</div>
          {stats.topCodes.length === 0 ? (
            <div className="p-12 text-center text-gray-400 text-sm">데이터 없음</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left w-12">순위</th>
                  <th className="px-4 py-2 text-left w-20">코드</th>
                  <th className="px-4 py-2 text-left">품목명</th>
                  <th className="px-4 py-2 text-right w-28">총 생산량</th>
                </tr>
              </thead>
              <tbody>
                {stats.topCodes.map((row, i) => (
                  <tr key={row.code} className="border-t">
                    <td className="px-4 py-2 font-bold text-gray-500">{i + 1}</td>
                    <td className="px-4 py-2 font-mono">{row.code}</td>
                    <td className="px-4 py-2">{row.name || '-'}</td>
                    <td className="px-4 py-2 text-right font-bold">{row.total.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="hidden lg:block" />
      </div>
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
  days: { day: number; label: string; total: number; isSunday: boolean }[];
  avg: number;
  prev3Avg: number;
}) {
  const maxRaw = Math.max(avg, prev3Avg, ...days.map((d) => d.total));
  const { max: yMax, step: tickStep } = niceScale(maxRaw * 1.15);
  const tickCount = Math.round(yMax / tickStep);

  const padL = 80, padR = 110, padT = 50, padB = 60;
  const innerW = Math.max(1100, days.length * 42);
  const innerH = 520;
  const W = padL + innerW + padR;
  const H = padT + innerH + padB;

  const bandW = innerW / days.length;
  const barW = Math.min(32, bandW * 0.7);
  const yFor = (v: number) => padT + innerH - (v / yMax) * innerH;

  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">
        {monthLabel} 일별 생산량
      </div>
      {days.every((d) => d.total === 0) ? (
        <div className="p-12 text-center text-gray-400 text-sm">해당 월에 생산 내역이 없습니다</div>
      ) : (
        <div className="p-4 overflow-x-auto">
          <svg width={W} height={H} className="min-w-full">
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
              if (d.total <= 0) return null;
              const cx = padL + bandW * i + bandW / 2;
              const y = yFor(d.total);
              const h = padT + innerH - y;
              return (
                <g key={`bar-${d.day}`}>
                  <rect x={cx - barW / 2} y={y} width={barW} height={h} fill="#2563eb" rx={2} />
                  <text x={cx} y={y - 6} textAnchor="middle" fontSize="11" fill="#1f2937" fontWeight="bold">
                    {d.total.toLocaleString()}
                  </text>
                </g>
              );
            })}

            {avg > 0 && (
              <g>
                <line x1={padL} y1={yFor(avg)} x2={padL + innerW} y2={yFor(avg)}
                  stroke="#6b7280" strokeWidth={2.5} />
                <rect x={padL + innerW + 4} y={yFor(avg) - 11} width={92} height={22} fill="#f3f4f6" stroke="#9ca3af" rx={2} />
                <text x={padL + innerW + 50} y={yFor(avg) + 4} textAnchor="middle" fontSize="12"
                  fill="#374151" fontWeight="bold">
                  {Math.round(avg).toLocaleString()}
                </text>
              </g>
            )}
            {prev3Avg > 0 && (
              <g>
                <line x1={padL} y1={yFor(prev3Avg)} x2={padL + innerW} y2={yFor(prev3Avg)}
                  stroke="#f59e0b" strokeWidth={2.5} />
                <rect x={padL + innerW + 4} y={yFor(prev3Avg) - 11} width={92} height={22} fill="#fffbeb" stroke="#f59e0b" rx={2} />
                <text x={padL + innerW + 50} y={yFor(prev3Avg) + 4} textAnchor="middle" fontSize="12"
                  fill="#b45309" fontWeight="bold">
                  {Math.round(prev3Avg).toLocaleString()}
                </text>
              </g>
            )}

            <line x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} stroke="#9ca3af" />
            <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="#9ca3af" />
          </svg>

          <div className="flex items-center justify-center gap-6 mt-4 text-sm text-gray-700 flex-wrap">
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 inline-block bg-blue-600 rounded-sm" /> 생산량
            </span>
            <span className="flex items-center gap-2">
              <span className="w-6 border-t-[2.5px] border-gray-500 inline-block" /> 일 평균 생산량
            </span>
            <span className="flex items-center gap-2">
              <span className="w-6 border-t-[2.5px] border-amber-500 inline-block" /> 직전 3개월 일평균 생산량
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({
  label, value, unit, color,
}: { label: string; value: string; unit: string; color: 'blue' | 'green' | 'purple' | 'orange' }) {
  const colors = {
    blue: 'border-blue-500 text-blue-700',
    green: 'border-green-500 text-green-700',
    purple: 'border-purple-500 text-purple-700',
    orange: 'border-orange-500 text-orange-700',
  };
  return (
    <div className={`bg-white border-l-4 ${colors[color]} rounded-lg shadow-sm p-4`}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl font-bold ${colors[color]}`}>{value}</span>
        <span className="text-xs text-gray-500">{unit}</span>
      </div>
    </div>
  );
}
