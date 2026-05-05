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

export default function AnalyticsMonthly() {
  const [month, setMonth] = useState(thisMonth());
  const [entries, setEntries] = useState<MachineEntry[]>([]);
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const start = `${month}-01`;
    const end = `${month}-31`;
    Promise.all([
      getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', start), where('date', '<=', end))),
      getDocs(query(collectionGroup(db, 'items'), where('date', '>=', start), where('date', '<=', end))),
    ])
      .then(([entriesSnap, itemsSnap]) => {
        if (cancelled) return;
        setEntries(entriesSnap.docs.map((d) => d.data() as MachineEntry));
        const map = new Map<string, string>();
        itemsSnap.forEach((d) => {
          const it = d.data() as Item;
          if (it.code && it.name) map.set(it.code, it.name);
        });
        setNameMap(map);
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

    const byCode: Record<string, number> = {};
    entries.forEach((e) => {
      byCode[e.code] = (byCode[e.code] || 0) + qty(e);
    });
    const topCodes = Object.entries(byCode)
      .map(([code, total]) => ({ code, name: nameMap.get(code) || '', total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    const maxDayTotal = Math.max(1, ...dayList.map((d) => d.total));

    return { total, daysWorked, avgPerDay, itemsCount: items.size, byMachine, dayList, topCodes, maxDayTotal };
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

      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">일별 생산량</div>
        {stats.dayList.length === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">해당 월에 생산 내역이 없습니다</div>
        ) : (
          <div className="p-4 space-y-1.5">
            {stats.dayList.map((d) => (
              <div key={d.date} className="flex items-center gap-3 text-sm">
                <span className="w-24 font-mono text-xs text-gray-500">{d.date}</span>
                <div className="flex-1 bg-gray-100 rounded h-5 overflow-hidden">
                  <div
                    className="bg-blue-600 h-full"
                    style={{ width: `${(d.total / stats.maxDayTotal) * 100}%` }}
                  />
                </div>
                <span className="w-20 text-right font-bold text-gray-700">{d.total.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">상위 생산 품목 (Top 10)</div>
        {stats.topCodes.length === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">데이터 없음</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">순위</th>
                <th className="px-4 py-2 text-left">코드</th>
                <th className="px-4 py-2 text-left">품목명</th>
                <th className="px-4 py-2 text-right">총 생산량</th>
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
