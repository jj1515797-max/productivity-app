import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import type { Item, MachineEntry } from '../types';

export default function ExternalPack() {
  const { id } = useParams();
  const machine = `${id}호기`;
  const date = todayKey();

  const [items, setItems] = useState<Item[]>([]);
  const [entries, setEntries] = useState<MachineEntry[]>([]);

  useEffect(() => {
    return onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      setItems(list);
    });
  }, [date]);

  useEffect(() => {
    return onSnapshot(collection(db, 'days', date, 'machines', machine, 'entries'), (snap) => {
      const list: MachineEntry[] = [];
      snap.forEach((d) => list.push(d.data() as MachineEntry));
      setEntries(list);
    });
  }, [date, machine]);

  const rows = useMemo(() => {
    const itemMap = new Map(items.map((i) => [i.code, i]));
    return entries.map((e) => {
      const item = itemMap.get(e.code);
      const orderQty = item?.orderQty || 0;
      const totalQty = item?.totalQty || 0;
      const shortage = e.actualProduction - totalQty;
      return {
        code: e.code,
        name: item?.name || '',
        orderQty,
        shipped: totalQty,
        actual: e.actualProduction,
        shortage,
      };
    });
  }, [items, entries]);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">외포장-{id}</h2>
      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-xs text-slate-600">
            <tr>
              <th className="p-2 text-left">코드</th>
              <th className="p-2 text-left">품목명</th>
              <th className="p-2 text-right">주문수량</th>
              <th className="p-2 text-right">발주량</th>
              <th className="p-2 text-right">실제 생산량</th>
              <th className="p-2 text-right">모자란 수량</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className={`border-t ${r.shortage > 0 ? 'bg-yellow-50' : ''} ${r.shortage < 0 ? 'bg-red-50' : ''}`}>
                <td className="p-2 font-mono">{r.code}</td>
                <td className="p-2">{r.name}</td>
                <td className="p-2 text-right">{r.orderQty}</td>
                <td className="p-2 text-right">{r.shipped}</td>
                <td className="p-2 text-right font-bold">{r.actual}</td>
                <td className={`p-2 text-right font-bold ${r.shortage > 0 ? 'text-green-600' : r.shortage < 0 ? 'text-red-600' : ''}`}>
                  {r.shortage > 0 ? `+${r.shortage}` : r.shortage || ''}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-400">{machine}에서 입력된 내역이 없습니다</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
