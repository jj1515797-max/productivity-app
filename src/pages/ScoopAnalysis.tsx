/** 내포장 분석 — 작업자별/품목별 내포장 실적을 일별·월별로 집계
 *  데이터: days/{date}/scoop/{auto} = { code, name, worker, qty, ts }
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';

interface ScoopRow { code: string; name: string; worker: string; qty: number; }

async function fetchScoop(date: string): Promise<ScoopRow[]> {
  const snap = await getDocs(collection(db, 'days', date, 'scoop'));
  const list: ScoopRow[] = [];
  snap.forEach((d) => {
    const e = d.data() as any;
    list.push({ code: e.code || '', name: e.name || '', worker: e.worker || '미지정', qty: Number(e.qty) || 0 });
  });
  return list;
}

function datesOfMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export default function ScoopAnalysis() {
  const [mode, setMode] = useState<'day' | 'month'>('day');
  const [date, setDate] = useState(todayKey());
  const [month, setMonth] = useState(todayKey().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ScoopRow[]>([]);
  const [byDay, setByDay] = useState<{ date: string; qty: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        if (mode === 'day') {
          const r = await fetchScoop(date);
          if (!cancelled) { setRows(r); setByDay([]); }
        } else {
          const dates = datesOfMonth(month);
          const all = await Promise.all(dates.map((d) => fetchScoop(d)));
          if (!cancelled) {
            const flat: ScoopRow[] = [];
            const perDay: { date: string; qty: number }[] = [];
            all.forEach((list, i) => {
              const sum = list.reduce((s, x) => s + x.qty, 0);
              if (sum > 0) perDay.push({ date: dates[i], qty: sum });
              flat.push(...list);
            });
            setRows(flat);
            setByDay(perDay);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, date, month]);

  const total = useMemo(() => rows.reduce((s, x) => s + x.qty, 0), [rows]);

  const byWorker = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r) => m.set(r.worker, (m.get(r.worker) || 0) + r.qty));
    return Array.from(m.entries()).map(([worker, qty]) => ({ worker, qty })).sort((a, b) => b.qty - a.qty);
  }, [rows]);

  const byItem = useMemo(() => {
    const m = new Map<string, { name: string; qty: number }>();
    rows.forEach((r) => {
      const e = m.get(r.code) || { name: r.name, qty: 0 };
      e.qty += r.qty;
      if (r.name) e.name = r.name;
      m.set(r.code, e);
    });
    return Array.from(m.entries()).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.qty - a.qty);
  }, [rows]);

  const daysWorked = byDay.length;
  const maxDay = Math.max(1, ...byDay.map((d) => d.qty));
  const maxWorker = Math.max(1, ...byWorker.map((w) => w.qty));

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">📦 내포장 분석</h2>
        <div className="flex rounded-lg overflow-hidden border">
          <button onClick={() => setMode('day')}
            className={`px-4 py-1.5 text-sm font-bold ${mode === 'day' ? 'bg-violet-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>일별</button>
          <button onClick={() => setMode('month')}
            className={`px-4 py-1.5 text-sm font-bold ${mode === 'month' ? 'bg-violet-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>월별</button>
        </div>
        {mode === 'day' ? (
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)}
            className="border rounded px-2 py-1 text-sm" />
        ) : (
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="border rounded px-2 py-1 text-sm" />
        )}
        {mode === 'day' && date !== todayKey() && (
          <button onClick={() => setDate(todayKey())} className="px-3 py-1 text-xs rounded bg-blue-100 text-blue-700 font-medium hover:bg-blue-200">오늘로</button>
        )}
      </div>

      {loading ? (
        <div className="p-16 text-center text-gray-400 text-sm">불러오는 중…</div>
      ) : total === 0 ? (
        <div className="bg-white border rounded-lg p-12 text-center text-gray-400 text-sm">
          {mode === 'day' ? '이 날짜에 내포장 실적이 없습니다.' : '이 달에 내포장 실적이 없습니다.'}
        </div>
      ) : (
        <>
          {/* KPI */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-violet-50 border border-violet-200 rounded-xl p-4 text-center">
              <div className="text-xs text-violet-700">총 내포장</div>
              <div className="text-3xl font-bold text-violet-800">{total.toLocaleString()}<span className="text-base font-normal text-gray-400 ml-1">개</span></div>
            </div>
            <div className="bg-slate-50 border rounded-xl p-4 text-center">
              <div className="text-xs text-gray-500">작업자</div>
              <div className="text-3xl font-bold text-gray-800">{byWorker.length}<span className="text-base font-normal text-gray-400 ml-1">명</span></div>
            </div>
            <div className="bg-slate-50 border rounded-xl p-4 text-center">
              <div className="text-xs text-gray-500">{mode === 'day' ? '품목' : '작업일수'}</div>
              <div className="text-3xl font-bold text-gray-800">
                {mode === 'day' ? byItem.length : daysWorked}
                <span className="text-base font-normal text-gray-400 ml-1">{mode === 'day' ? '품목' : '일'}</span>
              </div>
              {mode === 'month' && daysWorked > 0 && (
                <div className="text-xs text-gray-500 mt-0.5">일평균 {Math.round(total / daysWorked).toLocaleString()}개</div>
              )}
            </div>
          </div>

          {/* 작업자별 */}
          <div className="bg-white border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b font-bold text-gray-700 text-sm">작업자별 {mode === 'day' ? '오늘' : '이번 달'} 누적</div>
            <div className="divide-y">
              {byWorker.map((w) => (
                <div key={w.worker} className="px-4 py-2.5 flex items-center gap-3">
                  <div className="w-24 font-semibold text-gray-800 truncate">{w.worker}</div>
                  <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-violet-500 rounded-full" style={{ width: `${(w.qty / maxWorker) * 100}%` }} />
                  </div>
                  <div className="w-28 text-right">
                    <span className="font-bold text-violet-700 tabular-nums">{w.qty.toLocaleString()}</span>
                    <span className="text-xs text-gray-400 ml-1">개</span>
                    <span className="text-[11px] text-gray-400 ml-1">({((w.qty / total) * 100).toFixed(0)}%)</span>
                    {mode === 'month' && daysWorked > 0 && (
                      <div className="text-[10px] text-gray-400">일평균 {Math.round(w.qty / daysWorked).toLocaleString()}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 월별: 일자별 추이 */}
          {mode === 'month' && byDay.length > 0 && (
            <div className="bg-white border rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b font-bold text-gray-700 text-sm">일자별 내포장량</div>
              <div className="divide-y">
                {byDay.map((d) => (
                  <div key={d.date} className="px-4 py-2 flex items-center gap-3">
                    <div className="w-16 text-sm text-gray-600 tabular-nums">{d.date.slice(5)}</div>
                    <div className="flex-1 h-3.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${(d.qty / maxDay) * 100}%` }} />
                    </div>
                    <div className="w-24 text-right font-bold text-gray-700 tabular-nums">{d.qty.toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 품목별 */}
          <div className="bg-white border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b font-bold text-gray-700 text-sm">품목별 {mode === 'day' ? '오늘' : '이번 달'} 누적 ({byItem.length}품목)</div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left w-24">코드</th>
                  <th className="px-4 py-2 text-left">품목명</th>
                  <th className="px-4 py-2 text-right w-32">내포장 수량</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {byItem.map((it) => (
                  <tr key={it.code} className="hover:bg-slate-50/60">
                    <td className="px-4 py-2 font-mono font-bold text-violet-600">{it.code}</td>
                    <td className="px-4 py-2 text-gray-800">{it.name || '-'}</td>
                    <td className="px-4 py-2 text-right font-bold text-gray-800 tabular-nums">{it.qty.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
