import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import type { AttendanceRecord, Item, Member, ProductSetting } from '../types';
import { summarizeAttendance } from '../lib/attendance';
import { canonicalShort, convertErpCode, normalizeCode } from '../lib/codeUtil';

/* ===== localStorage 캐시 ===== */
const CACHE_PREFIX = 'productivity:';
const TTL_PAST    = 24 * 60 * 60 * 1000; // 과거 월: 24h
const TTL_CURRENT = 5 * 60 * 1000;       // 현재 월: 5분

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
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}
function clearAllProdCache() {
  try {
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
    });
  } catch {}
}

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
function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** 공정별 생산성: 배합/내포장=냄비+바트, 취반기=냄비만, 화구=바트만 */
function computeRow(d: DayProd) {
  const pot = d.pot || 0;
  const bat = d.bat || 0;
  const total = pot + bat;
  const stage = (numerator: number, people?: number, start?: string, end?: string) => {
    const hrs = hoursBetween(start, end);
    if (!people || people <= 0 || hrs <= 0 || numerator <= 0) return { hrs, prod: 0 };
    return { hrs, prod: Math.round(numerator / (people * hrs)) };
  };
  const bg = stage(total, d.bg_people, d.bg_start, d.bg_end);
  const ck = stage(pot,   d.ck_people, d.ck_start, d.ck_end);
  const fl = stage(bat,   d.fl_people, d.fl_start, d.fl_end);
  const pk = stage(total, d.pk_people, d.pk_start, d.pk_end);
  const denom = (d.attend || 0) + (d.leave || 0);
  const totalProd = denom > 0 && total > 0 ? Math.round(total / denom) : 0;
  return { total, pot, bat, bg, ck, fl, pk, totalProd };
}

function avg(arr: number[]): number {
  const nz = arr.filter((v) => v > 0);
  if (nz.length === 0) return 0;
  return Math.round(nz.reduce((s, v) => s + v, 0) / nz.length);
}

