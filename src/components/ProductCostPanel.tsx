/** 원재료분석 맨 아래 — 품목별 원재료비 (A월 · B월 나란히)
 *  원재료비 = 레시피 × 생산량 × 그 달 재고평가 단가. 원재료별 계산과 같은 근거를 품목으로 묶은 것이라
 *  두 달 모두 품목 합계 = 원재료별 원재료비 합계. */
import { useMemo, useState } from 'react';
import type { ProductCostLine } from '../lib/materialUsage';

type Side = { lines: ProductCostLine[]; total: number; qty: number };
type SortKey = 'bCost' | 'aCost' | 'bUnit' | 'delta';

const won = (n: number) => Math.round(n).toLocaleString();

export default function ProductCostPanel({ monthA, monthB, a, b, recipeLabel }: {
  monthA: string; monthB: string; a: Side; b: Side; recipeLabel: string;
}) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'cold' | 'ambient'>('all');
  const [sort, setSort] = useState<SortKey>('bCost');

  const rows = useMemo(() => {
    const m = new Map<string, { key: string; code: string; label: string; kind: 'cold' | 'ambient'; a?: ProductCostLine; b?: ProductCostLine }>();
    const put = (l: ProductCostLine, side: 'a' | 'b') => {
      const r = m.get(l.key) || { key: l.key, code: l.code, label: l.label, kind: l.kind };
      r[side] = l;
      if (side === 'b' || !r.label) r.label = l.label;
      m.set(l.key, r);
    };
    a.lines.forEach((l) => put(l, 'a'));
    b.lines.forEach((l) => put(l, 'b'));
    return [...m.values()];
  }, [a, b]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = rows.filter((r) => (kind === 'all' || r.kind === kind)
      && (!t || r.code.toLowerCase().includes(t) || r.label.toLowerCase().includes(t)));
    const delta = (r: typeof rows[number]) => (r.a && r.b && r.a.qty > 0 && r.b.qty > 0 ? r.b.unitCost - r.a.unitCost : -Infinity);
    const key: Record<SortKey, (r: typeof rows[number]) => number> = {
      bCost: (r) => r.b?.cost ?? -1,
      aCost: (r) => r.a?.cost ?? -1,
      bUnit: (r) => r.b?.unitCost ?? -1,
      delta: (r) => Math.abs(delta(r)) === Infinity ? -1 : Math.abs(delta(r)),
    };
    return list.sort((x, y) => key[sort](y) - key[sort](x));
  }, [rows, q, kind, sort]);

  const sum = (side: 'a' | 'b') => shown.reduce((s, r) => s + (r[side]?.cost || 0), 0);
  const sumQty = (side: 'a' | 'b') => shown.reduce((s, r) => s + (r[side]?.qty || 0), 0);
  const filtered = shown.length !== rows.length;

  const cell = (l?: ProductCostLine) => {
    if (!l) return <><td className="px-2 py-1.5 text-right text-gray-300">—</td><td className="px-2 py-1.5 text-right text-gray-300">—</td><td className="px-2 py-1.5 text-right text-gray-300 border-r">—</td></>;
    const warn = !l.hasRecipe ? '레시피 없음 — 원재료비 0으로 빠짐' : l.missingPriceGrams > 0 ? `단가 없는 원재료 ${Math.round(l.missingPriceGrams).toLocaleString()}g 은 금액에서 빠짐` : '';
    return (
      <>
        <td className="px-2 py-1.5 text-right tabular-nums">{l.qty.toLocaleString()}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-semibold" title={warn || undefined}>
          {l.hasRecipe ? won(l.unitCost) : <span className="text-rose-500 text-xs">레시피 없음</span>}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums border-r">{l.hasRecipe ? won(l.cost) : ''}</td>
      </>
    );
  };

  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b bg-slate-50 flex items-center gap-3 flex-wrap">
        <span className="font-bold text-gray-800">💵 품목별 원재료비</span>
        <span className="text-xs text-gray-500">레시피({recipeLabel}) × 생산량 × 그 달 재고평가 단가 · 품목 합계 = 원재료별 원재료비 합계 · 단가 없는 원재료(정제수 등)는 0원</span>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 코드·품목명"
            className="border rounded px-2 py-1 text-sm w-40" />
          <div className="flex rounded border overflow-hidden text-xs">
            {([['all', '전체'], ['cold', '냉장'], ['ambient', '실온']] as const).map(([k, t]) => (
              <button key={k} onClick={() => setKind(k)} className={`px-2.5 py-1 ${kind === k ? 'bg-gray-800 text-white' : 'bg-white text-gray-600'}`}>{t}</button>
            ))}
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="border rounded px-2 py-1 text-xs">
            <option value="bCost">{monthB} 원재료비 큰 순</option>
            <option value="aCost">{monthA} 원재료비 큰 순</option>
            <option value="bUnit">{monthB} 개당 원재료비 큰 순</option>
            <option value="delta">개당 증감 큰 순</option>
          </select>
        </div>
      </div>
      <div className="overflow-auto max-h-[70vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-100 text-xs text-gray-600">
            <tr>
              <th rowSpan={2} className="px-2 py-1.5 text-left border-r">코드</th>
              <th rowSpan={2} className="px-2 py-1.5 text-left border-r">품목</th>
              <th colSpan={3} className="px-2 py-1 text-center text-blue-700 border-r">{monthA}</th>
              <th colSpan={3} className="px-2 py-1 text-center text-rose-700 border-r">{monthB}</th>
              <th rowSpan={2} className="px-2 py-1.5 text-right">개당 증감</th>
            </tr>
            <tr>
              <th className="px-2 py-1 text-right">생산 EA</th><th className="px-2 py-1 text-right">개당 ₩</th><th className="px-2 py-1 text-right border-r">원재료비 ₩</th>
              <th className="px-2 py-1 text-right">생산 EA</th><th className="px-2 py-1 text-right">개당 ₩</th><th className="px-2 py-1 text-right border-r">원재료비 ₩</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const d = r.a && r.b && r.a.hasRecipe && r.b.hasRecipe && r.a.qty > 0 && r.b.qty > 0 ? r.b.unitCost - r.a.unitCost : null;
              const pct = d !== null && r.a!.unitCost > 0 ? (d / r.a!.unitCost) * 100 : null;
              return (
                <tr key={r.key} className="border-t hover:bg-slate-50">
                  <td className="px-2 py-1.5 font-mono text-xs text-gray-600 border-r whitespace-nowrap">{r.code || <span className="text-orange-600">실온</span>}</td>
                  <td className="px-2 py-1.5 border-r max-w-[16rem] truncate" title={r.label}>{r.label}</td>
                  {cell(r.a)}
                  {cell(r.b)}
                  <td className={`px-2 py-1.5 text-right tabular-nums whitespace-nowrap ${d === null ? 'text-gray-300' : d > 0 ? 'text-rose-600' : d < 0 ? 'text-blue-600' : 'text-gray-500'}`}>
                    {d === null ? '—' : `${d > 0 ? '+' : ''}${won(d)}`}
                    {pct !== null && <span className="text-[11px] ml-1">({pct > 0 ? '+' : ''}{pct.toFixed(1)}%)</span>}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">맞는 품목이 없습니다</td></tr>
            )}
          </tbody>
          <tfoot className="sticky bottom-0 bg-slate-100 font-bold text-gray-800">
            <tr className="border-t-2">
              <td colSpan={2} className="px-2 py-2 border-r">{filtered ? `보이는 ${shown.length}품목 합계` : `합계 (${rows.length}품목)`}</td>
              {(['a', 'b'] as const).map((side) => {
                const c = sum(side), n = sumQty(side);
                return [
                  <td key={`${side}q`} className="px-2 py-2 text-right tabular-nums">{n.toLocaleString()}</td>,
                  <td key={`${side}u`} className="px-2 py-2 text-right tabular-nums">{n > 0 ? won(c / n) : ''}</td>,
                  <td key={`${side}c`} className="px-2 py-2 text-right tabular-nums border-r">{won(c)}</td>,
                ];
              })}
              <td className="px-2 py-2" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
