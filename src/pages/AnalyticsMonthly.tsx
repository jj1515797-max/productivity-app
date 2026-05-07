import { useEffect, useMemo, useState } from 'react';
import { collectionGroup, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import type { AmbientEntry, Item, MachineEntry } from '../types';
import AmbientInputModal from '../components/AmbientInputModal';
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

export default function AnalyticsMonthly() {
  const [month, setMonth] = useState(thisMonth());
  const [entries, setEntries] = useState<MachineEntry[]>([]);
  const [ambient, setAmbient] = useState<AmbientEntry[]>([]);
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map());
  const [prev3Avg, setPrev3Avg] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setPrev3Avg(0);
    const start = `${month}-01`;
    const end = `${month}-31`;
    const qty = (e: MachineEntry) => (e.actualProduction || 0) + (e.additionalProduction || 0);

    Promise.all([
      getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', start), where('date', '<=', end))),
      getDocs(query(collectionGroup(db, 'items'), where('date', '>=', start), where('date', '<=', end))),
      getDocs(query(collectionGroup(db, 'ambient'), where('date', '>=', start), where('date', '<=', end))),
    ])
      .then(([entriesSnap, itemsSnap, ambientSnap]) => {
        if (cancelled) return;
        setEntries(entriesSnap.docs.map((d) => d.data() as MachineEntry));
        const map = new Map<string, string>();
        itemsSnap.forEach((d) => {
          const it = d.data() as Item;
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

    // 직전 3개월 평균은 백그라운드 (냉장+상온 합산)
    const prevMs = prevMonths(month, 3);
    Promise.all(
      prevMs.flatMap((pm) => [
        getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', `${pm}-01`), where('date', '<=', `${pm}-31`))),
        getDocs(query(collectionGroup(db, 'ambient'), where('date', '>=', `${pm}-01`), where('date', '<=', `${pm}-31`))),
      ])
    )
      .then((snaps) => {
        if (cancelled) return;
        const monthAvgs: number[] = [];
        for (let i = 0; i < prevMs.length; i++) {
          const eSnap = snaps[i * 2];
          const aSnap = snaps[i * 2 + 1];
          const ents = eSnap.docs.map((d) => d.data() as MachineEntry);
          const ambs = aSnap.docs.map((d) => d.data() as AmbientEntry);
          const dayMap: Record<string, number> = {};
          ents.forEach((e) => { dayMap[e.date] = (dayMap[e.date] || 0) + qty(e); });
          ambs.forEach((a) => { dayMap[a.date] = (dayMap[a.date] || 0) + (a.qty || 0); });
          const days = Object.keys(dayMap);
          const total = Object.values(dayMap).reduce((s, v) => s + v, 0);
          if (days.length) monthAvgs.push(total / days.length);
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

    // 일별 평균 품목 수: 작업일별 (item code + product name) 합집합
    const itemsByDay: Record<string, Set<string>> = {};
    entries.forEach((e) => {
      if (!itemsByDay[e.date]) itemsByDay[e.date] = new Set();
      itemsByDay[e.date].add(`c:${e.code.toLowerCase()}`);
    });
    ambient.forEach((a) => {
      if (!itemsByDay[a.date]) itemsByDay[a.date] = new Set();
      itemsByDay[a.date].add(`a:${a.productName}`);
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

    return {
      total, coldTotal, ambientTotal,
      daysWorked, coldDays, ambientDays,
      avgPerDay, coldAvg, ambientAvg,
      avgItemsPerDay,
      byMachine, allDays, topCodes,
    };
  }, [entries, ambient, nameMap, month]);

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
        <button
          onClick={() => setModalOpen(true)}
          className="ml-auto px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-md font-medium text-sm shadow-sm flex items-center gap-2"
        >
          <span className="w-2 h-2 rounded-full bg-white" /> 상온 입력
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="총 생산량" value={stats.total.toLocaleString()} unit="EA" color="indigo" sub="냉장 + 상온" />
        <Card label="냉장 생산량" value={stats.coldTotal.toLocaleString()} unit="EA" color="blue" />
        <Card label="상온 생산량" value={stats.ambientTotal.toLocaleString()} unit="EA" color="orange" />
        <Card label="작업일 수" value={stats.daysWorked.toString()} unit="일" color="green" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="일평균 생산량" value={Math.round(stats.avgPerDay).toLocaleString()} unit="EA" color="purple" sub="냉장 + 상온" />
        <Card label="냉장 일평균" value={Math.round(stats.coldAvg).toLocaleString()} unit="EA" color="blue" />
        <Card label="상온 일평균" value={Math.round(stats.ambientAvg).toLocaleString()} unit="EA" color="orange" />
        <Card label="일별 평균 품목 수" value={stats.avgItemsPerDay.toFixed(1)} unit="개" color="rose" />
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">호기별 생산량 (냉장)</div>
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
                  {stats.coldTotal ? `${((row.total / stats.coldTotal) * 100).toFixed(1)}%` : '-'}
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
          <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">상위 생산 품목 (Top 10) · 냉장</div>
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

      <AmbientInputModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
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
                    <rect x={cx - barW / 2} y={yAmb} width={barW} height={hAmb} fill="#f59e0b" rx={2} />
                  )}
                  {ambText && (
                    <g>
                      <rect x={cx - ambTW / 2} y={ambLabelY - 9} width={ambTW} height={16}
                        fill="#fff7ed" fillOpacity={0.95} stroke="#fdba74" strokeWidth={0.6} rx={3} />
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
                  stroke="#dc2626" strokeWidth={2.5} />
                <rect x={padL + innerW + 4} y={prev3LabelY - 11} width={92} height={22}
                  fill="#fef2f2" stroke="#dc2626" rx={2} />
                <text x={padL + innerW + 50} y={prev3LabelY + 4} textAnchor="middle" fontSize="12"
                  fill="#991b1b" fontWeight="bold">
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
              <span className="w-4 h-4 inline-block bg-amber-500 rounded-sm" /> 상온
            </span>
            <span className="flex items-center gap-2">
              <span className="w-6 border-t-[2.5px] border-gray-500 inline-block" /> 일 평균 생산량
            </span>
            <span className="flex items-center gap-2">
              <span className="w-6 border-t-[2.5px] border-red-600 inline-block" /> 직전 3개월 일평균 생산량
            </span>
          </div>
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
