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
 *  일별 = 같은 계산의 날짜별 확정 수량(byDateCode)을 용기 구분으로 묶은 것 — 일별 합 = 월 합계
 *  계획 = 그날 생산하기로 한 수량(생산계획 총수량, 현황판 총수량)을 같은 용기 구분으로. 실제 − 계획 = 잔여량 등으로 늘어난 몫
 *  생산량은 잔여량(물류) 보정이 들어간 computeMonthlyProduction 결과를 그대로 사용한다.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import ExcelJS from 'exceljs';
import { todayKey } from '../lib/dateUtil';
import { loadContainerMonth, isPastMonth, type ContainerRow } from '../lib/containerLoad';
import ContainerStockTab from '../components/ContainerStockTab';

const SMALL_ML = 185, LARGE_ML = 210;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const wdOf = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).getDay(); };

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

/** 차이(실제 − 계획) 칸 — 늘었으면 초록 +, 줄었으면 빨강 */
function DiffCell({ v }: { v: number }) {
  return (
    <td className={`px-3 py-2 text-right tabular-nums font-bold border-r ${v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-600' : 'text-gray-400'}`}>
      {v > 0 ? `+${v.toLocaleString()}` : v.toLocaleString()}
    </td>
  );
}

function MonthlyUsageTab() {
  const [month, setMonth] = useState(todayKey().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [ambiguous, setAmbiguous] = useState<string[]>([]);
  const [monthlyTotal, setMonthlyTotal] = useState(0);   // 월별현황 공식으로 재계산한 냉장 총량(교차검증용)
  const [byDateCode, setByDateCode] = useState<Record<string, Record<string, number>>>({});   // 날짜 → 코드 → 실제 수량
  const [planByDateCode, setPlanByDateCode] = useState<Record<string, Record<string, number>>>({});   // 날짜 → 코드 → 계획 수량
  const [sizeByShort, setSizeByShort] = useState<Record<string, 'small' | 'large'>>({});
  const [nameByShort, setNameByShort] = useState<Record<string, string>>({});
  const [view, setView] = useState<'item' | 'day'>('item');
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr('');
    const cached = tick === 0 ? getCache(month) : null;
    // 일별(계획·실제) 조회를 넣기 전에 저장된 캐시는 날짜별 수량이 없어 한 번 다시 계산한다
    if (cached && cached.byDateCode && cached.planByDateCode) {
      setRows(cached.rows); setAmbiguous(cached.ambiguous || []);
      setMonthlyTotal(cached.monthlyTotal || 0); setByDateCode(cached.byDateCode);
      setPlanByDateCode(cached.planByDateCode); setSizeByShort(cached.sizeByShort || {}); setNameByShort(cached.nameByShort || {});
      setLoading(false); return;
    }

    (async () => {
      try {
        const r = await loadContainerMonth(month);
        if (cancelled) return;
        setRows(r.rows);
        setAmbiguous(r.ambiguous);
        setMonthlyTotal(r.monthlyTotal);
        setByDateCode(r.byDateCode);
        setPlanByDateCode(r.planByDateCode); setSizeByShort(r.sizeByShort); setNameByShort(r.nameByShort);
        setCache(month, { rows: r.rows, ambiguous: r.ambiguous, monthlyTotal: r.monthlyTotal, byDateCode: r.byDateCode,
          planByDateCode: r.planByDateCode, sizeByShort: r.sizeByShort, nameByShort: r.nameByShort });
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

  // 일별 — 날짜마다 계획(생산하기로 한 것)·실제(완료) 용기 수 + 그날 품목
  //   용기 구분·품목명은 월 표와 같은 제품 DB 기준 (생산 안 한 품목도 제품 DB 에서 찾는다)
  type Sz = Row['size'];
  const daily = useMemo(() => {
    const info = new Map(rows.map((r) => [r.code, r]));
    const sizeOf = (code: string): Sz => info.get(code)?.size || sizeByShort[code] || 'unknown';
    const nameOf = (code: string) => info.get(code)?.name || nameByShort[code] || code;
    const dates = [...new Set([...Object.keys(byDateCode), ...Object.keys(planByDateCode)])].sort();
    return dates.map((date) => {
      const act = { small: 0, large: 0, unknown: 0 };
      const plan = { small: 0, large: 0, unknown: 0 };
      const codes = new Set([...Object.keys(byDateCode[date] || {}), ...Object.keys(planByDateCode[date] || {})]);
      const items = [...codes].map((code) => {
        const size = sizeOf(code);
        const a = byDateCode[date]?.[code] || 0;
        const p = planByDateCode[date]?.[code] || 0;
        act[size] += a; plan[size] += p;
        return { code, name: nameOf(code), size, qty: a, plan: p };
      }).filter((i) => Math.round(i.qty) !== 0 || Math.round(i.plan) !== 0)
        .sort((x, y) => y.qty - x.qty || y.plan - x.plan);
      const r = (o: typeof act) => ({ small: Math.round(o.small), large: Math.round(o.large), unknown: Math.round(o.unknown), total: Math.round(o.small + o.large + o.unknown) });
      const A = r(act), P = r(plan);
      return { date, ...A, plan: P, items };
    }).filter((d) => d.total !== 0 || d.plan.total !== 0);
  }, [byDateCode, planByDateCode, rows, sizeByShort, nameByShort]);
  const dailyHasUnknown = daily.some((d) => d.unknown !== 0 || d.plan.unknown !== 0);
  const planSum = useMemo(() => daily.reduce((s2, d) => ({
    small: s2.small + d.plan.small, large: s2.large + d.plan.large, unknown: s2.unknown + d.plan.unknown, total: s2.total + d.plan.total,
  }), { small: 0, large: 0, unknown: 0, total: 0 }), [daily]);
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
    // 일별 합계 · 일별 품목
    const sizeLabel = (z: Row['size']) => (z === 'small' ? `작은 ${SMALL_ML}ml` : z === 'large' ? `큰 ${LARGE_ML}ml` : '미분류');
    const styleHead = (r: ExcelJS.Row) => r.eachCell((c) => {
      c.font = { bold: true }; c.alignment = { horizontal: 'center' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } }; c.border = border;
    });
    const wd = wb.addWorksheet('일별 합계');
    wd.columns = [{ width: 12 }, { width: 6 }, { width: 13 }, { width: 13 }, { width: 10 }, { width: 11 }, { width: 13 }, { width: 13 }, { width: 10 }, { width: 11 }, { width: 11 }];
    styleHead(wd.addRow(['날짜', '요일',
      `계획 작은 ${SMALL_ML}ml`, `계획 큰 ${LARGE_ML}ml`, '계획 미분류', '계획 합계',
      `실제 작은 ${SMALL_ML}ml`, `실제 큰 ${LARGE_ML}ml`, '실제 미분류', '실제 합계', '차이(실제−계획)']));
    daily.forEach((d) => wd.addRow([d.date, WD[wdOf(d.date)],
      d.plan.small, d.plan.large, d.plan.unknown, d.plan.total,
      d.small, d.large, d.unknown, d.total, d.total - d.plan.total]).eachCell((c) => { c.border = border; c.alignment = { horizontal: 'center' }; }));
    const tr = wd.addRow(['합계', '', planSum.small, planSum.large, planSum.unknown, planSum.total, sum.small, sum.large, sum.unknown, total, total - planSum.total]);
    tr.font = { bold: true }; tr.eachCell((c) => { c.border = border; c.alignment = { horizontal: 'center' }; });
    wd.views = [{ state: 'frozen', ySplit: 1 }];
    const wi = wb.addWorksheet('일별 품목');
    wi.columns = [{ width: 12 }, { width: 6 }, { width: 10 }, { width: 30 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 10 }];
    styleHead(wi.addRow(['날짜', '요일', '코드', '품목명', '용기', '계획(개)', '실제(개)', '차이']));
    daily.forEach((d) => d.items.forEach((i) => wi.addRow([d.date, WD[wdOf(d.date)], i.code, i.name, sizeLabel(i.size),
      Math.round(i.plan), Math.round(i.qty), Math.round(i.qty) - Math.round(i.plan)])
      .eachCell((c, n) => { c.border = border; c.alignment = { horizontal: n === 4 ? 'left' : 'center' }; })));
    wi.views = [{ state: 'frozen', ySplit: 1 }];
    wi.autoFilter = { from: 'A1', to: 'H1' };
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
          <div className="text-xs text-gray-500 mt-0.5">{sum.smallCnt}품목{planSum.total > 0 && <> · 계획 <b className="tabular-nums">{planSum.small.toLocaleString()}</b>개</>}</div>
        </div>
        <div className="bg-white border-2 border-violet-300 rounded-xl p-4">
          <div className="text-xs text-violet-700 font-semibold">큰용기 {LARGE_ML}ml <span className="text-gray-400 font-normal">(그 외)</span></div>
          <div className="text-4xl font-extrabold text-violet-700 tabular-nums mt-1">{sum.large.toLocaleString()}<span className="text-base font-normal text-gray-400 ml-1">개</span></div>
          <div className="text-xs text-gray-500 mt-0.5">{sum.largeCnt}품목{planSum.total > 0 && <> · 계획 <b className="tabular-nums">{planSum.large.toLocaleString()}</b>개</>}</div>
        </div>
        <div className="bg-slate-50 border rounded-xl p-4">
          <div className="text-xs text-gray-500 font-semibold">합계</div>
          <div className="text-4xl font-extrabold text-gray-800 tabular-nums mt-1">{total.toLocaleString()}<span className="text-base font-normal text-gray-400 ml-1">개</span></div>
          <div className="text-xs text-gray-500 mt-0.5">
            {rows.length}품목
            {planSum.total > 0 && <> · 계획 <b className="tabular-nums">{planSum.total.toLocaleString()}</b>개</>}
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

      {/* 품목별 / 일별 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b bg-slate-50 flex items-center gap-3 flex-wrap">
          <div className="flex rounded-md border overflow-hidden text-sm">
            {([['item', '품목별'], ['day', '일별']] as const).map(([k, t]) => (
              <button key={k} onClick={() => setView(k)}
                className={`px-3.5 py-1.5 font-bold ${view === k ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{t}</button>
            ))}
          </div>
          <span className="text-xs text-gray-500">
            {view === 'item' ? '그 달 품목별 · 수량 많은 순' : '날짜별 계획(생산하기로 한 것) · 실제(완료) 용기 수 · 차이 = 실제 − 계획 (잔여량 등) · 날짜를 누르면 그날 품목별'}
          </span>
        </div>
        {view === 'day' ? (
          loading ? (
            <div className="p-12 text-center text-gray-400 text-sm">불러오는 중…</div>
          ) : daily.length === 0 ? (
            <div className="p-12 text-center text-gray-400 text-sm">{month} 생산 데이터가 없습니다.</div>
          ) : (
            <div className="max-h-[640px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-gray-600 sticky top-0 z-10">
                  <tr>
                    <th rowSpan={2} className="px-3 py-2 text-left w-32 border-r">날짜</th>
                    <th colSpan={dailyHasUnknown ? 4 : 3} className="px-3 py-1 text-center text-gray-700 bg-slate-100 border-r">계획 <span className="font-normal text-gray-500">(생산하기로 한 수량)</span></th>
                    <th colSpan={dailyHasUnknown ? 4 : 3} className="px-3 py-1 text-center text-gray-800 bg-emerald-50 border-r">실제 <span className="font-normal text-gray-500">(완료 · 잔여량 반영)</span></th>
                    <th rowSpan={2} className="px-3 py-2 text-right border-r">차이</th>
                    <th rowSpan={2} className="px-3 py-2 text-right w-16">품목</th>
                  </tr>
                  <tr>
                    {[0, 1].map((k) => (
                      <Fragment key={k}>
                        <th className="px-3 py-1.5 text-right text-cyan-700">작은 {SMALL_ML}</th>
                        <th className="px-3 py-1.5 text-right text-violet-700">큰 {LARGE_ML}</th>
                        {dailyHasUnknown && <th className="px-3 py-1.5 text-right text-amber-700">미분류</th>}
                        <th className="px-3 py-1.5 text-right border-r">합계</th>
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {daily.map((d) => {
                    const open = openDay === d.date;
                    const w = wdOf(d.date);
                    return (
                      <Fragment key={d.date}>
                        <tr onClick={() => setOpenDay(open ? null : d.date)}
                          className={`border-t cursor-pointer ${open ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
                          <td className="px-3 py-2 font-semibold text-gray-800 tabular-nums border-r whitespace-nowrap">
                            <span className="text-gray-400 mr-1">{open ? '▾' : '▸'}</span>{d.date.slice(5)}
                            <span className={`ml-1.5 text-xs ${w === 0 ? 'text-rose-500' : w === 6 ? 'text-blue-500' : 'text-gray-400'}`}>({WD[w]})</span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-cyan-700/80">{d.plan.small.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-violet-700/80">{d.plan.large.toLocaleString()}</td>
                          {dailyHasUnknown && <td className="px-3 py-2 text-right tabular-nums text-amber-700">{d.plan.unknown ? d.plan.unknown.toLocaleString() : ''}</td>}
                          <td className="px-3 py-2 text-right tabular-nums font-bold text-gray-700 border-r">{d.plan.total.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-cyan-700 font-bold">{d.small.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-violet-700 font-bold">{d.large.toLocaleString()}</td>
                          {dailyHasUnknown && <td className="px-3 py-2 text-right tabular-nums text-amber-700">{d.unknown ? d.unknown.toLocaleString() : ''}</td>}
                          <td className="px-3 py-2 text-right tabular-nums font-extrabold text-gray-900 border-r">{d.total.toLocaleString()}</td>
                          <DiffCell v={d.total - d.plan.total} />
                          <td className="px-3 py-2 text-right tabular-nums text-gray-500">{d.items.length}</td>
                        </tr>
                        {open && (
                          <tr className="bg-slate-50/70">
                            <td colSpan={dailyHasUnknown ? 11 : 9} className="px-4 py-2">
                              <table className="w-full text-xs">
                                <thead className="text-gray-500">
                                  <tr>
                                    <th className="py-1 text-left w-16">코드</th><th className="py-1 text-left">품목명</th><th className="py-1 w-24">용기</th>
                                    <th className="py-1 text-right w-20">계획</th><th className="py-1 text-right w-20">실제</th><th className="py-1 text-right w-20">차이</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-200">
                                  {d.items.map((i) => (
                                    <tr key={i.code}>
                                      <td className="py-1 pr-2 font-mono font-bold text-gray-700 w-16">{i.code}</td>
                                      <td className="py-1 pr-2 text-gray-800">{i.name}</td>
                                      <td className="py-1 pr-2 text-center w-24">
                                        <span className={`px-2 py-0.5 rounded-full font-bold ${
                                          i.size === 'small' ? 'bg-cyan-100 text-cyan-700' : i.size === 'large' ? 'bg-violet-100 text-violet-700' : 'bg-amber-100 text-amber-700'}`}>
                                          {i.size === 'small' ? `작은 ${SMALL_ML}` : i.size === 'large' ? `큰 ${LARGE_ML}` : '미분류'}
                                        </span>
                                      </td>
                                      <td className="py-1 text-right tabular-nums w-20 text-gray-600">{Math.round(i.plan).toLocaleString()}</td>
                                      <td className="py-1 text-right font-bold tabular-nums w-20">{Math.round(i.qty).toLocaleString()}</td>
                                      {(() => {
                                        const dv = Math.round(i.qty) - Math.round(i.plan);
                                        return <td className={`py-1 text-right tabular-nums w-20 ${dv > 0 ? 'text-emerald-700' : dv < 0 ? 'text-rose-600' : 'text-gray-400'}`}>{dv > 0 ? `+${dv.toLocaleString()}` : dv.toLocaleString()}</td>;
                                      })()}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot className="sticky bottom-0 bg-slate-100 font-bold text-gray-800">
                  <tr className="border-t-2">
                    <td className="px-3 py-2 border-r">합계 ({daily.length}일)</td>
                    <td className="px-3 py-2 text-right tabular-nums text-cyan-700/80">{planSum.small.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-violet-700/80">{planSum.large.toLocaleString()}</td>
                    {dailyHasUnknown && <td className="px-3 py-2 text-right tabular-nums text-amber-700">{planSum.unknown.toLocaleString()}</td>}
                    <td className="px-3 py-2 text-right tabular-nums border-r">{planSum.total.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-cyan-700">{sum.small.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-violet-700">{sum.large.toLocaleString()}</td>
                    {dailyHasUnknown && <td className="px-3 py-2 text-right tabular-nums text-amber-700">{sum.unknown.toLocaleString()}</td>}
                    <td className="px-3 py-2 text-right tabular-nums border-r">{total.toLocaleString()}</td>
                    <DiffCell v={total - planSum.total} />
                    <td className="px-3 py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        ) : loading ? (
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
