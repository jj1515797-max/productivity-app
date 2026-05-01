import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import type { Item } from '../types';

export default function Remaining() {
  const [items, setItems] = useState<Item[]>([]);
  const date = todayKey();

  useEffect(() => {
    return onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      list.sort((a, b) => a.code.localeCompare(b.code));
      setItems(list);
    });
  }, [date]);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">잔여량 확인</h2>
      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-xs text-slate-600">
            <tr>
              <th className="p-2 text-left">코드</th>
              <th className="p-2 text-left">품목명</th>
              <th className="p-2 text-right">잔여량</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const remain = it.totalQty - it.actualProduction;
              return (
                <tr key={it.code} className="border-t">
                  <td className="p-2 font-mono">{it.code}</td>
                  <td className="p-2">{it.name}</td>
                  <td className={`p-2 text-right font-bold ${remain <= 0 ? 'text-green-600' : 'text-slate-700'}`}>
                    {remain <= 0 ? '완료' : remain}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
