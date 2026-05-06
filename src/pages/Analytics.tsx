import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { Item } from '../types';

const MACHINES = ['1호기', '2호기', '3호기'] as const;

const STAGE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const STAGE_COLOR = [
  'bg-blue-500', 'bg-green-500', 'bg-orange-500', 'bg-purple-500',
  'bg-pink-500', 'bg-teal-500', 'bg-amber-500', 'bg-rose-500', 'bg-indigo-500',
];

function shiftDate(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + delta);
  const ny = date.getFullYear();
  const nm = String(date.getMonth() + 1).padStart(2, '0');
  const nd = String(date.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function dateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} (${days[date.getDay()]})`;
}

export default function AnalyticsDaily() {
  const [viewDate, setViewDate] = useState(loadViewDate);
  useEffect(() => { saveViewDate(viewDate); }, [viewDate]);

  const [items, setItems] = useState<Item[]>([]);
  const [machineQty, setMachineQty] = useState<Record<string, Record<string, number>>>({
    '1호기': {}, '2호기': {}, '3호기': {},
  });

  useEffect(() => {
    setItems([]);
    return onSnapshot(collection(db, 'days', viewDate, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      setItems(list);
    });
  }, [viewDate]);

  useEffect(() => {
    setMachineQty({ '1호기': {}, '2호기': {}, '3호기': {} });
    const unsubs = MACHINES.map((m) =>
      onSnapshot(collection(db, 'days', viewDate, 'machines', m, 'entries'), (snap) => {
        const map: Record<string, number> = {};
        snap.forEach((d) => {
          const e = d.data();
          const key = String(e.code || '').toLowerCase();
          const qty = (e.actualProduction || 0) + (e.additionalProduction || 0);
          map[key] = (map[key] || 0) + qty;
        });
        setMachineQty((prev) => ({ ...prev, [m]: map }));
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [viewDate]);

  const actualByCode = useMemo(() => {
    const result: Record<string, number> = {};
    MACHINES.forEach((m) => {
      Object.entries(machineQty[m]).forEach(([code, qty]) => {
        result[code] = (result[code] || 0) + qty;
      });
    });
    return result;
  }, [machineQty]);

  const stats = useMemo(() => {
    const totalActual = items.reduce((s, i) => s + (actualByCode[i.code.toLowerCase()] || 0), 0);
    const itemCount = items.length;
    const remaining = items.reduce((s, i) => {
      const a = actualByCode[i.code.toLowerCase()] || 0;
      const surplus = a - (i.totalQty || 0);
      return s + (surplus > 0 ? surplus : 0);
    }, 0);

    const byStage = STAGE_LETTERS.map((letter, idx) => {
      const stageItems = items.filter((it) => it.code.charAt(0).toUpperCase() === letter);
      const total = stageItems.reduce((sum, it) => sum + (actualByCode[it.code.toLowerCase()] || 0), 0);
      return { letter, color: STAGE_COLOR[idx], total, count: stageItems.length };
    });
    const maxStage = Math.max(1, ...byStage.map((b) => b.total));

    return { totalActual, itemCount, remaining, byStage, maxStage };
  }, [items, actualByCode]);

  return (
    <div className="space-y-5">
      <div className="bg-white border rounded-lg p-3 flex items-center justify-center gap-3 flex-wrap">
        <button
          onClick={() => setViewDate(shiftDate(viewDate, -1))}
          className="w-9 h-9 flex items-center justify-center rounded-full border border-gray-200 hover:bg-gray-50 text-gray-600"
          aria-label="이전 날짜"
        >◀</button>
        <span className="font-semibold text-gray-800 text-base min-w-[180px] text-center">{dateLabel(viewDate)}</span>
        <button
          onClick={() => setViewDate(shiftDate(viewDate, 1))}
          className="w-9 h-9 flex items-center justify-center rounded-full border border-gray-200 hover:bg-gray-50 text-gray-600"
          aria-label="다음 날짜"
        >▶</button>
        <input
          type="date"
          value={viewDate}
          onChange={(e) => e.target.value && setViewDate(e.target.value)}
          className="ml-1 px-2 py-1.5 text-sm border border-gray-200 rounded bg-white hover:bg-gray-50 text-gray-700 cursor-pointer"
        />
        {viewDate !== todayKey() && (
          <button
            onClick={() => setViewDate(todayKey())}
            className="ml-1 text-xs px-2.5 py-1 rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium"
          >오늘로</button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <BigCard label="총 생산(EA)" value={stats.totalActual.toLocaleString()} unit="EA" color="blue" />
        <BigCard label="품목수" value={stats.itemCount.toString()} unit="품목" color="green" />
        <BigCard label="생산성" value="-" unit="" color="orange" />
        <BigCard label="잔여량" value={stats.remaining.toLocaleString()} unit="EA" color="red" />
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">단계별 생산량</div>
        {stats.itemCount === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">선택한 날짜에 생산 데이터가 없습니다</div>
        ) : (
          <div className="p-5 space-y-3">
            {stats.byStage.map((s) => (
              <div key={s.letter} className="flex items-center gap-3">
                <div className="w-14 flex items-center justify-center">
                  <span className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-700 text-sm font-bold">{s.letter}</span>
                </div>
                <div className="flex-1 bg-gray-100 rounded h-7 overflow-hidden">
                  <div
                    className={`${s.color} h-full transition-all`}
                    style={{ width: `${(s.total / stats.maxStage) * 100}%` }}
                  />
                </div>
                <div className="w-36 text-right">
                  <span className="font-bold text-gray-800">{s.total.toLocaleString()}</span>
                  <span className="text-xs text-gray-500 ml-1">EA</span>
                  <span className="text-xs text-gray-400 ml-2">({s.count}품목)</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const colorMap = {
  blue:   { border: 'border-blue-500',   text: 'text-blue-600' },
  green:  { border: 'border-green-500',  text: 'text-green-600' },
  orange: { border: 'border-orange-400', text: 'text-orange-500' },
  red:    { border: 'border-red-400',    text: 'text-red-500' },
};

function BigCard({ label, value, unit, color }: {
  label: string; value: string; unit: string; color: keyof typeof colorMap;
}) {
  const c = colorMap[color];
  return (
    <div className={`bg-white rounded-lg border-t-4 ${c.border} shadow-sm p-5 text-center`}>
      <div className="text-xs text-gray-500 mb-2 font-medium">{label}</div>
      <div className={`text-3xl font-bold ${c.text}`}>{value}</div>
      <div className="text-xs text-gray-400 mt-1">{unit}</div>
    </div>
  );
}
