/** 분석 > 용기분석 — 월별 용기 사용량 (냉장이유식 기준)
 *
 *  용기 구분: 제품 DB(productSettings)의 ERP 코드 끝자리
 *    · '-51' 로 끝나면  → 작은용기 185ml   (예: F-045-51)
 *    · 그 외            → 큰용기  210ml   (예: F-043-01)
 *
 *  사용량 = 그 달 냉장 생산량(EA). 1EA = 용기 1개.
 *  생산량은 잔여량(물류) 보정이 들어간 computeMonthlyProduction 결과를 그대로 사용한다.
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, getDocs, query, where } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { canonicalShort, compareCode } from '../lib/codeUtil';
import { computeMonthlyProduction } from '../lib/monthlyProduction';
import type { Item, MachineEntry } from '../types';

const SMALL_ML = 185, LARGE_ML = 210;

function shiftMonth(m: string, delta: number): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const isPastMonth = (m: string) => m < todayKey().slice(0, 7);

/** 캐시: 지난달은 '월 마감 이후 계산된 것'만 신뢰, 현재달은 5분 */
const CK = 'containerAnalysis:';
function getCache(m: string) {
  try {
    const raw = localStorage.getItem(CK + m);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (isPastMonth(m)) {
      const [y, mm] = m.split('-').map(Number);
      if (ts < new Date(y, mm, 1).getTime()) return null;   // 진행중에 캐시된 부분집계 무시
      return data;
    }
    return Date.now() - ts > 5 * 60 * 1000 ? null : data;
  } catch { return null; }
}
const setCache = (m: string, data: unknown) => {
  try { localStorage.setItem(CK + m, JSON.stringify({ ts: Date.now(), data })); } catch { /* 용량초과 무시 */ }
};

interface Row { code: string; name: string; qty: number; size: 'small' | 'large' | 'unknown'; erpCode?: string }

