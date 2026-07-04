/** 내포장 분석 — 작업자별/품목별 내포장 실적을 일별·월별로 집계
 *  데이터: days/{date}/scoop/{auto} = { code, name, worker, qty, ts }
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';

interface ScoopRow { code: string; name: string; worker: string; qty: number; ts: number; }

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

async function fetchScoop(date: string): Promise<ScoopRow[]> {
  const snap = await getDocs(collection(db, 'days', date, 'scoop'));
  const list: ScoopRow[] = [];
  snap.forEach((d) => {
    const e = d.data() as any;
    list.push({ code: e.code || '', name: e.name || '', worker: e.worker || '미지정', qty: Number(e.qty) || 0, ts: Number(e.ts) || 0 });
  });
  return list;
}

function datesOfMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

function prevMonthOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

export default function ScoopAnalysis() {
  const [mode, setMode] = useState<'day' | 'month'>('day');
  const [date, setDate] = useState(todayKey());
  const [month, setMonth] = useState(todayKey().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ScoopRow[]>([]);
  const [byDay, setByDay] = useState<{ date: string; qty: number }[]>([]);
  const [prevTotal, setPrevTotal] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        if (mode === 'day') {
          const r = await fetchScoop(date);
          if (!cancelled) { setRows(r); setByDay([]); setPrevTotal(null); }
        } else {
          const dates = datesOfMonth(month);
          const all = await Promise.all(dates.map((d) => fetchScoop(d)));
          // 전월 비교 (합계만)
          const prevAll = await Promise.all(datesOfMonth(prevMonthOf(month)).map((d) => fetchScoop(d)));
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
            setPrevTotal(prevAll.flat().reduce((s, x) => s + x.qty, 0));
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
    const m = new Map<string, { name: string; qty: number; workers: Set<string> }>();
    rows.forEach((r) => {
      const e = m.get(r.code) || { name: r.name, qty: 0, workers: new Set<string>() };
      e.qty += r.qty;
      e.workers.add(r.worker);
      if (r.name) e.name = r.name;
      m.set(r.code, e);
    });
    return Array.from(m.entries()).map(([code, v]) => ({ code, name: v.name, qty: v.qty, workerCount: v.workers.size })).sort((a, b) => b.qty - a.qty);
  }, [rows]);

  // 시간대별 (ts 있는 것만)
  const byHour = useMemo(() => {
    const arr = new Array(24).fill(0);
    rows.forEach((r) => { if (r.ts > 0) arr[new Date(r.ts).getHours()] += r.qty; });
    const hours = arr.map((qty, hour) => ({ hour, qty }));
    const active = hours.filter((h) => h.qty > 0);
    if (active.length === 0) return [];
    const min = active[0].hour, max = active[active.length - 1].hour;
    return hours.slice(min, max + 1);
  }, [rows]);

  // 작업자 × 품목 교차 (품목 행 × 작업자 열)
  const matrix = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    rows.forEach((r) => {
      if (!m.has(r.code)) m.set(r.code, new Map());
      const inner = m.get(r.code)!;
      inner.set(r.worker, (inner.get(r.worker) || 0) + r.qty);
    });
    return m;
  }, [rows]);

  // 요일별 평균 (월별)
  const byWeekday = useMemo(() => {
    const sum = new Array(7).fill(0), cnt = new Array(7).fill(0);
    byDay.forEach((d) => { const w = weekdayOf(d.date); sum[w] += d.qty; cnt[w] += 1; });
    return WEEKDAYS.map((label, w) => ({ label, w, avg: cnt[w] ? Math.round(sum[w] / cnt[w]) : 0, days: cnt[w] }));
  }, [byDay]);

  const daysWorked = byDay.length;
  const maxDay = Math.max(1, ...byDay.map((d) => d.qty));
  const maxWorker = Math.max(1, ...byWorker.map((w) => w.qty));
  const maxHour = Math.max(1, ...byHour.map((h) => h.qty));
  const maxWeekday = Math.max(1, ...byWeekday.map((d) => d.avg));

  const delta = prevTotal !== null ? total - prevTotal : null;
  const deltaPct = prevTotal ? Math.round((delta! / prevTotal) * 100) : null;

  const downloadCsv = () => {
    const esc = (v: string | number) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const workers = byWorker.map((w) => w.worker);
    const header = ['코드', '품목명', ...workers, '합계'];
    const lines = byItem.map((it) => {
      const inner = matrix.get(it.code);
      const cells = workers.map((w) => inner?.get(w) || 0);
      return [it.code, it.name, ...cells, it.qty];
    });
    const totalRow = ['합계', '', ...workers.map((w) => byWorker.find((x) => x.worker === w)?.qty || 0), total];
    const csv = [header, ...lines, totalRow].map((r) => r.map(esc).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `내포장분석_${mode === 'day' ? date : month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
        {total > 0 && (
          <button onClick={downloadCsv} className="ml-auto px-3 py-1.5 text-sm rounded-md bg-blue-900 text-white font-medium hover:bg-blue-800">엑셀 다운로드</button>
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
              {mode === 'month' && delta !== null && (
                <div className={`text-xs mt-0.5 font-bold ${delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-rose-600' : 'text-gray-400'}`}>
                  전월 대비 {delta > 0 ? '+' : ''}{delta.toLocaleString()} ({deltaPct! > 0 ? '+' : ''}{deltaPct}%)
                </div>
              )}
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
          <Card title={`작업자별 ${mode === 'day' ? '오늘' : '이번 달'} 누적`}>
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
          </Card>

          {/* 시간대별 */}
          {byHour.length > 0 && (
            <Card title="시간대별 내포장량 (피크타임)">
              <div className="p-4 flex items-end gap-1.5" style={{ height: 160 }}>
                {byHour.map((h) => (
                  <div key={h.hour} className="flex-1 flex flex-col items-center justify-end gap-1 h-full">
                    <div className="text-[10px] text-gray-500 tabular-nums">{h.qty > 0 ? h.qty.toLocaleString() : ''}</div>
                    <div className={`w-full rounded-t ${h.qty === maxHour ? 'bg-rose-500' : 'bg-cyan-400'}`}
                      style={{ height: `${(h.qty / maxHour) * 100}%`, minHeight: h.qty > 0 ? 3 : 0 }} />
                    <div className="text-[10px] text-gray-400 tabular-nums">{h.hour}시</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 월별: 일자별 추이 */}
          {mode === 'month' && byDay.length > 0 && (
            <Card title="일자별 내포장량">
              <div className="divide-y">
                {byDay.map((d) => (
                  <div key={d.date} className="px-4 py-2 flex items-center gap-3">
                    <div className="w-20 text-sm text-gray-600 tabular-nums">{d.date.slice(5)} <span className="text-gray-400">{WEEKDAYS[weekdayOf(d.date)]}</span></div>
                    <div className="flex-1 h-3.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${(d.qty / maxDay) * 100}%` }} />
                    </div>
                    <div className="w-24 text-right font-bold text-gray-700 tabular-nums">{d.qty.toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 월별: 요일별 평균 */}
          {mode === 'month' && (
            <Card title="요일별 평균 내포장량">
              <div className="p-4 grid grid-cols-7 gap-2">
                {byWeekday.map((d) => (
                  <div key={d.w} className="text-center">
                    <div className={`text-xs font-bold mb-1 ${d.w === 0 ? 'text-rose-500' : d.w === 6 ? 'text-blue-500' : 'text-gray-600'}`}>{d.label}</div>
                    <div className="h-24 flex items-end justify-center">
                      <div className="w-full bg-violet-400 rounded-t" style={{ height: `${(d.avg / maxWeekday) * 100}%`, minHeight: d.avg > 0 ? 3 : 0 }} />
                    </div>
                    <div className="text-xs font-bold text-gray-700 mt-1 tabular-nums">{d.avg.toLocaleString()}</div>
                    <div className="text-[10px] text-gray-400">{d.days}일</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 품목별 (작업인원 포함) */}
          <Card title={`품목별 ${mode === 'day' ? '오늘' : '이번 달'} 누적 (${byItem.length}품목)`}>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left w-24">코드</th>
                  <th className="px-4 py-2 text-left">품목명</th>
                  <th className="px-4 py-2 text-center w-20">작업인원</th>
                  <th className="px-4 py-2 text-right w-32">내포장 수량</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {byItem.map((it) => (
                  <tr key={it.code} className="hover:bg-slate-50/60">
                    <td className="px-4 py-2 font-mono font-bold text-violet-600">{it.code}</td>
                    <td className="px-4 py-2 text-gray-800">{it.name || '-'}</td>
                    <td className="px-4 py-2 text-center text-gray-500">{it.workerCount}명</td>
                    <td className="px-4 py-2 text-right font-bold text-gray-800 tabular-nums">{it.qty.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* 작업자 × 품목 교차표 */}
          <Card title="작업자 × 품목 교차표">
            <div className="overflow-auto" style={{ maxHeight: '60vh' }}>
              <table className="text-sm border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-gray-100 text-xs text-gray-600">
                    <th className="px-3 py-2 text-left sticky left-0 bg-gray-100 z-20 min-w-[160px]">품목</th>
                    {byWorker.map((w) => (
                      <th key={w.worker} className="px-3 py-2 text-right whitespace-nowrap min-w-[70px]">{w.worker}</th>
                    ))}
                    <th className="px-3 py-2 text-right bg-gray-200 min-w-[70px]">합계</th>
                  </tr>
                </thead>
                <tbody>
                  {byItem.map((it) => {
                    const inner = matrix.get(it.code);
                    return (
                      <tr key={it.code} className="border-t border-gray-100 hover:bg-slate-50/60">
                        <td className="px-3 py-1.5 sticky left-0 bg-white z-10">
                          <span className="font-mono font-bold text-violet-600 mr-1">{it.code}</span>
                          <span className="text-gray-700">{it.name}</span>
                        </td>
                        {byWorker.map((w) => {
                          const q = inner?.get(w.worker) || 0;
                          return <td key={w.worker} className={`px-3 py-1.5 text-right tabular-nums ${q > 0 ? 'text-gray-800 font-semibold' : 'text-gray-200'}`}>{q > 0 ? q.toLocaleString() : '·'}</td>;
                        })}
                        <td className="px-3 py-1.5 text-right font-bold text-gray-900 tabular-nums bg-slate-50">{it.qty.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                    <td className="px-3 py-2 sticky left-0 bg-gray-50 z-10">합계</td>
                    {byWorker.map((w) => (
                      <td key={w.worker} className="px-3 py-2 text-right text-violet-700 tabular-nums">{w.qty.toLocaleString()}</td>
                    ))}
                    <td className="px-3 py-2 text-right text-gray-900 tabular-nums bg-gray-100">{total.toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 bg-slate-50 border-b font-bold text-gray-700 text-sm">{title}</div>
      {children}
    </div>
  );
}