export default function Productivity() {
  const today = todayKey();
  const thisMonth = today.slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const { from, to } = useMemo(() => monthBounds(month), [month]);

  // 비교 구간 — 직전 7일 vs 최근 7일
  const [aFrom, setAFrom] = useState(() => {
    const t = new Date();
    return ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 13));
  });
  const [aTo, setATo] = useState(() => {
    const t = new Date();
    return ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 7));
  });
  const [bFrom, setBFrom] = useState(() => {
    const t = new Date();
    return ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 6));
  });
  const [bTo, setBTo] = useState(today);

  const [daysByMonth, setDaysByMonth] = useState<Record<string, DayProd[]>>({});
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [cacheStatus, setCacheStatus] = useState<{ hit: number; miss: number }>({ hit: 0, miss: 0 });

  // 필요한 월들: 선택 월 + A·B 범위 포괄 월
  const neededMonths = useMemo(() => {
    const s = new Set<string>([month]);
    const addRange = (f: string, t: string) => {
      let cur = f.slice(0, 7);
      const last = t.slice(0, 7);
      while (cur <= last) {
        s.add(cur);
        const [y, m] = cur.split('-').map(Number);
        const next = new Date(y, m, 1);
        cur = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
        if (cur > last + '-99') break; // safety
      }
    };
    addRange(aFrom, aTo);
    addRange(bFrom, bTo);
    return Array.from(s).sort();
  }, [month, aFrom, aTo, bFrom, bTo]);

  const days = useMemo(() => {
    const all: DayProd[] = [];
    neededMonths.forEach((m) => {
      const list = daysByMonth[m] || [];
      list.forEach((d) => all.push(d));
    });
    return all;
  }, [daysByMonth, neededMonths]);

  const thisMonthKey = today.slice(0, 7);

  useEffect(() => {
    let cancel = false;

    // 1) 캐시 hit/miss 분류
    const hits: Record<string, DayProd[]> = {};
    const misses: string[] = [];
    neededMonths.forEach((m) => {
      const ttl = m === thisMonthKey ? TTL_CURRENT : TTL_PAST;
      const cached = refreshTick === 0 ? getCache<DayProd[]>(m, ttl) : null;
      if (cached) hits[m] = cached.data;
      else misses.push(m);
    });
    if (Object.keys(hits).length) {
      setDaysByMonth((prev) => ({ ...prev, ...hits }));
    }
    setCacheStatus({ hit: Object.keys(hits).length, miss: misses.length });

    if (misses.length === 0) return;
    setLoading(true);

    // 2) miss 인 월들만 한꺼번에 fetch (월 범위 합치기)
    const fetchFrom = misses.sort()[0] + '-01';
    const lastMissMonth = misses.sort()[misses.length - 1];
    const [ly, lm] = lastMissMonth.split('-').map(Number);
    const lastDay = new Date(ly, lm, 0).getDate();
    const fetchTo = `${lastMissMonth}-${String(lastDay).padStart(2, '0')}`;

    Promise.all([
      getDocs(query(collection(db, 'productivity'),
        where('date', '>=', fetchFrom), where('date', '<=', fetchTo))),
      getDocs(query(collectionGroup(db, 'items'),
        where('date', '>=', fetchFrom), where('date', '<=', fetchTo))),
      getDocs(query(collectionGroup(db, 'records'),
        where('date', '>=', fetchFrom), where('date', '<=', fetchTo))),
      getDocs(collection(db, 'productSettings')),
      getDocs(collection(db, 'members')),
    ]).then(([prodSnap, itemsSnap, recSnap, settingsSnap, memberSnap]) => {
      if (cancel) return;

      const settingsByNorm = new Map<string, ProductSetting>();
      settingsSnap.forEach((d) => {
        const s = d.data() as ProductSetting;
        settingsByNorm.set(normalizeCode(d.id), s);
        settingsByNorm.set(normalizeCode(convertErpCode(d.id)), s);
        settingsByNorm.set(normalizeCode(canonicalShort(d.id)), s);
      });

      const members: Member[] = [];
      memberSnap.forEach((d) => {
        const mm = d.data() as Member;
        if (mm.active !== false) members.push({ ...mm, id: d.id });
      });

      const potBatByDate: Record<string, { pot: number; bat: number }> = {};
      itemsSnap.forEach((d) => {
        const it = d.data() as Item;
        if (!it.date) return;
        const qty = it.totalQty || 0;
        if (qty <= 0) return;
        const s =
          settingsByNorm.get(normalizeCode(it.code)) ||
          settingsByNorm.get(normalizeCode(convertErpCode(it.code))) ||
          settingsByNorm.get(normalizeCode(canonicalShort(it.code)));
        if (!potBatByDate[it.date]) potBatByDate[it.date] = { pot: 0, bat: 0 };
        if (s?.type === '냄비') potBatByDate[it.date].pot += qty;
        else if (s?.type === '바트') potBatByDate[it.date].bat += qty;
      });

      const recsByDate: Record<string, Record<string, AttendanceRecord>> = {};
      recSnap.forEach((d) => {
        const r = d.data() as AttendanceRecord;
        if (!r.date || !r.memberId) return;
        if (!recsByDate[r.date]) recsByDate[r.date] = {};
        recsByDate[r.date][r.memberId] = r;
      });

      const docByDate: Record<string, any> = {};
      prodSnap.forEach((d) => { docByDate[d.id] = d.data(); });

      // 월별로 결과 분리
      const byMonth: Record<string, DayProd[]> = {};
      misses.forEach((m) => { byMonth[m] = []; });
      const allDates = new Set<string>([
        ...Object.keys(potBatByDate),
        ...Object.keys(recsByDate),
        ...Object.keys(docByDate),
      ]);
      allDates.forEach((date) => {
        const mk = date.slice(0, 7);
        if (!misses.includes(mk)) return;
        const doc = docByDate[date] || {};
        const auto = potBatByDate[date] || { pot: 0, bat: 0 };
        const attSummary = summarizeAttendance(members, recsByDate[date] || {}, date);
        byMonth[mk].push({
          date,
          pot: Number(doc.pot ?? auto.pot) || 0,
          bat: Number(doc.bat ?? auto.bat) || 0,
          attend: Number(doc.attend ?? attSummary.presentN) || 0,
          leave: Number(doc.leave ?? attSummary.leaveDays) || 0,
          bg_people: doc.bg_people, bg_start: doc.bg_start, bg_end: doc.bg_end,
          ck_people: doc.ck_people, ck_start: doc.ck_start, ck_end: doc.ck_end,
          fl_people: doc.fl_people, fl_start: doc.fl_start, fl_end: doc.fl_end,
          pk_people: doc.pk_people, pk_start: doc.pk_start, pk_end: doc.pk_end,
        });
      });
      // 각 월 정렬 + 캐시 저장
      Object.entries(byMonth).forEach(([mk, list]) => {
        list.sort((a, b) => a.date.localeCompare(b.date));
        setCache(mk, list);
      });
      setDaysByMonth((prev) => ({ ...prev, ...byMonth }));
    }).finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [neededMonths.join(','), refreshTick, thisMonthKey]);

  /** 빈 날(생산 0 & stage 인원 모두 없음) 또는 토요일은 분석에서 제외 */
  const isMeaningful = (d: DayProd) => {
    if (dowOf(d.date) === 6) return false;
    if ((d.pot || 0) + (d.bat || 0) > 0) return true;
    return !!(d.bg_people || d.ck_people || d.fl_people || d.pk_people);
  };

  const inRange = (s: string, e: string) =>
    days.filter((d) => d.date >= s && d.date <= e && isMeaningful(d));
  const rangeDays = useMemo(() => inRange(from, to), [days, from, to]);

  const dowAvg = useMemo(() => {
    const buckets: Record<number, { bg: number[]; ck: number[]; fl: number[]; pk: number[]; total: number[] }> = {};
    rangeDays.forEach((d) => {
      const dow = dowOf(d.date);
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

  const compare = useMemo(() => {
    const computeDow = (s: string, e: string) => {
      const list = inRange(s, e);
      const map: Record<number, { bg: number[]; ck: number[]; fl: number[]; pk: number[]; total: number[] }> = {};
      list.forEach((d) => {
        const dow = dowOf(d.date);
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
    const diff = (av: number, bv: number) => (av > 0 ? ((bv - av) / av) * 100 : 0);
    return [1, 2, 3, 4, 5, 0].map((dow) => {
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
      return {
        dow, label: `${DOW_LABELS[dow]}요일`, a, b,
        dbg: diff(a.bg, b.bg), dck: diff(a.ck, b.ck),
        dfl: diff(a.fl, b.fl), dpk: diff(a.pk, b.pk),
        dtotal: diff(a.total, b.total),
      };
    });
  }, [days, aFrom, aTo, bFrom, bTo]);

  const shiftMonth = (delta: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  return (
    <div className="space-y-5">
      {/* 월 선택 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-gray-800">📊 생산성 분석</span>
        <span className="text-gray-300">|</span>
        <button onClick={() => shiftMonth(-1)} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">◀</button>
        <input
          type="month"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="border rounded px-2 py-1 text-sm font-bold"
        />
        <button onClick={() => shiftMonth(1)} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">▶</button>
        <span className="text-xs text-gray-500 ml-1">{rangeDays.length}일 데이터</span>
        {loading && <span className="text-xs text-blue-600">불러오는 중...</span>}
        {!loading && cacheStatus.hit > 0 && cacheStatus.miss === 0 && (
          <span className="text-[11px] text-gray-400 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            캐시 사용중
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          <button
            onClick={() => { clearAllProdCache(); setRefreshTick((t) => t + 1); }}
            className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50"
            title="모든 캐시 무시하고 다시 불러오기"
          >🔄</button>
          <button
            onClick={() => setMonth(thisMonth)}
            className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50"
          >이번 달</button>
        </div>
      </div>

      {/* 요일별 평균 차트 + 표 */}
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

      {/* 일별 상세 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm flex items-center gap-2">
          <span>📋 일별 상세 — {month}</span>
          <span className="text-xs text-gray-500 font-normal">{rangeDays.length}일 (의미 있는 날)</span>
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
                    <td className="border px-2 py-1 text-right">{d.pot ? d.pot.toLocaleString() : '-'}</td>
                    <td className="border px-2 py-1 text-right">{d.bat ? d.bat.toLocaleString() : '-'}</td>
                    <td className="border px-2 py-1 text-right font-bold">{r.total ? r.total.toLocaleString() : '-'}</td>
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
                <tr><td colSpan={17} className="text-center text-gray-400 py-8">{loading ? '불러오는 중...' : '데이터가 없습니다 — 조직도→생산성 입력 페이지에서 입력하세요'}</td></tr>
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
  const niceMax = Math.ceil(maxVal / 100) * 100 || 100;
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
          <text x={padL - 4} y={yFor(v) + 3} fontSize={9} textAnchor="end" fill="#999">{Math.round(v)}</text>
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
  const niceMax = Math.ceil(maxVal / 100) * 100 || 100;
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
      {[-1, -0.5, 0, 0.5, 1].map((p) => (
        <text key={p} x={W - padR + 4} y={padT + innerH / 2 - p * (innerH / 2) + 3} fontSize={9} fill="#b45309">{Math.round(maxAbsPct * p)}%</text>
      ))}
      <line x1={padL} x2={W - padR} y1={padT + innerH / 2} y2={padT + innerH / 2} stroke="#fbbf24" strokeDasharray="3,3" />
    </svg>
  );
}
