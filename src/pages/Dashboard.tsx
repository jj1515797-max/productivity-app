import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import type { Item } from '../types';

export default function Dashboard() {
  const [items, setItems] = useState<Item[]>([]);
  const [pasteText, setPasteText] = useState('');
  const date = todayKey();

  useEffect(() => {
    const ref = collection(db, 'days', date, 'items');
    return onSnapshot(ref, (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      list.sort((a, b) => a.code.localeCompare(b.code));
      setItems(list);
    });
  }, [date]);

  const stats = useMemo(() => {
    const totalQty = items.reduce((s, i) => s + (i.totalQty || 0), 0);
    const actual = items.reduce((s, i) => s + (i.actualProduction || 0), 0);
    const itemCount = items.length;
    const completedItems = items.filter((i) => i.actualProduction >= i.totalQty && i.totalQty > 0).length;
    const pct = totalQty ? Math.round((actual / totalQty) * 100) : 0;
    return { totalQty, actual, itemCount, completedItems, pct };
  }, [items]);

  const onPaste = async () => {
    const rows = pasteText
      .split('\n')
      .map((r) => r.split('\t'))
      .filter((cols) => cols.length >= 9 && cols[0]?.trim());

    if (!rows.length) return alert('붙여넣을 데이터가 없습니다');

    const batch = writeBatch(db);
    for (const cols of rows) {
      const code = cols[0].trim();
      const num = (s: string) => {
        const n = parseFloat((s || '').replace(/,/g, ''));
        return isNaN(n) ? 0 : n;
      };
      const item: Item = {
        id: code,
        code,
        name: cols[1]?.trim() || '',
        orderQty: num(cols[2]),
        coupang: num(cols[3]),
        marketKurly: num(cols[4]),
        totalQty: num(cols[8]),
        actualProduction: 0,
        date,
      };
      batch.set(doc(db, 'days', date, 'items', code), item);
    }
    await batch.commit();
    setPasteText('');
  };

  const clearAll = async () => {
    if (!confirm('오늘 데이터를 모두 삭제할까요?')) return;
    const batch = writeBatch(db);
    items.forEach((i) => batch.delete(doc(db, 'days', date, 'items', i.code)));
    await batch.commit();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="품목수" value={`${stats.itemCount} 품목`} />
        <Stat label="총 수량" value={`${stats.totalQty.toLocaleString()} EA`} />
        <Stat label="완료된 수량" value={`${stats.actual} EA`} />
        <Stat label="진행률" value={`${stats.pct}%`} highlight={stats.pct === 100} />
        <Stat label="완료된 품목" value={`${stats.completedItems} 품목`} />
      </div>

      {items.length === 0 ? (
        <div className="bg-white border rounded-lg p-4 space-y-3">
          <h2 className="font-semibold">오늘 데이터 붙여넣기</h2>
          <p className="text-sm text-slate-500">
            ERP에서 가공한 데이터를 탭으로 구분된 형식 (코드 / 품목명 / 주문수량 / 쿠팡 / 마켓컬리 / (사용X) / (사용X) / (사용X) / 총수량) 그대로 붙여넣으세요.
          </p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            className="w-full h-40 border rounded-md p-3 font-mono text-sm"
            placeholder="A01\t순수쌀미음\t21\t-\t-\t...\t21"
          />
          <button
            onClick={onPaste}
            className="bg-slate-900 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-slate-700"
          >
            등록
          </button>
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="flex justify-between items-center p-3 border-b bg-slate-50">
            <h2 className="font-semibold">오늘 품목 ({items.length})</h2>
            <button onClick={clearAll} className="text-xs text-red-500 hover:underline">전체 삭제</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-slate-600 text-xs">
                <tr>
                  <th className="p-2 text-left">코드</th>
                  <th className="p-2 text-left">품목명</th>
                  <th className="p-2 text-right">주문수량</th>
                  <th className="p-2 text-right">쿠팡</th>
                  <th className="p-2 text-right">마켓컬리</th>
                  <th className="p-2 text-right">총수량</th>
                  <th className="p-2 text-right">실제 생산량</th>
                  <th className="p-2 text-right">±</th>
                  <th className="p-2 text-center">냉각 종료</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const diff = it.actualProduction - it.totalQty;
                  const done = it.actualProduction >= it.totalQty && it.totalQty > 0;
                  const short = it.actualProduction > 0 && it.actualProduction < it.totalQty;
                  return (
                    <tr
                      key={it.code}
                      className={`border-t ${done ? 'bg-green-100' : ''} ${short ? 'bg-red-50' : ''}`}
                    >
                      <td className="p-2 font-mono">{it.code}</td>
                      <td className="p-2 font-medium">{it.name}</td>
                      <td className="p-2 text-right">{it.orderQty || '-'}</td>
                      <td className="p-2 text-right text-orange-700">{it.coupang || '-'}</td>
                      <td className="p-2 text-right text-blue-700">{it.marketKurly || '-'}</td>
                      <td className="p-2 text-right font-semibold">{it.totalQty}</td>
                      <td className="p-2 text-right">{it.actualProduction}</td>
                      <td className={`p-2 text-right font-bold ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                        {diff > 0 ? `+${diff}` : diff || ''}
                      </td>
                      <td className="p-2 text-center text-xs text-slate-500">{it.coolingEndTime || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 border ${highlight ? 'bg-green-100 border-green-300' : 'bg-white'}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-bold mt-1">{value}</div>
    </div>
  );
}
