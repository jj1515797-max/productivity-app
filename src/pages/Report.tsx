import { Fragment, useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import { useTodayVisitorCount } from '../lib/presence';
import type { Item, MachineEntry } from '../types';

const MACHINES: MachineEntry['machine'][] = ['1호기', '2호기', '3호기'];
const MACHINE_START_COL = ['A', 'F', 'K'];

export default function Report() {
  const [date, setDate] = useState(loadViewDate);
  useEffect(() => { saveViewDate(date); }, [date]);
  const today = todayKey();
  const isToday = date === today;
  const visitors = useTodayVisitorCount();
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
        list.sort((a, b) => (a.workTime || a.additionalWorkTime || '').localeCompare(b.workTime || b.additionalWorkTime || ''));
        setByMachine((prev) => ({ ...prev, [m]: list }));
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [date]);

  const nameMap = useMemo(() => {
    const map = new Map<string, string>();
    items.forEach((i) => map.set(i.code.toLowerCase(), i.name));
    return map;
  }, [items]);

  const dateLabel = useMemo(() => {
    const [y, m, d] = date.split('-');
    return `${y}. ${Number(m)}. ${Number(d)}`;
  }, [date]);

  const sheetName = useMemo(() => {
    const [, m, d] = date.split('-');
    return `${m}-${d}`;
  }, [date]);

  const maxRows = Math.max(1, ...MACHINES.map((m) => (byMachine[m] || []).length));
  const totalEntries = MACHINES.reduce((s, m) => s + (byMachine[m] || []).length, 0);

  const downloadXlsx = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName);

    // A4 페이지 설정 + 기본 폰트
    ws.pageSetup = {
      paperSize: 9, // A4
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    };
    ws.properties.defaultRowHeight = 16;

    ws.columns = [
      { width: 9 }, { width: 22 }, { width: 9 }, { width: 11 },
      { width: 2 },
      { width: 9 }, { width: 22 }, { width: 9 }, { width: 11 },
      { width: 2 },
      { width: 9 }, { width: 22 }, { width: 9 }, { width: 11 },
    ];

    const thin = { style: 'thin' as const };
    const border = { top: thin, left: thin, right: thin, bottom: thin };
    const headerFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFD6E4F5' } };
    const baseFont = { size: 10 } as const;

    // Title (A1:J2 merged)
    ws.mergeCells('A1:J2');
    const title = ws.getCell('A1');
    title.value = '금속검출기(CCP-2P) 제품 통과 및 생산 내역';
    title.font = { size: 14, bold: true };
    title.alignment = { horizontal: 'center', vertical: 'middle' };

    // Document number / work date (right block)
    ws.mergeCells('K1:L1');
    ws.getCell('K1').value = '문서번호';
    ws.mergeCells('M1:N1');
    ws.getCell('M1').value = 'PB-HI-05-02';
    ws.mergeCells('K2:L2');
    ws.getCell('K2').value = '작업일자';
    ws.mergeCells('M2:N2');
    ws.getCell('M2').value = dateLabel;
    ['K1', 'L1', 'M1', 'N1', 'K2', 'L2', 'M2', 'N2'].forEach((addr) => {
      const c = ws.getCell(addr);
      c.border = border;
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.font = baseFont;
    });

    // Machine headers (row 4) and column headers (row 5)
    const subheaders = ['코드명', '품목명', '생산량', '작업 시간'];
    MACHINES.forEach((m, mi) => {
      const start = MACHINE_START_COL[mi];
      const end = String.fromCharCode(start.charCodeAt(0) + 3);
      ws.mergeCells(`${start}4:${end}4`);
      const headerCell = ws.getCell(`${start}4`);
      headerCell.value = m;
      headerCell.font = { ...baseFont, bold: true };
      headerCell.alignment = { horizontal: 'center', vertical: 'middle' };
      headerCell.fill = headerFill;
      headerCell.border = border;
      // also apply border to merged cells under header
      for (let i = 0; i < 4; i++) {
        const col = String.fromCharCode(start.charCodeAt(0) + i);
        ws.getCell(`${col}4`).border = border;
      }
      // Subheaders row 5
      subheaders.forEach((label, hi) => {
        const col = String.fromCharCode(start.charCodeAt(0) + hi);
        const c = ws.getCell(`${col}5`);
        c.value = label;
        c.font = { ...baseFont, bold: true };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.fill = headerFill;
        c.border = border;
      });
    });

    // Data rows — 데이터 있는 행에만 테두리·정렬
    const maxRows = Math.max(0, ...MACHINES.map((m) => (byMachine[m] || []).length));
    for (let i = 0; i < maxRows; i++) {
      ws.getRow(6 + i).height = 12;
    }
    MACHINES.forEach((m, mi) => {
      const start = MACHINE_START_COL[mi];
      const startCode = start.charCodeAt(0);
      const list = byMachine[m] || [];

      if (list.length === 0) {
        // "생산 내역 없음" cell at column B/G/L (2nd col) row 6
        const c = ws.getCell(`${String.fromCharCode(startCode + 1)}6`);
        c.value = '생산 내역 없음';
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.font = baseFont;
      }

      list.forEach((e, idx) => {
        const row = 6 + idx;
        const cCode = ws.getCell(`${String.fromCharCode(startCode)}${row}`);
        cCode.value = e.code;
        const cName = ws.getCell(`${String.fromCharCode(startCode + 1)}${row}`);
        cName.value = nameMap.get(e.code.toLowerCase()) || '';
        const cQty = ws.getCell(`${String.fromCharCode(startCode + 2)}${row}`);
        cQty.value = e.actualProduction || e.additionalProduction || 0;
        const cTime = ws.getCell(`${String.fromCharCode(startCode + 3)}${row}`);
        cTime.value = e.workTime || e.additionalWorkTime || '';
        // 테두리·정렬·폰트 — 이 행만
        for (let i = 0; i < 4; i++) {
          const col = String.fromCharCode(startCode + i);
          const cell = ws.getCell(`${col}${row}`);
          cell.border = border;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.font = baseFont;
        }
      });
    });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CCP-2P (${date}).xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-gray-800">생산 내역 조회</h2>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-50 border border-green-200 text-xs text-green-700 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            오늘 방문자 {visitors}명
          </span>
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
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">총 {totalEntries}건</span>
          <button
            onClick={downloadXlsx}
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
                {MACHINES.map((m, mi) => (
                  <th
                    key={m}
                    colSpan={4}
                    className={`border border-blue-300 p-2 text-center font-semibold ${mi > 0 ? 'border-l-4 border-l-slate-400' : ''}`}
                  >
                    {m}
                  </th>
                ))}
              </tr>
              <tr className="bg-blue-50 text-xs text-blue-900">
                {MACHINES.map((m, mi) => (
                  <Fragment key={m}>
                    <th className={`border border-blue-200 p-2 ${mi > 0 ? 'border-l-4 border-l-slate-400' : ''}`}>코드명</th>
                    <th className="border border-blue-200 p-2">품목명</th>
                    <th className="border border-blue-200 p-2">생산량</th>
                    <th className="border border-blue-200 p-2">작업 시간</th>
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
                    {MACHINES.map((m, mi) => {
                      const e = (byMachine[m] || [])[i];
                      const lDiv = mi > 0 ? 'border-l-4 border-l-slate-400' : '';
                      if (!e) {
                        return (
                          <Fragment key={m}>
                            <td className={`border p-2 ${lDiv}`}></td>
                            <td className="border p-2"></td>
                            <td className="border p-2"></td>
                            <td className="border p-2"></td>
                          </Fragment>
                        );
                      }
                      return (
                        <Fragment key={m}>
                          <td className={`border p-2 font-mono text-center ${lDiv}`}>{e.code}</td>
                          <td className="border p-2 text-center">{nameMap.get(e.code.toLowerCase()) || ''}</td>
                          <td className="border p-2 text-center font-bold">{e.actualProduction || e.additionalProduction || ''}</td>
                          <td className="border p-2 text-center">{e.workTime || e.additionalWorkTime || ''}</td>
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
