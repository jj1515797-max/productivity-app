import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, onSnapshot, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import type { GraphData, GraphPoint, Item, RemixEntry } from '../types';
import { compareCode } from '../lib/codeUtil';
import ExcelJS from 'exceljs';

const STAGES: { letter: string; label: string }[] = [
  { letter: 'A', label: '준비기' },
  { letter: 'B', label: '초기' },
  { letter: 'C', label: '중기' },
  { letter: 'D', label: '후기' },
  { letter: 'E', label: '완료기' },
  { letter: 'F', label: '영양밥' },
  { letter: 'F500', label: '한우토핑' },
  { letter: 'G', label: '유아식' },
  { letter: 'H', label: '키즈반찬' },
  { letter: 'I', label: '본죽키즈' },
];

function getStage(code: string): string | null {
  const m = (code || '').match(/^([A-Za-z])(\d+)/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  if (letter === 'F') return parseInt(m[2], 10) >= 500 ? 'F500' : 'F';
  return letter;
}

function normalize(code: string): string {
  return (code || '').toLowerCase().replace(/[-\s]/g, '');
}

function pad(n: number): string { return String(n).padStart(2, '0'); }
function dateStr(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/** 해당 월의 주차들 (월~토 기준, 사용자 엑셀과 동일) */
function getMonthWeeks(year: number, month: number): { idx: number; days: Date[] }[] {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const weeks: { idx: number; days: Date[] }[] = [];
  let cursor = new Date(first);
  // 첫 주: 1일부터 같은 주의 토요일까지
  while (cursor <= last) {
    const week: Date[] = [];
    for (let i = 0; i < 6 && cursor <= last; i++) {
      // 월요일 ~ 토요일만 포함
      const dow = cursor.getDay();
      if (dow !== 0) week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
      if (cursor.getDay() === 1 && week.length > 0) break; // 다음 월요일에 도달하면 주 종료
    }
    if (week.length > 0) weeks.push({ idx: weeks.length + 1, days: week });
  }
  return weeks;
}

function thisYearMonth(): { y: number; m: number } {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}

type ItemMap = Record<string, { totalQty: number; name: string }>;  // code(norm) → {totalQty, name}

export default function Remix() {
  const today = thisYearMonth();
  const [year, setYear] = useState(today.y);
  const [month, setMonth] = useState(today.m);
  const [weekIdx, setWeekIdx] = useState(1);
  const [editingGraph, setEditingGraph] = useState<'remix' | 'surplus' | null>(null);

  // 주차별 데이터
  const weeks = useMemo(() => getMonthWeeks(year, month), [year, month]);
  const currentWeek = weeks[weekIdx - 1] || weeks[0];
  const weekDates = currentWeek?.days || [];
  const weekDateStrs = weekDates.map(dateStr);

  // 주차 단위 fetch (items + logistics + remix)
  const [itemsByDate, setItemsByDate] = useState<Record<string, ItemMap>>({});
  const [logisticsByDate, setLogisticsByDate] = useState<Record<string, Record<string, number>>>({});
  const [remixByDate, setRemixByDate] = useState<Record<string, Record<string, RemixEntry>>>({});
  const [loadingWeek, setLoadingWeek] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (weekDateStrs.length === 0) return;
    let cancelled = false;
    setLoadingWeek(true);
    setItemsByDate({}); setLogisticsByDate({}); setRemixByDate({});

    const itemsP = Promise.all(weekDateStrs.map((d) => getDocs(collection(db, 'days', d, 'items'))));
    const logsP = Promise.all(weekDateStrs.map((d) => getDocs(collection(db, 'days', d, 'logistics'))));
    const remixP = Promise.all(weekDateStrs.map((d) => getDocs(collection(db, 'remix', d, 'items')).catch(() => null)));

    Promise.all([itemsP, logsP, remixP]).then(([itemSnaps, logSnaps, remixSnaps]) => {
      if (cancelled) return;
      const im: Record<string, ItemMap> = {};
      const lm: Record<string, Record<string, number>> = {};
      const rm: Record<string, Record<string, RemixEntry>> = {};
      weekDateStrs.forEach((d, i) => {
        const m1: ItemMap = {};
        itemSnaps[i].forEach((doc) => {
          const it = doc.data() as Item;
          m1[normalize(it.code)] = { totalQty: it.totalQty || 0, name: it.name || '' };
        });
        im[d] = m1;
        const m2: Record<string, number> = {};
        logSnaps[i].forEach((doc) => { m2[normalize(doc.id)] = (doc.data().qty as number) || 0; });
        lm[d] = m2;
        const m3: Record<string, RemixEntry> = {};
        if (remixSnaps[i]) {
          remixSnaps[i]!.forEach((doc) => { m3[normalize(doc.id)] = doc.data() as RemixEntry; });
        }
        rm[d] = m3;
      });
      setItemsByDate(im);
      setLogisticsByDate(lm);
      setRemixByDate(rm);
    }).finally(() => { if (!cancelled) setLoadingWeek(false); });

    return () => { cancelled = true; };
  }, [weekDateStrs.join(','), refreshTick]);

  // 주차 표에 나올 모든 코드 (병합)
  const allCodesWithName = useMemo(() => {
    const map = new Map<string, { code: string; name: string }>();
    Object.values(itemsByDate).forEach((dayMap) => {
      Object.entries(dayMap).forEach(([norm, info]) => {
        if (!map.has(norm)) map.set(norm, { code: norm.toUpperCase(), name: info.name });
      });
    });
    return Array.from(map.entries()).map(([norm, info]) => ({ norm, code: info.code, name: info.name }));
  }, [itemsByDate]);

  // 단계별 그룹 + 코드 정렬
  const grouped = useMemo(() => {
    const map = new Map<string, typeof allCodesWithName>();
    STAGES.forEach((s) => map.set(s.letter, []));
    allCodesWithName.forEach((it) => {
      const stg = getStage(it.code);
      if (!stg) return;
      map.get(stg)?.push(it);
    });
    map.forEach((list) => list.sort((a, b) => compareCode(a.code, b.code)));
    return map;
  }, [allCodesWithName]);

  // 일일/주차 합계
  const dayTotals = useMemo(() => {
    const out: Record<string, { totalQty: number; remaining: number; remixCount: number }> = {};
    weekDateStrs.forEach((d) => {
      let totalQty = 0, remaining = 0, remixCount = 0;
      Object.entries(itemsByDate[d] || {}).forEach(([norm, info]) => {
        totalQty += info.totalQty;
        const log = (logisticsByDate[d] || {})[norm];
        if (log !== undefined) remaining += log;
        else {
          // 자동: actual - planned 의 양수 부분은 알 수 없음 (entries 미수집)
          // 물류 입력 없으면 0
        }
      });
      Object.values(remixByDate[d] || {}).forEach((r) => { remixCount += r.count || 0; });
      out[d] = { totalQty, remaining, remixCount };
    });
    return out;
  }, [itemsByDate, logisticsByDate, remixByDate, weekDateStrs]);

  // 재배합 입력
  const saveRemix = async (date: string, code: string, count: number) => {
    if (count <= 0) {
      await deleteDoc(doc(db, 'remix', date, 'items', code)).catch(() => {});
    } else {
      await setDoc(doc(db, 'remix', date, 'items', code), { code, count, date });
    }
    setRefreshTick((t) => t + 1);
  };

  // ===== 월별 그래프 데이터 =====
  const [remixGraph, setRemixGraph] = useState<GraphData>({});
  const [surplusGraph, setSurplusGraph] = useState<GraphData>({});
  useEffect(() => {
    return onSnapshot(doc(db, 'analyticsGraphs', 'remix'), (s) => setRemixGraph(s.exists() ? (s.data() as GraphData) : {}));
  }, []);
  useEffect(() => {
    return onSnapshot(doc(db, 'analyticsGraphs', 'surplus'), (s) => setSurplusGraph(s.exists() ? (s.data() as GraphData) : {}));
  }, []);

  const saveGraph = async (which: 'remix' | 'surplus', points: GraphPoint[]) => {
    await setDoc(doc(db, 'analyticsGraphs', which), { points });
  };

  // 엑셀 다운로드
  const downloadExcel = async () => {
    if (weekDates.length === 0) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${year}-${pad(month)}-${weekIdx}주`);
    const header1 = ['단계', '코드', '품목명'];
    weekDateStrs.forEach((d) => {
      header1.push(`${d.slice(5)} 지시량`, '잔여량', '재배합');
    });
    ws.addRow(header1);
    STAGES.forEach((s) => {
      const items = grouped.get(s.letter) || [];
      items.forEach((it) => {
        const row: (string | number)[] = [s.label, it.code, it.name];
        weekDateStrs.forEach((d) => {
          const dayItems = itemsByDate[d] || {};
          const totalQty = dayItems[it.norm]?.totalQty || 0;
          const log = (logisticsByDate[d] || {})[it.norm];
          const remix = (remixByDate[d] || {})[it.norm]?.count || 0;
          row.push(totalQty || '', log ?? '', remix || '');
        });
        ws.addRow(row);
      });
    });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `재배합_${year}-${pad(month)}-${weekIdx}주.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 주차별 합계
  const weekTotal = useMemo(() => {
    let qty = 0, rem = 0, rmx = 0, workDays = 0;
    weekDateStrs.forEach((d) => {
      const t = dayTotals[d];
      if (!t) return;
      if (t.totalQty > 0) workDays++;
      qty += t.totalQty;
      rem += t.remaining;
      rmx += t.remixCount;
    });
    const ratio = qty > 0 ? (rem / qty) * 100 : 0;
    const avgRemix = workDays > 0 ? rmx / workDays : 0;
    return { qty, rem, rmx, workDays, ratio, avgRemix };
  }, [dayTotals, weekDateStrs]);

  return (
    <div className="space-y-5">
      {/* 상단 월별 그래프 2개 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MonthlyLineCard
          title="재배합 현황 (월별 평균 건수)"
          unit="건"
          points={remixGraph.points || []}
          color="#1e40af"
          onEdit={() => setEditingGraph('remix')}
        />
        <MonthlyLineCard
          title="잔여량 현황 (월별 %)"
          unit="%"
          points={surplusGraph.points || []}
          color="#dc2626"
          onEdit={() => setEditingGraph('surplus')}
        />
      </div>

      {/* 년/월/주차 네비 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="border rounded px-2 py-1.5 text-sm">
          {[year - 2, year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>
        <select value={month} onChange={(e) => { setMonth(Number(e.target.value)); setWeekIdx(1); }} className="border rounded px-2 py-1.5 text-sm">
          {Array.from({ length: 12 }).map((_, i) => <option key={i + 1} value={i + 1}>{i + 1}월</option>)}
        </select>
        <div className="flex items-center gap-1 ml-2">
          {weeks.map((w) => (
            <button
              key={w.idx}
              onClick={() => setWeekIdx(w.idx)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium ${
                weekIdx === w.idx ? 'bg-slate-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >{w.idx}주차</button>
          ))}
        </div>
        {loadingWeek && <span className="text-xs text-gray-500">불러오는 중...</span>}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">
            주 총 지시 <b>{weekTotal.qty.toLocaleString()}</b> · 잔여 <b className="text-rose-600">{weekTotal.rem.toLocaleString()}</b> ({weekTotal.ratio.toFixed(2)}%) · 재배합 <b>{weekTotal.rmx}건</b>
          </span>
          <button onClick={downloadExcel} className="px-3 py-1.5 bg-blue-900 text-white rounded text-sm font-medium hover:bg-blue-800">엑셀</button>
        </div>
      </div>

      {/* 단계별 그룹 표 */}
      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-gray-600">
            <tr>
              <th rowSpan={2} className="px-2 py-2 text-left border w-20">단계</th>
              <th rowSpan={2} className="px-2 py-2 text-left border w-20">코드</th>
              <th rowSpan={2} className="px-2 py-2 text-left border min-w-[140px]">품목명</th>
              {weekDateStrs.map((d) => (
                <th key={d} colSpan={3} className="px-2 py-1 text-center border bg-blue-50 text-blue-900 font-semibold">
                  {d.slice(5)}
                </th>
              ))}
            </tr>
            <tr>
              {weekDateStrs.map((d) => (
                <>
                  <th key={d + '-q'} className="px-1 py-1 text-right border">지시</th>
                  <th key={d + '-r'} className="px-1 py-1 text-right border">잔여</th>
                  <th key={d + '-m'} className="px-1 py-1 text-right border bg-amber-50">재배합</th>
                </>
              ))}
            </tr>
          </thead>
          <tbody>
            {STAGES.map((s) => {
              const items = grouped.get(s.letter) || [];
              if (items.length === 0) return null;
              return (
                <>
                  <tr key={`hd-${s.letter}`} className="bg-slate-100">
                    <td colSpan={3 + weekDateStrs.length * 3} className="px-3 py-1.5 font-bold text-slate-700 text-sm">
                      {s.label} <span className="text-xs text-gray-500 font-normal">({items.length}품목)</span>
                    </td>
                  </tr>
                  {items.map((it) => (
                    <tr key={`${s.letter}-${it.norm}`} className="border-t hover:bg-slate-50/50">
                      <td className="px-2 py-1 text-gray-500 border">{s.label}</td>
                      <td className="px-2 py-1 font-mono border">{it.code}</td>
                      <td className="px-2 py-1 border">{it.name || '-'}</td>
                      {weekDateStrs.map((d) => {
                        const totalQty = (itemsByDate[d] || {})[it.norm]?.totalQty || 0;
                        const log = (logisticsByDate[d] || {})[it.norm];
                        const remix = (remixByDate[d] || {})[it.norm]?.count || 0;
                        return (
                          <>
                            <td key={d + '-q'} className="px-1 py-0.5 text-right border">{totalQty || ''}</td>
                            <td key={d + '-r'} className={`px-1 py-0.5 text-right border ${log !== undefined ? 'text-rose-600 font-medium' : 'text-gray-300'}`}>
                              {log ?? ''}
                            </td>
                            <td key={d + '-m'} className="px-0 py-0 border bg-amber-50/40">
                              <RemixCell value={remix} onChange={(v) => saveRemix(d, it.code, v)} />
                            </td>
                          </>
                        );
                      })}
                    </tr>
                  ))}
                  {/* 단계 소계 */}
                  <tr className="bg-slate-50 border-t">
                    <td colSpan={3} className="px-2 py-1 text-right text-xs font-semibold text-slate-600">소계</td>
                    {weekDateStrs.map((d) => {
                      let q = 0, r = 0, m = 0;
                      items.forEach((it) => {
                        q += (itemsByDate[d] || {})[it.norm]?.totalQty || 0;
                        const log = (logisticsByDate[d] || {})[it.norm];
                        if (log !== undefined) r += log;
                        m += (remixByDate[d] || {})[it.norm]?.count || 0;
                      });
                      return (
                        <>
                          <td key={d + '-qs'} className="px-1 py-1 text-right border text-xs font-bold">{q || ''}</td>
                          <td key={d + '-rs'} className="px-1 py-1 text-right border text-xs font-bold text-rose-700">{r || ''}</td>
                          <td key={d + '-ms'} className="px-1 py-1 text-right border text-xs font-bold text-amber-700 bg-amber-50">{m || ''}</td>
                        </>
                      );
                    })}
                  </tr>
                </>
              );
            })}
            {/* 일 총계 */}
            <tr className="bg-slate-200 border-t-2 border-slate-400">
              <td colSpan={3} className="px-2 py-1.5 text-right text-sm font-bold text-slate-800">일 총계</td>
              {weekDateStrs.map((d) => {
                const t = dayTotals[d];
                return (
                  <>
                    <td key={d + '-tq'} className="px-1 py-1.5 text-right border text-sm font-bold">{t?.totalQty.toLocaleString() || ''}</td>
                    <td key={d + '-tr'} className="px-1 py-1.5 text-right border text-sm font-bold text-rose-700">{t?.remaining.toLocaleString() || ''}</td>
                    <td key={d + '-tm'} className="px-1 py-1.5 text-right border text-sm font-bold text-amber-700 bg-amber-100">{t?.remixCount || ''}</td>
                  </>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {editingGraph && (
        <GraphEditModal
          title={editingGraph === 'remix' ? '재배합 현황' : '잔여량 현황'}
          unit={editingGraph === 'remix' ? '건' : '%'}
          initial={editingGraph === 'remix' ? remixGraph.points || [] : surplusGraph.points || []}
          onClose={() => setEditingGraph(null)}
          onSave={async (pts) => { await saveGraph(editingGraph, pts); setEditingGraph(null); }}
        />
      )}
    </div>
  );
}

function RemixCell({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [local, setLocal] = useState(String(value || ''));
  useEffect(() => { setLocal(String(value || '')); }, [value]);
  return (
    <input
      type="number"
      inputMode="numeric"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const v = Number(local);
        if (!isNaN(v) && v !== value) onChange(v);
      }}
      className="w-full px-1 py-0.5 text-right text-xs bg-transparent focus:bg-white focus:outline-none focus:ring-1 focus:ring-amber-400"
      placeholder="0"
    />
  );
}

// ===== 월별 라인 그래프 카드 =====
function MonthlyLineCard({
  title, unit, points, color, onEdit,
}: { title: string; unit: string; points: GraphPoint[]; color: string; onEdit: () => void }) {
  const sorted = [...points].sort((a, b) => a.month.localeCompare(b.month));
  const max = sorted.length ? Math.max(...sorted.map((p) => p.value)) : 0;
  const min = 0;
  const range = Math.max(max - min, 0.1);

  const W = 800, H = 220, padL = 40, padR = 20, padT = 24, padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const xFor = (i: number) => padL + (sorted.length > 1 ? (i / (sorted.length - 1)) * innerW : innerW / 2);
  const yFor = (v: number) => padT + innerH - ((v - min) / range) * innerH;

  const path = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.value)}`).join(' ');

  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center">
        <span className="font-semibold text-gray-800 text-sm">{title}</span>
        <button onClick={onEdit} className="ml-auto px-2.5 py-1 text-xs bg-white border rounded hover:bg-gray-100">✎ 데이터 편집</button>
      </div>
      {sorted.length === 0 ? (
        <div className="p-8 text-center text-sm text-gray-400">데이터 없음 — 우측 ✎ 편집으로 입력하세요</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block">
          {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
            const y = padT + innerH * (1 - t);
            const v = (min + range * t);
            return (
              <g key={i}>
                <line x1={padL} y1={y} x2={padL + innerW} y2={y} stroke="#e5e7eb" strokeWidth={1} />
                <text x={padL - 4} y={y + 3} fontSize="10" fill="#9ca3af" textAnchor="end">{v.toFixed(1)}</text>
              </g>
            );
          })}
          <path d={path} fill="none" stroke={color} strokeWidth={2.5} />
          {sorted.map((p, i) => (
            <g key={p.month}>
              <circle cx={xFor(i)} cy={yFor(p.value)} r={4} fill="white" stroke={color} strokeWidth={2} />
              <text x={xFor(i)} y={yFor(p.value) - 8} fontSize="11" fill={color} textAnchor="middle" fontWeight="bold">{p.value.toFixed(1)}{unit}</text>
              <text x={xFor(i)} y={padT + innerH + 16} fontSize="10" fill="#6b7280" textAnchor="middle">{p.month}</text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

// ===== 그래프 편집 모달 =====
function GraphEditModal({
  title, unit, initial, onClose, onSave,
}: { title: string; unit: string; initial: GraphPoint[]; onClose: () => void; onSave: (pts: GraphPoint[]) => Promise<void> }) {
  const [rows, setRows] = useState<GraphPoint[]>(initial.length ? initial : []);
  const [newMonth, setNewMonth] = useState('');
  const [newVal, setNewVal] = useState('');
  const [saving, setSaving] = useState(false);

  const add = () => {
    if (!newMonth.trim() || newVal === '') return;
    const v = Number(newVal);
    if (isNaN(v)) return;
    setRows([...rows, { month: newMonth.trim(), value: v }]);
    setNewMonth(''); setNewVal('');
  };
  const remove = (i: number) => setRows(rows.filter((_, idx) => idx !== i));
  const update = (i: number, k: 'month' | 'value', v: string) => {
    setRows(rows.map((r, idx) => idx === i ? { ...r, [k]: k === 'value' ? Number(v) : v } : r));
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b bg-slate-50 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-800">{title} 데이터 편집</h3>
            <div className="text-xs text-gray-500 mt-0.5">월(YYYY-MM 또는 자유 텍스트) + 값({unit})</div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {rows.length === 0 && <div className="text-sm text-gray-400 text-center py-4">아래에서 추가하세요</div>}
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={r.month} onChange={(e) => update(i, 'month', e.target.value)} className="w-28 border rounded px-2 py-1 text-sm" placeholder="2025-04" />
              <input type="number" step="0.1" value={r.value} onChange={(e) => update(i, 'value', e.target.value)} className="flex-1 border rounded px-2 py-1 text-sm text-right" />
              <span className="text-xs text-gray-500 w-6">{unit}</span>
              <button onClick={() => remove(i)} className="text-red-500 text-xs">×</button>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-2 border-t mt-3">
            <input value={newMonth} onChange={(e) => setNewMonth(e.target.value)} className="w-28 border rounded px-2 py-1 text-sm" placeholder="2025-04" />
            <input type="number" step="0.1" value={newVal} onChange={(e) => setNewVal(e.target.value)} className="flex-1 border rounded px-2 py-1 text-sm text-right" placeholder={`값 (${unit})`} />
            <button onClick={add} className="px-3 py-1 bg-blue-600 text-white rounded text-sm">+</button>
          </div>
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex gap-2">
          <button onClick={onClose} className="px-3 py-2 border rounded text-sm">취소</button>
          <button
            onClick={async () => { setSaving(true); await onSave(rows); setSaving(false); }}
            disabled={saving}
            className="ml-auto px-5 py-2 bg-blue-900 text-white rounded text-sm font-medium"
          >{saving ? '저장중...' : '저장'}</button>
        </div>
      </div>
    </div>
  );
}
