/** 폐기금액 › 🧪 시생산비용 산출
 *  원재료를 골라(검색) 사용량(kg, 소수 5자리까지)을 넣으면 재고평가현황 단가(materialPricesInventory, 원/g)로 금액을 낸다.
 *  단가 기준: 해당월(기본) 또는 전월. 그 달 단가가 없는 원재료는 가장 가까운 이전 달 단가를 쓰고 그 달을 표시한다.
 *  입력은 그 기기(localStorage)에만 남는다 — 저장·공유하는 기록이 아니라 계산기. */
import { useEffect, useMemo, useState } from 'react';
import { CODE_KEY_PREFIX, normalizeCode, normalizeMaterialName } from '../lib/wasteCompute';

export interface InvPriceDoc { month: string; name: string; code?: string; pricePerGram: number }

interface Mat { key: string; name: string; code?: string; prices: Map<string, number> }
interface Row { key: string; name: string; code?: string; kg: string }

const LS_KEY = 'trialCost:v1';
const matKey = (name: string, code?: string) => (code ? CODE_KEY_PREFIX + normalizeCode(code) : normalizeMaterialName(name));
function shiftMonth(m: string, d: number) {
  const [y, mm] = m.split('-').map(Number);
  const t = new Date(y, mm - 1 + d, 1);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
}
const mon = (m: string) => `${Number(m.slice(5))}월`;
const parseKg = (s: string) => {
  const t = s.replace(/[,\s]/g, '');
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};
/** 금액 — 작은 값은 소수까지 */
const fmtWon = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : Math.abs(n) < 1000 ? 1 : 0 });
const fmtKgPrice = (ppg: number) => (ppg * 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });

