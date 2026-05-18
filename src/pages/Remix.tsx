import { Fragment, useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, onSnapshot, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import type { GraphData, GraphPoint, Item, ProductSetting, RemixEntry } from '../types';
import { compareCode, convertErpCode, normalizeCode } from '../lib/codeUtil';
import ExcelJS from 'exceljs';

const STAGES: { key: string; label: string }[] = [
  { key: 'A', label: '준비기' },
  { key: 'B', label: '초기' },
  { key: 'C', label: '중기' },
  { key: 'D', label: '후기' },
  { key: 'E', label: '완료기' },
  { key: 'G', label: '영양밥' },
  { key: 'G_SAUCE', label: '소스' },
  { key: 'H', label: '토핑' },
  { key: 'F', label: '유아식' },
  { key: 'I', label: '본죽키즈' },
];

function getStage(code: string): string | null {
  const m = (code || '').match(/^([A-Za-z])(\d+)/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const num = parseInt(m[2], 10);
  if (letter === 'G') return (num >= 101 && num <= 132) ? 'G_SAUCE' : 'G';
  if ('ABCDEFHI'.includes(letter)) return letter;
  return null;
}

function pad(n: number): string { return String(n).padStart(2, '0'); }
function dateStr(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/** 해당 월의 주차들 (일~금 6일, Sunday 시작. Sunday가 속한 달이 그 주의 달) */
function getMonthWeeks(year: number, month: number): { idx: number; days: Date[] }[] {
  const result: { idx: number; days: Date[] }[] = [];
  // 그 달의 1일을 포함하는 일요일 찾기
  let sunday = new Date(year, month - 1, 1);
  sunday.setDate(sunday.getDate() - sunday.getDay()); // 직전 일요일

  let idx = 0;
  while (true) {
    const sm = sunday.getMonth() + 1;
    const sy = sunday.getFullYear();
    if (sy > year || (sy === year && sm > month)) break;
    if (sy === year && sm === month) {
      idx++;
      const days: Date[] = [];
      for (let i = 0; i < 6; i++) {
        const d = new Date(sunday);
        d.setDate(sunday.getDate() + i);
        days.push(d);
      }
      result.push({ idx, days });
    }
    sunday.setDate(sunday.getDate() + 7);
  }
  return result;
}

function thisYearMonth(): { y: number; m: number } {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}

type ItemMap = Record<string, { totalQty: number; name: string }>;  // code(norm) → {totalQty, name}

export default function Remix() {
  const today = thisYearMonth();
  const [view, setView] = useState<'daily' | 'monthly'>('daily');
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
          m1[normalizeCode(it.code)] = { totalQty: it.totalQty || 0, name: it.name || '' };
        });
        im[d] = m1;
        const m2: Record<string, number> = {};
        logSnaps[i].forEach((doc) => { m2[normalizeCode(doc.id)] = (doc.data().qty as number) || 0; });
        lm[d] = m2;
        const m3: Record<string, RemixEntry> = {};
        if (remixSnaps[i]) {
          remixSnaps[i]!.forEach((doc) => { m3[normalizeCode(doc.id)] = doc.data() as RemixEntry; });
        }
        rm[d] = m3;
      });
      setItemsByDate(im);
      setLogisticsByDate(lm);
      setRemixByDate(rm);
    }).finally(() => { if (!cancelled) setLoadingWeek(false); });

    return () => { cancelled = true; };
  }, [weekDateStrs.join(','), refreshTick]);

  // 제품 DB 마스터 (한 번 로드)
  const [productList, setProductList] = useState<{ norm: string; code: string; name: string }[]>([]);
  useEffect(() => {
    getDocs(collection(db, 'productSettings')).then((snap) => {
      const list: { norm: string; code: string; name: string }[] = [];
      snap.forEach((d) => {
        const s = d.data() as ProductSetting;
        const shortCode = convertErpCode(s.code || d.id);
        list.push({ norm: normalizeCode(shortCode), code: shortCode, name: s.name || '' });
      });
      setProductList(list);
    }).catch(() => {});
  }, []);

  // 마스터 + 이번 주 등장 코드 병합 — 전 품목 항상 표시
  const allCodesWithName = useMemo(() => {
    const map = new Map<string, { code: string; name: string }>();
    productList.forEach((p) => map.set(p.norm, { code: p.code, name: p.name }));
    Object.values(itemsByDate).forEach((dayMap) => {
      Object.entries(dayMap).forEach(([norm, info]) => {
        if (!map.has(norm)) map.set(norm, { code: norm.toUpperCase(), name: info.name });
        else if (info.name && !map.get(norm)!.name) map.set(norm, { code: map.get(norm)!.code, name: info.name });
      });
    });
    return Array.from(map.entries()).map(([norm, info]) => ({ norm, code: info.code, name: info.name }));
  }, [productList, itemsByDate]);

  // 단계별 그룹 + 코드 정렬
  const grouped = useMemo(() => {
    const map = new Map<string, typeof allCodesWithName>();
    STAGES.forEach((s) => map.set(s.key, []));
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
      const items = grouped.get(s.key) || [];
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
    // 잔여율 = 잔여량 / (지시량 + 잔여량) — 실제 생산량 대비 잔여율
    const denom = qty + rem;
    const ratio = denom > 0 ? (rem / denom) * 100 : 0;
    const avgRemix = workDays > 0 ? rmx / workDays : 0;
    return { qty, rem, rmx, workDays, ratio, avgRemix };
  }, [dayTotals, weekDateStrs]);

  if (view === 'monthly') {
    return (
      <div className="space-y-5">
        <ViewToggle view={view} onChange={setView} />
        <MonthlyView
          year={year}
          onYearChange={setYear}
          remixGraph={remixGraph}
          surplusGraph={surplusGraph}
          onEditRemix={() => setEditingGraph('remix')}
          onEditSurplus={() => setEditingGraph('surplus')}
        />
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

  return (
    <div className="space-y-5">
      <ViewToggle view={view} onChange={setView} />

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
        <button onClick={downloadExcel} className="ml-auto px-3 py-1.5 bg-blue-900 text-white rounded text-sm font-medium hover:bg-blue-800">엑셀 다운로드</button>
      </div>

      {/* 주차 합계 큼지막한 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="주 총 지시량" value={weekTotal.qty.toLocaleString()} unit="EA" tone="blue" />
        <SummaryCard label="주 잔여량 합계" value={weekTotal.rem.toLocaleString()} unit="EA" tone="rose" />
        <SummaryCard label="주 잔여율" value={weekTotal.ratio.toFixed(2)} unit="%" tone="rose" />
        <SummaryCard label="주 재배합" value={String(weekTotal.rmx)} unit="건" tone="amber" sub={weekTotal.workDays > 0 ? `일평균 ${weekTotal.avgRemix.toFixed(1)}건` : undefined} />
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
                <Fragment key={d + '-hdr'}>
                  <th className="px-1 py-1 text-right border border-l-2 border-l-slate-400">지시</th>
                  <th className="px-1 py-1 text-right border">잔여</th>
                  <th className="px-1 py-1 text-right border bg-amber-50">재배합</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 일 총계 (맨 위) */}
            <tr className="bg-slate-200 border-y-2 border-slate-400 sticky top-0">
              <td colSpan={3} className="px-2 py-2 text-right text-sm font-bold text-slate-800 bg-slate-200">일 총계</td>
              {weekDateStrs.map((d) => {
                const t = dayTotals[d];
                return (
                  <Fragment key={d + '-top'}>
                    <td className="px-1 py-2 text-right border-x text-sm font-bold">{t?.totalQty.toLocaleString() || ''}</td>
                    <td className="px-1 py-2 text-right border-x text-sm font-bold text-rose-700">{t?.remaining.toLocaleString() || ''}</td>
                    <td className="px-1 py-2 text-right border-x text-sm font-bold text-amber-700 bg-amber-100">{t?.remixCount || ''}</td>
                  </Fragment>
                );
              })}
            </tr>
            {STAGES.map((s) => {
              const items = grouped.get(s.key) || [];
              if (items.length === 0) return null;
              return (
                <Fragment key={`stg-${s.key}`}>
                  <tr key={`hd-${s.key}`} className="bg-slate-100">
                    <td colSpan={3 + weekDateStrs.length * 3} className="px-3 py-1.5 font-bold text-slate-700 text-sm">
                      {s.label} <span className="text-xs text-gray-500 font-normal">({items.length}품목)</span>
                    </td>
                  </tr>
                  {items.map((it) => (
                    <tr key={`${s.key}-${it.norm}`} className="border-t hover:bg-slate-50/50">
                      <td className="px-2 py-1 text-gray-500 border">{s.label}</td>
                      <td className="px-2 py-1 font-mono border">{it.code}</td>
                      <td className="px-2 py-1 border">{it.name || '-'}</td>
                      {weekDateStrs.map((d) => {
                        const totalQty = (itemsByDate[d] || {})[it.norm]?.totalQty || 0;
                        const log = (logisticsByDate[d] || {})[it.norm];
                        const remix = (remixByDate[d] || {})[it.norm]?.count || 0;
                        return (
                          <Fragment key={d + '-c'}>
                            <td className="px-1 py-0.5 text-right border">{totalQty || ''}</td>
                            <td className={`px-1 py-0.5 text-right border ${log !== undefined ? 'text-rose-600 font-medium' : 'text-gray-300'}`}>
                              {log ?? ''}
                            </td>
                            <td className="px-0 py-0 border bg-amber-50/40">
                              <RemixCell value={remix} onChange={(v) => saveRemix(d, it.code, v)} />
                            </td>
                          </Fragment>
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
                        <Fragment key={d + '-sub'}>
                          <td className="px-1 py-1 text-right border text-xs font-bold">{q || ''}</td>
                          <td className="px-1 py-1 text-right border text-xs font-bold text-rose-700">{r || ''}</td>
                          <td className="px-1 py-1 text-right border text-xs font-bold text-amber-700 bg-amber-50">{m || ''}</td>
                        </Fragment>
                      );
                    })}
                  </tr>
                </Fragment>
              );
            })}
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

function SummaryCard({ label, value, unit, tone, sub }: {
  label: string; value: string; unit: string;
  tone: 'blue' | 'rose' | 'amber';
  sub?: string;
}) {
  const tones = {
    blue:  'border-blue-500  text-blue-700',
    rose:  'border-rose-500  text-rose-700',
    amber: 'border-amber-500 text-amber-700',
  };
  return (
    <div className={`bg-white border-l-4 ${tones[tone]} rounded-lg shadow-sm p-4`}>
      <div className="text-xs text-gray-500 mb-1 font-medium">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={`text-3xl font-bold ${tones[tone]}`}>{value}</span>
        <span className="text-xs text-gray-500">{unit}</span>
      </div>
      {sub && <div className="text-[11px] text-gray-500 mt-1">{sub}</div>}
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
  title, unit, points, color, onEdit, onEnlarge, large,
}: { title: string; unit: string; points: GraphPoint[]; color: string; onEdit: () => void; onEnlarge?: () => void; large?: boolean }) {
  const sorted = [...points].sort((a, b) => a.month.localeCompare(b.month));
  const max = sorted.length ? Math.max(...sorted.map((p) => p.value)) : 0;
  const min = 0;
  const range = Math.max(max - min, 0.1);

  const W = large ? 1400 : 1100, H = large ? 380 : 260;
  const padL = 50, padR = 20, padT = 28, padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const xFor = (i: number) => padL + (sorted.length > 1 ? (i / (sorted.length - 1)) * innerW : innerW / 2);
  const yFor = (v: number) => padT + innerH - ((v - min) / range) * innerH;

  const path = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.value)}`).join(' ');

  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      {title && (
        <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center gap-2">
          <span className="font-semibold text-gray-800 text-sm">{title}</span>
          {onEnlarge && <button onClick={onEnlarge} className="ml-auto px-2.5 py-1 text-xs bg-white border rounded hover:bg-gray-100">🔍 확대</button>}
          <button onClick={onEdit} className={`${onEnlarge ? '' : 'ml-auto'} px-2.5 py-1 text-xs bg-white border rounded hover:bg-gray-100`}>✎ 데이터 편집</button>
        </div>
      )}
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

type MonthAgg = {
  month: number;
  totalQty: number;
  remaining: number;
  remixCount: number;
  itemCount: number;
  workDays: number;
  remainingRatio: number;
  avgRemix: number;
  hasOverride?: boolean;
};

type MonthlyOverride = {
  totalQty?: number;
  remaining?: number;
  remixCount?: number;
  itemCount?: number;
  workDays?: number;
};

// localStorage 캐시 (월별 집계는 거의 안 바뀜)
const AGG_CACHE_PREFIX = 'remixMonthAgg:';
function isPastMonth(year: number, month: number): boolean {
  const now = new Date();
  const cy = now.getFullYear(), cm = now.getMonth() + 1;
  return year < cy || (year === cy && month < cm);
}
function getAggCache(year: number, month: number): { totalQty: number; remaining: number; remixCount: number; itemCount: number; workDays: number } | null {
  try {
    const raw = localStorage.getItem(`${AGG_CACHE_PREFIX}${year}-${pad(month)}`);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    const ttl = isPastMonth(year, month) ? 30 * 24 * 3600 * 1000 : 30 * 60 * 1000;
    if (Date.now() - ts > ttl) return null;
    return data;
  } catch { return null; }
}
function setAggCache(year: number, month: number, data: any) {
  try { localStorage.setItem(`${AGG_CACHE_PREFIX}${year}-${pad(month)}`, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

function ViewToggle({ view, onChange }: { view: 'daily' | 'monthly'; onChange: (v: 'daily' | 'monthly') => void }) {
  return (
    <div className="bg-white border rounded-lg p-2 flex items-center gap-1 w-max">
      <button
        onClick={() => onChange('daily')}
        className={`px-4 py-1.5 rounded text-sm font-medium ${view === 'daily' ? 'bg-slate-800 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
      >일일현황</button>
      <button
        onClick={() => onChange('monthly')}
        className={`px-4 py-1.5 rounded text-sm font-medium ${view === 'monthly' ? 'bg-slate-800 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
      >월별정리</button>
    </div>
  );
}

async function aggregateMonth(year: number, month: number): Promise<{ totalQty: number; remaining: number; remixCount: number; itemCount: number; workDays: number }> {
  const cached = getAggCache(year, month);
  if (cached) return cached;

  const lastDay = new Date(year, month, 0).getDate();
  const dates = Array.from({ length: lastDay }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`);
  let totalQty = 0, remaining = 0, remixCount = 0, workDays = 0;
  const codesSet = new Set<string>();
  const [itemsSnaps, logsSnaps, remixSnaps] = await Promise.all([
    Promise.all(dates.map((d) => getDocs(collection(db, 'days', d, 'items')))),
    Promise.all(dates.map((d) => getDocs(collection(db, 'days', d, 'logistics')))),
    Promise.all(dates.map((d) => getDocs(collection(db, 'remix', d, 'items')).catch(() => null))),
  ]);
  dates.forEach((_d, idx) => {
    let dayQty = 0;
    itemsSnaps[idx].forEach((doc) => {
      const it = doc.data() as Item;
      dayQty += it.totalQty || 0;
      codesSet.add(normalizeCode(it.code));
    });
    if (dayQty > 0) workDays++;
    totalQty += dayQty;
    logsSnaps[idx].forEach((doc) => { remaining += (doc.data().qty as number) || 0; });
    if (remixSnaps[idx]) {
      remixSnaps[idx]!.forEach((doc) => { remixCount += (doc.data().count as number) || 0; });
    }
  });
  const data = { totalQty, remaining, remixCount, itemCount: codesSet.size, workDays };
  setAggCache(year, month, data);
  return data;
}

function mergeWithOverride(auto: { totalQty: number; remaining: number; remixCount: number; itemCount: number; workDays: number }, ov?: MonthlyOverride) {
  const totalQty = ov?.totalQty ?? auto.totalQty;
  const remaining = ov?.remaining ?? auto.remaining;
  const remixCount = ov?.remixCount ?? auto.remixCount;
  const itemCount = ov?.itemCount ?? auto.itemCount;
  const workDays = ov?.workDays ?? auto.workDays;
  const denom = totalQty + remaining;
  return {
    totalQty, remaining, remixCount, itemCount, workDays,
    remainingRatio: denom > 0 ? (remaining / denom) * 100 : 0,
    avgRemix: workDays > 0 ? remixCount / workDays : 0,
    hasOverride: !!ov && Object.values(ov).some((v) => v !== undefined),
  };
}

function MonthlyView({
  year, onYearChange, remixGraph, surplusGraph, onEditRemix, onEditSurplus,
}: {
  year: number;
  onYearChange: (y: number) => void;
  remixGraph: GraphData;
  surplusGraph: GraphData;
  onEditRemix: () => void;
  onEditSurplus: () => void;
}) {
  const today = new Date();
  // 그래프 범위: 기본 13개월 (현재월 포함, 12개월 전)
  const defaultEnd = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
  const defaultStart = (() => {
    const d = new Date(today.getFullYear(), today.getMonth() - 12, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  })();
  const [rangeStart, setRangeStart] = useState(defaultStart);
  const [rangeEnd, setRangeEnd] = useState(defaultEnd);
  const [enlargedGraph, setEnlargedGraph] = useState<'remix' | 'surplus' | null>(null);

  const [aggs, setAggs] = useState<MonthAgg[]>([]);  // for selected year (table)
  const [rangeAggs, setRangeAggs] = useState<{ key: string; auto: any; ov?: MonthlyOverride }[]>([]);  // for graph range
  const [overrides, setOverrides] = useState<Record<string, MonthlyOverride>>({});
  const [loading, setLoading] = useState(false);
  const [editingMonth, setEditingMonth] = useState<number | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // 수동 보정 데이터 (월별) 실시간 구독
  useEffect(() => {
    return onSnapshot(collection(db, 'monthlyStats'), (snap) => {
      const map: Record<string, MonthlyOverride> = {};
      snap.forEach((d) => { map[d.id] = d.data() as MonthlyOverride; });
      setOverrides(map);
    });
  }, []);

  // 선택된 년도의 1~12월 집계 (캐시 사용)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setAggs([]);
    (async () => {
      const result: MonthAgg[] = [];
      for (let m = 1; m <= 12; m++) {
        const auto = await aggregateMonth(year, m);
        if (cancelled) return;
        const ov = overrides[`${year}-${pad(m)}`];
        const merged = mergeWithOverride(auto, ov);
        result.push({ month: m, ...merged });
        setAggs([...result]);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [year, overrides, refreshTick]);

  // 그래프 범위 데이터
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [sy, sm] = rangeStart.split('-').map(Number);
      const [ey, em] = rangeEnd.split('-').map(Number);
      const months: { y: number; m: number }[] = [];
      let cur = new Date(sy, sm - 1, 1);
      const end = new Date(ey, em - 1, 1);
      while (cur <= end) {
        months.push({ y: cur.getFullYear(), m: cur.getMonth() + 1 });
        cur.setMonth(cur.getMonth() + 1);
      }
      const result: { key: string; auto: any; ov?: MonthlyOverride }[] = [];
      for (const { y, m } of months) {
        const key = `${y}-${pad(m)}`;
        // 선택 년도와 동일하면 aggs에서 재사용
        const auto = (y === year) ? null : await aggregateMonth(y, m);
        if (cancelled) return;
        result.push({ key, auto, ov: overrides[key] });
      }
      if (!cancelled) setRangeAggs(result);
    })();
    return () => { cancelled = true; };
  }, [rangeStart, rangeEnd, overrides, year, refreshTick]);

  // 그래프 포인트 계산
  const remixPoints: GraphPoint[] = useMemo(() => {
    const manual = new Map((remixGraph.points || []).map((p) => [p.month, p.value]));
    return rangeAggs.map(({ key, auto, ov }) => {
      if (manual.has(key)) return { month: key, value: manual.get(key)! };
      let auto2 = auto;
      if (!auto2) {
        const [, mm] = key.split('-').map(Number);
        const a = aggs.find((x) => x.month === mm);
        if (a) auto2 = { totalQty: a.totalQty, remaining: a.remaining, remixCount: a.remixCount, itemCount: a.itemCount, workDays: a.workDays };
      }
      if (!auto2) return { month: key, value: 0 };
      const merged = mergeWithOverride(auto2, ov);
      return { month: key, value: merged.avgRemix };
    });
  }, [rangeAggs, aggs, remixGraph]);

  const surplusPoints: GraphPoint[] = useMemo(() => {
    const manual = new Map((surplusGraph.points || []).map((p) => [p.month, p.value]));
    return rangeAggs.map(({ key, auto, ov }) => {
      if (manual.has(key)) return { month: key, value: manual.get(key)! };
      let auto2 = auto;
      if (!auto2) {
        const [, mm] = key.split('-').map(Number);
        const a = aggs.find((x) => x.month === mm);
        if (a) auto2 = { totalQty: a.totalQty, remaining: a.remaining, remixCount: a.remixCount, itemCount: a.itemCount, workDays: a.workDays };
      }
      if (!auto2) return { month: key, value: 0 };
      const merged = mergeWithOverride(auto2, ov);
      return { month: key, value: merged.remainingRatio };
    });
  }, [rangeAggs, aggs, surplusGraph]);

  const saveOverride = async (month: number, ov: MonthlyOverride) => {
    const key = `${year}-${pad(month)}`;
    const cleaned: MonthlyOverride = {};
    (['totalQty', 'remaining', 'remixCount', 'itemCount', 'workDays'] as const).forEach((k) => {
      if (ov[k] !== undefined && ov[k] !== null && !isNaN(ov[k] as number)) cleaned[k] = ov[k];
    });
    if (Object.keys(cleaned).length === 0) {
      await deleteDoc(doc(db, 'monthlyStats', key)).catch(() => {});
    } else {
      await setDoc(doc(db, 'monthlyStats', key), cleaned);
    }
  };

  const downloadExcel = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${year}년 월별정리`);
    ws.addRow(['월', '생산수량', '잔여량', '잔여율(%)', '재배합', '일평균재배합', '품목수', '작업일']);
    aggs.forEach((a) => {
      ws.addRow([
        `${a.month}월`, a.totalQty, a.remaining,
        Number(a.remainingRatio.toFixed(2)),
        a.remixCount, Number(a.avgRemix.toFixed(2)),
        a.itemCount, a.workDays,
      ]);
    });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `월별정리_${year}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  const clearCacheAll = () => {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(AGG_CACHE_PREFIX)) localStorage.removeItem(k);
      }
    } catch {}
    setRefreshTick((t) => t + 1);
  };

  return (
    <>
      {/* 그래프 범위 선택 */}
      <div className="bg-white border rounded-lg p-3 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-gray-500">그래프 범위:</span>
        <input type="month" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} className="border rounded px-2 py-1 text-sm" />
        <span className="text-xs text-gray-400">~</span>
        <input type="month" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} className="border rounded px-2 py-1 text-sm" />
        <span className="text-xs text-gray-400">(기본 13개월)</span>
        <button onClick={clearCacheAll} className="ml-auto px-2.5 py-1 text-xs border rounded hover:bg-gray-50" title="모든 월 캐시 무효화 후 재집계">🔄 캐시 무효화</button>
      </div>

      {/* 재배합 그래프 */}
      <MonthlyLineCard
        title="재배합 현황 (월별 일평균 건수)"
        unit="건"
        points={remixPoints}
        color="#1e40af"
        onEdit={onEditRemix}
        onEnlarge={() => setEnlargedGraph('remix')}
      />
      {/* 잔여량 그래프 */}
      <MonthlyLineCard
        title="잔여량 현황 (월별 %)"
        unit="%"
        points={surplusPoints}
        color="#dc2626"
        onEdit={onEditSurplus}
        onEnlarge={() => setEnlargedGraph('surplus')}
      />

      {/* 년도 선택 + 엑셀 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3">
        <select value={year} onChange={(e) => onYearChange(Number(e.target.value))} className="border rounded px-3 py-1.5 text-sm">
          {[year - 3, year - 2, year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>
        {loading && <span className="text-xs text-gray-500">집계중...</span>}
        <span className="text-xs text-gray-400">📦 캐시: 과거월 30일, 현재월 30분</span>
        <button onClick={downloadExcel} className="ml-auto px-3 py-1.5 bg-blue-900 text-white rounded text-sm font-medium hover:bg-blue-800">엑셀 다운로드</button>
      </div>

      {/* 월별 표 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b bg-slate-50 font-semibold text-gray-800">{year}년 월별 정리</div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">월</th>
              <th className="px-3 py-2 text-right">생산 수량</th>
              <th className="px-3 py-2 text-right">잔여량</th>
              <th className="px-3 py-2 text-right">잔여율</th>
              <th className="px-3 py-2 text-right">재배합</th>
              <th className="px-3 py-2 text-right">일평균 재배합</th>
              <th className="px-3 py-2 text-right">품목수</th>
              <th className="px-3 py-2 text-right">작업일</th>
              <th className="px-3 py-2 text-right w-16"></th>
            </tr>
          </thead>
          <tbody>
            {aggs.length === 0 && !loading && (
              <tr><td colSpan={9} className="p-8 text-center text-gray-400 text-sm">데이터 없음</td></tr>
            )}
            {aggs.map((a) => (
              <tr key={a.month} className={`border-t hover:bg-slate-50/50 ${a.hasOverride ? 'bg-amber-50/40' : ''}`}>
                <td className="px-3 py-2 font-medium">
                  {a.month}월
                  {a.hasOverride && <span className="ml-1 text-[10px] text-amber-600 font-bold">수동</span>}
                </td>
                <td className="px-3 py-2 text-right">{a.totalQty.toLocaleString()}</td>
                <td className="px-3 py-2 text-right text-rose-700">{a.remaining.toLocaleString()}</td>
                <td className="px-3 py-2 text-right text-rose-700 font-bold">{a.remainingRatio.toFixed(2)}%</td>
                <td className="px-3 py-2 text-right text-amber-700">{a.remixCount}</td>
                <td className="px-3 py-2 text-right text-amber-700 font-bold">{a.avgRemix.toFixed(1)}건</td>
                <td className="px-3 py-2 text-right text-gray-600">{a.itemCount}</td>
                <td className="px-3 py-2 text-right text-gray-600">{a.workDays}일</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setEditingMonth(a.month)} className="text-xs text-blue-600 hover:underline">수정</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editingMonth !== null && (
        <MonthOverrideModal
          year={year}
          month={editingMonth}
          override={overrides[`${year}-${pad(editingMonth)}`]}
          auto={aggs.find((a) => a.month === editingMonth)}
          onClose={() => setEditingMonth(null)}
          onSave={async (ov) => { await saveOverride(editingMonth, ov); setEditingMonth(null); }}
        />
      )}

      {enlargedGraph && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6" onClick={() => setEnlargedGraph(null)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-6xl w-full" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center">
              <span className="font-bold">{enlargedGraph === 'remix' ? '재배합 현황' : '잔여량 현황'} (확대)</span>
              <button onClick={() => setEnlargedGraph(null)} className="ml-auto text-gray-500">×</button>
            </div>
            <div className="p-4">
              <MonthlyLineCard
                title=""
                unit={enlargedGraph === 'remix' ? '건' : '%'}
                points={enlargedGraph === 'remix' ? remixPoints : surplusPoints}
                color={enlargedGraph === 'remix' ? '#1e40af' : '#dc2626'}
                onEdit={enlargedGraph === 'remix' ? onEditRemix : onEditSurplus}
                large
              />
              <p className="text-xs text-gray-500 mt-2">💡 PPT용: 우클릭 → 이미지로 저장</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MonthOverrideModal({
  year, month, override, auto, onClose, onSave,
}: {
  year: number;
  month: number;
  override?: MonthlyOverride;
  auto?: MonthAgg;
  onClose: () => void;
  onSave: (ov: MonthlyOverride) => Promise<void>;
}) {
  const [vals, setVals] = useState<MonthlyOverride>(() => override || {});
  const [saving, setSaving] = useState(false);

  const set = (k: keyof MonthlyOverride, v: string) => {
    const n = v.trim() === '' ? undefined : Number(v);
    setVals({ ...vals, [k]: n });
  };

  const Field = ({ k, label, autoVal }: { k: keyof MonthlyOverride; label: string; autoVal: number }) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label} <span className="text-gray-400">(자동: {autoVal.toLocaleString()})</span></label>
      <input
        type="number" inputMode="numeric"
        value={vals[k] ?? ''}
        onChange={(e) => set(k, e.target.value)}
        placeholder="자동값 사용"
        className="w-full border rounded px-3 py-2 text-sm"
      />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
        <div className="px-5 py-4 border-b bg-amber-50">
          <h3 className="font-bold">{year}년 {month}월 수동 입력</h3>
          <div className="text-xs text-gray-500 mt-0.5">빈 칸은 자동 집계값 사용. 입력하면 그 값이 우선됩니다.</div>
        </div>
        <div className="p-5 space-y-3">
          <Field k="totalQty" label="생산 수량" autoVal={auto?.totalQty ?? 0} />
          <Field k="remaining" label="잔여량" autoVal={auto?.remaining ?? 0} />
          <Field k="remixCount" label="재배합 건수" autoVal={auto?.remixCount ?? 0} />
          <Field k="itemCount" label="품목수" autoVal={auto?.itemCount ?? 0} />
          <Field k="workDays" label="작업일 수" autoVal={auto?.workDays ?? 0} />
          <p className="text-[11px] text-gray-500">잔여율과 일평균 재배합은 자동 계산됩니다.</p>
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex gap-2">
          <button onClick={onClose} className="px-3 py-2 border rounded text-sm">취소</button>
          <button
            onClick={async () => { setSaving(true); await onSave(vals); setSaving(false); }}
            disabled={saving}
            className="ml-auto px-5 py-2 bg-amber-600 text-white rounded text-sm font-medium hover:bg-amber-700"
          >{saving ? '저장중...' : '저장'}</button>
        </div>
      </div>
    </div>
  );
}
