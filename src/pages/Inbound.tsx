/** 구매 > 입고 — 그날 입고 원재료를 붙여넣으면 ERP 품목코드를 자동 매칭하고
 *  업체별로 묶어 ERP 업로드용 엑셀을 생성한다.
 *  - ERP 코드 마스터: settings(설정)에서 '품목코드 품목명 [규격] [업체]' 로 등록 → materialErpCodes 컬렉션
 *  - 입고 붙여넣기: '원재료명 [탭/콤마] 수량' (수량 단위는 그대로 유지: kg/g/box 등)
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { normalizeMaterialName } from '../lib/wasteCompute';

interface ErpMat { code: string; name: string; supplier?: string; vat?: string; }
interface Row { name: string; qty: number | null; unit: string; matched?: ErpMat; ambiguous?: boolean; }

const NO_SUPPLIER = '미지정 업체';

// 핵심 이름: 괄호 안(예: (국내산)) 제거 + 공백 제거 + 소문자 → '단호박(국내산)' == '단호박'
function coreName(s: string): string {
  return (s || '').replace(/\(.*?\)/g, '').replace(/\s+/g, '').toLowerCase();
}

// ERP 발주수량은 g 기준 → kg면 ×1000, g/그 외는 그대로
function toGrams(qty: number, unit: string): number {
  const u = (unit || '').toLowerCase();
  if (u.includes('kg')) return Math.round(qty * 1000);
  return qty;
}

// '원재료명 320kg' / '원재료명\t320\tkg' 등에서 이름·수량·단위 추출
function parseLine(line: string): Row | null {
  // 엑셀 붙여넣기는 탭 구분 → 탭이 있으면 탭으로만 자름(이름 속 콤마 보존)
  const parts = (line.includes('\t') ? line.split('\t') : line.split(',')).map((s) => s.trim()).filter(Boolean);
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
  // 업체 그날그날 수정 (품목코드별 오버라이드). 마스터의 기본 업체를 덮어씀.
  const [override, setOverride] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<{ count: number; updatedAt?: string; items: any[] } | null>(null);
  const [saving, setSaving] = useState(false);

  // 선택 날짜의 저장 데이터 → 자동으로 입력칸에 채움 (없으면 비움)
  useEffect(() => {
    getDoc(doc(db, 'purchaseInbound', date)).then((s) => {
      if (s.exists()) {
        const d = s.data() as any;
        const items = (d.items || []) as any[];
        setSaved({ count: items.length, updatedAt: d.updatedAt, items });
        setText(items.map((it) => `${it.name}\t${it.qty}${it.unit || ''}`).join('\n'));
        const ov: Record<string, string> = {};
        items.forEach((it) => { if (it.supplier && it.supplier !== NO_SUPPLIER) ov[it.code] = it.supplier; });
        setOverride(ov);
      } else {
        setSaved(null); setText(''); setOverride({});
      }
    }).catch(() => {});
  }, [date]);

  const [supCodes, setSupCodes] = useState<Record<string, string>>({});  // 업체명 → 거래처코드
  const [erpCfg, setErpCfg] = useState<{ plant?: string; tppo?: string; um?: string; exch?: string; pjt?: string }>({});

  useEffect(() => onSnapshot(collection(db, 'materialErpCodes'), (snap) => {
    const list: ErpMat[] = [];
    snap.forEach((d) => list.push(d.data() as ErpMat));
    setMaster(list);
  }), []);
  useEffect(() => onSnapshot(collection(db, 'supplierCodes'), (snap) => {
    const m: Record<string, string> = {};
    snap.forEach((d) => { const v = d.data() as any; m[v.name || d.id] = v.code || ''; });
    setSupCodes(m);
  }), []);
  useEffect(() => onSnapshot(doc(db, 'appMeta', 'purchaseErp'), (s) => setErpCfg((s.data() || {}) as any)), []);

  const maps = useMemo(() => {
    const exact = new Map<string, ErpMat>();
    const core = new Map<string, ErpMat[]>();
    master.forEach((x) => {
      exact.set(normalizeMaterialName(x.name), x);
      const c = coreName(x.name);
      if (!core.has(c)) core.set(c, []);
      core.get(c)!.push(x);
    });
    return { exact, core };
  }, [master]);

  const rows = useMemo<Row[]>(() => {
    return text.trim().split('\n').map((l) => parseLine(l.trim())).filter(Boolean).map((r) => {
      const row = r as Row;
      // 1) 이름 완전일치 → 2) 괄호 뺀 핵심 이름 일치(단, 후보 1개일 때만)
      const ex = maps.exact.get(normalizeMaterialName(row.name));
      if (ex) { row.matched = ex; return row; }
      const cand = maps.core.get(coreName(row.name));
      if (cand && cand.length === 1) row.matched = cand[0];
      else if (cand && cand.length > 1) row.ambiguous = true;
      return row;
    });
  }, [text, maps]);

  const valid = rows.filter((r) => r.matched && r.qty !== null);
  const ambiguous = rows.filter((r) => r.ambiguous);
  const unmatched = rows.filter((r) => !r.matched && !r.ambiguous);
  const noQty = rows.filter((r) => r.matched && r.qty === null);
  const hasSupplier = master.some((m) => m.supplier);
  const effSupplier = (r: Row) => (override[r.matched!.code] ?? r.matched!.supplier ?? '').trim() || NO_SUPPLIER;
  // 업체 자동완성 목록 (마스터 + 오버라이드에 쓰인 업체들)
  const supplierList = useMemo(() => {
    const s = new Set<string>();
    master.forEach((m) => { if (m.supplier?.trim()) s.add(m.supplier.trim()); });
    Object.values(override).forEach((v) => { if (v.trim()) s.add(v.trim()); });
    return Array.from(s).sort();
  }, [master, override]);

  // 업체별 그룹
  const groups = useMemo(() => {
    const g = new Map<string, Row[]>();
    valid.forEach((r) => {
      const sup = (override[r.matched!.code] ?? r.matched!.supplier ?? '').trim() || NO_SUPPLIER;
      if (!g.has(sup)) g.set(sup, []);
      g.get(sup)!.push(r);
    });
    return Array.from(g.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [valid, override]);

  const save = async () => {
    if (valid.length === 0) return;
    setSaving(true);
    try {
      const items = valid.map((r) => ({ code: r.matched!.code, name: r.matched!.name, qty: r.qty, unit: r.unit || 'g', supplier: effSupplier(r) }));
      const updatedAt = new Date().toISOString();
      await setDoc(doc(db, 'purchaseInbound', date), { date, items, updatedAt }, { merge: false });
      setSaved({ count: items.length, updatedAt, items });
      alert(`${items.length}품목 저장 완료 (${date})`);
    } finally { setSaving(false); }
  };
  const clearInput = async () => {
    const hasSaved = !!saved;
    const msg = hasSaved
      ? `이 날짜(${date}) 입력과 저장분을 모두 삭제할까요?`
      : '입력한 내용을 비울까요?';
    if (!confirm(msg)) return;
    setText('');
    setOverride({});
    if (hasSaved) {
      await deleteDoc(doc(db, 'purchaseInbound', date)).catch(() => {});
      setSaved(null);
    }
  };

  const download = async () => {
    if (valid.length === 0) return;
    const wb = new ExcelJS.Workbook();
    const thin = { style: 'thin', color: { argb: 'FFCBD5E1' } } as const;
    const border = { top: thin, left: thin, right: thin, bottom: thin };
    groups.forEach(([supplier, list]) => {
      const safe = supplier.replace(/[\\/*?:[\]]/g, ' ').slice(0, 28) || '업체';
      const ws = wb.addWorksheet(safe);
      ws.columns = [{ width: 16 }, { width: 28 }, { width: 12 }, { width: 8 }];
      const head = ws.addRow(['품목코드', '품목명', '수량', '단위']);
      head.eachCell((c) => {
        c.font = { bold: true, size: 11 };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0EC' } };
        c.border = border;
      });
      head.height = 20;
      list.forEach((r) => {
        const row = ws.addRow([r.matched!.code, r.matched!.name, r.qty, r.unit || 'g']);
        row.eachCell((c, i) => {
          c.border = border;
          c.alignment = { horizontal: i === 1 ? 'left' : 'center', vertical: 'middle' };
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

  // ERP 일괄매입등록 업로드 양식 — ERP가 구형 .xls(BIFF8)만 받으므로 SheetJS로 .xls 생성.
  // 1행 헤더 + 2행부터 데이터 (CD_PARTNER … CD_EXCH).
  const erpDownload = () => {
    if (valid.length === 0) return;
    const header = ['CD_PARTNER', 'CD_PLANT', 'CD_TPPO', 'FG_UM', 'CD_PJT', 'CD_ITEM', 'QT_PO', 'CD_EXCH'];
    const aoa: (string | number)[][] = [
      header,
      header.map(() => ''),   // 2번째 줄은 비움 (ERP가 2행은 입력 안 받음) → 데이터는 3행부터
      ...valid.map((r) => {
        const sup = effSupplier(r);
        return [
          supCodes[sup] || '',
          erpCfg.plant || '', erpCfg.tppo || '',
          erpCfg.um || '',   // FG_UM = 단가유형 (설정 고정값, 예: 001 정상가)
          erpCfg.pjt || '',
          r.matched!.code, toGrams(r.qty as number, r.unit), erpCfg.exch || '',
        ];
      }),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, `ERP발주_${date}.xls`, { bookType: 'xls' });
  };

  const missingSupCodes = useMemo(() => {
    const s = new Set<string>();
    valid.forEach((r) => { const sup = effSupplier(r); if (sup !== NO_SUPPLIER && !supCodes[sup]) s.add(sup); });
    return Array.from(s);
  }, [valid, supCodes, override]);

  return (
    <div className="space-y-4">
      <datalist id="supplier-list">
        {supplierList.map((s) => <option key={s} value={s} />)}
      </datalist>
      {/* 헤더 */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">🛒 입고 발주</h2>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)}
          className="border rounded px-2 py-1 text-sm" />
        <span className="text-sm text-gray-500">
          ERP 코드 마스터 <b className="text-teal-700">{master.length}</b>개 등록됨
        </span>
        <button onClick={clearInput} disabled={rows.length === 0}
          className="ml-auto px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-600 font-medium hover:bg-gray-50 disabled:opacity-40">
          🗑️ 비우기
        </button>
        <button onClick={save} disabled={valid.length === 0 || saving}
          className="px-4 py-1.5 text-sm rounded-md bg-blue-700 text-white font-medium hover:bg-blue-800 disabled:bg-gray-300">
          {saving ? '저장중...' : '💾 저장'}
        </button>
        <button onClick={erpDownload} disabled={valid.length === 0}
          className="px-4 py-1.5 text-sm rounded-md bg-teal-700 text-white font-medium hover:bg-teal-800 disabled:bg-gray-300">
          📤 ERP 업로드 엑셀
        </button>
        <button onClick={download} disabled={valid.length === 0}
          className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-600 font-medium hover:bg-gray-50 disabled:opacity-50">
          업체별(읽기용)
        </button>
      </div>

      {missingSupCodes.length > 0 && (
        <div className="bg-orange-50 border border-orange-300 rounded-lg px-4 py-2.5 text-sm text-orange-800">
          ⚠ 거래처코드 없는 업체 {missingSupCodes.length}개: <b>{missingSupCodes.join(', ')}</b>
          <span className="text-orange-600"> → 설정 → 구매 ERP 설정에서 거래처코드 등록 (CD_PARTNER 빈칸으로 나감)</span>
        </div>
      )}

      {saved && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 text-sm text-blue-800">
          📌 이 날짜 저장분 자동 표시됨: <b>{saved.count}품목</b>
          {saved.updatedAt && <span className="text-blue-500 text-xs ml-1">(마지막 저장 {saved.updatedAt.slice(0, 16).replace('T', ' ')})</span>}
        </div>
      )}

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
            {ambiguous.length > 0 && <span className="text-orange-600 ml-2">· 후보중복 {ambiguous.length}</span>}
            {noQty.length > 0 && <span className="text-orange-600 ml-2">· 수량없음 {noQty.length}</span>}
          </div>
        )}
      </div>

      {/* 경고 */}
      {(unmatched.length > 0 || ambiguous.length > 0 || noQty.length > 0) && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm space-y-1">
          {unmatched.length > 0 && (
            <div className="text-red-700">
              ⚠ ERP 코드 미등록 {unmatched.length}개: <b>{unmatched.map((u) => u.name).join(', ')}</b>
              <span className="text-red-500"> → 설정에 코드 추가 필요 (엑셀에서 제외됨)</span>
            </div>
          )}
          {ambiguous.length > 0 && (
            <div className="text-orange-700">
              ⚠ 이름이 여러 품목과 겹쳐 자동매칭 불가 {ambiguous.length}개: <b>{ambiguous.map((u) => u.name).join(', ')}</b>
              <span className="text-orange-600"> → 괄호까지 정확히 입력하세요 (예: 단호박(국내산))</span>
            </div>
          )}
          {noQty.length > 0 && (
            <div className="text-orange-700">⚠ 수량 인식 실패 {noQty.length}개: {noQty.map((u) => u.name).join(', ')}</div>
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
                <th className="px-4 py-2 text-right w-28">수량</th>
                <th className="px-4 py-2 text-left w-40">업체 (변경 가능)</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.map((r, i) => (
                <tr key={i} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2 font-mono font-bold text-teal-700">{r.matched!.code}</td>
                  <td className="px-4 py-2 text-gray-800">{r.matched!.name}</td>
                  <td className="px-4 py-2 text-right font-bold tabular-nums">{r.qty!.toLocaleString()}<span className="text-xs text-gray-400 ml-1">{r.unit || 'g'}</span></td>
                  <td className="px-4 py-2">
                    <input list="supplier-list" defaultValue={effSupplier(r) === NO_SUPPLIER ? '' : effSupplier(r)}
                      key={`${r.matched!.code}-${override[r.matched!.code] ?? ''}`}
                      onBlur={(e) => setOverride((o) => ({ ...o, [r.matched!.code]: e.target.value }))}
                      placeholder="업체" className="w-36 border rounded px-2 py-1 text-xs" />
                  </td>
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
