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

  // 실제 생산된 항목만, 잔여량 = 실제생산량 - 총수량 (양수면 잔여, 음수면 부족)
  const produced = items.filter((it) => it.actualProduction > 0);
  const surplus = produced.filter((it) => it.actualProduction > it.totalQty);
  const exact = produced.filter((it) => it.actualProduction === it.totalQty);
  const shortage = produced.filter((it) => it.actualProduction < it.totalQty);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">잔여량 확인</h2>
        <span className="text-sm text-gray-500">생산 진행 {produced.length}개 품목</span>
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
