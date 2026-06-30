import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, onSnapshot, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { shiftDateKey, todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { Item, MachineEntry } from '../types';
import { compareCode } from '../lib/codeUtil';

const MACHINES: MachineEntry['machine'][] = ['1호기', '2호기', '3호기'];

// A-001-01 → A-01 / F-528-01 → F-528 / I-003-51 → I-03
function convertErpCode(raw: string): string {
  const m = raw.trim().match(/^([A-Za-z])-(\d+)-\d+$/);
  if (!m) return raw.trim();
  const letter = m[1].toUpperCase();
  const num = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${letter}-${num}`;
}

// 비교용: 대시·공백 제거 + 소문자
function normalize(code: string): string {
  return code.toLowerCase().replace(/[-\s]/g, '');
}

export default function Remaining() {
  const [items, setItems] = useState<Item[]>([]);
  const [machineQty, setMachineQty] = useState<Record<string, Record<string, number>>>({});
  const [logisticsQty, setLogisticsQty] = useState<Record<string, number>>({});
  const [date, setDate] = useState(loadViewDate);
  const [showModal, setShowModal] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [pasteText, setPasteText] = useState('');

  useEffect(() => { saveViewDate(date); }, [date]);
  const today = todayKey();
  const isToday = date === today;

  useEffect(() => {
    setItems([]);
    return onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      list.sort((a, b) => compareCode(a.code, b.code));
      setItems(list);
    });
  }, [date]);

  useEffect(() => {
    setMachineQty({});
    const unsubs = MACHINES.map((machine) =>
      onSnapshot(collection(db, 'days', date, 'machines', machine, 'entries'), (snap) => {
        const map: Record<string, number> = {};
        snap.forEach((d) => {
          const e = d.data() as MachineEntry;
          const key = String(e.code || '').toLowerCase();
          const qty = (e.actualProduction || 0) + (e.additionalProduction || 0);
          map[key] = (map[key] || 0) + qty;
        });
        setMachineQty((prev) => ({ ...prev, [machine]: map }));
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [date]);

  useEffect(() => {
    setLogisticsQty({});
    return onSnapshot(collection(db, 'days', date, 'logistics'), (snap) => {
      // key = 실제 doc ID (ourCode, e.g. "A-01") → 삭제 시 그대로 사용
      const map: Record<string, number> = {};
      snap.forEach((d) => {
        map[d.id] = (d.data().qty as number) || 0;
      });
      setLogisticsQty(map);
    });
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

  const hasLogistics = Object.keys(logisticsQty).length > 0;

  const enriched = useMemo(() => {
    const itemsNorm = new Set(items.map((i) => normalize(i.code)));
    const matched = items.map((it) => {
      const actual = actualByCode[it.code.toLowerCase()] || 0;
      const normItem = normalize(it.code);
      const logEntry = Object.entries(logisticsQty).find(([k]) => normalize(k) === normItem);
      const logQty = logEntry ? logEntry[1] : undefined;
      return {
        ...it,
        actualProduction: actual,
        totalQty: it.totalQty || 0,
        logQty,
      };
    });
    // items 에 없지만 logistics 에는 있는 코드도 표시 (누락 방지)
    Object.entries(logisticsQty).forEach(([code, qty]) => {
      if (!itemsNorm.has(normalize(code))) {
        matched.push({
          id: code,
          code,
          name: '(품목 미등록)',
          orderQty: 0,
          coupang: 0,
          marketKurly: 0,
          totalQty: 0,
          actualProduction: 0,
          date,
          logQty: qty,
        });
      }
    });
    return matched;
  }, [items, actualByCode, logisticsQty, date]);

  // 생산 모드: 잔여량 = actual - totalQty
  // 물류 모드: 잔여량 = logQty (등록수량 그대로)
  const produced = enriched.filter((it) => it.actualProduction > 0 || it.logQty !== undefined);
  const surplus  = hasLogistics
    ? produced.filter((it) => (it.logQty || 0) > 0)
    : produced.filter((it) => it.actualProduction > it.totalQty);
  const exact    = hasLogistics
    ? produced.filter((it) => it.logQty === 0)
    : produced.filter((it) => it.actualProduction === it.totalQty);
  const shortage = hasLogistics
    ? []
    : produced.filter((it) => it.actualProduction < it.totalQty);

  const saveLogistics = async () => {
    const lines = pasteText.trim().split('\n').map((r) => r.split('\t'));
    const hIdx = lines.findIndex((r) => r.some((c) => c.trim() === '제품코드'));
    if (hIdx < 0) return alert('제품코드 헤더를 찾을 수 없습니다');
    const header = lines[hIdx].map((c) => c.trim());
    const codeCol = header.indexOf('제품코드');
    const qtyCol  = header.indexOf('등록수량');
    if (codeCol < 0 || qtyCol < 0) return alert('제품코드 또는 등록수량 열을 찾을 수 없습니다');

    // 같은 코드 합산 (ERP에서 동일 코드가 여러 행에 나뉘어 들어올 수 있음)
    const byCode = new Map<string, { qty: number; erpCode: string }>();
    for (let i = hIdx + 1; i < lines.length; i++) {
      const r = lines[i];
      const erpCode = (r[codeCol] || '').trim();
      const qty = parseInt(r[qtyCol] || '0', 10);
      if (!erpCode || isNaN(qty) || qty < 0) continue;
      const ourCode = convertErpCode(erpCode);
      const prev = byCode.get(ourCode);
      if (prev) prev.qty += qty;
      else byCode.set(ourCode, { qty, erpCode });
    }

    const batch = writeBatch(db);
    let count = 0;
    byCode.forEach(({ qty, erpCode }, ourCode) => {
      batch.set(doc(db, 'days', date, 'logistics', ourCode), { code: ourCode, qty, erpCode });
      count++;
    });
    await batch.commit();
    setShowModal(false);
    setPasteText('');
    alert(`${count}개 품목 물류 데이터 저장 완료`);
  };

  const clearLogistics = async () => {
    if (!confirm('물류 데이터를 삭제하고 생산 기준으로 돌아갈까요?')) return;
    const batch = writeBatch(db);
    Object.keys(logisticsQty).forEach((code) => {
      batch.delete(doc(db, 'days', date, 'logistics', code));
    });
    await batch.commit();
  };

  const downloadCsv = () => {
    const escape = (v: string | number) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['구분', '코드', '품목명', '총수량', '실제 생산량', '잔여량'];
    const sectionFor = (it: typeof produced[number]) => {
      const r = it.actualProduction - it.totalQty;
      return r > 0 ? '잔여' : r < 0 ? '부족' : '잔여량 없음';
    };
    const rows = produced.map((it) => [
      sectionFor(it), it.code, it.name, it.totalQty,
      it.actualProduction, it.actualProduction - it.totalQty,
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
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-gray-800">
            {hasLogistics ? '잔여량 (물류)' : '잔여량 (생산)'}
          </h2>
          <button
            onClick={() => setShowAnalysis(true)}
            className="px-3 py-1.5 text-sm rounded-md bg-rose-600 text-white font-semibold hover:bg-rose-700 shadow-sm"
            title="최근 며칠간 같은 품목의 잔여량 추이를 한눈에 — 연속 10개 이상이면 수율조정 후보"
          >📊 잔여량분석</button>
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
            >오늘로</button>
          )}
          {!isToday && (
            <span className="text-xs text-orange-600 font-medium">⚠ 과거 날짜 보는 중</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">생산 진행 {produced.length}개 품목</span>
          {hasLogistics && (
            <button
              onClick={clearLogistics}
              className="px-3 py-1.5 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50"
            >물류 초기화</button>
          )}
          <button
            onClick={() => setShowModal(true)}
            className="px-3 py-1.5 text-sm rounded-md bg-blue-700 text-white font-medium hover:bg-blue-800"
          >수정</button>
          <button
            onClick={downloadCsv}
            disabled={produced.length === 0}
            className="px-3 py-1.5 text-sm rounded-md bg-blue-900 text-white font-medium hover:bg-blue-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >엑셀 다운로드</button>
        </div>
      </div>

      {produced.length === 0 && (
        <div className="bg-white rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-400 text-sm">아직 생산된 품목이 없습니다</p>
        </div>
      )}

      {shortage.length > 0 && (
        <Section
          title="부족 (추가생산 필요)"
          count={shortage.length}
          color="red"
          totalLabel="부족 합계"
          totalValue={shortage.reduce((s, it) => s + (it.totalQty - it.actualProduction), 0)}
        >
          {shortage.map((it) => <Row key={it.code} item={it} mode={hasLogistics ? 'logistics' : 'production'} />)}
        </Section>
      )}

      {surplus.length > 0 && (
        <Section
          title="잔여량 있음"
          count={surplus.length}
          color="green"
          totalLabel="잔여량 합계"
          totalValue={surplus.reduce(
            (s, it) => s + (hasLogistics ? (it.logQty || 0) : (it.actualProduction - it.totalQty)),
            0,
          )}
        >
          {surplus.map((it) => <Row key={it.code} item={it} mode={hasLogistics ? 'logistics' : 'production'} />)}
        </Section>
      )}

      {exact.length > 0 && (
        <Section title="잔여량 없음" count={exact.length} color="blue">
          {exact.map((it) => <Row key={it.code} item={it} mode={hasLogistics ? 'logistics' : 'production'} />)}
        </Section>
      )}

      {/* 잔여량 추세 분석 모달 (수율조정 도우미) */}
      {showAnalysis && (
        <RemainAnalysisModal endDate={date} onClose={() => setShowAnalysis(false)} />
      )}

      {/* 물류 수정 모달 */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl space-y-4 p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-800 text-lg">물류 데이터 입력</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  ERP 재고 화면에서 복사 후 붙여넣기 · 제품코드·등록수량 열 자동 인식
                </p>
              </div>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              className="w-full h-64 border rounded-lg p-3 font-mono text-xs resize-none focus:outline-none focus:ring-2 focus:ring-blue-600"
              placeholder="ERP에서 복사한 내용을 여기에 붙여넣으세요 (Ctrl+V)"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowModal(false); setPasteText(''); }}
                className="border border-gray-300 px-5 py-2 rounded text-sm text-gray-600 hover:bg-gray-50"
              >취소</button>
              <button
                onClick={saveLogistics}
                disabled={!pasteText.trim()}
                className="bg-blue-700 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >저장</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, count, color, totalLabel, totalValue, children }: {
  title: string;
  count: number;
  color: 'green' | 'blue' | 'red';
  totalLabel?: string;
  totalValue?: number;
  children: React.ReactNode;
}) {
  const colors = { green: 'border-green-500 bg-green-50', blue: 'border-blue-500 bg-blue-50', red: 'border-red-500 bg-red-50' };
  const textColors = { green: 'text-green-700', blue: 'text-blue-700', red: 'text-red-700' };
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <div className={`px-5 py-3 border-b border-l-4 ${colors[color]} flex items-center gap-2`}>
        <span className={`font-semibold ${textColors[color]}`}>{title}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[color]} ${textColors[color]}`}>품목수 {count}개</span>
        {totalLabel && totalValue !== undefined && (
          <span className={`ml-auto text-sm font-bold ${textColors[color]}`}>
            {totalLabel} {totalValue.toLocaleString()}
          </span>
        )}
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

function Row({ item, mode }: { item: Item & { logQty?: number }; mode: 'production' | 'logistics' }) {
  if (mode === 'logistics') {
    const log = item.logQty ?? 0;
    return (
      <tr className="hover:bg-gray-50">
        <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{item.code}</td>
        <td className="px-4 py-2.5 font-medium text-gray-800">{item.name}</td>
        <td className="px-4 py-2.5 text-right text-gray-600">{item.totalQty}</td>
        <td className="px-4 py-2.5 text-right text-gray-700">{item.actualProduction}</td>
        <td className={`px-4 py-2.5 text-right font-bold ${log > 0 ? 'text-green-600' : 'text-blue-600'}`}>
          {log > 0 ? `+${log}` : '✓'}
        </td>
      </tr>
    );
  }
  const remain = item.actualProduction - item.totalQty;
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{item.code}</td>
      <td className="px-4 py-2.5 font-medium text-gray-800">{item.name}</td>
      <td className="px-4 py-2.5 text-right text-gray-600">{item.totalQty}</td>
      <td className="px-4 py-2.5 text-right text-gray-700">{item.actualProduction}</td>
      <td className={`px-4 py-2.5 text-right font-bold ${remain > 0 ? 'text-green-600' : remain < 0 ? 'text-red-500' : 'text-blue-600'}`}>
        {remain > 0 ? `+${remain}` : remain === 0 ? '✓' : remain}
      </td>
    </tr>
  );
}

