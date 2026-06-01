import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey, effectiveTodayKey } from '../lib/dateUtil';
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

  // 새벽 2시 기준 자동 날짜 롤오버 — 어떤 날짜를 보고 있든 당일로 갱신
  useEffect(() => {
    const tick = () => {
      const eff = effectiveTodayKey();
      if (date !== eff) setDate(eff);
    };
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [date]);

  const [items, setItems] = useState<Item[]>([]);
  const [entries, setEntries] = useState<(MachineEntry & { docId: string })[]>([]);
  const [allMachineQty, setAllMachineQty] = useState<Record<string, Record<string, number>>>({
    '1호기': {}, '2호기': {}, '3호기': {},
  });

  /* 표 글자 크기 — 이 기기(브라우저)에만 적용 */
  const FONT_KEY = 'extPackTableFontSize';
  const FONT_MIN = 12, FONT_MAX = 72, FONT_DEFAULT = 18, FONT_STEP = 2;
  const [fontSize, setFontSize] = useState<number>(() => {
    const v = Number(localStorage.getItem(FONT_KEY));
    return v >= FONT_MIN && v <= FONT_MAX ? v : FONT_DEFAULT;
  });
  useEffect(() => { localStorage.setItem(FONT_KEY, String(fontSize)); }, [fontSize]);
  const codeSize = fontSize + 6;
  const cellPadY = Math.max(8, Math.round(fontSize * 0.5));
  const cellPadX = Math.max(8, Math.round(fontSize * 0.45));
  const cellStyle = { fontSize, paddingTop: cellPadY, paddingBottom: cellPadY, paddingLeft: cellPadX, paddingRight: cellPadX };
  const codeStyle = { fontSize: codeSize, paddingTop: cellPadY, paddingBottom: cellPadY, paddingLeft: cellPadX, paddingRight: cellPadX };

  /* 실시간 시계 (클라이언트만, Firestore 비용 X) */
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      setItems(list);
    });
  }, [date]);

  useEffect(() => {
    return onSnapshot(collection(db, 'days', date, 'machines', machine, 'entries'), (snap) => {
      const list: (MachineEntry & { docId: string })[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as MachineEntry), docId: d.id }));
      list.sort((a, b) => {
        const ta = a.workTime || a.additionalWorkTime || '';
        const tb = b.workTime || b.additionalWorkTime || '';
        const cmp = tb.localeCompare(ta);
        if (cmp !== 0) return cmp;
        return b.docId.localeCompare(a.docId); // 같은 분 → 나중에 만든 doc(=docId 큼)이 위
      });
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

    // 이 호기에서 코드별 등록 횟수
    const entryCountByCode: Record<string, number> = {};
    entries.forEach((e) => {
      const k = e.code.toLowerCase();
      entryCountByCode[k] = (entryCountByCode[k] || 0) + 1;
    });

    return entries.map((e, idx) => {
      const item = itemMap.get(e.code.toLowerCase());
      const orderQty = item?.orderQty || 0;
      const totalQty = item?.totalQty || 0;
      const rowActual = e.actualProduction || 0;
      const rowAdd = e.additionalProduction || 0;
      const combined = combinedByCode[e.code.toLowerCase()] || 0;
      // 같은 호기에서 여러 번 OR 다른 호기에서도 생산한 경우
      const sameMulti = (entryCountByCode[e.code.toLowerCase()] || 1) > 1;
      const crossMachine = MACHINES.filter((m) => (allMachineQty[m][e.code.toLowerCase()] || 0) > 0).length > 1;
      const multiEntry = sameMulti || crossMachine;

      let bg = '';
      if (totalQty > 0) {
        if (combined < totalQty) bg = 'bg-red-200';           // 합산해도 부족
        else if (multiEntry) bg = 'bg-green-200';             // 재생산으로 맞춤/초과
        else if (combined > totalQty) bg = 'bg-yellow-200';   // 단일 생산, 초과
        // combined === totalQty && 단일 생산 → 흰색 (bg 없음)
      }

      const combinedDiff = combined - totalQty;
      return {
        key: `${e.code}-${idx}`,
        code: e.code,
        name: item?.name || '',
        orderQty,
        shipped: totalQty,
        actual: rowActual,
        additional: rowAdd,
        combinedDiff,
        bg,
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
        {/* 실시간 시계 */}
        <span className="ml-auto text-sm font-mono text-gray-700 tabular-nums" aria-label="현재 시각">
          🕐 {now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
        </span>
        {/* 표 글자 크기 (이 기기에만 적용) */}
        <div className="flex items-center gap-1 border rounded px-1 py-0.5 bg-white" title="이 기기에서만 적용됩니다">
          <button
            onClick={() => setFontSize((v) => Math.max(FONT_MIN, v - FONT_STEP))}
            className="px-2.5 py-1 text-sm rounded hover:bg-gray-100 font-bold disabled:text-gray-300"
            disabled={fontSize <= FONT_MIN}
            aria-label="글자 작게"
          >A−</button>
          <span className="text-xs text-gray-500 min-w-[36px] text-center">{fontSize}px</span>
          <button
            onClick={() => setFontSize((v) => Math.min(FONT_MAX, v + FONT_STEP))}
            className="px-2.5 py-1 text-sm rounded hover:bg-gray-100 font-bold disabled:text-gray-300"
            disabled={fontSize >= FONT_MAX}
            aria-label="글자 크게"
          >A+</button>
          <button
            onClick={() => setFontSize(FONT_DEFAULT)}
            className="px-2 py-1 text-xs rounded hover:bg-gray-100 text-gray-500"
            aria-label="기본 크기"
            title="기본 크기로"
          >↺</button>
        </div>
      </div>
      <div className="bg-white border rounded-lg">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-600">
            <tr>
              <th className="p-2 text-left sticky top-0 z-10 bg-slate-100">코드</th>
              <th className="p-2 text-left sticky top-0 z-10 bg-slate-100">품목명</th>
              <th className="p-2 text-right sticky top-0 z-10 bg-slate-100">주문수량</th>
              <th className="p-2 text-right sticky top-0 z-10 bg-slate-100">발주량</th>
              <th className="p-2 text-right sticky top-0 z-10 bg-slate-100">실제 생산량</th>
              <th className="p-2 text-right sticky top-0 z-10 bg-slate-100">모자란 수량</th>
              <th className="p-2 text-right sticky top-0 z-10 bg-slate-100">추가 생산량</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const diffColor =
                r.combinedDiff > 0 ? 'text-green-700' :
                r.combinedDiff < 0 ? 'text-red-700' : '';
              return (
                <tr key={r.key} className={`border-t border-gray-400 ${r.bg}`}>
                  <td className="font-mono font-bold" style={codeStyle}>{r.code}</td>
                  <td style={cellStyle}>{r.name}</td>
                  <td className="text-right font-bold" style={cellStyle}>{r.orderQty}</td>
                  <td className="text-right" style={cellStyle}>{r.shipped}</td>
                  <td className="text-right" style={cellStyle}>{r.actual || ''}</td>
                  <td className={`text-right font-bold ${diffColor}`} style={cellStyle}>
                    {r.combinedDiff > 0 ? `+${r.combinedDiff}` : r.combinedDiff || ''}
                  </td>
                  <td className="text-right" style={cellStyle}>
                    {r.additional > 0 ? r.additional : ''}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-400">{machine}에서 입력된 내역이 없습니다</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
