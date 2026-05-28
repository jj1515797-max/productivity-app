import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';

type StageKey = 'bg' | 'ck' | 'fl' | 'pk';
const STAGES: { key: StageKey; label: string; color: string }[] = [
  { key: 'bg', label: '배합',   color: '#3b82f6' },
  { key: 'ck', label: '취반기', color: '#ef4444' },
  { key: 'fl', label: '화구',   color: '#f59e0b' },
  { key: 'pk', label: '내포장', color: '#10b981' },
];
const TOTAL_COLOR = '#6366f1';
const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

interface DayProd {
  date: string;
  pot: number; bat: number; attend: number; leave: number;
  bg_people?: number; bg_start?: string; bg_end?: string;
  ck_people?: number; ck_start?: string; ck_end?: string;
  fl_people?: number; fl_start?: string; fl_end?: string;
  pk_people?: number; pk_start?: string; pk_end?: string;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftDays(s: string, delta: number): string {
  const [y, m, dd] = s.split('-').map(Number);
  return ymd(new Date(y, m - 1, dd + delta));
}
function dowOf(s: string): number {
  const [y, m, dd] = s.split('-').map(Number);
  return new Date(y, m - 1, dd).getDay();
}
function hoursBetween(start?: string, end?: string): number {
  if (!start || !end || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return diff > 0 ? diff / 60 : 0;
}

function computeRow(d: DayProd) {
  const total = (d.pot || 0) + (d.bat || 0);
  const stage = (people?: number, start?: string, end?: string) => {
    const hrs = hoursBetween(start, end);
    if (!people || people <= 0 || hrs <= 0 || total <= 0) return { hrs, prod: 0 };
    return { hrs, prod: Math.round(total / (people * hrs)) };
  };
  const bg = stage(d.bg_people, d.bg_start, d.bg_end);
  const ck = stage(d.ck_people, d.ck_start, d.ck_end);
  const fl = stage(d.fl_people, d.fl_start, d.fl_end);
  const pk = stage(d.pk_people, d.pk_start, d.pk_end);
  const denom = (d.attend || 0) + (d.leave || 0);
  const totalProd = denom > 0 && total > 0 ? Math.round(total / denom) : 0;
  return { total, bg, ck, fl, pk, totalProd };
}

function avg(arr: number[]): number {
  const nz = arr.filter((v) => v > 0);
  if (nz.length === 0) return 0;
  return Math.round(nz.reduce((s, v) => s + v, 0) / nz.length);
}

export default function Productivity() {
  const today = todayKey();
  const monthStart = today.slice(0, 8) + '01';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);

  // 비교 구간 기본: 직전 주 vs 이번 주 (월~금)
  const monStart = (() => {
    const t = new Date();
    const day = t.getDay();
    const diffToMon = (day + 6) % 7; // 0=Mon, 6=Sun
    return ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() - diffToMon));
  })();
  const [aFrom, setAFrom] = useState(shiftDays(monStart, -7));
  const [aTo, setATo] = useState(shiftDays(monStart, -1));
  const [bFrom, setBFrom] = useState(monStart);
  const [bTo, setBTo] = useState(today);

  const [days, setDays] = useState<DayProd[]>([]);
  const [loading, setLoading] = useState(false);

  // 한 번에 from~to + 비교 A·B 까지 포괄해서 fetch (중복 read 회피)
  const fetchFrom = useMemo(() => [from, aFrom, bFrom].sort()[0], [from, aFrom, bFrom]);
  const fetchTo   = useMemo(() => [to,   aTo,   bTo  ].sort().reverse()[0], [to, aTo, bTo]);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    getDocs(query(
      collection(db, 'productivity'),
      where('date', '>=', fetchFrom),
      where('date', '<=', fetchTo),
    )).then((snap) => {
      if (cancel) return;
      const list: DayProd[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          date: d.id,
          pot: Number(data.pot) || 0,
          bat: Number(data.bat) || 0,
          attend: Number(data.attend) || 0,
          leave: Number(data.leave) || 0,
          bg_people: data.bg_people, bg_start: data.bg_start, bg_end: data.bg_end,
          ck_people: data.ck_people, ck_start: data.ck_start, ck_end: data.ck_end,
          fl_people: data.fl_people, fl_start: data.fl_start, fl_end: data.fl_end,
          pk_people: data.pk_people, pk_start: data.pk_start, pk_end: data.pk_end,
        });
      });
      list.sort((a, b) => a.date.localeCompare(b.date));
      setDays(list);
    }).finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [fetchFrom, fetchTo]);

  const inRange = (s: string, e: string) => days.filter((d) => d.date >= s && d.date <= e);
  const rangeDays = useMemo(() => inRange(from, to), [days, from, to]);

  // 요일별 평균 (월~금+일, 토요일 제외)
  const dowAvg = useMemo(() => {
    const buckets: Record<number, { bg: number[]; ck: number[]; fl: number[]; pk: number[]; total: number[] }> = {};
    rangeDays.forEach((d) => {
      const dow = dowOf(d.date);
      if (dow === 6) return; // 토 제외
      const r = computeRow(d);
      if (!buckets[dow]) buckets[dow] = { bg: [], ck: [], fl: [], pk: [], total: [] };
      buckets[dow].bg.push(r.bg.prod);
      buckets[dow].ck.push(r.ck.prod);
      buckets[dow].fl.push(r.fl.prod);
      buckets[dow].pk.push(r.pk.prod);
      buckets[dow].total.push(r.totalProd);
    });
    return [1, 2, 3, 4, 5, 0].map((dow) => ({
      dow,
      label: `${DOW_LABELS[dow]}요일`,
      bg: avg(buckets[dow]?.bg || []),
      ck: avg(buckets[dow]?.ck || []),
      fl: avg(buckets[dow]?.fl || []),
      pk: avg(buckets[dow]?.pk || []),
      total: avg(buckets[dow]?.total || []),
      n: (buckets[dow]?.total || []).filter((v) => v > 0).length,
    }));
  }, [rangeDays]);

  // 비교 A vs B (요일별 평균 비교)
  const compare = useMemo(() => {
    const computeDow = (s: string, e: string) => {
      const list = inRange(s, e);
      const map: Record<number, { bg: number[]; ck: number[]; fl: number[]; pk: number[]; total: number[] }> = {};
      list.forEach((d) => {
        const dow = dowOf(d.date);
        if (dow === 6) return;
        const r = computeRow(d);
        if (!map[dow]) map[dow] = { bg: [], ck: [], fl: [], pk: [], total: [] };
        map[dow].bg.push(r.bg.prod);
        map[dow].ck.push(r.ck.prod);
        map[dow].fl.push(r.fl.prod);
        map[dow].pk.push(r.pk.prod);
        map[dow].total.push(r.totalProd);
      });
      return map;
    };
    const A = computeDow(aFrom, aTo);
    const B = computeDow(bFrom, bTo);
    const rows = [1, 2, 3, 4, 5, 0].map((dow) => {
      const a = {
        bg: avg(A[dow]?.bg || []), ck: avg(A[dow]?.ck || []),
        fl: avg(A[dow]?.fl || []), pk: avg(A[dow]?.pk || []),
        total: avg(A[dow]?.total || []),
      };
      const b = {
        bg: avg(B[dow]?.bg || []), ck: avg(B[dow]?.ck || []),
        fl: avg(B[dow]?.fl || []), pk: avg(B[dow]?.pk || []),
        total: avg(B[dow]?.total || []),
      };
      const diff = (av: number, bv: number) => (av > 0 ? ((bv - av) / av) * 100 : 0);
      return {
        dow, label: `${DOW_LABELS[dow]}요일`,
        a, b,
        dbg: diff(a.bg, b.bg), dck: diff(a.ck, b.ck),
        dfl: diff(a.fl, b.fl), dpk: diff(a.pk, b.pk),
        dtotal: diff(a.total, b.total),
      };
    });
    return rows;
  }, [days, aFrom, aTo, bFrom, bTo]);

  return (
    <div className="space-y-5">
      {/* 날짜 범위 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-gray-800">📊 생산성 분석</span>
        <span className="text-gray-300">|</span>
        <label className="text-xs text-gray-600">기간</label>
        <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="border rounded px-2 py-1 text-sm" />
        <span className="text-gray-400">~</span>
        <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="border rounded px-2 py-1 text-sm" />
        <span className="text-xs text-gray-500 ml-1">{rangeDays.length}일 데이터</span>
        {loading && <span className="text-xs text-blue-600">불러오는 중...</span>}
        <div className="ml-auto flex gap-1.5">
          <button
            onClick={() => { setFrom(today.slice(0, 8) + '01'); setTo(today); }}
            className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50"
          >이번 달</button>
          <button
            onClick={() => {
              const t = new Date();
              setFrom(ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)));
              setTo(ymd(new Date(t.getFullYear(), t.getMonth(), 0)));
            }}
            className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50"
          >지난 달</button>
          <button
            onClick={() => {
              const t = new Date();
              setFrom(ymd(new Date(t.getTime() - 29 * 86400000)));
              setTo(today);
            }}
            className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50"
          >최근 30일</button>
        </div>
      </div>

      {/* 요일별 평균 카드 + 차트 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border rounded-lg p-4">
          <h3 className="font-bold text-gray-800 mb-3">요일별 평균 생산성 <span className="text-xs text-gray-500 font-normal">(토요일 제외)</span></h3>
          <DowBarChart data={dowAvg} />
          <div className="flex items-center gap-4 mt-3 text-xs flex-wrap">
            {STAGES.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-1 rounded" style={{ background: TOTAL_COLOR }} />
              전체
            </span>
          </div>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">요일별 평균표</div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left">요일</th>
                {STAGES.map((s) => (
                  <th key={s.key} className="px-3 py-2 text-right" style={{ color: s.color }}>{s.label}</th>
                ))}
                <th className="px-3 py-2 text-right" style={{ color: TOTAL_COLOR }}>전체</th>
                <th className="px-2 py-2 text-right text-gray-400">N</th>
              </tr>
            </thead>
            <tbody>
              {dowAvg.map((r) => (
                <tr key={r.dow} className="border-t">
                  <td className="px-3 py-1.5 font-semibold">{r.label}</td>
                  <td className="px-3 py-1.5 text-right">{r.bg || '-'}</td>
                  <td className="px-3 py-1.5 text-right">{r.ck || '-'}</td>
                  <td className="px-3 py-1.5 text-right">{r.fl || '-'}</td>
                  <td className="px-3 py-1.5 text-right">{r.pk || '-'}</td>
                  <td className="px-3 py-1.5 text-right font-bold" style={{ color: TOTAL_COLOR }}>{r.total || '-'}</td>
                  <td className="px-2 py-1.5 text-right text-xs text-gray-400">{r.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 비교 구간 */}
      <div className="bg-white border rounded-lg p-4">
        <div className="flex items-center gap-3 flex-wrap mb-3">
          <h3 className="font-bold text-gray-800">📈 구간 비교 (요일별 평균)</h3>
          <span className="text-gray-300">|</span>
          <span className="text-xs font-semibold text-blue-600">A</span>
          <input type="date" value={aFrom} onChange={(e) => e.target.value && setAFrom(e.target.value)} className="border rounded px-2 py-1 text-xs" />
          <span className="text-gray-400">~</span>
          <input type="date" value={aTo} onChange={(e) => e.target.value && setATo(e.target.value)} className="border rounded px-2 py-1 text-xs" />
          <span className="text-xs font-semibold text-red-600 ml-2">B</span>
          <input type="date" value={bFrom} onChange={(e) => e.target.value && setBFrom(e.target.value)} className="border rounded px-2 py-1 text-xs" />
          <span className="text-gray-400">~</span>
          <input type="date" value={bTo} onChange={(e) => e.target.value && setBTo(e.target.value)} className="border rounded px-2 py-1 text-xs" />
        </div>
        <CompareChart rows={compare} />
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-100">
              <tr>
                <th rowSpan={2} className="border px-2 py-1.5">요일</th>
                {STAGES.map((s) => (
                  <th key={s.key} colSpan={3} className="border px-2 py-1.5 text-center" style={{ background: s.color + '20' }}>{s.label}</th>
                ))}
                <th colSpan={3} className="border px-2 py-1.5 text-center" style={{ background: TOTAL_COLOR + '20' }}>전체</th>
              </tr>
              <tr className="bg-slate-50 text-[10px] text-gray-500">
                {STAGES.map((s) => (
                  <>
                    <th key={s.key + 'a'} className="border px-1.5 py-1">A</th>
                    <th key={s.key + 'b'} className="border px-1.5 py-1">B</th>
                    <th key={s.key + 'd'} className="border px-1.5 py-1">증감</th>
                  </>
                ))}
                <th className="border px-1.5 py-1">A</th>
                <th className="border px-1.5 py-1">B</th>
                <th className="border px-1.5 py-1">증감</th>
              </tr>
            </thead>
            <tbody>
              {compare.map((r) => (
                <tr key={r.dow}>
                  <td className="border px-2 py-1 font-semibold">{r.label}</td>
                  {(['bg','ck','fl','pk'] as const).map((k) => {
                    const d = r[`d${k}` as keyof typeof r] as number;
                    return (
                      <>
                        <td key={k+'a'} className="border px-1.5 py-1 text-right">{r.a[k] || '-'}</td>
                        <td key={k+'b'} className="border px-1.5 py-1 text-right">{r.b[k] || '-'}</td>
                        <td key={k+'d'} className={`border px-1.5 py-1 text-right font-semibold ${d > 0 ? 'text-green-600 bg-green-50' : d < 0 ? 'text-red-600 bg-red-50' : 'text-gray-400'}`}>
                          {d ? `${d > 0 ? '+' : ''}${d.toFixed(1)}%` : '-'}
                        </td>
                      </>
                    );
                  })}
                  <td className="border px-1.5 py-1 text-right font-bold">{r.a.total || '-'}</td>
                  <td className="border px-1.5 py-1 text-right font-bold">{r.b.total || '-'}</td>
                  <td className={`border px-1.5 py-1 text-right font-bold ${r.dtotal > 0 ? 'text-green-600 bg-green-50' : r.dtotal < 0 ? 'text-red-600 bg-red-50' : 'text-gray-400'}`}>
                    {r.dtotal ? `${r.dtotal > 0 ? '+' : ''}${r.dtotal.toFixed(1)}%` : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 일별 상세 표 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm flex items-center gap-2">
          <span>📋 일별 상세</span>
          <span className="text-xs text-gray-500 font-normal">{rangeDays.length}일</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-gray-600">
              <tr>
                <th className="border px-2 py-1.5">날짜</th>
                <th className="border px-2 py-1.5">요일</th>
                <th className="border px-2 py-1.5 text-right">냄비</th>
                <th className="border px-2 py-1.5 text-right">바트</th>
                <th className="border px-2 py-1.5 text-right">합계</th>
                {STAGES.map((s) => (
                  <th key={s.key} colSpan={3} className="border px-2 py-1.5 text-center" style={{ background: s.color + '20' }}>{s.label}</th>
                ))}
                <th className="border px-2 py-1.5 text-right">출근</th>
                <th className="border px-2 py-1.5 text-right">연차</th>
                <th className="border px-2 py-1.5 text-right" style={{ color: TOTAL_COLOR }}>전체생산성</th>
              </tr>
              <tr className="bg-slate-100 text-[10px] text-gray-500">
                <th className="border" colSpan={5}></th>
                {STAGES.map((s) => (
                  <>
                    <th key={s.key + 'p'} className="border px-1 py-0.5">인원</th>
                    <th key={s.key + 'h'} className="border px-1 py-0.5">시간</th>
                    <th key={s.key + 'r'} className="border px-1 py-0.5">생산성</th>
                  </>
                ))}
                <th className="border" colSpan={3}></th>
              </tr>
            </thead>
            <tbody>
              {[...rangeDays].reverse().map((d) => {
                const r = computeRow(d);
                const dow = dowOf(d.date);
                const dowLabel = DOW_LABELS[dow];
                const sunRow = dow === 0;
                return (
                  <tr key={d.date} className={sunRow ? 'bg-rose-50' : ''}>
                    <td className="border px-2 py-1 font-mono">{d.date.slice(5)}</td>
                    <td className={`border px-2 py-1 text-center ${dow === 0 ? 'text-red-600' : ''}`}>{dowLabel}</td>
                    <td className="border px-2 py-1 text-right">{d.pot.toLocaleString()}</td>
                    <td className="border px-2 py-1 text-right">{d.bat.toLocaleString()}</td>
                    <td className="border px-2 py-1 text-right font-bold">{r.total.toLocaleString()}</td>
                    {(['bg','ck','fl','pk'] as const).map((k) => {
                      const peopleKey = `${k}_people` as keyof DayProd;
                      const people = d[peopleKey] as number | undefined;
                      const stage = r[k];
                      return (
                        <>
                          <td key={k+'p'} className="border px-1 py-1 text-right">{people || '-'}</td>
                          <td key={k+'h'} className="border px-1 py-1 text-right">{stage.hrs ? stage.hrs.toFixed(1) : '-'}</td>
                          <td key={k+'r'} className="border px-1 py-1 text-right font-semibold">{stage.prod || '-'}</td>
                        </>
                      );
                    })}
                    <td className="border px-2 py-1 text-right">{d.attend || '-'}</td>
                    <td className="border px-2 py-1 text-right">{d.leave || '-'}</td>
                    <td className="border px-2 py-1 text-right font-bold" style={{ color: TOTAL_COLOR }}>{r.totalProd || '-'}</td>
                  </tr>
                );
              })}
              {rangeDays.length === 0 && (
                <tr><td colSpan={17} className="text-center text-gray-400 py-8">이 기간에 입력된 생산성 데이터가 없습니다</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ===== 차트 컴포넌트 ===== */
function DowBarChart({ data }: { data: { label: string; bg: number; ck: number; fl: number; pk: number; total: number }[] }) {
  const W = 580, H = 220, padL = 32, padR = 8, padT = 10, padB = 28;
  const maxVal = Math.max(50, ...data.flatMap((d) => [d.bg, d.ck, d.fl, d.pk, d.total]));
  const niceMax = Math.ceil(maxVal / 100) * 100;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const bandW = innerW / data.length;
  const barW = (bandW - 8) / 4;
  const yFor = (v: number) => padT + innerH - (v / niceMax) * innerH;
  const ticks = 4;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {Array.from({ length: ticks + 1 }, (_, i) => i * (niceMax / ticks)).map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={yFor(v)} y2={yFor(v)} stroke="#eee" />
          <text x={padL - 4} y={yFor(v) + 3} fontSize={9} textAnchor="end" fill="#999">{v}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const xBase = padL + i * bandW + 4;
        return (
          <g key={d.label}>
            <rect x={xBase + barW * 0} y={yFor(d.bg)} width={barW - 1} height={Math.max(0, innerH - (yFor(d.bg) - padT))} fill={STAGES[0].color} />
            <rect x={xBase + barW * 1} y={yFor(d.ck)} width={barW - 1} height={Math.max(0, innerH - (yFor(d.ck) - padT))} fill={STAGES[1].color} />
            <rect x={xBase + barW * 2} y={yFor(d.fl)} width={barW - 1} height={Math.max(0, innerH - (yFor(d.fl) - padT))} fill={STAGES[2].color} />
            <rect x={xBase + barW * 3} y={yFor(d.pk)} width={barW - 1} height={Math.max(0, innerH - (yFor(d.pk) - padT))} fill={STAGES[3].color} />
            <text x={xBase + (bandW - 8) / 2} y={H - 10} fontSize={10} textAnchor="middle" fill="#555">{d.label}</text>
          </g>
        );
      })}
      {/* 전체 line + 라벨 */}
      <polyline
        fill="none"
        stroke={TOTAL_COLOR}
        strokeWidth={2}
        points={data.map((d, i) => `${padL + i * bandW + bandW / 2},${yFor(d.total)}`).join(' ')}
      />
      {data.map((d, i) => (
        <g key={'t' + i}>
          <circle cx={padL + i * bandW + bandW / 2} cy={yFor(d.total)} r={3} fill={TOTAL_COLOR} />
          {d.total > 0 && (
            <text x={padL + i * bandW + bandW / 2} y={yFor(d.total) - 6} fontSize={9} textAnchor="middle" fill={TOTAL_COLOR} fontWeight="bold">{d.total}</text>
          )}
        </g>
      ))}
    </svg>
  );
}

function CompareChart({ rows }: { rows: { label: string; a: { total: number }; b: { total: number }; dtotal: number }[] }) {
  const W = 800, H = 240, padL = 36, padR = 36, padT = 10, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxVal = Math.max(50, ...rows.flatMap((r) => [r.a.total, r.b.total]));
  const niceMax = Math.ceil(maxVal / 100) * 100;
  const maxAbsPct = Math.max(20, ...rows.map((r) => Math.abs(r.dtotal)));
  const bandW = innerW / rows.length;
  const barW = (bandW - 12) / 2;
  const yFor = (v: number) => padT + innerH - (v / niceMax) * innerH;
  const yForPct = (v: number) => padT + innerH / 2 - (v / maxAbsPct) * (innerH / 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {[0, 0.25, 0.5, 0.75, 1].map((p) => (
        <g key={p}>
          <line x1={padL} x2={W - padR} y1={padT + innerH * p} y2={padT + innerH * p} stroke="#eee" />
          <text x={padL - 4} y={padT + innerH * p + 3} fontSize={9} textAnchor="end" fill="#999">{Math.round(niceMax * (1 - p))}</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const xBase = padL + i * bandW + 6;
        return (
          <g key={r.label}>
            <rect x={xBase} y={yFor(r.a.total)} width={barW} height={Math.max(0, innerH - (yFor(r.a.total) - padT))} fill="#3b82f6" />
            <rect x={xBase + barW} y={yFor(r.b.total)} width={barW} height={Math.max(0, innerH - (yFor(r.b.total) - padT))} fill="#ef4444" />
            <text x={xBase + barW / 2} y={yFor(r.a.total) - 4} fontSize={9} textAnchor="middle" fill="#1e40af" fontWeight="bold">{r.a.total || ''}</text>
            <text x={xBase + barW + barW / 2} y={yFor(r.b.total) - 4} fontSize={9} textAnchor="middle" fill="#991b1b" fontWeight="bold">{r.b.total || ''}</text>
            <text x={xBase + barW} y={H - 10} fontSize={10} textAnchor="middle" fill="#555">{r.label}</text>
          </g>
        );
      })}
      {/* 증감율 라인 (오른쪽 축) */}
      <polyline
        fill="none"
        stroke="#f59e0b"
        strokeWidth={2}
        points={rows.map((r, i) => `${padL + i * bandW + bandW / 2},${yForPct(r.dtotal)}`).join(' ')}
      />
      {rows.map((r, i) => (
        <g key={'p' + i}>
          <circle cx={padL + i * bandW + bandW / 2} cy={yForPct(r.dtotal)} r={3} fill="#f59e0b" />
          <text x={padL + i * bandW + bandW / 2} y={yForPct(r.dtotal) - 6} fontSize={9} textAnchor="middle" fill="#b45309" fontWeight="bold">{r.dtotal ? `${r.dtotal > 0 ? '+' : ''}${r.dtotal.toFixed(1)}%` : ''}</text>
        </g>
      ))}
      {/* 우측 축 (%) */}
      {[-1, -0.5, 0, 0.5, 1].map((p) => (
        <text key={p} x={W - padR + 4} y={padT + innerH / 2 - p * (innerH / 2) + 3} fontSize={9} fill="#b45309">{Math.round(maxAbsPct * p)}%</text>
      ))}
      {/* 0% 기준선 */}
      <line x1={padL} x2={W - padR} y1={padT + innerH / 2} y2={padT + innerH / 2} stroke="#fbbf24" strokeDasharray="3,3" />
    </svg>
  );
}