export default function TrialCostModal({ initialMonth, priceDocs, onClose }: { initialMonth: string; priceDocs: InvPriceDoc[]; onClose: () => void }) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null') as { title?: string; rows?: Row[] } | null; } catch { return null; } })();
  const [month, setMonth] = useState(initialMonth);
  const [basis, setBasis] = useState<'cur' | 'prev'>('cur');
  const [title, setTitle] = useState(saved?.title || '');
  const [rows, setRows] = useState<Row[]>(saved?.rows || []);
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify({ title, rows })); } catch { /* noop */ } }, [title, rows]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 원재료 목록 — 코드(없으면 이름)로 묶고 달별 단가를 모은다. 이름은 가장 최근 달 것
  const mats = useMemo(() => {
    const map = new Map<string, Mat & { latest: string }>();
    priceDocs.forEach((d) => {
      const name = (d.name || '').trim();
      if (!name || !d.month) return;
      const code = (d.code || '').trim() || undefined;
      const k = matKey(name, code);
      const m = map.get(k) || { key: k, name, code, prices: new Map<string, number>(), latest: '' };
      if (d.pricePerGram > 0) m.prices.set(d.month, d.pricePerGram);
      if (d.month >= m.latest) { m.latest = d.month; m.name = name; }
      map.set(k, m);
    });
    return map;
  }, [priceDocs]);

  const priceMonth = basis === 'cur' ? month : shiftMonth(month, -1);
  /** 기준 달 단가, 없으면 가장 가까운 이전 달 */
  const priceOf = (k: string): { ppg: number; month: string; exact: boolean } | null => {
    const m = mats.get(k);
    if (!m) return null;
    const exact = m.prices.get(priceMonth);
    if (exact) return { ppg: exact, month: priceMonth, exact: true };
    const before = [...m.prices.keys()].filter((x) => x < priceMonth).sort().pop();
    return before ? { ppg: m.prices.get(before)!, month: before, exact: false } : null;
  };
  const monthHasPrices = useMemo(() => priceDocs.some((d) => d.month === priceMonth && d.pricePerGram > 0), [priceDocs, priceMonth]);

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const qn = normalizeMaterialName(q);
    return [...mats.values()]
      .filter((m) => m.name.toLowerCase().includes(q) || normalizeMaterialName(m.name).includes(qn) || (m.code || '').toLowerCase().includes(q))
      .sort((a, b) => Number(!!b.prices.get(priceMonth)) - Number(!!a.prices.get(priceMonth)) || a.name.localeCompare(b.name))
      .slice(0, 30);
  }, [mats, search, priceMonth]);

  const add = (m: Mat) => {
    setSearch('');
    if (rows.some((r) => r.key === m.key)) return;
    setRows([...rows, { key: m.key, name: m.name, code: m.code, kg: '' }]);
  };

  const calc = rows.map((r) => {
    const kg = parseKg(r.kg);
    const p = priceOf(r.key);
    const amt = p && Number.isFinite(kg) ? kg * 1000 * p.ppg : 0;
    return { r, kg, p, amt };
  });
  const totalKg = calc.reduce((s, x) => s + (Number.isFinite(x.kg) ? x.kg : 0), 0);
  const total = calc.reduce((s, x) => s + x.amt, 0);
  const noPrice = calc.filter((x) => !x.p).length;
  const fallback = calc.filter((x) => x.p && !x.p.exact).length;

  const copy = () => {
    const lines = [
      `시생산비용${title ? ` — ${title}` : ''} (${mon(priceMonth)} 재고평가 단가)`,
      ['원재료', '코드', '단가(원/kg)', '사용량(kg)', '금액(원)'].join('\t'),
      ...calc.map((x) => [x.r.name, x.r.code || '', x.p ? (x.p.ppg * 1000).toFixed(1) + (x.p.exact ? '' : ` (${mon(x.p.month)})`) : '단가 없음', Number.isFinite(x.kg) ? String(x.kg) : '', Math.round(x.amt * 10) / 10].join('\t')),
      ['합계', '', '', String(Math.round(totalKg * 1e5) / 1e5), Math.round(total)].join('\t'),
    ];
    navigator.clipboard?.writeText(lines.join('\n')).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-hidden flex flex-col">
        {/* 머리 */}
        <div className="px-5 py-3 border-b bg-violet-50 flex items-center gap-3 flex-wrap">
          <h3 className="font-bold text-gray-800">🧪 시생산비용 산출</h3>
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="border rounded px-2 py-1 text-sm font-bold bg-white" />
          <div className="flex rounded-md border overflow-hidden text-xs bg-white">
            {([['cur', `${mon(month)} 단가 (해당월)`], ['prev', `${mon(shiftMonth(month, -1))} 단가 (전월)`]] as const).map(([k, t]) => (
              <button key={k} onClick={() => setBasis(k)}
                className={`px-3 py-1.5 font-bold ${basis === k ? 'bg-violet-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>{t}</button>
            ))}
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-full hover:bg-gray-200 text-gray-500 text-lg">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {!monthHasPrices && (
            <div className="text-sm bg-amber-50 border border-amber-300 text-amber-900 rounded px-3 py-2">
              ⚠ {mon(priceMonth)} 재고평가 단가가 아직 없습니다 — 원재료마다 가장 가까운 이전 달 단가로 계산합니다{basis === 'cur' ? ' (전월 단가로 바꿔 볼 수 있어요)' : ''}.
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="시생산 이름·메모 (선택)" className="border rounded px-3 py-2 text-sm w-60" />
            <div className="relative flex-1 min-w-[16rem]">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 원재료 이름·코드 검색해서 추가 (예: 한우, 당근)"
                className="w-full border-2 border-violet-200 focus:border-violet-500 outline-none rounded px-3 py-2 text-sm" autoFocus />
              {search.trim() && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-white border rounded-lg shadow-lg z-10 max-h-72 overflow-y-auto">
                  {results.length === 0 && <div className="px-3 py-2 text-sm text-gray-500">재고평가현황에 없는 원재료입니다</div>}
                  {results.map((m) => {
                    const p = priceOf(m.key);
                    const added = rows.some((r) => r.key === m.key);
                    return (
                      <button key={m.key} onClick={() => add(m)} disabled={added}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-violet-50 flex items-center gap-2 border-b last:border-b-0 disabled:opacity-40">
                        <span className="font-medium text-gray-800">{m.name}</span>
                        {m.code && <span className="font-mono text-[11px] text-gray-400">{m.code}</span>}
                        <span className={`ml-auto text-xs tabular-nums ${!p ? 'text-rose-600' : p.exact ? 'text-gray-600' : 'text-amber-700'}`}>
                          {added ? '추가됨' : p ? `${fmtKgPrice(p.ppg)}원/kg${p.exact ? '' : ` (${mon(p.month)})`}` : '단가 없음'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-400 border rounded-lg">위에서 원재료를 검색해 추가하세요</div>
          ) : (
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full text-sm tabular-nums min-w-[640px]">
                <thead className="bg-slate-50 text-xs text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left">원재료</th>
                    <th className="px-3 py-2 text-right">단가 (원/kg) · {mon(priceMonth)}</th>
                    <th className="px-3 py-2 text-right">사용량 (kg)</th>
                    <th className="px-3 py-2 text-right">금액 (원)</th>
                    <th className="px-2 py-2 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {calc.map(({ r, kg, p, amt }, i) => (
                    <tr key={r.key}>
                      <td className="px-3 py-2">
                        <div className="font-semibold text-gray-800">{r.name}</div>
                        {r.code && <div className="font-mono text-[11px] text-gray-400">{r.code}</div>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {p ? <>{fmtKgPrice(p.ppg)}{!p.exact && <span className="ml-1 text-[11px] font-bold text-amber-700">({mon(p.month)} 단가)</span>}</> : <span className="text-rose-600 text-xs font-bold">단가 없음</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input value={r.kg} inputMode="decimal" placeholder="0.00000"
                          onChange={(e) => setRows(rows.map((x, xi) => (xi === i ? { ...x, kg: e.target.value } : x)))}
                          className={`w-36 border rounded px-2 py-1 text-right bg-yellow-50 ${Number.isFinite(kg) ? '' : 'border-rose-500 bg-rose-50'}`} />
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-gray-900">{p ? fmtWon(amt) : '—'}</td>
                      <td className="px-2 py-2 text-center"><button onClick={() => setRows(rows.filter((_, xi) => xi !== i))} className="text-gray-400 hover:text-rose-600">✕</button></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-violet-50 font-bold">
                  <tr>
                    <td className="px-3 py-2.5">합계 <span className="text-xs font-normal text-gray-500">{rows.length}종</span></td>
                    <td />
                    <td className="px-3 py-2.5 text-right">{totalKg.toLocaleString(undefined, { maximumFractionDigits: 5 })} kg</td>
                    <td className="px-3 py-2.5 text-right text-lg text-violet-800">{fmtWon(total)}원</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {(noPrice > 0 || fallback > 0) && (
            <div className="text-xs text-amber-800 space-y-0.5">
              {noPrice > 0 && <div>⚠ 단가 없는 원재료 {noPrice}종은 금액에서 빠졌습니다 (설정 › 재고평가현황)</div>}
              {fallback > 0 && <div>⚠ {fallback}종은 {mon(priceMonth)} 단가가 없어 이전 달 단가로 계산했습니다 (노란 표시)</div>}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex items-center gap-2">
          <span className="text-[11px] text-gray-500">단가 = 재고평가현황 · 입력은 이 기기에만 남습니다</span>
          <button onClick={() => { if (rows.length && window.confirm('추가한 원재료를 모두 지울까요?')) { setRows([]); setTitle(''); } }}
            className="ml-auto px-3 py-1.5 text-xs rounded border bg-white hover:bg-gray-100">비우기</button>
          <button onClick={copy} disabled={!rows.length}
            className={`px-3 py-1.5 text-xs rounded border font-bold disabled:opacity-40 ${copied ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white hover:bg-gray-100'}`}>{copied ? '복사됨 ✓' : '📋 엑셀용 복사'}</button>
          <button onClick={onClose} className="px-4 py-1.5 text-sm rounded bg-gray-800 text-white font-semibold">닫기</button>
        </div>
      </div>
    </div>
  );
}
