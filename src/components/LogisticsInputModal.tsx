import { useEffect, useState } from 'react';
import { collection, doc, onSnapshot, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';

function convertErpCode(raw: string): string {
  const m = raw.trim().match(/^([A-Za-z])-(\d+)-\d+$/);
  if (!m) return raw.trim();
  const letter = m[1].toUpperCase();
  const num = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${letter}-${num}`;
}

export default function LogisticsInputModal({
  open, onClose, defaultDate,
}: { open: boolean; onClose: () => void; defaultDate: string }) {
  const [date, setDate] = useState(defaultDate);
  const [pasteText, setPasteText] = useState('');
  const [existing, setExisting] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setDate(defaultDate); }, [open, defaultDate]);

  useEffect(() => {
    if (!open) return;
    return onSnapshot(collection(db, 'days', date, 'logistics'), (snap) => {
      const map: Record<string, number> = {};
      snap.forEach((d) => { map[d.id] = (d.data().qty as number) || 0; });
      setExisting(map);
    });
  }, [open, date]);

  const existingCount = Object.keys(existing).length;
  const existingTotal = Object.values(existing).reduce((s, v) => s + v, 0);

  const save = async () => {
    const lines = pasteText.trim().split('\n').map((r) => r.split('\t'));
    const hIdx = lines.findIndex((r) => r.some((c) => c.trim() === '제품코드'));
    if (hIdx < 0) return alert('제품코드 헤더를 찾을 수 없습니다');
    const header = lines[hIdx].map((c) => c.trim());
    const codeCol = header.indexOf('제품코드');
    const qtyCol = header.indexOf('등록수량');
    if (codeCol < 0 || qtyCol < 0) return alert('제품코드 또는 등록수량 열을 찾을 수 없습니다');

    setSaving(true);
    try {
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
      setPasteText('');
      alert(`${date}\n${count}개 품목 물류 데이터 저장 완료`);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (existingCount === 0) return;
    if (!confirm(`${date} 의 물류 데이터(${existingCount}개)를 삭제할까요?`)) return;
    const batch = writeBatch(db);
    Object.keys(existing).forEach((code) => {
      batch.delete(doc(db, 'days', date, 'logistics', code));
    });
    await batch.commit();
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b flex items-center justify-between bg-gradient-to-r from-rose-50 to-pink-50">
          <div>
            <h3 className="text-lg font-bold text-gray-800">잔여량 입력 (물류)</h3>
            <div className="text-xs text-gray-500 mt-0.5">ERP에서 복사한 표를 그대로 붙여넣기 하세요</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-gray-200 text-gray-500 text-lg">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-sm font-medium text-gray-700">날짜</label>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="border rounded px-3 py-1.5 text-sm"
            />
            <span className="ml-auto text-sm text-gray-600">
              현재 등록: <span className="font-semibold text-gray-800">{existingCount}</span>개 품목 / 총
              <span className="font-bold text-rose-600 ml-1">{existingTotal.toLocaleString()}</span> EA
            </span>
          </div>

          {existingCount > 0 && (
            <div className="border rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-slate-50 border-b text-xs font-semibold text-gray-700 flex items-center justify-between">
                <span>{date} 기존 등록 내역</span>
                <button onClick={clear} className="text-xs text-red-600 hover:underline font-medium">전체 삭제</button>
              </div>
              <div className="max-h-48 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(existing).sort(([a], [b]) => a.localeCompare(b)).map(([code, qty]) => (
                      <tr key={code} className="border-t">
                        <td className="px-3 py-1.5 font-mono">{code}</td>
                        <td className="px-3 py-1.5 text-right font-bold text-rose-700">{qty.toLocaleString()} EA</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">ERP 데이터 붙여넣기</label>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="ERP의 '제품코드' '등록수량' 열이 있는 표 전체를 복사 후 여기에 붙여넣기..."
              className="w-full h-56 border rounded-md p-3 text-sm font-mono"
            />
            <p className="text-[11px] text-gray-500 mt-1">
              · 헤더에 '제품코드'와 '등록수량'이 포함되어야 합니다<br />
              · 코드는 자동으로 변환됩니다 (예: A-001-01 → A-01, F-528-01 → F-528)
            </p>
          </div>
        </div>

        <div className="border-t bg-slate-50 px-6 py-4 flex items-center gap-2">
          <button onClick={onClose} className="px-4 py-2 border rounded text-sm font-medium text-gray-700 hover:bg-gray-100">
            취소
          </button>
          <button
            onClick={save}
            disabled={!pasteText.trim() || saving}
            className="ml-auto px-5 py-2 bg-rose-600 text-white rounded font-medium hover:bg-rose-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {saving ? '저장중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
