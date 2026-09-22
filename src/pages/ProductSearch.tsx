/** 분석 > 제품검색 — 품목코드나 제품명으로 그 제품의 생산 이력을 본다.
 *
 *  "F553 이 언제 몇 개씩 나갔나" 를 한 화면에서 답한다.
 *  수량은 월별현황·용기분석과 같은 규칙(computeMonthlyProduction)에서 나오므로
 *  여기 숫자와 다른 화면 숫자가 어긋나지 않는다.
 *
 *  냉장은 단축코드(F553)로, 실온은 제품명으로 묶인다 — 실온에는 코드가 없다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ExcelJS from 'exceljs';
import { canonicalShort, compareCode } from '../lib/codeUtil';
import { loadContainerMonth } from '../lib/containerLoad';
import { todayKey } from '../lib/dateUtil';

/** 데이터가 쌓이기 시작한 달 — 이 앞은 조회해도 빈 달이라 후보에서 뺀다 */
const DATA_START = '2026-02';

const shiftMonth = (m: string, d: number) => {
  const [y, mm] = m.split('-').map(Number);
  const x = new Date(y, mm - 1 + d, 1);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
};
const monthsBetween = (a: string, b: string) => {
  const out: string[] = [];
  for (let m = a; m <= b; m = shiftMonth(m, 1)) out.push(m);
  return out;
};
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const dowOf = (d: string) => DOW[new Date(`${d}T00:00:00`).getDay()];
const nf = (n: number) => Math.round(n).toLocaleString();

/** 한 달치 결과 — 월 단위로 캐시한다 */
interface MonthData {
  byDateCode: Record<string, Record<string, number>>;
  ambientRows: { productName: string; qty: number; date: string }[];
  nameByShort: Record<string, string>;
  erpByShort: Record<string, string>;
}

const CK = 'productSearch:';
const isPast = (m: string) => m < todayKey().slice(0, 7);
function readCache(m: string): MonthData | null {
  try {
    const raw = localStorage.getItem(CK + m);
    if (!raw) return null;
    const { ts, v } = JSON.parse(raw);
    if (isPast(m)) {
      const [y, mm] = m.split('-').map(Number);
      return ts < new Date(y, mm, 1).getTime() ? null : v;  // 진행중에 담긴 부분집계는 버린다
    }
    return Date.now() - ts > 5 * 60 * 1000 ? null : v;
  } catch { return null; }
}
const writeCache = (m: string, v: MonthData) => {
  try { localStorage.setItem(CK + m, JSON.stringify({ ts: Date.now(), v })); } catch { /* 용량초과 무시 */ }
};

/** 검색 결과 한 제품 */
interface Hit {
  key: string;             // 냉장=단축코드, 실온=제품명
  kind: '냉장' | '실온';
  name: string;
  erp: string;
  total: number;
  days: { date: string; qty: number }[];
}