export default function ContainerAnalysis() {
  const [month, setMonth] = useState(todayKey().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [ambiguous, setAmbiguous] = useState<string[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr('');
    const cached = tick === 0 ? getCache(month) : null;
    if (cached) { setRows(cached.rows); setAmbiguous(cached.ambiguous || []); setLoading(false); return; }

    (async () => {
      try {
        const start = `${month}-01`, end = `${month}-31`;
        const [entSnap, itemSnap, prodSnap] = await Promise.all([
          getDocs(query(collectionGroup(db, 'entries'), where('date', '>=', start), where('date', '<=', end))),
          getDocs(query(collectionGroup(db, 'items'), where('date', '>=', start), where('date', '<=', end))),
          getDocs(collection(db, 'productSettings')),
        ]);
        // 월 물류(잔여량) — 일자별 합
        const [yy, mm] = month.split('-').map(Number);
        const lastDay = new Date(yy, mm, 0).getDate();
        const dates = Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
        const logSnaps = await Promise.all(dates.map((d) => getDocs(collection(db, 'days', d, 'logistics'))));
        const logisticsByDay: Record<string, number> = {};
        logSnaps.forEach((s, i) => {
          if (s.empty) return;
          let sum = 0; s.forEach((d) => { sum += (d.data().qty as number) || 0; });
          logisticsByDay[dates[i]] = sum;
        });
        if (cancelled) return;

        // days/ 하위만 (waste/entries · remix/items 섞이지 않게 경로로 거름)
        const entries = entSnap.docs
          .filter((d) => d.ref.path.startsWith('days/') && d.ref.path.includes('/machines/'))
          .map((d) => d.data() as MachineEntry)
          .filter((e) => !!e.machine);
        const items = itemSnap.docs
          .filter((d) => d.ref.path.startsWith('days/'))
          .map((d) => d.data() as Item);

        // 제품 DB → 단축코드별 용기 구분 (ERP 코드 끝 '-51' = 작은용기)
        const sizeByShort = new Map<string, 'small' | 'large'>();
        const erpByShort = new Map<string, string>();
        const nameByShort = new Map<string, string>();
        const conflict = new Set<string>();
        prodSnap.forEach((d) => {
          const data = d.data() as { code?: string; name?: string };
          const erp = (data.code || d.id || '').trim();
          if (!erp) return;
          const short = canonicalShort(erp);
          const size: 'small' | 'large' = /-51$/.test(erp) ? 'small' : 'large';
          const prev = sizeByShort.get(short);
          if (prev && prev !== size) conflict.add(short);   // -01/-51 이 같은 단축코드로 겹치는 경우
          sizeByShort.set(short, size);
          erpByShort.set(short, erp);
          if (data.name) nameByShort.set(short, data.name);
        });

        const prod = computeMonthlyProduction(entries, items, [], logisticsByDay);
        const list: Row[] = [];
        prod.coldByCode.forEach((qty, short) => {
          const q = Math.round(qty);
          if (q === 0) return;
          const size = sizeByShort.get(short);
          list.push({
            code: short,
            name: nameByShort.get(short) || prod.stages.flatMap((s) => s.items).find((i) => i.code === short)?.name || short,
            qty: q,
            size: size || 'unknown',
            erpCode: erpByShort.get(short),
          });
        });
        list.sort((a, b) => b.qty - a.qty || compareCode(a.code, b.code));
        if (cancelled) return;
        setRows(list);
        setAmbiguous([...conflict]);
        setCache(month, { rows: list, ambiguous: [...conflict] });
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [month, tick]);

  const sum = useMemo(() => {
    const s = { small: 0, large: 0, unknown: 0, smallCnt: 0, largeCnt: 0, unknownCnt: 0 };
    rows.forEach((r) => {
      if (r.size === 'small') { s.small += r.qty; s.smallCnt++; }
      else if (r.size === 'large') { s.large += r.qty; s.largeCnt++; }
      else { s.unknown += r.qty; s.unknownCnt++; }
    });
    return s;
  }, [rows]);
  const total = sum.small + sum.large + sum.unknown;

  const downloadXlsx = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${month} 용기`);
    ws.columns = [{ width: 12 }, { width: 16 }, { width: 30 }, { width: 14 }, { width: 12 }];
    const thin = { style: 'thin' as const, color: { argb: 'FFCBD5E1' } };
    const border = { top: thin, left: thin, right: thin, bottom: thin };
    ws.addRow([`용기 사용량 — ${month} (냉장이유식)`]);
    ws.mergeCells('A1:E1');
    ws.getCell('A1').font = { size: 14, bold: true };
    ws.addRow([]);
    ws.addRow([`작은용기 ${SMALL_ML}ml`, sum.small, `큰용기 ${LARGE_ML}ml`, sum.large, `합계 ${total}`]);
    ws.getRow(3).font = { bold: true };
    ws.addRow([]);
    const head = ws.addRow(['단축코드', 'ERP코드', '품목명', '용기', '수량(개)']);
    head.eachCell((c) => {
      c.font = { bold: true };
      c.alignment = { horizontal: 'center' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
      c.border = border;
    });
    rows.forEach((r) => {
      const row = ws.addRow([r.code, r.erpCode || '', r.name,
        r.size === 'small' ? `작은 ${SMALL_ML}ml` : r.size === 'large' ? `큰 ${LARGE_ML}ml` : '미분류', r.qty]);
      row.eachCell((c, i) => { c.border = border; c.alignment = { horizontal: i === 3 ? 'left' : 'center' }; });
    });
    const buf = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a'); a.href = url; a.download = `용기사용량_${month}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      {/* 상단 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-gray-800 text-lg">🥣 용기 분석</span>
        <span className="text-xs text-gray-400">냉장이유식 기준</span>
        <span className="text-gray-300">|</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setMonth(shiftMonth(month, -1))} className="w-8 h-8 rounded hover:bg-gray-100">◀</button>
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="border rounded px-2 py-1 text-sm font-bold" />
          <button onClick={() => setMonth(shiftMonth(month, 1))} className="w-8 h-8 rounded hover:bg-gray-100">▶</button>
        </div>
        {loading && <span className="text-xs text-blue-600">불러오는 중…</span>}
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => { localStorage.removeItem(CK + month); setTick((t) => t + 1); }}
            className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50" title="캐시 무시하고 다시 계산">🔄</button>
          <button onClick={() => setMonth(todayKey().slice(0, 7))} className="px-2.5 py-1 text-xs rounded border hover:bg-gray-50">이번 달</button>
          <button onClick={downloadXlsx} disabled={rows.length === 0}
            className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:bg-gray-300">📥 엑셀</button>
        </div>
      </div>

      {err && <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">불러오기 실패: {err}</div>}

      {/* 요약 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white border-2 border-cyan-300 rounded-xl p-4">
          <div className="text-xs text-cyan-700 font-semibold">작은용기 {SMALL_ML}ml <span className="text-gray-400 font-normal">(코드 -51)</span></div>
          <div className="text-4xl font-extrabold text-cyan-700 tabular-nums mt-1">{sum.small.toLocaleString()}<span className="text-base font-normal text-gray-400 ml-1">개</span></div>
          <div className="text-xs text-gray-500 mt-0.5">{sum.smallCnt}품목</div>
        </div>
        <div className="bg-white border-2 border-violet-300 rounded-xl p-4">
          <div className="text-xs text-violet-700 font-semibold">큰용기 {LARGE_ML}ml <span className="text-gray-400 font-normal">(그 외)</span></div>
          <div className="text-4xl font-extrabold text-violet-700 tabular-nums mt-1">{sum.large.toLocaleString()}<span className="text-base font-normal text-gray-400 ml-1">개</span></div>
          <div className="text-xs text-gray-500 mt-0.5">{sum.largeCnt}품목</div>
        </div>
        <div className="bg-slate-50 border rounded-xl p-4">
          <div className="text-xs text-gray-500 font-semibold">합계</div>
          <div className="text-4xl font-extrabold text-gray-800 tabular-nums mt-1">{total.toLocaleString()}<span className="text-base font-normal text-gray-400 ml-1">개</span></div>
          <div className="text-xs text-gray-500 mt-0.5">{rows.length}품목</div>
        </div>
      </div>

      {sum.unknownCnt > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800">
          ⚠ 제품 DB에 없어 용기 구분을 못 한 품목 {sum.unknownCnt}개 ({sum.unknown.toLocaleString()}개) — 아래 표에서 <b>미분류</b>로 표시됩니다.
          설정 → 제품 DB에 코드를 등록하면 자동 반영됩니다.
        </div>
      )}
      {ambiguous.length > 0 && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">
          ⚠ 같은 단축코드에 -01/-51 이 함께 등록돼 용기 구분이 모호한 코드: <b>{ambiguous.join(', ')}</b> — 제품 DB 확인 필요
        </div>
      )}

      {/* 품목별 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">
          품목별 사용량 <span className="text-xs text-gray-500 font-normal">· 수량 많은 순</span>
        </div>
        {loading ? (
          <div className="p-12 text-center text-gray-400 text-sm">불러오는 중…</div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">{month} 생산 데이터가 없습니다.</div>
        ) : (
          <div className="max-h-[560px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-gray-600 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left w-24">코드</th>
                  <th className="px-3 py-2 text-left w-28">ERP코드</th>
                  <th className="px-3 py-2 text-left">품목명</th>
                  <th className="px-3 py-2 text-center w-28">용기</th>
                  <th className="px-3 py-2 text-right w-28">수량(개)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.code} className="hover:bg-slate-50/60">
                    <td className="px-3 py-1.5 font-mono font-bold text-gray-700">{r.code}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-gray-400">{r.erpCode || '-'}</td>
                    <td className="px-3 py-1.5 text-gray-800">{r.name}</td>
                    <td className="px-3 py-1.5 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                        r.size === 'small' ? 'bg-cyan-100 text-cyan-700'
                        : r.size === 'large' ? 'bg-violet-100 text-violet-700'
                        : 'bg-amber-100 text-amber-700'}`}>
                        {r.size === 'small' ? `작은 ${SMALL_ML}` : r.size === 'large' ? `큰 ${LARGE_ML}` : '미분류'}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-bold tabular-nums">{r.qty.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
