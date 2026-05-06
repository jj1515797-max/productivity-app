import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { Item, MachineEntry } from '../types';

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
  const [pasteText, setPasteText] = useState('');

  useEffect(() => { saveViewDate(date); }, [date]);
  const today = todayKey();
  const isToday = date === today;

  useEffect(() => {
    setItems([]);
    return onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      list.sort((a, b) => a.code.localeCompare(b.code));
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

  const enriched = useMemo(() => items.map((it) => {
    const actual = actualByCode[it.code.toLowerCase()] || 0;
    // logisticsQty 키(doc ID)와 item 코드를 둘 다 normalize해서 비교
    const normItem = normalize(it.code);
    const logEntry = Object.entries(logisticsQty).find(([k]) => normalize(k) === normItem);
    const totalQty = logEntry !== undefined ? logEntry[1] : (it.totalQty || 0);
    return { ...it, actualProduction: actual, totalQty };
  }), [items, actualByCode, logisticsQty]);

  const produced = enriched.filter((it) => it.actualProduction > 0);
  const surplus  = produced.filter((it) => it.actualProduction > it.totalQty);
  const exact    = produced.filter((it) => it.actualProduction === it.totalQty);
  const shortage = produced.filter((it) => it.actualProduction < it.totalQty);

  const saveLogistics = async () => {
    const lines = pasteText.trim().split('\n').map((r) => r.split('\t'));
    const hIdx = lines.findIndex((r) => r.some((c) => c.trim() === '제품코드'));
    if (hIdx < 0) return alert('제품코드 헤더를 찾을 수 없습니다');
    const header = lines[hIdx].map((c) => c.trim());
    const codeCol = header.indexOf('제품코드');
    const qtyCol  = header.indexOf('등록수량');
    if (codeCol < 0 || qtyCol < 0) return alert('제품코드 또는 등록수량 열을 찾을 수 없습니다');

    const batch = writeBatch(db);
    let count = 0;
    for (let i = hIdx + 1; i < lines.length; i++) {
      const r = lines[i];
      const erpCode = (r[codeCol] || '').trim();
      const qty = parseInt(r[qtyCol] || '0', 10);
      if (!erpCode || isNaN(qty) || qty < 0) continue;
      const ourCode = convertErpCode(erpCode);
      batch.set(doc(db, 'days', date, 'logistics', ourCode), { code: ourCode, qty, erpCode });
      count++;
    }
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
        <Section title="부족 (추가생산 필요)" count={shortage.length} color="red">
          {shortage.map((it) => <Row key={it.code} item={it} />)}
        </Section>
      )}

      {surplus.length > 0 && (
        <Section title="잔여량 있음" count={surplus.length} color="green">
          {surplus.map((it) => <Row key={it.code} item={it} />)}
        </Section>
      )}

      {exact.length > 0 && (
        <Section title="잔여량 없음" count={exact.length} color="blue">
          {exact.map((it) => <Row key={it.code} item={it} />)}
        </Section>
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

function Section({ title, count, color, children }: {
  title: string; count: number; color: 'green' | 'blue' | 'red'; children: React.ReactNode;
}) {
  const colors = { green: 'border-green-500 bg-green-50', blue: 'border-blue-500 bg-blue-50', red: 'border-red-500 bg-red-50' };
  const textColors = { green: 'text-green-700', blue: 'text-blue-700', red: 'text-red-700' };
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
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
      <td className={`px-4 py-2.5 text-right font-bold ${remain > 0 ? 'text-green-600' : remain < 0 ? 'text-red-500' : 'text-blue-600'}`}>
        {remain > 0 ? `+${remain}` : remain === 0 ? '✓' : remain}
      </td>
    </tr>
  );
}