/* ============================================================
   잔여량 추세 분석 (수율조정 도우미)
   최근 N일의 days/{date} 데이터를 한 번에 읽어
   품목 × 날짜 격자로 잔여량을 펼쳐 보여준다.
   며칠 연속 임계치(기본 10개) 이상인 품목 = 수율조정 후보 → 상단 정렬.
   ============================================================ */

type DayRemainMap = Map<string, { code: string; name: string; remain: number }>;

// 하루치 잔여량 맵: normalize(code) → { code, name, remain }
async function fetchDayRemainMap(date: string): Promise<DayRemainMap> {
  const result: DayRemainMap = new Map();
  const snaps = await Promise.all([
    getDocs(collection(db, 'days', date, 'items')),
    getDocs(collection(db, 'days', date, 'logistics')),
    ...MACHINES.map((m) => getDocs(collection(db, 'days', date, 'machines', m, 'entries'))),
  ]);
  const itemsSnap = snaps[0];
  const logSnap = snaps[1];
  const machineSnaps = snaps.slice(2);

  // 기기별 실제 생산량 합산 (코드 소문자 키)
  const actual: Record<string, number> = {};
  machineSnaps.forEach((s) =>
    s.forEach((d) => {
      const e = d.data() as MachineEntry;
      const key = String(e.code || '').toLowerCase();
      actual[key] = (actual[key] || 0) + (e.actualProduction || 0) + (e.additionalProduction || 0);
    })
  );

  // 물류 등록수량 (normalize 키)
  const logMap: Record<string, number> = {};
  logSnap.forEach((d) => { logMap[normalize(d.id)] = (d.data().qty as number) || 0; });
  const hasLog = logSnap.size > 0;

  itemsSnap.forEach((d) => {
    const it = d.data() as Item;
    const norm = normalize(it.code);
    if (hasLog) {
      const lq = logMap[norm];
      if (lq === undefined) return;            // 물류 모드: 등록 안 된 품목은 제외
      result.set(norm, { code: it.code, name: it.name || '', remain: lq });
    } else {
      const act = actual[it.code.toLowerCase()] || 0;
      if (act <= 0) return;                    // 생산 안 한 품목 제외
      result.set(norm, { code: it.code, name: it.name || '', remain: act - (it.totalQty || 0) });
    }
  });

  // items 에 없지만 물류엔 있는 코드도 포함
  if (hasLog) {
    logSnap.forEach((d) => {
      const norm = normalize(d.id);
      if (!result.has(norm)) {
        result.set(norm, { code: d.id, name: '', remain: (d.data().qty as number) || 0 });
      }
    });
  }
  return result;
}

