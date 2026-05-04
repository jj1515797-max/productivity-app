import { useState } from 'react';
import ExcelJS from 'exceljs';
import { writeBatch, doc } from 'firebase/firestore';
import { db } from '../firebase';
import type { Item, MachineEntry } from '../types';

type Log = { type: 'info' | 'ok' | 'err'; msg: string };

const MACHINE_SHEETS: Record<string, MachineEntry['machine']> = {
  '1호기': '1호기',
  '2호기': '2호기',
  '3호기': '3호기',
};

const ITEMS_SHEET = '죽받기용';

function parseDateFromFilename(name: string): string | null {
  const m = name.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// find header row by locating "코드명" in first 5 rows
function findHeaderRow(ws: ExcelJS.Worksheet): { row: number; cols: Record<string, number> } | null {
  for (let r = 1; r <= 5; r++) {
    const cols: Record<string, number> = {};
    const row = ws.getRow(r);
    let foundCode = false;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const v = String(cell.value ?? '').trim();
      if (v) cols[v] = colNumber;
      if (v === '코드명' || v === '코드') foundCode = true;
    });
    if (foundCode) return { row: r, cols };
  }
  return null;
}

function cellNum(ws: ExcelJS.Worksheet, row: number, col: number): number {
  const v = ws.getRow(row).getCell(col).value;
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  }
  if (typeof v === 'object' && 'result' in (v as object)) {
    const r = (v as { result?: unknown }).result;
    return typeof r === 'number' ? r : 0;
  }
  return 0;
}

