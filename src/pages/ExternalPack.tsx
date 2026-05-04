import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { Item, MachineEntry } from '../types';

export default function ExternalPack() {
  const { id } = useParams();
  const machine = `${id}호기`;
  const [date, setDate] = useState(loadViewDate);
  useEffect(() => { saveViewDate(date); }, [date]);
  const today = todayKey();
  const isToday = date === today;

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
      list.sort((a, b) => b.workTime.localeCompare(a.workTime));
      setEntries(list);
    });
  }, [date, machine]);

  const rows = useMemo(() => {
    const itemMap = new Map(items.map((i) => [i.code.toLowerCase(), i]));
    return entries.map((e) => {
      const item = itemMap.get(e.code.toLowerCase());
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
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold">외포장-{id}</h2>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        />
        {!isToday && (
          <button
            onClick={() => setDate(today)}
            className="px-3 py-1 text-xs rounded bg-blue-100 text-blue-700 font-medium hover:bg-blue-200"
          >
            오늘로
          </button>
        )}
        {!isToday && (
          <span className="text-xs text-orange-600 font-medium">⚠ 과거 날짜 보는 중</span>
        )}
      </div>
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
