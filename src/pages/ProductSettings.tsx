import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import type { ProductSetting } from '../types';

type ProdType = '냄비' | '바트';

const TYPE_STYLE: Record<ProdType, { chip: string; soft: string; text: string; border: string }> = {
  냄비: { chip: 'bg-orange-500', soft: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
  바트: { chip: 'bg-cyan-500',   soft: 'bg-cyan-50',   text: 'text-cyan-700',   border: 'border-cyan-200' },
};

export default function ProductSettings() {
  const [settings, setSettings] = useState<ProductSetting[]>([]);
  const [search, setSearch] = useState('');
  const [showProductDB, setShowProductDB] = useState(true);
  const [showBulk, setShowBulk] = useState(false);

  useEffect(() => {
    return onSnapshot(collection(db, 'productSettings'), (snap) => {
      const list: ProductSetting[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as ProductSetting), code: d.id }));
      list.sort((a, b) => a.code.localeCompare(b.code));
      setSettings(list);
    });
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return settings;
    return settings.filter((s) => s.code.toLowerCase().includes(q) || (s.name || '').toLowerCase().includes(q));
  }, [settings, search]);

  const counts = useMemo(() => {
    let pot = 0, bat = 0, none = 0;
    settings.forEach((s) => {
      if (s.type === '냄비') pot++;
      else if (s.type === '바트') bat++;
      else none++;
    });
    return { pot, bat, none, total: settings.length };
  }, [settings]);

  const setType = async (code: string, type: ProdType | null) => {
    await setDoc(doc(db, 'productSettings', code), { code, type }, { merge: true });
  };

  const remove = async (code: string) => {
    if (!confirm(`'${code}' 항목을 삭제할까요?`)) return;
    await deleteDoc(doc(db, 'productSettings', code));
  };

  return (
    <div className="space-y-4">
      {/* 제품 DB 섹션 */}
      <Section
        icon="📦"
        title="제품 DB"
        badge={`${counts.total}개`}
        open={showProductDB}
        onToggle={() => setShowProductDB(!showProductDB)}
      >
        <div className="space-y-4">
          {/* 검색 + 통계 */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[240px]">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="🔍 코드 또는 품목명 검색..."
                className="w-full border rounded-md px-3 py-2 text-sm"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">×</button>
              )}
            </div>
            <button
              onClick={() => setShowBulk(true)}
              className="px-3 py-2 border rounded-md font-medium text-sm hover:bg-gray-100"
            >📋 일괄 입력</button>
            <button
              onClick={() => {
                const code = prompt('새 제품 코드 (예: A-01)');
                if (code?.trim()) setType(code.trim().toUpperCase(), null);
              }}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium text-sm"
            >+ 추가</button>
          </div>

          {/* 통계 칩 */}
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="px-2.5 py-1 rounded-full bg-orange-100 text-orange-700 font-medium flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-500" /> 냄비 {counts.pot}
            </span>
            <span className="px-2.5 py-1 rounded-full bg-cyan-100 text-cyan-700 font-medium flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" /> 바트 {counts.bat}
            </span>
            <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 font-medium flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400" /> 미분류 {counts.none}
            </span>
          </div>

          {/* 목록 */}
          {filtered.length === 0 ? (
            <div className="p-12 text-center text-gray-400 text-sm border rounded-lg">
              {search ? `'${search}' 검색 결과가 없습니다` : '등록된 제품이 없습니다. 우측 상단 + 추가 또는 📋 일괄 입력을 사용하세요'}
            </div>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-2 text-left w-32">코드</th>
                    <th className="px-4 py-2 text-left">품목명</th>
                    <th className="px-4 py-2 text-center w-64">구분</th>
                    <th className="px-4 py-2 text-right w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => (
                    <tr key={s.code} className="border-t hover:bg-slate-50/60">
                      <td className="px-4 py-2 font-mono text-sm">{s.code}</td>
                      <td className="px-4 py-2 text-gray-700">{s.name || <span className="text-gray-300">-</span>}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-center gap-1.5">
                          {(['냄비', '바트'] as ProdType[]).map((t) => {
                            const active = s.type === t;
                            const style = TYPE_STYLE[t];
                            return (
                              <button
                                key={t}
                                onClick={() => setType(s.code, active ? null : t)}
                                className={`px-3 py-1 rounded-full text-xs font-bold border transition ${
                                  active
                                    ? `${style.chip} text-white border-transparent shadow`
                                    : `${style.soft} ${style.text} ${style.border} hover:brightness-95`
                                }`}
                              >
                                {t}
                              </button>
                            );
                          })}
                          {s.type && (
                            <button
                              onClick={() => setType(s.code, null)}
                              className="text-[10px] text-gray-400 hover:text-gray-600 ml-1"
                              title="구분 해제"
                            >해제</button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => remove(s.code)}
                          className="text-xs text-red-500 hover:underline"
                        >삭제</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Section>

      {/* 일괄 입력 모달 */}
      {showBulk && (
        <BulkModal
          onClose={() => setShowBulk(false)}
          existing={settings}
        />
      )}
    </div>
  );
}

function Section({
  icon, title, badge, open, onToggle, children,
}: {
  icon?: string; title: string; badge?: string;
  open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-5 py-3.5 flex items-center gap-3 hover:bg-slate-50 text-left"
      >
        {icon && <span className="text-base">{icon}</span>}
        <span className="font-bold text-gray-800">{title}</span>
        {badge && (
          <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">{badge}</span>
        )}
        <span className="ml-auto text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="border-t p-5">{children}</div>}
    </div>
  );
}

function BulkModal({
  onClose, existing,
}: { onClose: () => void; existing: ProductSetting[] }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  // 미리보기
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((line) => {
    const parts = line.split(/[,\t]/).map((s) => s.trim());
    const code = (parts[0] || '').toUpperCase();
    const t = (parts[1] || '').trim();
    const type: '냄비' | '바트' | null = t === '냄비' ? '냄비' : t === '바트' ? '바트' : null;
    const name = parts[2] || '';
    return { code, type, name, valid: code.length > 0 };
  });
  const validRows = parsed.filter((p) => p.valid);

  const save = async () => {
    if (validRows.length === 0) return;
    setSaving(true);
    try {
      const batch = writeBatch(db);
      validRows.forEach((row) => {
        const update: any = { code: row.code };
        if (row.type) update.type = row.type;
        if (row.name) update.name = row.name;
        batch.set(doc(db, 'productSettings', row.code), update, { merge: true });
      });
      await batch.commit();
      alert(`${validRows.length}개 저장 완료`);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl h-[88vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b bg-gradient-to-r from-blue-50 to-indigo-50 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-800">제품 DB 일괄 입력</h3>
            <div className="text-xs text-gray-500 mt-0.5">엑셀에서 복사 후 붙여넣기 또는 직접 입력</div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-800 leading-relaxed">
            <strong>형식:</strong> 한 줄에 한 제품. <strong>코드, 구분, 품목명(선택)</strong> 순서. 콤마(,) 또는 탭으로 구분.<br />
            예시: <code className="bg-white px-1.5 py-0.5 rounded mx-1">A-01, 냄비, 한우미역깨죽</code>
            <span className="mx-1">또는</span>
            <code className="bg-white px-1.5 py-0.5 rounded">A-02	바트</code><br />
            구분이 없거나 다르면 미분류로 등록됩니다. <strong>{existing.length}개</strong> 기존 항목과 코드 일치 시 덮어쓰기.
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"A-01, 냄비, 한우미역깨죽\nA-02, 바트, 단호박죽\nB-01, 냄비\nC-05, 바트"}
            className="w-full h-64 border rounded-md p-3 text-sm font-mono"
          />
          {parsed.length > 0 && (
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">
                미리보기 ({validRows.length} / {parsed.length} 유효)
              </div>
              <div className="border rounded max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-3 py-1.5 text-left w-24">코드</th>
                      <th className="px-3 py-1.5 text-center w-16">구분</th>
                      <th className="px-3 py-1.5 text-left">품목명</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.map((p, i) => (
                      <tr key={i} className={`border-t ${!p.valid ? 'bg-red-50 text-red-600' : ''}`}>
                        <td className="px-3 py-1 font-mono">{p.code || '(없음)'}</td>
                        <td className="px-3 py-1 text-center">
                          {p.type ? (
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${TYPE_STYLE[p.type].chip} text-white`}>{p.type}</span>
                          ) : <span className="text-gray-400">미분류</span>}
                        </td>
                        <td className="px-3 py-1">{p.name || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-2 border rounded text-sm font-medium hover:bg-gray-100">취소</button>
          <span className="ml-auto text-xs text-gray-500">{validRows.length}개 저장 예정</span>
          <button
            onClick={save}
            disabled={validRows.length === 0 || saving}
            className="px-5 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {saving ? '저장중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
