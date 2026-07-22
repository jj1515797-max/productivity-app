/** 구매 > 입고이력 — 저장된 일별 입고(purchaseInbound/{date})를 월별로 집계.
 *  일자별 입고 건수(구매추이), 업체별, 품목별 누적, 전월 대비.
 */
import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';

interface Item { code: string; name: string; qty: number; unit?: string; supplier?: string; }
interface DayDoc { date: string; items: Item[]; }

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

async function fetchMonth(month: string): Promise<DayDoc[]> {
  const snaps = await Promise.all(datesOfMonth(month).map((d) => getDoc(doc(db, 'purchaseInbound', d))));
  const out: DayDoc[] = [];
  snaps.forEach((s) => { if (s.exists()) { const d = s.data() as any; out.push({ date: d.date, items: d.items || [] }); } });
  return out;
}

export default function InboundHistory() {
  const [month, setMonth] = useState(todayKey().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState<DayDoc[]>([]);
  const [prevLines, setPrevLines] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [cur, prev] = await Promise.all([fetchMonth(month), fetchMonth(prevMonthOf(month))]);
        if (!cancelled) {
          setDays(cur);
          setPrevLines(prev.reduce((s, d) => s + d.items.length, 0));
        }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [month]);

  const allItems = useMemo(() => days.flatMap((d) => d.items), [days]);
  const totalLines = allItems.length;

  const byDay = useMemo(() => days.map((d) => ({ date: d.date, count: d.items.length })).sort((a, b) => a.date.localeCompare(b.date)), [days]);
  const maxDay = Math.max(1, ...byDay.map((d) => d.count));

  const bySupplier = useMemo(() => {
    const m = new Map<string, { lines: number; codes: Set<string> }>();
    allItems.forEach((it) => {
      const s = it.supplier || '미지정 업체';
      if (!m.has(s)) m.set(s, { lines: 0, codes: new Set() });
      const e = m.get(s)!; e.lines++; e.codes.add(it.code);
    });
    return Array.from(m.entries()).map(([supplier, v]) => ({ supplier, lines: v.lines, items: v.codes.size })).sort((a, b) => b.lines - a.lines);
  }, [allItems]);

  const byItem = useMemo(() => {
    const m = new Map<string, { name: string; qty: number; unit: string; supplier: string; times: number }>();
    allItems.forEach((it) => {
      const e = m.get(it.code) || { name: it.name, qty: 0, unit: it.unit || 'g', supplier: it.supplier || '', times: 0 };
      e.qty += Number(it.qty) || 0; e.times++;
      if (it.unit) e.unit = it.unit;
      if (it.supplier) e.supplier = it.supplier;
      m.set(it.code, e);
    });
    return Array.from(m.entries()).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.qty - a.qty);
  }, [allItems]);

  const uniqueItems = byItem.length;
  const delta = prevLines !== null ? totalLines - prevLines : null;

  const downloadXlsx = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${month} 품목별`);
    ws.columns = [{ width: 16 }, { width: 28 }, { width: 12 }, { width: 8 }, { width: 18 }, { width: 10 }];
    const thin = { style: 'thin', color: { argb: 'FFCBD5E1' } } as const;
    const border = { top: thin, left: thin, right: thin, bottom: thin };
    const head = ws.addRow(['품목코드', '품목명', '월 합계수량', '단위', '업체', '입고횟수']);
    head.eachCell((c) => { c.font = { bold: true }; c.alignment = { horizontal: 'center' }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0EC' } }; c.border = border; });
    byItem.forEach((it) => {
      const r = ws.addRow([it.code, it.name, it.qty, it.unit, it.supplier, it.times]);
      r.eachCell((c, i) => { c.border = border; c.alignment = { horizontal: i === 2 ? 'left' : 'center' }; });
    });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `입고이력_${month}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">📚 입고 이력</h2>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="border rounded px-2 py-1 text-sm" />
        {totalLines > 0 && (
          <button onClick={downloadXlsx} className="ml-auto px-4 py-1.5 text-sm rounded-md bg-teal-700 text-white font-medium hover:bg-teal-800">📥 품목별 엑셀</button>
        )}
      </div>

      {loading ? (
        <div className="p-16 text-center text-gray-400 text-sm">불러오는 중…</div>
      ) : totalLines === 0 ? (
        <div className="bg-white border rounded-lg p-12 text-center text-gray-400 text-sm">이 달 저장된 입고 데이터가 없습니다. (입고 화면에서 💾 저장하면 여기 쌓입니다)</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-slate-50 border rounded-xl p-4 text-center">
              <div className="text-xs text-gray-500">입고일수</div>
              <div className="text-3xl font-bold text-gray-800">{days.length}<span className="text-base font-normal text-gray-400 ml-1">일</span></div>
            </div>
            <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 text-center">
              <div className="text-xs text-teal-700">총 입고 건수</div>
              <div className="text-3xl font-bold text-teal-800">{totalLines.toLocaleString()}</div>
              {delta !== null && (
                <div className={`text-xs mt-0.5 font-bold ${delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-rose-600' : 'text-gray-400'}`}>
                  전월 대비 {delta > 0 ? '+' : ''}{delta}
                </div>
              )}
            </div>
            <div className="bg-slate-50 border rounded-xl p-4 text-center">
              <div className="text-xs text-gray-500">품목 종류</div>
              <div className="text-3xl font-bold text-gray-800">{uniqueItems.toLocaleString()}</div>
            </div>
          </div>

          {/* 일자별 입고 건수 — 구매추이 */}
          <div className="bg-white border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b font-bold text-gray-700 text-sm">일자별 입고 건수 (구매추이)</div>
            <div className="divide-y">
              {byDay.map((d) => (
                <div key={d.date} className="px-4 py-2 flex items-center gap-3">
                  <div className="w-16 text-sm text-gray-600 tabular-nums">{d.date.slice(5)}</div>
                  <div className="flex-1 h-3.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-teal-500 rounded-full" style={{ width: `${(d.count / maxDay) * 100}%` }} />
                  </div>
                  <div className="w-20 text-right font-bold text-gray-700 tabular-nums">{d.count}건</div>
                </div>
              ))}
            </div>
          </div>

          {/* 업체별 */}
          <div className="bg-white border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b font-bold text-gray-700 text-sm">업체별 이번 달</div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr><th className="px-4 py-2 text-left">업체</th><th className="px-4 py-2 text-right w-28">입고 건수</th><th className="px-4 py-2 text-right w-28">품목 수</th></tr>
              </thead>
              <tbody className="divide-y">
                {bySupplier.map((s) => (
                  <tr key={s.supplier} className="hover:bg-slate-50/60">
                    <td className="px-4 py-2 font-semibold text-gray-800">{s.supplier}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-bold text-teal-700">{s.lines}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-600">{s.items}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 품목별 누적 */}
          <div className="bg-white border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b font-bold text-gray-700 text-sm">품목별 월 누적 ({uniqueItems}품목)</div>
            <div className="max-h-[520px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 sticky top-0">
                  <tr>
                    <th className="px-4 py-2 text-left w-32">품목코드</th>
                    <th className="px-4 py-2 text-left">품목명</th>
                    <th className="px-4 py-2 text-left w-32">업체</th>
                    <th className="px-4 py-2 text-right w-16">횟수</th>
                    <th className="px-4 py-2 text-right w-32">월 합계</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {byItem.map((it) => (
                    <tr key={it.code} className="hover:bg-slate-50/60">
                      <td className="px-4 py-2 font-mono font-bold text-teal-700">{it.code}</td>
                      <td className="px-4 py-2 text-gray-800">{it.name}</td>
                      <td className="px-4 py-2 text-gray-500">{it.supplier || '-'}</td>
                      <td className="px-4 py-2 text-right text-gray-500 tabular-nums">{it.times}</td>
                      <td className="px-4 py-2 text-right font-bold tabular-nums">{it.qty.toLocaleString()}<span className="text-xs text-gray-400 ml-1">{it.unit}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
