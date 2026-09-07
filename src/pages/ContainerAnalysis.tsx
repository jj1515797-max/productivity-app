/** 분석 > 용기분석
 *
 *  탭 ① 월별 사용량 — 그 달 생산량(EA)을 용기 구분별로 집계
 *  탭 ② 재고 정합성 — 재고조사 투입량 vs 이론사용량 검증
 *
 *  용기 구분: 제품 DB(productSettings)의 ERP 코드 끝자리
 *    · '-51' 로 끝나면  → 작은용기 185ml   (예: F-045-51)
 *    · 그 외            → 큰용기  210ml   (예: F-043-01)
 *
 *  사용량 = 그 달 냉장 생산량(EA). 1EA = 용기 1개.
 *  생산량은 잔여량(물류) 보정이 들어간 computeMonthlyProduction 결과를 그대로 사용한다.
 */
import { useEffect, useMemo, useState } from 'react';
import ExcelJS from 'exceljs';
import { todayKey } from '../lib/dateUtil';
import { loadContainerMonth, isPastMonth, type ContainerRow } from '../lib/containerLoad';
import ContainerStockTab from '../components/ContainerStockTab';

const SMALL_ML = 185, LARGE_ML = 210;

function shiftMonth(m: string, delta: number): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

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

type Row = ContainerRow;

function MonthlyUsageTab() {
  const [month, setMonth] = useState(todayKey().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [ambiguous, setAmbiguous] = useState<string[]>([]);
  const [monthlyTotal, setMonthlyTotal] = useState(0);   // 월별현황 공식으로 재계산한 냉장 총량(교차검증용)
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr('');
    const cached = tick === 0 ? getCache(month) : null;
    if (cached) {
      setRows(cached.rows); setAmbiguous(cached.ambiguous || []);
      setMonthlyTotal(cached.monthlyTotal || 0); setLoading(false); return;
    }

    (async () => {
      try {
        const r = await loadContainerMonth(month);
        if (cancelled) return;
        setRows(r.rows);
        setAmbiguous(r.ambiguous);
        setMonthlyTotal(r.monthlyTotal);
        setCache(month, { rows: r.rows, ambiguous: r.ambiguous, monthlyTotal: r.monthlyTotal });
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [month, tick]);

  // 합계는 원값(비반올림)으로 누적한 뒤 마지막에 반올림 → 코드별 반올림 누적오차 방지
  const sum = useMemo(() => {
    const raw = { small: 0, large: 0, unknown: 0 };
    const cnt = { smallCnt: 0, largeCnt: 0, unknownCnt: 0 };
    rows.forEach((r) => {
      if (r.size === 'small') { raw.small += r.qty; cnt.smallCnt++; }
      else if (r.size === 'large') { raw.large += r.qty; cnt.largeCnt++; }
      else { raw.unknown += r.qty; cnt.unknownCnt++; }
    });
    return {
      small: Math.round(raw.small), large: Math.round(raw.large), unknown: Math.round(raw.unknown),
      rawTotal: raw.small + raw.large + raw.unknown, ...cnt,
    };
  }, [rows]);
  const total = Math.round(sum.rawTotal);
  // 월별현황(일자 단위 공식) 대비 차이 — 1개 이상 벌어지면 화면에 드러냄
  const diff = monthlyTotal ? total - monthlyTotal : 0;

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
        r.size === 'small' ? `작은 ${SMALL_ML}ml` : r.size === 'large' ? `큰 ${LARGE_ML}ml` : '미분류', Math.round(r.qty)]);
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
        <span className="text-xs text-gray-400">냉장이유식 기준</span>
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
          <div className="text-xs text-gray-500 mt-0.5">
            {rows.length}품목
            {!loading && monthlyTotal > 0 && (
              <span className={diff === 0 ? 'text-emerald-600 ml-1.5 font-semibold' : 'text-red-600 ml-1.5 font-semibold'}>
                · 월별현황 {monthlyTotal.toLocaleString()} {diff === 0 ? '일치 ✓' : `(${diff > 0 ? '+' : ''}${diff})`}
              </span>
            )}
          </div>
        </div>
      </div>

      {!loading && monthlyTotal > 0 && diff !== 0 && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">
          ⚠ <b>월별현황 냉장 생산량({monthlyTotal.toLocaleString()})과 {Math.abs(diff).toLocaleString()}개 차이</b>가 납니다.
          <span className="text-red-600"> 잔여량(물류)만 있고 품목 계획이 없는 날이 있으면 코드별로 배분할 대상이 없어 이런 차이가 생깁니다.
          해당 일자의 품목/잔여량 입력을 확인해 주세요.</span>
        </div>
      )}

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
                    <td className="px-3 py-1.5 text-right font-bold tabular-nums">{Math.round(r.qty).toLocaleString()}</td>
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

const TABS = [
  { id: 'usage', label: '📦 월별 사용량', sub: '생산량 기준 용기 사용량' },
  { id: 'stock', label: '🧮 재고 정합성', sub: '재고조사 투입량 검증' },
] as const;

export default function ContainerAnalysis() {
  const [tab, setTab] = useState<'usage' | 'stock'>('usage');
  return (
    <div className="space-y-4">
      <div className="bg-white border rounded-lg px-3 pt-3 flex items-end gap-1 flex-wrap">
        <span className="font-bold text-gray-800 text-lg mr-3 mb-2">🥣 용기 분석</span>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-t-lg border-b-[3px] transition text-sm ${
              tab === t.id
                ? 'border-blue-600 text-blue-700 font-bold bg-blue-50/60'
                : 'border-transparent text-gray-500 hover:text-gray-800 hover:bg-gray-50'}`}>
            {t.label}
            <span className={`block text-[10px] font-normal ${tab === t.id ? 'text-blue-500' : 'text-gray-400'}`}>{t.sub}</span>
          </button>
        ))}
      </div>
      {tab === 'usage' ? <MonthlyUsageTab /> : <ContainerStockTab />}
    </div>
  );
}