interface AnalysisRow {
  code: string;
  name: string;
  cells: (number | null)[];   // 날짜별 잔여량 (없는 날 = null)
  overDays: number;           // 임계 이상 일수
  streak: number;             // 최근(마지막 등장일 기준) 연속 임계 이상
  maxStreak: number;          // 등장일 중 최대 연속 임계 이상
}

function RemainAnalysisModal({ endDate, onClose }: { endDate: string; onClose: () => void }) {
  const [rangeDays, setRangeDays] = useState(14);
  const [threshold, setThreshold] = useState(10);
  const [minOverDays, setMinOverDays] = useState(2);
  const [loading, setLoading] = useState(true);
  const [dayData, setDayData] = useState<DayRemainMap[]>([]);

  // 끝 날짜(endDate)에서 과거로 rangeDays일 — 오래된→최신 순
  const dates = useMemo(
    () => Array.from({ length: rangeDays }, (_, i) => shiftDateKey(endDate, -(rangeDays - 1 - i))),
    [endDate, rangeDays]
  );
  const today = todayKey();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const maps = await Promise.all(dates.map((d) => fetchDayRemainMap(d)));
        if (!cancelled) setDayData(maps);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dates]);

  const rows = useMemo<AnalysisRow[]>(() => {
    const byCode = new Map<string, { code: string; name: string; cells: (number | null)[] }>();
    dayData.forEach((map, di) => {
      map.forEach((v, norm) => {
        if (!byCode.has(norm)) {
          byCode.set(norm, { code: v.code, name: v.name, cells: Array(dates.length).fill(null) });
        }
        const row = byCode.get(norm)!;
        row.cells[di] = v.remain;
        row.code = v.code;
        if (v.name) row.name = v.name;   // 최신 이름 유지
      });
    });

    const arr: AnalysisRow[] = Array.from(byCode.values()).map((r) => {
      const overDays = r.cells.filter((c) => c !== null && c >= threshold).length;
      const appear = r.cells.filter((c) => c !== null) as number[];   // 등장일만 (시간순)
      let streak = 0;
      for (let k = appear.length - 1; k >= 0; k--) {
        if (appear[k] >= threshold) streak++; else break;
      }
      let maxStreak = 0, cur = 0;
      appear.forEach((c) => { if (c >= threshold) { cur++; if (cur > maxStreak) maxStreak = cur; } else cur = 0; });
      return { ...r, overDays, streak, maxStreak };
    });

    return arr
      .filter((r) => r.overDays >= minOverDays)
      .sort((a, b) => b.streak - a.streak || b.overDays - a.overDays || b.maxStreak - a.maxStreak);
  }, [dayData, dates.length, threshold, minOverDays]);

  const fmtHead = (key: string) => {
    const [, m, d] = key.split('-');
    return `${Number(m)}/${Number(d)}`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[88vh] flex flex-col overflow-hidden">
        {/* 헤더 */}
        <div className="px-5 py-4 border-b bg-gradient-to-r from-rose-50 to-orange-50 flex items-center gap-3 flex-wrap">
          <div>
            <h3 className="font-bold text-gray-800 text-lg">📊 잔여량 추세 분석 <span className="text-rose-600">— 수율조정 도우미</span></h3>
            <p className="text-xs text-gray-500 mt-0.5">최근 {rangeDays}일간 같은 품목의 잔여량. 임계 {threshold}개 이상이 연속되면 수율을 낮출 후보입니다.</p>
          </div>
          <button onClick={onClose} className="ml-auto w-7 h-7 rounded-full hover:bg-white/70 text-gray-500 text-lg">✕</button>
        </div>

        {/* 컨트롤 */}
        <div className="px-5 py-3 border-b bg-slate-50 flex items-center gap-4 flex-wrap text-sm">
          <label className="flex items-center gap-1.5">
            <span className="text-gray-600">기간</span>
            <select value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))}
              className="border rounded px-2 py-1 text-sm">
              <option value={7}>7일</option>
              <option value={14}>14일</option>
              <option value={30}>30일</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-gray-600">임계(잔여)</span>
            <input type="number" inputMode="numeric" value={threshold}
              onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
              className="w-16 border rounded px-2 py-1 text-sm text-center" />
            <span className="text-gray-400">개 이상</span>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-gray-600">최소</span>
            <select value={minOverDays} onChange={(e) => setMinOverDays(Number(e.target.value))}
              className="border rounded px-2 py-1 text-sm">
              <option value={1}>1일 이상</option>
              <option value={2}>2일 이상</option>
              <option value={3}>3일 이상</option>
              <option value={4}>4일 이상</option>
            </select>
            <span className="text-gray-400">임계 초과한 품목만</span>
          </label>
          <span className="ml-auto text-gray-500">
            후보 <b className="text-rose-600">{rows.length}</b>품목
          </span>
        </div>

        {/* 본문 */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="p-16 text-center text-gray-400 text-sm">최근 {rangeDays}일 데이터 불러오는 중…</div>
          ) : rows.length === 0 ? (
            <div className="p-16 text-center text-gray-400 text-sm">
              조건에 맞는 품목이 없습니다 — 최근 {rangeDays}일간 잔여량 {threshold}개 이상이 {minOverDays}일 이상인 품목이 없어요.
            </div>
          ) : (
            <table className="text-sm border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-gray-100 text-xs text-gray-600">
                  <th className="px-3 py-2 text-left sticky left-0 bg-gray-100 z-20 min-w-[180px]">품목</th>
                  <th className="px-2 py-2 text-center bg-gray-100">연속</th>
                  <th className="px-2 py-2 text-center bg-gray-100">{threshold}↑일수</th>
                  {dates.map((d) => (
                    <th key={d} className={`px-1.5 py-2 text-center font-medium whitespace-nowrap ${d === today ? 'bg-rose-100 text-rose-700' : 'bg-gray-100'}`}>
                      {fmtHead(d)}{d === today ? <div className="text-[9px] font-bold">오늘</div> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code} className="border-t border-gray-100 hover:bg-slate-50/60">
                    <td className="px-3 py-1.5 sticky left-0 bg-white z-10">
                      <div className="font-medium text-gray-800 truncate max-w-[170px]">{r.name || r.code}</div>
                      <div className="font-mono text-[10px] text-gray-400">{r.code}</div>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {r.streak >= 2 ? (
                        <span className="px-1.5 py-0.5 rounded-full bg-rose-600 text-white text-xs font-bold">{r.streak}연속</span>
                      ) : (
                        <span className="text-gray-400 text-xs">{r.streak || '-'}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-center text-xs font-bold text-rose-600">{r.overDays}</td>
                    {r.cells.map((c, i) => {
                      if (c === null) {
                        return <td key={i} className="px-1.5 py-1.5 text-center text-gray-300 bg-gray-50/60">·</td>;
                      }
                      const over = c >= threshold;
                      return (
                        <td key={i}
                          className={`px-1.5 py-1.5 text-center font-bold tabular-nums ${
                            over ? 'bg-red-300 text-red-900'
                            : c > 0 ? 'text-green-600'
                            : c < 0 ? 'text-gray-400'
                            : 'text-blue-500'
                          }`}>
                          {c > 0 ? c : c === 0 ? '0' : c}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 범례 */}
        <div className="px-5 py-2.5 border-t bg-slate-50 flex items-center gap-4 text-xs text-gray-500 flex-wrap">
          <span className="flex items-center gap-1"><span className="inline-block w-4 h-4 rounded bg-red-300" /> 잔여 {threshold}개 이상</span>
          <span className="flex items-center gap-1"><span className="text-green-600 font-bold">+</span> 잔여 있음(임계 미만)</span>
          <span className="flex items-center gap-1"><span className="text-gray-300">·</span> 그날 생산 없음</span>
          <span className="ml-auto">정렬: 최근 연속 → 임계초과 일수 순</span>
        </div>
      </div>
    </div>
  );
}