function cellStr(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = ws.getRow(row).getCell(col).value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) {
    const h = String(v.getHours()).padStart(2, '0');
    const m = String(v.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
  if (typeof v === 'object' && 'result' in (v as object)) {
    const r = (v as { result?: unknown }).result;
    return r == null ? '' : String(r);
  }
  return String(v).trim();
}

function cellTime(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = ws.getRow(row).getCell(col).value;
  if (!v) return '';
  if (v instanceof Date) {
    const h = String(v.getHours()).padStart(2, '0');
    const m = String(v.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
  if (typeof v === 'number') {
    // Excel time fraction
    const totalMin = Math.round(v * 24 * 60);
    const h = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
    const m = String(totalMin % 60).padStart(2, '0');
    return `${h}:${m}`;
  }
  return cellStr(ws, row, col);
}

export default function Import() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState(true);

  const log = (l: Log) => setLogs((prev) => [...prev, l]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setLogs([]);
    try {
      for (const file of Array.from(files)) {
        await processFile(file);
      }
    } finally {
      setBusy(false);
    }
  };

  const processFile = async (file: File) => {
    const date = parseDateFromFilename(file.name);
    if (!date) {
      log({ type: 'err', msg: `[${file.name}] 파일명에서 날짜를 못 찾음 (YYYY-MM-DD 형식 필요)` });
      return;
    }
    log({ type: 'info', msg: `▶ ${file.name} → ${date}` });

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(await file.arrayBuffer());
    } catch (e) {
      log({ type: 'err', msg: `  엑셀 파싱 실패: ${(e as Error).message}` });
      return;
    }

    const machineEntries: MachineEntry[] = [];
    const items: Item[] = [];

    for (const ws of wb.worksheets) {
      const sheetName = ws.name.trim();

      if (MACHINE_SHEETS[sheetName]) {
        const m = MACHINE_SHEETS[sheetName];
        const header = findHeaderRow(ws);
        if (!header) {
          log({ type: 'err', msg: `  [${sheetName}] 헤더 행 못 찾음` });
          continue;
        }
        const cCode = header.cols['코드명'] || header.cols['코드'];
        const cActual = header.cols['실제 생산량'] || header.cols['실제생산량'];
        const cAdd = header.cols['추가 생산량'] || header.cols['추가생산량'];
        const cTime = header.cols['작업 시간'] || header.cols['작업시간'];
        const cAddTime = header.cols['추가 생산량 작업시간'] || header.cols['추가작업시간'];
        if (!cCode || !cActual) {
          log({ type: 'err', msg: `  [${sheetName}] 코드명/실제생산량 컬럼 못 찾음` });
          continue;
        }
        let count = 0;
        for (let r = header.row + 1; r <= ws.rowCount; r++) {
          const code = cellStr(ws, r, cCode);
          if (!code) continue;
          const actual = cellNum(ws, r, cActual);
          if (actual <= 0) continue;
          const add = cAdd ? cellNum(ws, r, cAdd) : 0;
          const wt = cTime ? cellTime(ws, r, cTime) : '';
          const awt = cAddTime ? cellTime(ws, r, cAddTime) : '';
          const entry: MachineEntry = {
            id: code,
            code,
            actualProduction: actual,
            additionalProduction: add,
            workTime: wt,
            machine: m,
            date,
          };
          if (awt) entry.additionalWorkTime = awt;
          machineEntries.push(entry);
          count++;
        }
        log({ type: 'ok', msg: `  [${sheetName}] ${count}건 파싱` });
      } else if (sheetName === ITEMS_SHEET) {
        const header = findHeaderRow(ws);
        if (!header) {
          log({ type: 'err', msg: `  [${sheetName}] 헤더 행 못 찾음` });
          continue;
        }
        const cCode = header.cols['코드명'] || header.cols['코드'];
        const cName = header.cols['품목명'];
        const cOrder = header.cols['주문 수량'] || header.cols['주문수량'];
        const cCoupang = header.cols['쿠팡'];
        const cKurly = header.cols['마켓컬리'];
        const cTotal = header.cols['총 수량'] || header.cols['총수량'];
        const cActual = header.cols['실제 생산량'] || header.cols['실제생산량'];
        const cCool = header.cols['냉각 종료 예상 시간'] || header.cols['냉각종료예상시간'];
        if (!cCode || !cName) {
          log({ type: 'err', msg: `  [${sheetName}] 코드/품목명 컬럼 못 찾음` });
          continue;
        }
        let count = 0;
        for (let r = header.row + 1; r <= ws.rowCount; r++) {
          const code = cellStr(ws, r, cCode);
          const name = cellStr(ws, r, cName);
          if (!code || !name) continue;
          const item: Item = {
            id: code,
            code,
            name,
            orderQty: cOrder ? cellNum(ws, r, cOrder) : 0,
            coupang: cCoupang ? cellNum(ws, r, cCoupang) : 0,
            marketKurly: cKurly ? cellNum(ws, r, cKurly) : 0,
            totalQty: cTotal ? cellNum(ws, r, cTotal) : 0,
            actualProduction: cActual ? cellNum(ws, r, cActual) : 0,
            date,
          };
          const cool = cCool ? cellTime(ws, r, cCool) : '';
          if (cool) item.coolingEndTime = cool;
          items.push(item);
          count++;
        }
        log({ type: 'ok', msg: `  [${sheetName}] ${count}개 품목 파싱` });
      }
    }

    log({
      type: 'info',
      msg: `  요약: items ${items.length}개, entries ${machineEntries.length}건`,
    });

    if (dryRun) {
      log({ type: 'info', msg: '  (테스트 모드: Firestore 저장 안 함)' });
      return;
    }

    // Write to Firestore in batches of 450 (Firestore limit 500/batch)
    try {
      const writes: { ref: ReturnType<typeof doc>; data: object }[] = [];
      items.forEach((it) =>
        writes.push({ ref: doc(db, 'days', date, 'items', it.code), data: it })
      );
      machineEntries.forEach((e) =>
        writes.push({
          ref: doc(db, 'days', date, 'machines', e.machine, 'entries', e.code),
          data: e,
        })
      );

      for (let i = 0; i < writes.length; i += 450) {
        const batch = writeBatch(db);
        writes.slice(i, i + 450).forEach((w) => batch.set(w.ref, w.data));
        await batch.commit();
      }
      log({ type: 'ok', msg: `  ✓ Firestore 저장 완료 (${writes.length}건)` });
    } catch (e) {
      log({ type: 'err', msg: `  Firestore 저장 실패: ${(e as Error).message}` });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">백업 데이터 가져오기</h2>
      </div>

      <div className="bg-white border rounded-lg p-5 space-y-4">
        <div className="text-sm text-gray-700 space-y-1">
          <p>구글 시트에서 다운로드한 <code className="bg-gray-100 px-1 rounded">.xlsx</code> 파일을 선택하세요. 여러 개 한 번에 가능.</p>
          <p>파일명에 <code className="bg-gray-100 px-1 rounded">YYYY-MM-DD</code>가 들어 있어야 날짜를 인식합니다 (예: <code>생산팀 안돈_Backup_2026-05-01(금요일).xlsx</code>).</p>
          <p className="text-orange-700">⚠ 같은 날짜의 같은 코드가 이미 있으면 <strong>덮어쓰기</strong>됩니다.</p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <span>테스트 모드 (저장 안 하고 파싱만 확인)</span>
        </label>

        <input
          type="file"
          accept=".xlsx"
          multiple
          disabled={busy}
          onChange={(e) => handleFiles(e.target.files)}
          className="block w-full text-sm file:mr-3 file:px-4 file:py-2 file:rounded file:border-0 file:bg-blue-900 file:text-white hover:file:bg-blue-800 file:cursor-pointer"
        />
        {busy && <div className="text-sm text-blue-700">처리 중...</div>}
      </div>

      {logs.length > 0 && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-5 py-2 border-b bg-slate-50 font-semibold text-sm">처리 로그</div>
          <div className="p-4 font-mono text-xs space-y-0.5 max-h-96 overflow-y-auto">
            {logs.map((l, i) => (
              <div
                key={i}
                className={
                  l.type === 'err' ? 'text-red-600' : l.type === 'ok' ? 'text-green-700' : 'text-gray-700'
                }
              >
                {l.msg}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