export default function ProductSearch() {
  const thisMonth = todayKey().slice(0, 7);
  const [from, setFrom] = useState(() => {
    const back = shiftMonth(thisMonth, -2);
    return back < DATA_START ? DATA_START : back;
  });
  const [to, setTo] = useState(thisMonth);
  const [q, setQ] = useState('');
  const [data, setData] = useState<Record<string, MonthData>>({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState('');
  const abort = useRef(false);

  const months = useMemo(() => (from <= to ? monthsBetween(from, to) : []), [from, to]);
  const missing = months.filter((m) => !data[m]);

  /* 캐시에 있는 달을 먼저 올린다 — 같은 기간을 다시 볼 때 즉시 뜬다 */
  useEffect(() => {
    const got: Record<string, MonthData> = {};
    months.forEach((m) => { const v = readCache(m); if (v) got[m] = v; });
    if (Object.keys(got).length) setData((p) => ({ ...got, ...p }));
  }, [months]);

  const load = useCallback(async (list: string[]) => {
    setErr(''); abort.current = false;
    for (let i = 0; i < list.length; i++) {
      if (abort.current) { setBusy(''); return; }
      const m = list[i];
      setBusy(`${m} 불러오는 중… (${i + 1}/${list.length})`);
      try {
        const r = await loadContainerMonth(m);
        const v: MonthData = {
          byDateCode: r.byDateCode, ambientRows: r.ambientRows,
          nameByShort: r.nameByShort, erpByShort: r.erpByShort,
        };
        writeCache(m, v);
        setData((p) => ({ ...p, [m]: v }));
      } catch (e) {
        setErr(`${m} 불러오기 실패: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
    setBusy('');
  }, []);

  /* ── 검색 ── */
  const hits: Hit[] = useMemo(() => {
    const term = q.trim();
    if (!term) return [];
    const up = term.toUpperCase();
    const short = canonicalShort(term);            // 'F553', 'F-553-01' 둘 다 F553 으로
    const cold = new Map<string, Hit>();
    const amb = new Map<string, Hit>();

    months.forEach((m) => {
      const d = data[m];
      if (!d) return;
      // 냉장 — 코드 · 이름 · ERP 전체코드 어느 쪽이든 걸리면 잡는다
      Object.entries(d.byDateCode).forEach(([date, codes]) => {
        Object.entries(codes).forEach(([code, qty]) => {
          if (Math.round(qty) === 0) return;
          const name = d.nameByShort[code] || '';
          const erp = d.erpByShort[code] || '';
          const ok = code.toUpperCase().includes(up)
            || (short.length > 1 && code.toUpperCase() === short)
            || erp.toUpperCase().includes(up)
            || name.includes(term);
          if (!ok) return;
          let h = cold.get(code);
          if (!h) { h = { key: code, kind: '냉장', name, erp, total: 0, days: [] }; cold.set(code, h); }
          if (!h.name && name) h.name = name;
          if (!h.erp && erp) h.erp = erp;
          h.total += qty;
          h.days.push({ date, qty });
        });
      });
      // 실온 — 제품명만 있다
      d.ambientRows.forEach((a) => {
        if (!a.productName || !a.qty) return;
        if (!a.productName.includes(term)) return;
        let h = amb.get(a.productName);
        if (!h) { h = { key: a.productName, kind: '실온', name: a.productName, erp: '', total: 0, days: [] }; amb.set(a.productName, h); }
        h.total += a.qty;
        h.days.push({ date: a.date, qty: a.qty });
      });
    });

    const out = [...cold.values(), ...amb.values()];
    out.forEach((h) => h.days.sort((a, b) => a.date.localeCompare(b.date)));
    return out.sort((a, b) => b.total - a.total || compareCode(a.key, b.key));
  }, [q, months, data]);

  /* 검색 결과가 하나뿐이면 바로 펼친다 — 한 번 더 누르게 할 이유가 없다 */
  useEffect(() => {
    if (hits.length === 1) setPicked(hits[0].key);
    else if (!hits.some((h) => h.key === picked)) setPicked('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits]);

  const sel = hits.find((h) => h.key === picked) || null;

  /* 선택 제품의 월별 합계 */
  const byMonth = useMemo(() => {
    if (!sel) return [];
    const m = new Map<string, number>();
    sel.days.forEach((d) => {
      const k = d.date.slice(0, 7);
      m.set(k, (m.get(k) || 0) + d.qty);
    });
    return months.map((k) => ({ month: k, qty: m.get(k) || 0 }));
  }, [sel, months]);

  const stat = useMemo(() => {
    if (!sel || !sel.days.length) return null;
    const qs = sel.days.map((d) => d.qty);
    const activeMonths = new Set(sel.days.map((d) => d.date.slice(0, 7))).size;
    return {
      total: sel.total,
      dayCount: sel.days.length,
      first: sel.days[0].date,
      last: sel.days[sel.days.length - 1].date,
      avg: sel.total / sel.days.length,
      max: Math.max(...qs),
      perMonth: sel.total / Math.max(1, activeMonths),
    };
  }, [sel]);

  const maxMonth = Math.max(1, ...byMonth.map((b) => b.qty));

  const download = async () => {
    if (!sel) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sel.key.slice(0, 28));
    ws.columns = [{ width: 14 }, { width: 8 }, { width: 14 }];
    ws.addRow([`${sel.name || sel.key} 생산 이력`]);
    ws.mergeCells('A1:C1');
    ws.getCell('A1').font = { size: 14, bold: true };
    ws.addRow([`${sel.kind} · ${sel.erp || sel.key} · ${from} ~ ${to}`]).getCell(1).font = { size: 10, color: { argb: 'FF808080' } };
    ws.addRow([]);
    const head = ws.addRow(['날짜', '요일', '생산량(EA)']);
    head.eachCell((c) => {
      c.font = { bold: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
      c.alignment = { horizontal: 'center' };
    });
    sel.days.forEach((d) => {
      const r = ws.addRow([d.date, dowOf(d.date), Math.round(d.qty)]);
      r.getCell(2).alignment = { horizontal: 'center' };
      r.getCell(3).numFmt = '#,##0';
    });
    const tot = ws.addRow(['합계', '', Math.round(sel.total)]);
    tot.font = { bold: true };
    tot.getCell(3).numFmt = '#,##0';
    ws.views = [{ state: 'frozen', ySplit: 4 }];
    const buf = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url; a.download = `생산이력_${sel.name || sel.key}_${from}~${to}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  const monthOpts = monthsBetween(DATA_START, thisMonth);

  return (
    <div className="space-y-4">
      {/* 검색 */}
      <div className="bg-white border rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-gray-800 text-lg">🔎 제품검색</span>
          <span className="text-xs text-gray-400">품목코드 · 제품명으로 생산 이력 찾기</span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            id="ps-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="F553 · F-553-01 · 한우 … 코드나 제품명"
            className="flex-1 min-w-[220px] border rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-400 outline-none"
          />
          <div className="flex items-center gap-1 text-sm">
            <select value={from} onChange={(e) => setFrom(e.target.value)} className="border rounded px-2 py-2">
              {monthOpts.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="text-gray-400">~</span>
            <select value={to} onChange={(e) => setTo(e.target.value)} className="border rounded px-2 py-2">
              {monthOpts.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          {busy ? (
            <button onClick={() => { abort.current = true; }}
              className="px-3 py-2 text-sm rounded border hover:bg-gray-50">중단</button>
          ) : (
            <button onClick={() => load(missing.length ? missing : months)}
              disabled={months.length === 0}
              className="px-4 py-2 text-sm rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:bg-gray-300">
              {missing.length ? `📥 불러오기 (${missing.length}개월)` : '🔄 다시 불러오기'}
            </button>
          )}
        </div>

        {busy && <div className="text-xs text-blue-600 font-semibold">{busy}</div>}
        {err && <div className="bg-red-50 border border-red-300 rounded p-2.5 text-sm text-red-700">{err}</div>}

        {from > to && (
          <div className="bg-amber-50 border border-amber-300 rounded p-2.5 text-sm text-amber-800">
            시작 월이 종료 월보다 뒤입니다.
          </div>
        )}
        {missing.length > 0 && !busy && from <= to && (
          <div className="bg-sky-50 border border-sky-300 rounded p-2.5 text-sm text-sky-800">
            아직 안 불러온 달이 {missing.length}개 있습니다 ({missing.join(', ')}).
            <b> 「불러오기」</b>를 누르면 생산 데이터에서 읽어옵니다. 한 번 읽은 지난달은 저장돼 다시 읽지 않습니다.
          </div>
        )}
      </div>

      {/* 결과 목록 */}
      {q.trim() && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b bg-slate-50 text-sm">
            <b className="text-gray-800">검색 결과 {hits.length}건</b>
            {hits.length > 1 && <span className="text-gray-500 ml-2">· 하나를 고르면 아래에 이력이 나옵니다</span>}
          </div>
          {hits.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              {months.some((m) => data[m])
                ? <>「{q}」 로 생산된 기록이 없습니다. 기간을 넓히거나 코드 일부만 넣어 보세요.</>
                : <>먼저 <b>「불러오기」</b>를 눌러 생산 데이터를 읽어오세요.</>}
            </div>
          ) : (
            <div className="divide-y max-h-72 overflow-y-auto">
              {hits.map((h) => (
                <button key={h.kind + h.key} onClick={() => setPicked(h.key)}
                  className={`w-full text-left px-4 py-2.5 flex items-center gap-3 hover:bg-slate-50 ${
                    picked === h.key ? 'bg-blue-50/70' : ''}`}>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    h.kind === '냉장' ? 'bg-cyan-100 text-cyan-700' : 'bg-amber-100 text-amber-700'}`}>
                    {h.kind}
                  </span>
                  <span className="font-mono font-bold text-gray-700 text-sm">{h.erp || h.key}</span>
                  <span className="text-gray-800 text-sm flex-1 truncate">{h.name || '(제품 DB에 이름 없음)'}</span>
                  <span className="text-xs text-gray-500">{h.days.length}일</span>
                  <span className="font-bold tabular-nums text-gray-800">{nf(h.total)}</span>
                  <span className="text-xs text-gray-400">EA</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 선택 제품 상세 */}
      {sel && stat && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card label="총 생산량" sub={`${from} ~ ${to}`} v={nf(stat.total)} unit="EA" tone="ok" />
            <Card label="생산 일수" sub={`${stat.first} ~ ${stat.last}`} v={String(stat.dayCount)} unit="일" />
            <Card label="생산일 평균" sub={`최대 ${nf(stat.max)} EA`} v={nf(stat.avg)} unit="EA" />
            <Card label="월평균" sub="생산이 있던 달 기준" v={nf(stat.perMonth)} unit="EA" />
          </div>

          {/* 월별 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
              <span className="font-bold text-gray-800 text-sm">{sel.name || sel.key} · 월별 생산량</span>
              <span className="text-xs text-gray-400">{sel.kind} · {sel.erp || sel.key}</span>
              <button onClick={download}
                className="ml-auto px-3 py-1.5 text-xs rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700">
                📥 엑셀
              </button>
            </div>
            <div className="p-4 space-y-1.5">
              {byMonth.map((b) => (
                <div key={b.month} className="flex items-center gap-3">
                  <span className="font-mono text-xs text-gray-500 w-16 shrink-0">{b.month}</span>
                  <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden">
                    <div className="h-full bg-blue-500 rounded transition-all"
                      style={{ width: `${(b.qty / maxMonth) * 100}%` }} />
                  </div>
                  <span className={`font-bold tabular-nums text-sm w-20 text-right ${
                    b.qty ? 'text-gray-800' : 'text-gray-300'}`}>{b.qty ? nf(b.qty) : '-'}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 일별 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">
              일별 생산 기록 <span className="text-xs text-gray-500 font-normal">· {stat.dayCount}일</span>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-gray-600 sticky top-0">
                  <tr>
                    <th className="px-4 py-2 text-left w-32">날짜</th>
                    <th className="px-2 py-2 text-center w-14">요일</th>
                    <th className="px-4 py-2 text-right w-28">생산량(EA)</th>
                    <th className="px-4 py-2 text-left">비중</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {sel.days.map((d) => (
                    <tr key={d.date} className="hover:bg-slate-50/60">
                      <td className="px-4 py-1.5 font-mono text-gray-700">{d.date}</td>
                      <td className={`px-2 py-1.5 text-center text-xs ${
                        dowOf(d.date) === '일' ? 'text-red-500' : dowOf(d.date) === '토' ? 'text-blue-500' : 'text-gray-500'}`}>
                        {dowOf(d.date)}
                      </td>
                      <td className="px-4 py-1.5 text-right font-bold tabular-nums">{nf(d.qty)}</td>
                      <td className="px-4 py-1.5">
                        <div className="h-2 bg-gray-100 rounded overflow-hidden max-w-[220px]">
                          <div className="h-full bg-blue-400 rounded" style={{ width: `${(d.qty / stat.max) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-gray-500 px-1">
            수량은 <b>월별현황·용기분석과 같은 규칙</b>으로 계산합니다 — 그날 잔여량 수정이 있으면 「계획 + 잔여량」,
            없으면 「호기 실적 합」입니다. 그래서 다른 분석 화면의 숫자와 어긋나지 않습니다.
          </p>
        </>
      )}

      {!q.trim() && (
        <div className="bg-white border rounded-lg p-10 text-center text-gray-400 text-sm">
          위 칸에 <b className="text-gray-600">품목코드</b>나 <b className="text-gray-600">제품명</b>을 넣으세요.
          <div className="text-xs mt-2 text-gray-400">
            예: <code className="bg-gray-100 px-1.5 py-0.5 rounded">F553</code> ·
            <code className="bg-gray-100 px-1.5 py-0.5 rounded ml-1">F-553-01</code> ·
            <code className="bg-gray-100 px-1.5 py-0.5 rounded ml-1">한우</code>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ label, sub, v, unit, tone }: {
  label: string; sub: string; v: string; unit: string; tone?: 'ok';
}) {
  return (
    <div className="bg-white border rounded-xl p-4">
      <div className="text-xs text-gray-500 font-semibold">{label}</div>
      <div className={`text-3xl font-extrabold tabular-nums mt-1 ${tone === 'ok' ? 'text-emerald-600' : 'text-gray-800'}`}>
        {v}<span className="text-base font-normal text-gray-400 ml-1">{unit}</span>
      </div>
      <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>
    </div>
  );
}
