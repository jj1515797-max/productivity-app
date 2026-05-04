import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import type { Item, MachineEntry } from '../types';

const MACHINES: MachineEntry['machine'][] = ['1호기', '2호기', '3호기'];

export default function Remaining() {
  const [items, setItems] = useState<Item[]>([]);
  const [machineQty, setMachineQty] = useState<Record<string, Record<string, number>>>({});
  const date = todayKey();

  useEffect(() => {
    return onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      list.sort((a, b) => a.code.localeCompare(b.code));
      setItems(list);
    });
  }, [date]);

  useEffect(() => {
    const unsubs = MACHINES.map((machine) =>
      onSnapshot(collection(db, 'days', date, 'machines', machine, 'entries'), (snap) => {
        const map: Record<string, number> = {};
        snap.forEach((d) => {
          const e = d.data() as MachineEntry;
          map[e.code] = (e.actualProduction || 0) + (e.additionalProduction || 0);
        });
        setMachineQty((prev) => ({ ...prev, [machine]: map }));
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [date]);

  const actualByCode = useMemo(() => {
    const totals: Record<string, number> = {};
    MACHINES.forEach((m) => {
      Object.entries(machineQty[m] || {}).forEach(([code, qty]) => {
        totals[code] = (totals[code] || 0) + qty;
      });
    });
    return totals;
  }, [machineQty]);

  const enriched = items.map((it) => ({ ...it, actualProduction: actualByCode[it.code] || 0 }));
  const produced = enriched.filter((it) => it.actualProduction > 0);
  const surplus = produced.filter((it) => it.actualProduction > it.totalQty);
  const exact = produced.filter((it) => it.actualProduction === it.totalQty);
  const shortage = produced.filter((it) => it.actualProduction < it.totalQty);

  const downloadCsv = () => {
    const escape = (v: string | number) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['구분', '코드', '품목명', '총수량', '실제 생산량', '잔여량'];
    const sectionFor = (it: typeof produced[number]) => {
      const r = it.actualProduction - it.totalQty;
      return r > 0 ? '잔여' : r < 0 ? '부족' : '완료';
    };
    const rows = produced.map((it) => [
      sectionFor(it),
      it.code,
      it.name,
      it.totalQty,
      it.actualProduction,
      it.actualProduction - it.totalQty,
    ]);
    const csv = [header, ...rows].map((r) => r.map(escape).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `잔여량_${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">잔여량 확인</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">생산 진행 {produced.length}개 품목</span>
          <button
            onClick={downloadCsv}
            disabled={produced.length === 0}
            className="px-3 py-1.5 text-sm rounded-md bg-blue-900 text-white font-medium hover:bg-blue-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            엑셀 다운로드
          </button>
        </div>
      </div>

      {produced.length === 0 && (
        <div className="bg-white rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-400 text-sm">아직 생산된 품목이 없습니다</p>
        </div>
      )}

      {surplus.length > 0 && (
        <Section title="잔여량 있음" count={surplus.length} color="green">
          {surplus.map((it) => (
            <Row key={it.code} item={it} />
          ))}
        </Section>
      )}

      {exact.length > 0 && (
        <Section title="정확히 완료" count={exact.length} color="blue">
          {exact.map((it) => (
            <Row key={it.code} item={it} />
          ))}
        </Section>
      )}

      {shortage.length > 0 && (
        <Section title="부족 (추가생산 필요)" count={shortage.length} color="red">
          {shortage.map((it) => (
            <Row key={it.code} item={it} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title, count, color, children
}: {
  title: string; count: number; color: 'green' | 'blue' | 'red'; children: React.ReactNode;
}) {
  const colors = {
    green: 'border-green-500 bg-green-50',
    blue:  'border-blue-500 bg-blue-50',
    red:   'border-red-500 bg-red-50',
  };
  const textColors = {
    green: 'text-green-700',
    blue:  'text-blue-700',
    red:   'text-red-700',
  };
  return (
    <div className={`bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden`}>
      <div className={`px-5 py-3 border-b border-l-4 ${colors[color]} flex items-center gap-2`}>
        <span className={`font-semibold ${textColors[color]}`}>{title}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[color]} ${textColors[color]}`}>{count}개</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 text-xs text-gray-500">
            <th className="px-4 py-2 text-left font-medium">코드</th>
            <th className="px-4 py-2 text-left font-medium">품목명</th>
            <th className="px-4 py-2 text-right font-medium">총수량</th>
            <th className="px-4 py-2 text-right font-medium">실제 생산량</th>
            <th className="px-4 py-2 text-right font-medium">잔여량</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">{children}</tbody>
      </table>
    </div>
  );
}

function Row({ item }: { item: Item }) {
  const remain = item.actualProduction - item.totalQty;
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{item.code}</td>
      <td className="px-4 py-2.5 font-medium text-gray-800">{item.name}</td>
      <td className="px-4 py-2.5 text-right text-gray-600">{item.totalQty}</td>
      <td className="px-4 py-2.5 text-right text-gray-700">{item.actualProduction}</td>
      <td className={`px-4 py-2.5 text-right font-bold ${
        remain > 0 ? 'text-green-600' : remain < 0 ? 'text-red-500' : 'text-blue-600'
      }`}>
        {remain > 0 ? `+${remain}` : remain === 0 ? '✓' : remain}
      </td>
    </tr>
  );
}
