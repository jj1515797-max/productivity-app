import { Fragment, useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import type { Item, MachineEntry } from '../types';

const MACHINES: MachineEntry['machine'][] = ['1호기', '2호기', '3호기'];

export default function Report() {
  const [date, setDate] = useState(todayKey());
  const [items, setItems] = useState<Item[]>([]);
  const [byMachine, setByMachine] = useState<Record<string, MachineEntry[]>>({});

  useEffect(() => {
    return onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      setItems(list);
    });
  }, [date]);

  useEffect(() => {
    setByMachine({});
    const unsubs = MACHINES.map((m) =>
      onSnapshot(collection(db, 'days', date, 'machines', m, 'entries'), (snap) => {
        const list: MachineEntry[] = [];
        snap.forEach((d) => list.push(d.data() as MachineEntry));
        list.sort((a, b) => a.workTime.localeCompare(b.workTime));
        setByMachine((prev) => ({ ...prev, [m]: list }));
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [date]);

  const nameMap = useMemo(() => {
    const map = new Map<string, string>();
    items.forEach((i) => map.set(i.code, i.name));
    return map;
  }, [items]);

  const dateLabel = useMemo(() => {
    const [y, m, d] = date.split('-');
    return `${y}. ${Number(m)}. ${Number(d)}`;
  }, [date]);

  const maxRows = Math.max(1, ...MACHINES.map((m) => (byMachine[m] || []).length));
  const totalEntries = MACHINES.reduce((s, m) => s + (byMachine[m] || []).length, 0);

  const downloadCsv = () => {
    const escape = (v: string | number) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header: (string | number)[] = [];
    MACHINES.forEach((m) => header.push(`${m} 코드`, `${m} 품목명`, `${m} 생산량`, `${m} 작업시간`));
    const rows: (string | number)[][] = [];
    for (let i = 0; i < maxRows; i++) {
      const row: (string | number)[] = [];
      MACHINES.forEach((m) => {
        const e = (byMachine[m] || [])[i];
        if (e) {
          row.push(e.code, nameMap.get(e.code) || '', e.actualProduction, e.workTime);
        } else {
          row.push('', '', '', '');
        }
      });
      rows.push(row);
    }
    const csv = [header, ...rows].map((r) => r.map(escape).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `생산내역_${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-gray-800">생산 내역 조회</h2>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">총 {totalEntries}건</span>
          <button
            onClick={downloadCsv}
            disabled={totalEntries === 0}
            className="px-3 py-1.5 text-sm rounded-md bg-blue-900 text-white font-medium hover:bg-blue-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            엑셀 다운로드
          </button>
        </div>
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b bg-slate-50 flex items-center justify-between">
          <div className="font-bold text-gray-800">금속검출기(CCP-2P) 제품 통과 및 생산 내역</div>
          <div className="text-xs text-gray-600">작업일자 <span className="font-medium">{dateLabel}</span></div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-blue-100 text-blue-900">
                {MACHINES.map((m) => (
                  <th key={m} colSpan={4} className="border p-2 text-center font-semibold">{m}</th>
                ))}
              </tr>
              <tr className="bg-blue-50 text-xs text-blue-900">
                {MACHINES.map((m) => (
                  <Fragment key={m}>
                    <th className="border p-2">코드명</th>
                    <th className="border p-2">품목명</th>
                    <th className="border p-2">생산량</th>
                    <th className="border p-2">작업 시간</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {totalEntries === 0 ? (
                <tr>
                  <td colSpan={12} className="p-12 text-center text-gray-400">
                    선택한 날짜({date})에 생산 내역이 없습니다
                  </td>
                </tr>
              ) : (
                Array.from({ length: maxRows }).map((_, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    {MACHINES.map((m) => {
                      const e = (byMachine[m] || [])[i];
                      if (!e) {
                        return (
                          <Fragment key={m}>
                            <td className="border p-2"></td>
                            <td className="border p-2"></td>
                            <td className="border p-2"></td>
                            <td className="border p-2"></td>
                          </Fragment>
                        );
                      }
                      return (
                        <Fragment key={m}>
                          <td className="border p-2 font-mono text-center">{e.code}</td>
                          <td className="border p-2 text-center">{nameMap.get(e.code) || ''}</td>
                          <td className="border p-2 text-center font-bold">{e.actualProduction}</td>
                          <td className="border p-2 text-center">{e.workTime}</td>
                        </Fragment>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
