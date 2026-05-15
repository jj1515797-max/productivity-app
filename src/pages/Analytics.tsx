import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { AmbientEntry, AttendanceRecord, Item, Member } from '../types';
import { AMBIENT_CATEGORIES, CATEGORY_STYLES, type AmbientCategory } from '../lib/ambientProducts';
import { summarizeAttendance } from '../lib/attendance';
import ProcessTimeline from '../components/ProcessTimeline';

const MACHINES = ['1호기', '2호기', '3호기'] as const;

const STAGE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'F500', 'G', 'H', 'I'];
const STAGE_COLOR = [
  'bg-blue-500', 'bg-green-500', 'bg-orange-500', 'bg-purple-500',
  'bg-pink-500', 'bg-teal-500', 'bg-cyan-500', 'bg-amber-500', 'bg-rose-500', 'bg-indigo-500',
];

function getStage(code: string): string | null {
  const m = code.match(/^([A-Za-z])(\d+)/);
  if (!m) {
    const c = code.charAt(0).toUpperCase();
    return STAGE_LETTERS.includes(c) ? c : null;
  }
  const letter = m[1].toUpperCase();
  const num = parseInt(m[2], 10);
  if (letter === 'F') return num >= 500 ? 'F500' : 'F';
  return letter;
}

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
  const [ambient, setAmbient] = useState<AmbientEntry[]>([]);
  const [logisticsTotal, setLogisticsTotal] = useState<{ total: number; hasData: boolean; byCode: Record<string, number> }>({ total: 0, hasData: false, byCode: {} });
  const [productivity, setProductivity] = useState<{ attend?: number; leave?: number }>({});
  const [members, setMembers] = useState<Member[]>([]);
  const [attendRecords, setAttendRecords] = useState<Record<string, AttendanceRecord>>({});

  useEffect(() => {
    setItems([]);
    return onSnapshot(collection(db, 'days', viewDate, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      setItems(list);
    });
  }, [viewDate]);

  useEffect(() => {
    setAmbient([]);
    return onSnapshot(collection(db, 'days', viewDate, 'ambient'), (snap) => {
      const list: AmbientEntry[] = [];
      snap.forEach((d) => list.push(d.data() as AmbientEntry));
      setAmbient(list);
    });
  }, [viewDate]);

  useEffect(() => {
    setProductivity({});
    return onSnapshot(doc(db, 'productivity', viewDate), (snap) => {
      setProductivity(snap.exists() ? (snap.data() as { attend?: number; leave?: number }) : {});
    });
  }, [viewDate]);

  // 잔여량 (물류) 구독 — 잔여량 수정 후 즉시 반영
  useEffect(() => {
    setLogisticsTotal({ total: 0, hasData: false, byCode: {} });
    return onSnapshot(collection(db, 'days', viewDate, 'logistics'), (snap) => {
      let total = 0;
      let count = 0;
      const byCode: Record<string, number> = {};
      snap.forEach((d) => {
        const qty = (d.data().qty as number) || 0;
        total += qty;
        count++;
        const norm = (d.id || '').toLowerCase().replace(/[-\s]/g, '');
        byCode[norm] = qty;
      });
      setLogisticsTotal({ total, hasData: count > 0, byCode });
    });
  }, [viewDate]);

  // 인원 마스터는 자주 안 바뀌므로 1회 fetch (생산성 계산용)
  useEffect(() => {
    getDocs(collection(db, 'members')).then((snap) => {
      const list: Member[] = [];
      snap.forEach((d) => {
        const data = d.data() as Member;
        if (data.active !== false) list.push({ ...data, id: d.id });
      });
      setMembers(list);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setAttendRecords({});
    return onSnapshot(collection(db, 'attendance', viewDate, 'records'), (snap) => {
      const map: Record<string, AttendanceRecord> = {};
      snap.forEach((d) => { map[d.id] = d.data() as AttendanceRecord; });
      setAttendRecords(map);
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
    // 냉장 생산: 잔여량 수정값이 있으면 totalQty + logQty (사용자 입력 우선)
    const coldActual = items.reduce((s, i) => {
      const norm = i.code.toLowerCase().replace(/[-\s]/g, '');
      const lq = logisticsTotal.byCode[norm];
      if (lq !== undefined) return s + (i.totalQty || 0) + lq;
      return s + (actualByCode[i.code.toLowerCase()] || 0);
    }, 0);
    const ambientTotal = ambient.reduce((s, a) => s + (a.qty || 0), 0);
    const totalActual = coldActual + ambientTotal;
    const itemCount = items.length;
    // 잔여량: 물류 입력값(잔여량 수정)이 있으면 그 값, 없으면 (실제생산 - 발주량) 자동 계산
    const remaining = logisticsTotal.hasData
      ? logisticsTotal.total
      : items.reduce((s, i) => {
          const a = actualByCode[i.code.toLowerCase()] || 0;
          const surplus = a - (i.totalQty || 0);
          return s + (surplus > 0 ? surplus : 0);
        }, 0);

    const byStage = STAGE_LETTERS.map((letter, idx) => {
      const stageItems = items.filter((it) => getStage(it.code) === letter);
      const total = stageItems.reduce((sum, it) => sum + (actualByCode[it.code.toLowerCase()] || 0), 0);
      return { letter, color: STAGE_COLOR[idx], total, count: stageItems.length };
    });
    const maxStage = Math.max(1, ...byStage.map((b) => b.total));

    // 냉장 발주 총수량 (items.totalQty 합계)
    const coldOrdered = items.reduce((s, i) => s + (i.totalQty || 0), 0);

    // 출근인원 / 연차 (수동 우선, 없으면 조직도 자동 계산)
    const summary = summarizeAttendance(members, attendRecords, viewDate);
    const attend = productivity.attend ?? summary.workforceN;
    const leave = productivity.leave ?? summary.leaveDays;
    const denom = attend + leave;
    const productivityValue = denom > 0 && coldOrdered > 0 ? coldOrdered / denom : null;

    return {
      totalActual, coldActual, ambientTotal, itemCount, remaining, byStage, maxStage,
      coldOrdered, attend, leave, productivityValue,
    };
  }, [items, ambient, actualByCode, members, attendRecords, productivity, viewDate, logisticsTotal]);

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

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <BigCard label="총 생산(EA)" value={stats.totalActual.toLocaleString()} unit="EA" color="indigo" />
        <BigCard label="냉장 생산" value={stats.coldActual.toLocaleString()} unit="EA" color="blue" />
        <BigCard label="상온 생산" value={stats.ambientTotal.toLocaleString()} unit="EA" color="orange" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <BigCard label="품목수" value={stats.itemCount.toString()} unit="품목" color="green" />
        <BigCard
          label="생산성"
          value={stats.productivityValue !== null ? Math.round(stats.productivityValue).toLocaleString() : '-'}
          unit=""
          color="orange"
        />
        <BigCard label="잔여량" value={stats.remaining.toLocaleString()} unit="EA" color="red" />
      </div>

      <ProcessTimeline date={viewDate} />

      {ambient.length > 0 && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b bg-orange-50 font-semibold text-orange-800 flex items-center justify-between flex-wrap gap-2">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-orange-500" />
              상온 생산
            </span>
            <span className="text-xs text-orange-700 font-medium">
              {ambient.length}품목 / 총 {stats.ambientTotal.toLocaleString()} EA
            </span>
          </div>
          <div className="p-4 space-y-4">
            {AMBIENT_CATEGORIES.map((cat) => {
              const list = ambient
                .filter((a) => (a.category as AmbientCategory) === cat)
                .sort((x, y) => (y.qty || 0) - (x.qty || 0));
              if (list.length === 0) return null;
              const style = CATEGORY_STYLES[cat];
              const subtotal = list.reduce((s, a) => s + (a.qty || 0), 0);
              return (
                <div key={cat}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`inline-block w-2.5 h-2.5 rounded-full ${style.chip}`} />
                    <span className="text-xs font-bold text-gray-700">{cat}</span>
                    <span className="text-xs text-gray-400">({list.length})</span>
                    <span className="ml-auto text-xs text-gray-600">
                      소계 <span className="font-bold text-orange-700">{subtotal.toLocaleString()}</span> EA
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {list.map((a) => (
                      <div
                        key={a.productName}
                        className={`px-3 py-2 rounded border ${style.soft} ${style.border} flex items-center justify-between`}
                      >
                        <span className="text-sm text-gray-800 truncate">
                          {a.productName.replace(`${cat}_`, '').replace('순수본_', '')}
                        </span>
                        <span className="text-sm font-bold text-orange-700 ml-3 whitespace-nowrap">
                          {(a.qty || 0).toLocaleString()} <span className="text-[10px] text-gray-500">EA</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">단계별 생산량</div>
        {stats.itemCount === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">선택한 날짜에 생산 데이터가 없습니다</div>
        ) : (
          <div className="p-5 space-y-3">
            {stats.byStage.map((s) => (
              <div key={s.letter} className="flex items-center gap-3">
                <div className="w-14 flex items-center justify-center">
                  <span className="px-2 h-8 min-w-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-700 text-xs font-bold">{s.letter}</span>
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
  indigo: { border: 'border-indigo-500', text: 'text-indigo-700' },
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
