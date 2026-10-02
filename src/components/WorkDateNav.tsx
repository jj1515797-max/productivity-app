/** 날짜 고르기 — 기본은 생산 당일(새벽 2시 기준).
 *  지난/다음 날짜를 볼 수 있고, 켜 둔 채로 생산일이 바뀌면(새벽 2시) 새 날로 넘어간다.
 *  (다른 날짜를 보는 중이어도 날이 바뀌는 순간에만 넘어가고, 1분마다 당일로 끌어오지는 않는다) */
import { useEffect, useRef, useState } from 'react';
import { effectiveTodayKey, shiftDateKey } from '../lib/dateUtil';

export function useWorkDate(): [string, (d: string) => void, string] {
  const [date, setDate] = useState(effectiveTodayKey());
  const [today, setToday] = useState(effectiveTodayKey());
  const lastDay = useRef(today);
  useEffect(() => {
    const t = setInterval(() => {
      const d = effectiveTodayKey();
      if (d !== lastDay.current) { lastDay.current = d; setToday(d); setDate(d); }
    }, 30_000);
    return () => clearInterval(t);
  }, []);
  return [date, setDate, today];
}

export default function WorkDateNav({ date, setDate, today }: { date: string; setDate: (d: string) => void; today: string }) {
  const isToday = date === today;
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => setDate(shiftDateKey(date, -1))} className="px-3 py-1.5 border rounded bg-white text-lg leading-none active:bg-gray-100">◀</button>
      <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)}
        className={`border rounded px-2 py-1.5 font-mono ${isToday ? '' : 'border-orange-400 bg-orange-50'}`} />
      <button onClick={() => setDate(shiftDateKey(date, 1))} className="px-3 py-1.5 border rounded bg-white text-lg leading-none active:bg-gray-100">▶</button>
      {isToday
        ? <span className="text-xs text-blue-600 font-medium">생산 당일</span>
        : <>
            <button onClick={() => setDate(today)} className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white font-medium">오늘로</button>
            <span className="text-xs text-orange-600 font-medium">⚠ {date < today ? '과거' : '미래'} 날짜 보는 중</span>
          </>}
    </div>
  );
}
