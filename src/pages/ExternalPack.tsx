import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { Item, MachineEntry } from '../types';

const MACHINES = ['1호기', '2호기', '3호기'] as const;

export default function ExternalPack() {
  const { id } = useParams();
  const machine = `${id}호기`;
  const [date, setDate] = useState(loadViewDate);
  useEffect(() => { saveViewDate(date); }, [date]);
  const today = todayKey();
  const isToday = date === today;

  const [items, setItems] = useState<Item[]>([]);
  const [entries, setEntries] = useState<MachineEntry[]>([]);
  const [allMachineQty, setAllMachineQty] = useState<Record<string, Record<string, number>>>({
    '1호기': {}, '2호기': {}, '3호기': {},
  });

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
      list.sort((a, b) => (b.workTime || b.additionalWorkTime || '').localeCompare(a.workTime || a.additionalWorkTime || ''));
      setEntries(list);
    });
  }, [date, machine]);

  useEffect(() => {
    setAllMachineQty({ '1호기': {}, '2호기': {}, '3호기': {} });
    const unsubs = MACHINES.map((m) =>
      onSnapshot(collection(db, 'days', date, 'machines', m, 'entries'), (snap) => {
        const map: Record<string, number> = {};
        snap.forEach((d) => {
          const e = d.data();
          const key = String(e.code || '').toLowerCase();
          const qty = (e.actualProduction || 0) + (e.additionalProduction || 0);
          map[key] = (map[key] || 0) + qty;
        });
        setAllMachineQty((prev) => ({ ...prev, [m]: map }));
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [date]);

  const combinedByCode = useMemo(() => {
    const result: Record<string, number> = {};
    MACHINES.forEach((m) => {
      Object.entries(allMachineQty[m]).forEach(([code, qty]) => {
        result[code] = (result[code] || 0) + qty;
      });
    });
    return result;
  }, [allMachineQty]);

  const rows = useMemo(() => {
    const itemMap = new Map(items.map((i) => [i.code.toLowerCase(), i]));
    return entries.map((e, idx) => {
      const item = itemMap.get(e.code.toLowerCase());
      const orderQty = item?.orderQty || 0;
      const totalQty = item?.totalQty || 0;
      const rowActual = (e.actualProduction || 0) + (e.additionalProduction || 0);
      const combined = combinedByCode[e.code.toLowerCase()] || 0;
      const combinedDiff = combined - totalQty;
      return {
        key: `${e.code}-${idx}`,
        code: e.code,
        name: item?.name || '',
        orderQty,
        shipped: totalQty,
        actual: rowActual,
        combined,
        combinedDiff,
      };
    });
  }, [items, entries, combinedByCode]);

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
            {rows.map((r) => {
              let rowBg = '';
              if (r.shipped > 0) {
                if (r.combinedDiff > 0) rowBg = 'bg-yellow-200';
                else if (r.combinedDiff === 0) rowBg = 'bg-green-200';
                else rowBg = 'bg-red-200';
              }
              const diffColor =
                r.combinedDiff > 0 ? 'text-green-700' :
                r.combinedDiff < 0 ? 'text-red-700' : '';
              return (
                <tr key={r.key} className={`border-t ${rowBg}`}>
                  <td className="p-2 font-mono">{r.code}</td>
                  <td className="p-2">{r.name}</td>
                  <td className="p-2 text-right">{r.orderQty}</td>
                  <td className="p-2 text-right">{r.shipped}</td>
                  <td className="p-2 text-right font-bold">{r.actual}</td>
                  <td className={`p-2 text-right font-bold ${diffColor}`}>
                    {r.combinedDiff > 0 ? `+${r.combinedDiff}` : r.combinedDiff || ''}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-400">{machine}에서 입력된 내역이 없습니다</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
