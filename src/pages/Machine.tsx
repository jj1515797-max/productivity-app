import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { collection, doc, onSnapshot, addDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey, formatTime } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { Item, MachineEntry } from '../types';
import { compareCode } from '../lib/codeUtil';

export default function Machine() {
  const { id } = useParams();
  const machine = `${id}호기` as MachineEntry['machine'];
  const [date, setDate] = useState(loadViewDate);
  useEffect(() => { saveViewDate(date); }, [date]);
  const today = todayKey();
  const isToday = date === today;

  const [items, setItems] = useState<Item[]>([]);
  const [entries, setEntries] = useState<(MachineEntry & { docId: string })[]>([]);
  const [search, setSearch] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [qty, setQty] = useState<number>(0);
  const [isAdditional, setIsAdditional] = useState(false);

  useEffect(() => {
    return onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      list.sort((a, b) => compareCode(a.code, b.code));
      setItems(list);
    });
  }, [date]);

  useEffect(() => {
    return onSnapshot(collection(db, 'days', date, 'machines', machine, 'entries'), (snap) => {
      const list: (MachineEntry & { docId: string })[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as MachineEntry), docId: d.id }));
      list.sort((a, b) => (b.workTime || b.additionalWorkTime || '').localeCompare(a.workTime || a.additionalWorkTime || ''));
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
    const time = formatTime();
    const base = { id: selectedCode, code: selectedCode, machine, date };
    const data = isAdditional
      ? { ...base, additionalProduction: qty, additionalWorkTime: time }
      : { ...base, actualProduction: qty, workTime: time };
    await addDoc(collection(db, 'days', date, 'machines', machine, 'entries'), data);
    setSelectedCode(null);
    setQty(0);
    setSearch('');
    setIsAdditional(false);
  };

  const remove = async (docId: string, code: string) => {
    if (!confirm(`${code} 기록을 삭제할까요?`)) return;
    await deleteDoc(doc(db, 'days', date, 'machines', machine, 'entries', docId));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold">{machine} 입력</h2>
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
          <span className="text-xs text-orange-600 font-medium">⚠ 과거 날짜에 입력 중</span>
        )}
      </div>

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
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={isAdditional}
                onChange={(e) => setIsAdditional(e.target.checked)}
                className="w-5 h-5"
              />
              <span className={isAdditional ? 'text-green-700' : 'text-slate-700'}>
                추가 생산 {isAdditional && '(부족분 추가 생산으로 기록)'}
              </span>
            </label>
            <div className="flex items-center gap-2">
              <button onClick={() => setQty(Math.max(0, qty - 1))} className="w-12 h-12 border rounded-md text-xl">−</button>
              <input
                type="number"
                value={qty}
                onChange={(e) => setQty(Number(e.target.value) || 0)}
                className="flex-1 border rounded-md px-3 py-3 text-center text-xl font-bold"
              />
              <button onClick={() => setQty(qty + 1)} className="w-12 h-12 border rounded-md text-xl">+</button>
              <button
                onClick={submit}
                className={`text-white px-6 py-3 rounded-md font-medium ${isAdditional ? 'bg-green-700 hover:bg-green-800' : 'bg-slate-900 hover:bg-slate-800'}`}
              >
                {isAdditional ? '추가 등록' : '등록'}
              </button>
            </div>
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
              <th className="p-2 text-right bg-green-50">추가 생산량</th>
              <th className="p-2 text-center">작업 시간</th>
              <th className="p-2 text-center bg-green-50">추가 작업 시간</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const actual = e.actualProduction || 0;
              const add = e.additionalProduction || 0;
              return (
                <tr key={e.docId} className="border-t">
                  <td className="p-2 font-mono">{e.code}</td>
                  <td className="p-2 text-right font-bold">{actual || '-'}</td>
                  <td className={`p-2 text-right font-bold ${add > 0 ? 'bg-green-50 text-green-700' : ''}`}>
                    {add > 0 ? `+${add}` : '-'}
                  </td>
                  <td className="p-2 text-center">{e.workTime || '-'}</td>
                  <td className={`p-2 text-center ${e.additionalWorkTime ? 'bg-green-50 text-green-700' : ''}`}>
                    {e.additionalWorkTime || '-'}
                  </td>
                  <td className="p-2 text-right">
                    <button onClick={() => remove(e.docId, e.code)} className="text-xs text-red-500 hover:underline">삭제</button>
                  </td>
                </tr>
              );
            })}
            {entries.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-400">아직 입력 내역이 없습니다</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
