/** 설정 › 제품 바코드 DB — 제품코드 / 제품명 / 제품바코드 붙여넣기 */
import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { BARCODE_COL, gtinCheck, parseBarcodeLine } from '../lib/barcode';
import type { ProductBarcode } from '../lib/barcode';

export default function ProductBarcodePanel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [rows, setRows] = useState<ProductBarcode[]>([]);
  const [search, setSearch] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => onSnapshot(collection(db, BARCODE_COL), (snap) => {
    const list: ProductBarcode[] = [];
    snap.forEach((d) => list.push({ ...(d.data() as ProductBarcode), barcode: d.id }));
    list.sort((a, b) => a.code.localeCompare(b.code) || a.barcode.localeCompare(b.barcode));
    setRows(list);
    onCountChange?.(list.length);
  }), [onCountChange]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.code.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q) || r.barcode.includes(q.toUpperCase()));
  }, [rows, search]);

  const remove = async (bc: string) => {
    if (!confirm(`바코드 ${bc} 를 삭제할까요?`)) return;
    await deleteDoc(doc(db, BARCODE_COL, bc));
  };
  const deleteAll = async () => {
    if (rows.length === 0) return;
    if (prompt(`⚠️ 바코드 ${rows.length}개를 모두 삭제합니다. 되돌릴 수 없습니다.\n진행하려면 "삭제" 를 입력하세요.`) !== '삭제') return;
    setDeleting(true);
    try {
      for (let i = 0; i < rows.length; i += 400) {
        const b = writeBatch(db);
        rows.slice(i, i + 400).forEach((r) => b.delete(doc(db, BARCODE_COL, r.barcode)));
        await b.commit();
      }
    } finally { setDeleting(false); }
  };

  return (
    <div className="space-y-3">
      <div className="bg-indigo-50 border border-indigo-200 rounded p-3 text-xs text-indigo-800 leading-relaxed">
        <b>입력 › 바코드 확인</b> 화면에서 찍은 바코드를 제품으로 바꿔 보여줄 때 씁니다.<br />
        형식: <code className="bg-white px-1 rounded">제품코드 · 제품명 · 제품바코드</code> — 엑셀에서 세 열을 복사해 그대로 붙여넣으면 됩니다.
        같은 바코드를 다시 붙여넣으면 덮어씁니다.
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 제품코드·제품명·바코드 검색..."
          className="flex-1 min-w-[240px] border rounded-md px-3 py-2 text-sm" />
        <span className="text-xs text-gray-500">{filtered.length}/{rows.length}개</span>
        <button onClick={() => setShowBulk(true)} className="px-3 py-2 bg-indigo-600 text-white rounded text-sm font-medium hover:bg-indigo-700">📋 붙여넣기</button>
        {rows.length > 0 && (
          <button onClick={deleteAll} disabled={deleting}
            className="px-3 py-2 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 disabled:bg-gray-300">
            {deleting ? '삭제중...' : `🗑️ 전체 삭제 (${rows.length})`}
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="p-10 text-center text-gray-400 text-sm border rounded-lg">등록된 바코드가 없습니다 — 📋 붙여넣기로 넣어 주세요</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="max-h-[520px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left w-32">제품코드</th>
                  <th className="px-3 py-2 text-left">제품명</th>
                  <th className="px-3 py-2 text-left w-44">제품바코드</th>
                  <th className="px-3 py-2 w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((r) => {
                  const bad = gtinCheck(r.barcode) === false;
                  return (
                    <tr key={r.barcode} className="hover:bg-slate-50/60">
                      <td className="px-3 py-1.5 font-mono font-bold text-indigo-700">{r.code}</td>
                      <td className="px-3 py-1.5 text-gray-800">{r.name}</td>
                      <td className="px-3 py-1.5 font-mono">
                        {r.barcode}
                        {bad && <span className="ml-1 text-[10px] text-amber-600" title="EAN/UPC 체크디지트가 맞지 않습니다 — 번호를 확인하세요">⚠ 체크디지트</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <button onClick={() => remove(r.barcode)} className="text-xs text-red-500 hover:underline">삭제</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showBulk && <BarcodeBulkModal existing={rows} onClose={() => setShowBulk(false)} />}
    </div>
  );
}

function BarcodeBulkModal({ existing, onClose }: { existing: ProductBarcode[]; onClose: () => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((line) => ({ line, row: parseBarcodeLine(line) }));
  // 머리글 행(바코드 칸에 숫자가 하나도 없음)은 조용히 건너뛴다
  const header = (r: ProductBarcode | null) => !!r && !/\d/.test(r.barcode);
  const ok = parsed.filter((p) => p.row && !header(p.row)).map((p) => p.row!);
  const bad = parsed.filter((p) => !p.row);

  // 붙여넣은 것 안에서 같은 바코드가 다른 제품으로 두 번 → 마지막 것이 이긴다. 알려 준다.
  const seen = new Map<string, ProductBarcode>();
  const conflicts: string[] = [];
  ok.forEach((r) => {
    const p = seen.get(r.barcode);
    if (p && p.code !== r.code) conflicts.push(`${r.barcode}: ${p.code} → ${r.code}`);
    seen.set(r.barcode, r);
  });
  const finalRows = [...seen.values()];
  const exMap = new Map(existing.map((e) => [e.barcode, e]));
  const changed = finalRows.filter((r) => exMap.has(r.barcode) && exMap.get(r.barcode)!.code !== r.code);
  const checkBad = finalRows.filter((r) => gtinCheck(r.barcode) === false);

  const save = async () => {
    if (finalRows.length === 0) return;
    setSaving(true);
    try {
      const now = Date.now();
      for (let i = 0; i < finalRows.length; i += 400) {
        const b = writeBatch(db);
        finalRows.slice(i, i + 400).forEach((r) => b.set(doc(db, BARCODE_COL, r.barcode), { ...r, updatedAt: now }));
        await b.commit();
      }
      alert(`${finalRows.length}개 저장했습니다`);
      onClose();
    } catch (e: any) {
      alert(`저장 실패: ${e?.message || e}`);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b flex items-center">
          <span className="font-bold">📋 제품 바코드 붙여넣기</span>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700">✕</button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto">
          <div className="text-xs text-gray-600">
            엑셀에서 <b>제품코드 / 제품명 / 제품바코드</b> 세 열을 복사해 붙여넣으세요. 머리글 행은 자동으로 건너뜁니다.
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} autoFocus
            placeholder={'F553\t한우야채죽\t8801234567893\nF554\t전복죽\t8801234567886'}
            className="w-full border rounded p-2 font-mono text-xs" />
          {lines.length > 0 && (
            <div className="text-xs space-y-1">
              <div>인식 <b className="text-indigo-700">{finalRows.length}개</b>
                {bad.length > 0 && <span className="text-red-600"> · 형식 오류 {bad.length}줄</span>}
                {changed.length > 0 && <span className="text-amber-700"> · 기존과 제품이 다른 바코드 {changed.length}개 (덮어씀)</span>}
                {checkBad.length > 0 && <span className="text-amber-700"> · 체크디지트 안 맞음 {checkBad.length}개</span>}
              </div>
              {conflicts.length > 0 && <div className="text-amber-700">붙여넣은 목록 안에서 같은 바코드가 다른 제품에 중복: {conflicts.slice(0, 5).join(', ')}{conflicts.length > 5 && ' …'} (아래쪽 줄로 저장)</div>}
              {bad.length > 0 && <div className="text-red-600">형식 오류: {bad.slice(0, 3).map((b) => b.line).join(' / ')}</div>}
              {checkBad.length > 0 && <div className="text-amber-700">체크디지트 확인: {checkBad.slice(0, 5).map((r) => `${r.code} ${r.barcode}`).join(', ')}</div>}
              <div className="border rounded max-h-56 overflow-y-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 sticky top-0"><tr><th className="px-2 py-1 text-left">제품코드</th><th className="px-2 py-1 text-left">제품명</th><th className="px-2 py-1 text-left">바코드</th></tr></thead>
                  <tbody className="divide-y">
                    {finalRows.slice(0, 200).map((r) => (
                      <tr key={r.barcode}><td className="px-2 py-0.5 font-mono">{r.code}</td><td className="px-2 py-0.5">{r.name}</td><td className="px-2 py-0.5 font-mono">{r.barcode}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 border rounded text-sm">취소</button>
          <button onClick={save} disabled={saving || finalRows.length === 0}
            className="px-4 py-2 bg-indigo-600 text-white rounded text-sm font-medium hover:bg-indigo-700 disabled:bg-gray-300">
            {saving ? '저장중...' : `${finalRows.length}개 저장`}
          </button>
        </div>
      </div>
    </div>
  );
}
