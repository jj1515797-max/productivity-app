/** 조직도 › 연차검색 — 월(또는 올해) 단위로 사람별 연차·반차 등 사용 횟수와 날짜
 *  기록은 attendance/{날짜}/records/{memberId}. 기간의 날짜마다 한 번씩 읽는다 (월 30회, 올해 최대 365회). */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import type { AttendanceRecord, AttendanceStatus, Member } from '../types';
import { LEAVE_DAY_WEIGHT } from '../types';
import { getStatuses } from '../lib/attendance';

const KINDS: AttendanceStatus[] = ['연차', '반차', '반반차', '결혼반차', '생일반차', '병가', '경조사', '휴무'];
const COLOR: Partial<Record<AttendanceStatus, string>> = {
  연차: 'bg-orange-100 text-orange-800', 반차: 'bg-amber-100 text-amber-800', 반반차: 'bg-yellow-100 text-yellow-800',
  결혼반차: 'bg-pink-100 text-pink-800', 생일반차: 'bg-fuchsia-100 text-fuchsia-800', 병가: 'bg-rose-100 text-rose-800',
  경조사: 'bg-violet-100 text-violet-800', 휴무: 'bg-gray-100 text-gray-600',
};

function datesOf(range: string): string[] {
  // range = 'YYYY-MM' 또는 'YYYY' (올해 1월~이번 달까지)
  const out: string[] = [];
  const now = new Date();
  const [y, m] = range.split('-').map(Number);
  const months = m ? [m] : Array.from({ length: y === now.getFullYear() ? now.getMonth() + 1 : 12 }, (_, i) => i + 1);
  months.forEach((mm) => {
    const last = new Date(y, mm, 0).getDate();
    for (let d = 1; d <= last; d++) {
      const key = `${y}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (new Date(y, mm - 1, d) <= now) out.push(key);
    }
  });
  return out;
}

interface Row {
  id: string; name: string; dept: string;
  count: Partial<Record<AttendanceStatus, number>>;
  days: number;                                   // 연차 환산 일수 (휴무 제외)
  list: { date: string; statuses: AttendanceStatus[] }[];
}

export default function LeaveSearchModal({ members, onClose }: { members: Member[]; onClose: () => void }) {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [mode, setMode] = useState<'month' | 'year'>('month');
  const [month, setMonth] = useState(thisMonth);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [recs, setRecs] = useState<{ date: string; id: string; r: AttendanceRecord }[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const range = mode === 'month' ? month : month.slice(0, 4);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    const dates = datesOf(range);
    Promise.all(dates.map((d) => getDocs(collection(db, 'attendance', d, 'records')).then((s) => ({ d, s }))))
      .then((all) => {
        if (cancel) return;
        const out: { date: string; id: string; r: AttendanceRecord }[] = [];
        all.forEach(({ d, s }) => s.forEach((doc) => out.push({ date: d, id: doc.id, r: doc.data() as AttendanceRecord })));
        setRecs(out);
      })
      .catch(() => { if (!cancel) setRecs([]); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [range]);

  const rows = useMemo(() => {
    const byId = new Map<string, Row>();
    const memberById = new Map(members.map((m) => [m.id, m]));
    const ensure = (id: string, name: string) => {
      let r = byId.get(id);
      if (!r) {
        const m = memberById.get(id);
        r = { id, name: m?.name || name || '(이름 없음)', dept: m?.dept || '', count: {}, days: 0, list: [] };
        byId.set(id, r);
      }
      return r;
    };
    members.forEach((m) => ensure(m.id, m.name));
    recs.forEach(({ date, id, r }) => {
      const st = getStatuses(r).filter((s) => s !== '출근');
      if (st.length === 0) return;
      const row = ensure(id, r.name);
      st.forEach((s) => { row.count[s] = (row.count[s] || 0) + 1; if (s !== '휴무') row.days += LEAVE_DAY_WEIGHT[s] || 0; });
      row.list.push({ date, statuses: st });
    });
    const needle = q.trim().toLowerCase();
    return [...byId.values()]
      .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.dept.toLowerCase().includes(needle))
      .map((r) => ({ ...r, list: r.list.sort((a, b) => a.date.localeCompare(b.date)) }))
      .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
  }, [recs, members, q]);

  const dow = (d: string) => '일월화수목금토'[new Date(d + 'T00:00:00').getDay()];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b flex items-center gap-2 flex-wrap">
          <h3 className="text-lg font-bold text-gray-800">🔎 연차검색</h3>
          <div className="flex rounded border overflow-hidden text-sm ml-2">
            {(['month', 'year'] as const).map((k) => (
              <button key={k} onClick={() => setMode(k)}
                className={`px-3 py-1 ${mode === k ? 'bg-blue-600 text-white' : 'bg-white'}`}>{k === 'month' ? '월별' : '올해 누적'}</button>
            ))}
          </div>
          {mode === 'month'
            ? <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="border rounded px-2 py-1 text-sm" />
            : <select value={month.slice(0, 4)} onChange={(e) => setMonth(`${e.target.value}-01`)} className="border rounded px-2 py-1 text-sm">
                {[now.getFullYear(), now.getFullYear() - 1].map((y) => <option key={y} value={y}>{y}년</option>)}
              </select>}
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 또는 부서"
            className="border rounded px-3 py-1.5 text-sm w-48" />
          {loading && <span className="text-xs text-gray-500">불러오는 중…</span>}
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700 text-xl">✕</button>
        </div>
        <div className="px-5 py-2 text-[11px] text-gray-500 border-b bg-slate-50">
          횟수 = 그 상태로 기록된 날 수 · 환산(일) = 연차 1 · 반차 0.5 · 반반차 0.25 · 결혼/생일반차 0.5 · 병가·경조사 1 (휴무 제외) · 이름을 누르면 날짜가 펼쳐집니다
        </div>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left">이름</th>
                <th className="px-2 py-2 text-left">부서</th>
                {KINDS.map((k) => <th key={k} className="px-2 py-2 text-right whitespace-nowrap">{k}</th>)}
                <th className="px-3 py-2 text-right whitespace-nowrap">환산(일)</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {!loading && rows.length === 0 && <tr><td colSpan={KINDS.length + 3} className="px-3 py-8 text-center text-gray-400">검색 결과가 없습니다</td></tr>}
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr onClick={() => setOpen(open === r.id ? null : r.id)}
                    className={`cursor-pointer hover:bg-blue-50/50 ${r.list.length === 0 ? 'text-gray-400' : ''}`}>
                    <td className="px-3 py-2 font-bold">{r.list.length > 0 && <span className="text-gray-400 mr-1">{open === r.id ? '▾' : '▸'}</span>}{r.name}</td>
                    <td className="px-2 py-2 text-xs text-gray-500">{r.dept}</td>
                    {KINDS.map((k) => <td key={k} className="px-2 py-2 text-right tabular-nums">{r.count[k] ? <b>{r.count[k]}</b> : <span className="text-gray-300">·</span>}</td>)}
                    <td className="px-3 py-2 text-right tabular-nums font-extrabold text-blue-700">{r.days ? r.days.toLocaleString(undefined, { maximumFractionDigits: 2 }) : <span className="text-gray-300 font-normal">0</span>}</td>
                  </tr>
                  {open === r.id && r.list.length > 0 && (
                    <tr>
                      <td colSpan={KINDS.length + 3} className="px-6 py-2 bg-slate-50">
                        <div className="flex flex-wrap gap-1.5">
                          {r.list.map((x) => (
                            <span key={x.date} className={`px-2 py-0.5 rounded text-xs ${COLOR[x.statuses[0]] || 'bg-gray-100'}`}>
                              {x.date.slice(5).replace('-', '/')}({dow(x.date)}) {x.statuses.join('+')}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
