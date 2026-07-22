/** 구매 > 입고 — 그날 입고 원재료를 붙여넣으면 ERP 품목코드를 자동 매칭하고
 *  업체별로 묶어 ERP 업로드용 엑셀을 생성한다.
 *  - ERP 코드 마스터: settings(설정)에서 '품목코드 품목명 [규격] [업체]' 로 등록 → materialErpCodes 컬렉션
 *  - 입고 붙여넣기: '원재료명 [탭/콤마] 수량' (수량 단위는 그대로 유지: kg/g/box 등)
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { normalizeMaterialName } from '../lib/wasteCompute';

interface ErpMat { code: string; name: string; spec?: string; supplier?: string; }
interface Row { name: string; qty: number | null; unit: string; matched?: ErpMat; }

const NO_SUPPLIER = '미지정 업체';

// '원재료명 320kg' / '원재료명\t320\tkg' 등에서 이름·수량·단위 추출
function parseLine(line: string): Row | null {
  const parts = line.split(/[\t,]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let qtyIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) { if (/\d/.test(parts[i])) { qtyIdx = i; break; } }
  let name = parts[0], qty: number | null = null, unit = '';
  const parseQty = (tok: string) => {
    const mm = tok.match(/([\d.,]+)\s*([a-zA-Z가-힣]*)/);
    if (mm) { qty = Number(mm[1].replace(/,/g, '')) || null; unit = mm[2] || ''; }
  };
  if (qtyIdx <= 0) {
    const mm = parts[0].match(/^(.*?)[\s]+([\d.,]+)\s*([a-zA-Z가-힣]*)$/);
    if (mm) { name = mm[1].trim(); qty = Number(mm[2].replace(/,/g, '')) || null; unit = mm[3] || ''; }
    else name = parts[0];
  } else {
    name = parts.slice(0, qtyIdx).join(' ').trim() || parts[0];
    parseQty(parts[qtyIdx]);
  }
  return { name, qty, unit };
}

export default function Inbound() {
  const [master, setMaster] = useState<ErpMat[]>([]);
  const [text, setText] = useState('');
  const [date, setDate] = useState(todayKey());

  useEffect(() => onSnapshot(collection(db, 'materialErpCodes'), (snap) => {
    const list: ErpMat[] = [];
    snap.forEach((d) => list.push(d.data() as ErpMat));
    setMaster(list);
  }), []);

  const lookup = useMemo(() => {
    const m = new Map<string, ErpMat>();
    master.forEach((x) => m.set(normalizeMaterialName(x.name), x));
    return m;
  }, [master]);

  const rows = useMemo<Row[]>(() => {
    return text.trim().split('\n').map((l) => parseLine(l.trim())).filter(Boolean).map((r) => {
      const row = r as Row;
      row.matched = lookup.get(normalizeMaterialName(row.name));
      return row;
    });
  }, [text, lookup]);

  const valid = rows.filter((r) => r.matched && r.qty !== null);
  const unmatched = rows.filter((r) => !r.matched);
  const noQty = rows.filter((r) => r.matched && r.qty === null);
  const hasSupplier = master.some((m) => m.supplier);

  // 업체별 그룹
  const groups = useMemo(() => {
    const g = new Map<string, Row[]>();
    valid.forEach((r) => {
      const sup = r.matched!.supplier?.trim() || NO_SUPPLIER;
      if (!g.has(sup)) g.set(sup, []);
      g.get(sup)!.push(r);
    });
    return Array.from(g.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [valid]);

  const download = async () => {
    if (valid.length === 0) return;
    const wb = new ExcelJS.Workbook();
    const thin = { style: 'thin', color: { argb: 'FFCBD5E1' } } as const;
    const border = { top: thin, left: thin, right: thin, bottom: thin };
    groups.forEach(([supplier, list]) => {
      const safe = supplier.replace(/[\\/*?:[\]]/g, ' ').slice(0, 28) || '업체';
      const ws = wb.addWorksheet(safe);
      ws.columns = [{ width: 16 }, { width: 26 }, { width: 12 }, { width: 12 }, { width: 8 }];
      const head = ws.addRow(['품목코드', '품목명', '규격', '수량', '단위']);
      head.eachCell((c) => {
        c.font = { bold: true, size: 11 };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0EC' } };
        c.border = border;
      });
      head.height = 20;
      list.forEach((r) => {
        const row = ws.addRow([r.matched!.code, r.matched!.name, r.matched!.spec || '', r.qty, r.unit || 'g']);
        row.eachCell((c, i) => {
          c.border = border;
          c.alignment = { horizontal: i === 2 ? 'left' : (i >= 4 ? 'center' : (i === 1 ? 'left' : 'center')), vertical: 'middle' };
          if (i === 1) c.alignment = { horizontal: 'left', vertical: 'middle' };
          if (i === 4) c.font = { bold: true };
        });
      });
    });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `입고발주_${date}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">🛒 입고 발주</h2>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)}
          className="border rounded px-2 py-1 text-sm" />
        <span className="text-sm text-gray-500">
          ERP 코드 마스터 <b className="text-teal-700">{master.length}</b>개 등록됨
        </span>
        <button onClick={download} disabled={valid.length === 0}
          className="ml-auto px-4 py-1.5 text-sm rounded-md bg-teal-700 text-white font-medium hover:bg-teal-800 disabled:bg-gray-300">
          📥 업체별 엑셀 다운로드
        </button>
      </div>

      {master.length === 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800">
          먼저 <b>분석 → 설정 → 원재료 ERP 코드</b>에서 <code className="bg-white px-1 rounded">품목코드 품목명</code> 을 붙여넣어 등록하세요.
        </div>
      )}

      {/* 붙여넣기 */}
      <div className="bg-white border rounded-lg p-4 space-y-2">
        <div className="text-sm font-semibold text-gray-700">오늘 입고 붙여넣기</div>
        <div className="text-xs text-gray-500">
          형식: <code className="bg-gray-100 px-1 rounded">원재료명 [탭/콤마] 수량</code> — 한 줄에 하나. 엑셀에서 이름·수량 두 열을 그대로 복사해 붙여넣으면 됩니다.
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)}
          placeholder={"당근\t150kg\n대파\t40kg\n무\t170kg"}
          className="w-full h-48 border rounded-md p-3 text-sm font-mono" />
        {rows.length > 0 && (
          <div className="text-sm text-gray-600">
            매칭 <b className="text-teal-700">{valid.length}</b> / 전체 {rows.length}줄
            {unmatched.length > 0 && <span className="text-red-600 ml-2">· 미매칭 {unmatched.length}</span>}
            {noQty.length > 0 && <span className="text-orange-600 ml-2">· 수량없음 {noQty.length}</span>}
          </div>
        )}
      </div>

      {/* 미매칭 경고 */}
      {(unmatched.length > 0 || noQty.length > 0) && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm">
          {unmatched.length > 0 && (
            <div className="text-red-700">
              ⚠ ERP 코드 미등록 {unmatched.length}개: <b>{unmatched.map((u) => u.name).join(', ')}</b>
              <span className="text-red-500"> → 설정에 코드 추가 필요 (엑셀에서 제외됨)</span>
            </div>
          )}
          {noQty.length > 0 && (
            <div className="text-orange-700 mt-1">⚠ 수량 인식 실패 {noQty.length}개: {noQty.map((u) => u.name).join(', ')}</div>
          )}
        </div>
      )}

      {/* 업체별 미리보기 */}
      {groups.map(([supplier, list]) => (
        <div key={supplier} className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 bg-teal-50 border-b flex items-center gap-2">
            <span className="font-bold text-teal-800">{supplier}</span>
            <span className="text-xs text-gray-500">{list.length}품목</span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left w-32">품목코드</th>
                <th className="px-4 py-2 text-left">품목명</th>
                <th className="px-4 py-2 text-left w-24">규격</th>
                <th className="px-4 py-2 text-right w-28">수량</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.map((r, i) => (
                <tr key={i} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2 font-mono font-bold text-teal-700">{r.matched!.code}</td>
                  <td className="px-4 py-2 text-gray-800">{r.matched!.name}</td>
                  <td className="px-4 py-2 text-gray-500">{r.matched!.spec || '-'}</td>
                  <td className="px-4 py-2 text-right font-bold tabular-nums">{r.qty!.toLocaleString()}<span className="text-xs text-gray-400 ml-1">{r.unit || 'g'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {!hasSupplier && groups.length > 0 && (
        <div className="text-xs text-gray-400">
          ※ 업체 정보가 없어 한 그룹으로 표시됩니다. 설정의 ERP 코드에 <b>업체</b>까지 넣으면 업체별로 자동 분리됩니다.
        </div>
      )}
    </div>
  );
}
