import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import type { Item } from '../types';

const MACHINES = ['1호기', '2호기', '3호기'] as const;

// 타임존 버그 없는 날짜 이동
function shiftDate(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + delta);
  const ny = date.getFullYear();
  const nm = String(date.getMonth() + 1).padStart(2, '0');
  const nd = String(date.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function dateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')} (${days[date.getDay()]})`;
}

export default function Dashboard() {
  const [items, setItems] = useState<Item[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [viewDate, setViewDate] = useState(todayKey());
  const [isWeekend, setIsWeekend] = useState(() => {
    const day = new Date().getDay();
    return day === 0 || day === 6;
  });

  // 각 호기의 실제 생산량: { code: qty }
  const [machineQty, setMachineQty] = useState<Record<string, Record<string, number>>>({
    '1호기': {}, '2호기': {}, '3호기': {},
  });

  // 품목 목록 구독
  useEffect(() => {
    setItems([]); // 날짜 바뀌면 즉시 초기화 (구데이터 잔상 방지)
    return onSnapshot(collection(db, 'days', viewDate, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      list.sort((a, b) => a.code.localeCompare(b.code));
      setItems(list);
    });
  }, [viewDate]);

  // 3개 호기 entries 구독 → 실제 생산량 합산용
  useEffect(() => {
    setMachineQty({ '1호기': {}, '2호기': {}, '3호기': {} });
    const unsubs = MACHINES.map((machine) =>
      onSnapshot(collection(db, 'days', viewDate, 'machines', machine, 'entries'), (snap) => {
        const map: Record<string, number> = {};
        snap.forEach((d) => {
          const e = d.data();
          map[e.code] = (e.actualProduction || 0) + (e.additionalProduction || 0);
        });
        setMachineQty((prev) => ({ ...prev, [machine]: map }));
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [viewDate]);

  // 코드별 실제 생산량 합계 (전 호기 합산)
  const actualByCode = useMemo(() => {
    const result: Record<string, number> = {};
    MACHINES.forEach((m) => {
      Object.entries(machineQty[m]).forEach(([code, qty]) => {
        result[code] = (result[code] || 0) + qty;
      });
    });
    return result;
  }, [machineQty]);

  const stats = useMemo(() => {
    const totalQty = items.reduce((s, i) => s + (i.totalQty || 0), 0);
    const actual = items.reduce((s, i) => s + (actualByCode[i.code] || 0), 0);
    const itemCount = items.length;
    const completedItems = items.filter(
      (i) => (actualByCode[i.code] || 0) >= i.totalQty && i.totalQty > 0
    ).length;
    const pct = totalQty ? Math.round((actual / totalQty) * 100) : 0;
    return { totalQty, actual, itemCount, completedItems, pct };
  }, [items, actualByCode]);

  const onPaste = async () => {
    const num = (s: string) => {
      const cleaned = (s || '').trim().replace(/,/g, '');
      if (cleaned === '-' || cleaned === '') return 0;
      const n = parseFloat(cleaned);
      return isNaN(n) ? 0 : n;
    };

    const minCols = isWeekend ? 5 : 6;
    const rows = pasteText
      .split('\n')
      .map((r) => r.split('\t'))
      .filter((cols) => cols.length >= minCols && cols[0]?.trim());

    if (!rows.length) return alert(`붙여넣을 데이터가 없습니다 (${isWeekend ? '주말' : '평일'} 모드: ${minCols}열 필요)`);

    const batch = writeBatch(db);
    for (const cols of rows) {
      const code = cols[0].trim();
      const item: Item = {
        id: code, code,
        name: cols[1]?.trim() || '',
        orderQty: num(cols[2]),
        coupang: num(cols[3]),
        marketKurly: isWeekend ? 0 : num(cols[4]),
        totalQty: isWeekend ? num(cols[4]) : num(cols[5]),
        actualProduction: 0,
        date: viewDate,
      };
      batch.set(doc(db, 'days', viewDate, 'items', code), item);
    }
    await batch.commit();
    setPasteText('');
    setShowPaste(false);
  };

  const clearAll = async () => {
    if (!confirm('오늘 데이터를 모두 삭제할까요?')) return;
    const batch = writeBatch(db);
    items.forEach((i) => batch.delete(doc(db, 'days', viewDate, 'items', i.code)));
    await batch.commit();
  };

  const hasKurly = items.some((i) => i.marketKurly > 0);

  return (
    <div className="space-y-5">
      {/* 날짜 네비게이션 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewDate(shiftDate(viewDate, -1))}
            className="w-8 h-8 flex items-center justify-center rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 text-lg"
          >‹</button>
          <span className="font-semibold text-gray-800 text-base">{dateLabel(viewDate)}</span>
          <button
            onClick={() => setViewDate(shiftDate(viewDate, 1))}
            className="w-8 h-8 flex items-center justify-center rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 text-lg"
          >›</button>
          {viewDate !== todayKey() && (
            <button
              onClick={() => setViewDate(todayKey())}
              className="ml-1 text-xs px-2.5 py-1 rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium"
            >오늘로</button>
          )}
        </div>
        <div className="flex gap-2 items-center">
          <button
            onClick={() => setShowPaste(true)}
            className="bg-orange-500 hover:bg-orange-600 text-white text-sm px-4 py-2 rounded font-medium transition"
          >
            + 데이터 입력
          </button>
          {items.length > 0 && (
            <button onClick={clearAll} className="text-sm text-red-500 hover:underline">전체 삭제</button>
          )}
        </div>
      </div>

      {/* 통계 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="금일 품목수" value={`${stats.itemCount}`} unit="품목" color="blue" />
        <StatCard label="총 수량" value={stats.totalQty.toLocaleString()} unit="EA" color="green" />
        <StatCard label="완료된 수량" value={stats.actual.toLocaleString()} unit="EA" color="orange" />
        <StatCard
          label="진행률"
          value={`${stats.pct}`}
          unit="%"
          color={stats.pct === 100 ? 'green' : stats.pct >= 50 ? 'orange' : 'red'}
        />
        <StatCard label="완료된 품목" value={`${stats.completedItems}`} unit="품목" color="purple" />
      </div>

      {/* 붙여넣기 패널 */}
      {showPaste && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5 space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="font-semibold text-gray-800">ERP 데이터 붙여넣기</h2>
            <button onClick={() => setShowPaste(false)} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
          </div>
          <div className="flex items-center gap-2 bg-gray-50 rounded-md p-1 w-max">
            <button
              onClick={() => setIsWeekend(false)}
              className={`px-4 py-1.5 text-sm rounded transition ${!isWeekend ? 'bg-blue-900 text-white font-medium' : 'text-gray-500 hover:text-gray-800'}`}
            >
              평일 (쿠팡+컬리)
            </button>
            <button
              onClick={() => setIsWeekend(true)}
              className={`px-4 py-1.5 text-sm rounded transition ${isWeekend ? 'bg-blue-900 text-white font-medium' : 'text-gray-500 hover:text-gray-800'}`}
            >
              주말 (쿠팡만)
            </button>
          </div>
          <p className="text-xs text-gray-500">
            열 순서: {isWeekend
              ? '코드 / 품목명 / 주문수량 / 쿠팡 / 총수량 (5열)'
              : '코드 / 품목명 / 주문수량 / 쿠팡 / 마켓컬리 / 총수량 (6열)'}
          </p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            className="w-full h-40 border border-gray-200 rounded-md p-3 font-mono text-xs resize-none focus:outline-none focus:ring-2 focus:ring-blue-900"
            placeholder={isWeekend ? 'A01\t순수쌀미음\t17\t-\t17' : 'A01\t순수쌀미음\t17\t-\t-\t17'}
          />
          <div className="flex gap-2">
            <button onClick={onPaste} className="bg-blue-900 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-800 transition">
              등록
            </button>
            <button onClick={() => setShowPaste(false)} className="border border-gray-300 px-5 py-2 rounded text-sm text-gray-600 hover:bg-gray-50 transition">
              취소
            </button>
          </div>
        </div>
      )}

      {/* 품목 테이블 */}
      {items.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">품목별 현황</h2>
            <span className="text-xs text-gray-400">{items.length}개 품목</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 text-left font-medium">코드</th>
                  <th className="px-4 py-3 text-left font-medium">품목명</th>
                  <th className="px-4 py-3 text-right font-medium">주문수량</th>
                  <th className="px-4 py-3 text-right font-medium text-orange-600">쿠팡</th>
                  {hasKurly && <th className="px-4 py-3 text-right font-medium text-blue-600">마켓컬리</th>}
                  <th className="px-4 py-3 text-right font-medium">총수량</th>
                  <th className="px-4 py-3 text-right font-medium">실제 생산량</th>
                  <th className="px-4 py-3 text-right font-medium">±</th>
                  <th className="px-4 py-3 text-center font-medium">냉각 종료</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((it) => {
                  const actual = actualByCode[it.code] || 0;
                  const diff = actual - it.totalQty;
                  const done = actual >= it.totalQty && it.totalQty > 0;
                  const inProgress = actual > 0 && actual < it.totalQty;
                  return (
                    <tr
                      key={it.code}
                      className={`transition-colors ${done ? 'bg-green-50' : inProgress ? 'bg-red-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{it.code}</td>
                      <td className="px-4 py-3 font-medium text-gray-800">{it.name}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{it.orderQty || '-'}</td>
                      <td className="px-4 py-3 text-right text-orange-600 font-medium">{it.coupang || '-'}</td>
                      {hasKurly && <td className="px-4 py-3 text-right text-blue-600 font-medium">{it.marketKurly || '-'}</td>}
                      <td className="px-4 py-3 text-right font-semibold text-gray-800">{it.totalQty}</td>
                      <td className="px-4 py-3 text-right text-gray-700 font-medium">{actual || '-'}</td>
                      <td className={`px-4 py-3 text-right font-bold ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-500' : 'text-gray-400'}`}>
                        {/* 생산 시작 전이면 ± 숨김 */}
                        {actual === 0 ? '' : diff > 0 ? `+${diff}` : diff < 0 ? diff : '✓'}
                      </td>
                      <td className="px-4 py-3 text-center text-xs text-gray-400">{it.coolingEndTime || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {items.length === 0 && !showPaste && (
        <div className="bg-white rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-400 text-sm mb-3">이 날짜의 생산 데이터가 없습니다</p>
          <button
            onClick={() => setShowPaste(true)}
            className="bg-blue-900 text-white text-sm px-5 py-2 rounded font-medium hover:bg-blue-800 transition"
          >
            + 데이터 입력
          </button>
        </div>
      )}
    </div>
  );
}

const colorMap = {
  blue:   { border: 'border-blue-500',   text: 'text-blue-600' },
  green:  { border: 'border-green-500',  text: 'text-green-600' },
  orange: { border: 'border-orange-400', text: 'text-orange-500' },
  red:    { border: 'border-red-400',    text: 'text-red-500' },
  purple: { border: 'border-purple-400', text: 'text-purple-600' },
};

function StatCard({ label, value, unit, color }: {
  label: string; value: string; unit: string; color: keyof typeof colorMap;
}) {
  const c = colorMap[color];
  return (
    <div className={`bg-white rounded-lg border-t-4 ${c.border} shadow-sm p-4`}>
      <div className="text-xs text-gray-500 mb-2 font-medium">{label}</div>
      <div className={`text-2xl font-bold ${c.text}`}>{value}</div>
      <div className="text-xs text-gray-400 mt-0.5">{unit}</div>
    </div>
  );
}
