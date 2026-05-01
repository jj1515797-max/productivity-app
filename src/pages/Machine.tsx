import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { collection, doc, onSnapshot, setDoc, deleteDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey, formatTime } from '../lib/dateUtil';
import type { Item, MachineEntry } from '../types';

export default function Machine() {
  const { id } = useParams();
  const machine = `${id}호기` as MachineEntry['machine'];
  const date = todayKey();

  const [items, setItems] = useState<Item[]>([]);
  const [entries, setEntries] = useState<MachineEntry[]>([]);
  const [search, setSearch] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [qty, setQty] = useState<number>(0);

  useEffect(() => {
    return onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      list.sort((a, b) => a.code.localeCompare(b.code));
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items.slice(0, 30);
    return items.filter((i) => i.code.toLowerCase().includes(q) || i.name.includes(q));
  }, [items, search]);

  const submit = async () => {
    if (!selectedCode || qty <= 0) return alert('코드와 수량을 입력하세요');
    const ref = doc(db, 'days', date, 'machines', machine, 'entries', selectedCode);
    const entry: MachineEntry = {
      id: selectedCode,
      code: selectedCode,
      actualProduction: qty,
      additionalProduction: 0,
      workTime: formatTime(),
      isLast: false,
      machine,
      date,
    };
    await setDoc(ref, entry);
    setSelectedCode(null);
    setQty(0);
    setSearch('');
  };

  const toggleLast = async (code: string, isLast: boolean) => {
    const ref = doc(db, 'days', date, 'machines', machine, 'entries', code);
    await updateDoc(ref, { isLast: !isLast });
  };

  const remove = async (code: string) => {
    if (!confirm(`${code} 기록을 삭제할까요?`)) return;
    await deleteDoc(doc(db, 'days', date, 'machines', machine, 'entries', code));
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">{machine} 입력</h2>

      <div className="bg-white border rounded-lg p-4 space-y-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="코드 또는 품목명 검색..."
          className="w-full border rounded-md px-3 py-3 text-base"
        />
        {search && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-60 overflow-y-auto">
            {filtered.map((it) => (
              <button
                key={it.code}
                onClick={() => { setSelectedCode(it.code); setSearch(it.name); }}
                className={`text-left p-3 rounded border ${selectedCode === it.code ? 'bg-slate-900 text-white' : 'hover:bg-slate-50'}`}
              >
                <div className="font-mono text-xs opacity-70">{it.code}</div>
                <div className="font-medium">{it.name}</div>
                <div className="text-xs opacity-70">총 {it.totalQty}EA</div>
              </button>
            ))}
          </div>
        )}

        {selectedCode && (
          <div className="flex items-center gap-2">
            <button onClick={() => setQty(Math.max(0, qty - 1))} className="w-12 h-12 border rounded-md text-xl">−</button>
            <input
              type="number"
              value={qty}
              onChange={(e) => setQty(Number(e.target.value) || 0)}
              className="flex-1 border rounded-md px-3 py-3 text-center text-xl font-bold"
            />
            <button onClick={() => setQty(qty + 1)} className="w-12 h-12 border rounded-md text-xl">+</button>
            <button onClick={submit} className="bg-slate-900 text-white px-6 py-3 rounded-md font-medium">등록</button>
          </div>
        )}
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="p-3 border-b bg-slate-50 font-semibold">오늘 입력 내역 ({entries.length})</div>
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-xs text-slate-600">
            <tr>
              <th className="p-2 text-left">코드</th>
              <th className="p-2 text-right">실제 생산량</th>
              <th className="p-2 text-center">작업 시간</th>
              <th className="p-2 text-center">마지막 제품</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.code} className="border-t">
                <td className="p-2 font-mono">{e.code}</td>
                <td className="p-2 text-right font-bold">{e.actualProduction}</td>
                <td className="p-2 text-center">{e.workTime}</td>
                <td className="p-2 text-center">
                  <input
                    type="checkbox"
                    checked={e.isLast}
                    onChange={() => toggleLast(e.code, e.isLast)}
                    className="w-5 h-5"
                  />
                </td>
                <td className="p-2 text-right">
                  <button onClick={() => remove(e.code)} className="text-xs text-red-500 hover:underline">삭제</button>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-slate-400">아직 입력 내역이 없습니다</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
