import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, getCountFromServer, onSnapshot, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import type { Material, ProductSetting } from '../types';
import { canonicalShort, convertErpCode } from '../lib/codeUtil';

type ProdType = '냄비' | '바트';

const TYPE_STYLE: Record<ProdType, { chip: string; soft: string; text: string; border: string }> = {
  냄비: { chip: 'bg-orange-500', soft: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
  바트: { chip: 'bg-cyan-500',   soft: 'bg-cyan-50',   text: 'text-cyan-700',   border: 'border-cyan-200' },
};

export default function ProductSettings() {
  const [settings, setSettings] = useState<ProductSetting[]>([]);
  const [search, setSearch] = useState('');
  const [showProductDB, setShowProductDB] = useState(false);
  const [showMaterialDB, setShowMaterialDB] = useState(false);
  const [showRecipeDB, setShowRecipeDB] = useState(false);
  const [showPriceDB, setShowPriceDB] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [showWeightBulk, setShowWeightBulk] = useState(false);
  const [materials, setMaterials] = useState<Material[]>([]);
  // 헤더에 표시할 총개수만 가볍게 (count aggregation = 1읽기)
  const [productCount, setProductCount] = useState<number | null>(null);
  const [materialCount, setMaterialCount] = useState<number | null>(null);
  const [recipeCount, setRecipeCount] = useState<number | null>(null);
  const [priceCount, setPriceCount] = useState<number | null>(null);

  useEffect(() => {
    getCountFromServer(collection(db, 'productSettings')).then((s) => setProductCount(s.data().count)).catch(() => {});
    getCountFromServer(collection(db, 'materials')).then((s) => setMaterialCount(s.data().count)).catch(() => {});
    getCountFromServer(collection(db, 'recipes')).then((s) => setRecipeCount(s.data().count)).catch(() => {});
    getCountFromServer(collection(db, 'materialPrices')).then((s) => setPriceCount(s.data().count)).catch(() => {});
  }, []);

  // 섹션이 펼쳐졌을 때만 구독 (읽기 부하 절감)
  useEffect(() => {
    if (!showProductDB) return;
    return onSnapshot(collection(db, 'productSettings'), (snap) => {
      const list: ProductSetting[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as ProductSetting), code: d.id }));
      list.sort((a, b) => a.code.localeCompare(b.code));
      setSettings(list);
    });
  }, [showProductDB]);

  useEffect(() => {
    if (!showMaterialDB) return;
    return onSnapshot(collection(db, 'materials'), (snap) => {
      const list: Material[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as Material), id: d.id }));
      list.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
      setMaterials(list);
    });
  }, [showMaterialDB]);

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

  const setWeight = async (code: string, w: number | null) => {
    await setDoc(doc(db, 'productSettings', code), { code, packWeight: w }, { merge: true });
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
        badge={productCount !== null ? `${productCount}개` : '...'}
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
              onClick={() => setShowWeightBulk(true)}
              className="px-3 py-2 border rounded-md font-medium text-sm hover:bg-gray-100"
            >⚖️ 포장중량 일괄</button>
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
                    <th className="px-4 py-2 text-left w-44">코드</th>
                    <th className="px-4 py-2 text-left">품목명</th>
                    <th className="px-4 py-2 text-center w-28">포장중량(g)</th>
                    <th className="px-4 py-2 text-center w-64">구분</th>
                    <th className="px-4 py-2 text-right w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => {
                    const shortCode = convertErpCode(s.code);
                    const isErp = shortCode !== s.code;
                    return (
                    <tr key={s.code} className="border-t hover:bg-slate-50/60">
                      <td className="px-4 py-2 font-mono text-sm whitespace-nowrap">
                        <span>{s.code}</span>
                        {isErp && (
                          <span className="ml-2 text-[11px] text-blue-600">→ {shortCode}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-gray-700">{s.name || <span className="text-gray-300">-</span>}</td>
                      <td className="px-4 py-2 text-center">
                        <WeightCell value={s.packWeight} onSave={(v) => setWeight(s.code, v)} />
                      </td>
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Section>

      {/* 원재료 DB 섹션 */}
      <Section
        icon="🥕"
        title="원재료 DB"
        badge={materialCount !== null ? `${materialCount}개` : '...'}
        open={showMaterialDB}
        onToggle={() => setShowMaterialDB(!showMaterialDB)}
      >
        <MaterialDB materials={materials} />
      </Section>

      {/* 레시피 DB 섹션 (폐기금액 계산용) */}
      <Section
        icon="📝"
        title="레시피 DB"
        badge={recipeCount !== null ? `${recipeCount}개` : '...'}
        open={showRecipeDB}
        onToggle={() => setShowRecipeDB(!showRecipeDB)}
      >
        {showRecipeDB && <RecipeDB onCountChange={setRecipeCount} />}
      </Section>

      {/* 원재료 단가 섹션 (폐기금액 계산용) */}
      <Section
        icon="💰"
        title="원재료 단가 (폐기금액 계산용)"
        badge={priceCount !== null ? `${priceCount}개` : '...'}
        open={showPriceDB}
        onToggle={() => setShowPriceDB(!showPriceDB)}
      >
        {showPriceDB && <MaterialPriceDB onCountChange={setPriceCount} />}
      </Section>

      {/* 일괄 입력 모달 */}
      {showBulk && (
        <BulkModal
          onClose={() => setShowBulk(false)}
          existing={settings}
        />
      )}
      {showWeightBulk && (
        <WeightBulkModal onClose={() => setShowWeightBulk(false)} existing={settings} />
      )}
    </div>
  );
}

function WeightCell({ value, onSave }: { value?: number; onSave: (v: number | null) => void }) {
  const [local, setLocal] = useState(value !== undefined && value !== null ? String(value) : '');
  useEffect(() => { setLocal(value !== undefined && value !== null ? String(value) : ''); }, [value]);
  return (
    <input
      type="number" inputMode="numeric"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const t = local.trim();
        if (t === '') { onSave(null); return; }
        const n = Number(t);
        if (!isNaN(n) && n !== value) onSave(n);
      }}
      placeholder="-"
      className="w-20 border rounded px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-300"
    />
  );
}

function WeightBulkModal({ onClose, existing }: { onClose: () => void; existing: ProductSetting[] }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  // 기존 제품: 표준코드 → 실제 docId 매핑
  const lookup = useMemo(() => {
    const m = new Map<string, string>();
    existing.forEach((s) => m.set(canonicalShort(s.code), s.code));
    return m;
  }, [existing]);

  // 잘못 생성된 PB- 항목들
  const junkDocs = useMemo(() => existing.filter((s) => /^PB-/i.test(s.code)), [existing]);

  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((line) => {
    const parts = line.split(/[,\t]/).map((s) => s.trim());
    const rawCode = parts[0] || '';
    const canon = canonicalShort(rawCode);
    const matchedDoc = lookup.get(canon);
    let weight: number | null = null;
    for (let i = parts.length - 1; i >= 1; i--) {
      const n = Number((parts[i] || '').replace(/[^0-9.]/g, ''));
      if (!isNaN(n) && n > 0) { weight = n; break; }
    }
    return { rawCode, canon, matchedDoc, weight, valid: !!matchedDoc && weight !== null };
  });
  const validRows = parsed.filter((p) => p.valid);
  const unmatched = parsed.filter((p) => p.weight !== null && !p.matchedDoc);

  const save = async () => {
    if (validRows.length === 0) return;
    setSaving(true);
    try {
      const batch = writeBatch(db);
      validRows.forEach((row) => {
        batch.set(doc(db, 'productSettings', row.matchedDoc!), { packWeight: row.weight }, { merge: true });
      });
      await batch.commit();
      alert(`${validRows.length}개 기존 제품에 포장중량 반영 완료`);
      onClose();
    } finally { setSaving(false); }
  };

  const cleanupJunk = async () => {
    if (junkDocs.length === 0) return;
    if (!confirm(`잘못 생성된 'PB-' 항목 ${junkDocs.length}개를 삭제할까요?`)) return;
    setCleaning(true);
    try {
      // 500개씩 배치
      for (let i = 0; i < junkDocs.length; i += 400) {
        const batch = writeBatch(db);
        junkDocs.slice(i, i + 400).forEach((s) => batch.delete(doc(db, 'productSettings', s.code)));
        await batch.commit();
      }
      alert(`${junkDocs.length}개 삭제 완료`);
    } finally { setCleaning(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl h-[85vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b bg-gradient-to-r from-violet-50 to-blue-50 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-800">포장중량 일괄 입력</h3>
            <div className="text-xs text-gray-500 mt-0.5">기존 제품 DB에 포장중량만 매칭해서 덮어씁니다 (새 항목 안 만듦)</div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {junkDocs.length > 0 && (
            <div className="bg-red-50 border border-red-300 rounded p-3 flex items-center gap-3">
              <span className="text-sm text-red-700">⚠ 이전에 잘못 생성된 <b>PB-</b> 항목이 {junkDocs.length}개 있습니다.</span>
              <button onClick={cleanupJunk} disabled={cleaning} className="ml-auto px-3 py-1.5 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 disabled:bg-gray-300">
                {cleaning ? '삭제중...' : `PB- 항목 ${junkDocs.length}개 삭제`}
              </button>
            </div>
          )}
          <div className="bg-violet-50 border border-violet-200 rounded p-3 text-xs text-violet-800 leading-relaxed">
            <b>형식:</b> 코드 / 품목명 / 포장중량 — 콤마 또는 탭 구분. 마지막 숫자를 포장중량(g)으로 인식.<br />
            코드는 <code className="bg-white px-1 rounded">PB-A-001</code>, <code className="bg-white px-1 rounded">A-001-01</code>, <code className="bg-white px-1 rounded">A01</code> 어느 형식이든 기존 제품과 자동 매칭됩니다.
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"PB-A-001\t순수쌀미음\t150\nPB-A-002\t감자미음\t150"}
            className="w-full h-60 border rounded-md p-3 text-sm font-mono"
          />
          {parsed.length > 0 && (
            <div className="space-y-1 text-sm">
              <div className="text-gray-600">
                매칭 성공 <b className="text-violet-700">{validRows.length}</b> / 전체 {parsed.length}줄
              </div>
              {unmatched.length > 0 && (
                <div className="text-red-600 text-xs">
                  ⚠ 제품DB에 없어 매칭 실패 {unmatched.length}개: {unmatched.slice(0, 10).map((u) => u.rawCode).join(', ')}{unmatched.length > 10 ? ' …' : ''}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-2 border rounded text-sm font-medium hover:bg-gray-100">닫기</button>
          <button onClick={save} disabled={validRows.length === 0 || saving} className="ml-auto px-5 py-2 bg-violet-600 text-white rounded font-medium hover:bg-violet-700 disabled:bg-gray-300">
            {saving ? '저장중...' : `${validRows.length}개 반영`}
          </button>
        </div>
      </div>
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

// ============ 원재료 DB ============
function MaterialDB({ materials }: { materials: Material[] }) {
  const [search, setSearch] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftCat, setDraftCat] = useState('');
  const [draftSpecs, setDraftSpecs] = useState<string[]>([]);
  const [newSpec, setNewSpec] = useState('');
  const [adding, setAdding] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return materials;
    return materials.filter((m) =>
      m.name.toLowerCase().includes(q) ||
      (m.category || '').toLowerCase().includes(q) ||
      (m.specs || []).some((s) => s.toLowerCase().includes(q))
    );
  }, [materials, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, Material[]>();
    filtered.forEach((m) => {
      const k = m.category || '미분류';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const startEdit = (m: Material) => {
    setEditId(m.id);
    setDraftName(m.name);
    setDraftCat(m.category || '');
    setDraftSpecs([...(m.specs || [])]);
    setNewSpec('');
    setAdding(false);
  };
  const startAdd = () => {
    setEditId(null);
    setAdding(true);
    setDraftName('');
    setDraftCat('');
    setDraftSpecs([]);
    setNewSpec('');
  };
  const cancel = () => { setEditId(null); setAdding(false); };

  const addSpecToDraft = () => {
    const s = newSpec.trim();
    if (!s || draftSpecs.includes(s)) { setNewSpec(''); return; }
    setDraftSpecs([...draftSpecs, s]);
    setNewSpec('');
  };
  const removeSpecFromDraft = (s: string) => setDraftSpecs(draftSpecs.filter((x) => x !== s));

  const saveDraft = async () => {
    if (!draftName.trim()) return;
    if (adding) {
      const ref = doc(collection(db, 'materials'));
      await setDoc(ref, { name: draftName.trim(), category: draftCat.trim(), specs: draftSpecs });
    } else if (editId) {
      await updateDoc(doc(db, 'materials', editId), {
        name: draftName.trim(), category: draftCat.trim(), specs: draftSpecs,
      });
    }
    cancel();
  };

  const remove = async (m: Material) => {
    if (!confirm(`'${m.name}' 원재료를 삭제할까요?`)) return;
    await deleteDoc(doc(db, 'materials', m.id));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 원재료명·분류·규격 검색..."
            className="w-full border rounded-md px-3 py-2 text-sm"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">×</button>
          )}
        </div>
        <button onClick={() => setShowBulk(true)} className="px-3 py-2 border rounded-md font-medium text-sm hover:bg-gray-100">📋 일괄 입력</button>
        <button onClick={startAdd} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md font-medium text-sm">+ 추가</button>
      </div>

      {/* 추가/수정 폼 */}
      {(adding || editId) && (
        <div className="border-2 border-emerald-300 bg-emerald-50/40 rounded-lg p-4 space-y-3">
          <div className="font-semibold text-emerald-800 text-sm">{adding ? '원재료 추가' : '원재료 수정'}</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">원재료명</label>
              <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="예: 당근" className="w-full border rounded-md px-3 py-2 text-sm" autoFocus />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">분류 (선택)</label>
              <input value={draftCat} onChange={(e) => setDraftCat(e.target.value)} placeholder="예: 채소, 육류, 곡물" className="w-full border rounded-md px-3 py-2 text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">규격</label>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              {draftSpecs.length === 0 && <span className="text-xs text-gray-400">규격 없음 (선택)</span>}
              {draftSpecs.map((s) => (
                <span key={s} className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-gray-300 rounded-full text-xs">
                  {s}
                  <button onClick={() => removeSpecFromDraft(s)} className="text-gray-400 hover:text-red-600 ml-0.5">×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={newSpec}
                onChange={(e) => setNewSpec(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSpecToDraft(); } }}
                placeholder="예: 3mm  (입력 후 추가)"
                className="flex-1 border rounded-md px-3 py-2 text-sm"
              />
              <button onClick={addSpecToDraft} className="px-3 py-2 bg-gray-700 text-white rounded-md text-sm font-medium hover:bg-gray-800">규격 추가</button>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={cancel} className="px-3 py-2 border rounded text-sm font-medium hover:bg-white">취소</button>
            <button onClick={saveDraft} disabled={!draftName.trim()} className="ml-auto px-5 py-2 bg-emerald-600 text-white rounded font-medium hover:bg-emerald-700 disabled:bg-gray-300">저장</button>
          </div>
        </div>
      )}

      {/* 목록 */}
      {materials.length === 0 ? (
        <div className="p-12 text-center text-gray-400 text-sm border rounded-lg">등록된 원재료가 없습니다 — + 추가 또는 📋 일괄 입력</div>
      ) : grouped.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm border rounded-lg">'{search}' 검색 결과가 없습니다</div>
      ) : (
        <div className="space-y-3">
          {grouped.map(([cat, list]) => (
            <div key={cat} className="border rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-slate-50 border-b text-xs font-semibold text-gray-700">{cat} <span className="text-gray-400 font-normal">{list.length}</span></div>
              <table className="w-full text-sm">
                <tbody>
                  {list.map((m) => (
                    <tr key={m.id} className="border-t hover:bg-slate-50/60">
                      <td className="px-4 py-2 font-medium text-gray-800 w-40">{m.name}</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-1.5">
                          {(m.specs || []).length === 0 ? (
                            <span className="text-xs text-gray-300">규격 없음</span>
                          ) : (
                            (m.specs || []).map((s) => (
                              <span key={s} className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded text-xs">{s}</span>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right w-28">
                        <button onClick={() => startEdit(m)} className="text-xs text-blue-600 hover:underline mr-3">수정</button>
                        <button onClick={() => remove(m)} className="text-xs text-red-500 hover:underline">삭제</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {showBulk && <MaterialBulkModal onClose={() => setShowBulk(false)} />}
    </div>
  );
}

function MaterialBulkModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((line) => {
    const parts = line.split(/[,\t]/).map((s) => s.trim());
    const name = parts[0] || '';
    const category = parts[1] || '';
    const specsRaw = parts[2] || '';
    const specs = specsRaw ? specsRaw.split(/[|/]/).map((s) => s.trim()).filter(Boolean) : [];
    return { name, category, specs, valid: name.length > 0 };
  });
  const validRows = parsed.filter((p) => p.valid);

  const save = async () => {
    if (validRows.length === 0) return;
    setSaving(true);
    try {
      const batch = writeBatch(db);
      validRows.forEach((row) => {
        const ref = doc(collection(db, 'materials'));
        batch.set(ref, { name: row.name, category: row.category, specs: row.specs });
      });
      await batch.commit();
      alert(`${validRows.length}개 추가됨`);
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl h-[85vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b bg-gradient-to-r from-emerald-50 to-green-50 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-800">원재료 일괄 입력</h3>
            <div className="text-xs text-gray-500 mt-0.5">한 줄에 한 원재료</div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-xs text-emerald-800 leading-relaxed">
            <b>형식:</b> 원재료명, 분류, 규격 — 콤마 또는 탭 구분. 규격은 여러 개면 <code className="bg-white px-1 rounded">|</code> 또는 <code className="bg-white px-1 rounded">/</code> 로 구분.<br />
            예: <code className="bg-white px-1.5 py-0.5 rounded">당근, 채소, 3mm|5mm|7mm</code> · <code className="bg-white px-1.5 py-0.5 rounded">양파, 채소</code>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"당근, 채소, 3mm|5mm|7mm\n양파, 채소, 5mm\n한우, 육류\n쌀, 곡물"}
            className="w-full h-56 border rounded-md p-3 text-sm font-mono"
          />
          {parsed.length > 0 && (
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">미리보기 ({validRows.length}/{parsed.length})</div>
              <div className="border rounded max-h-56 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500"><tr><th className="px-3 py-1.5 text-left w-32">원재료</th><th className="px-3 py-1.5 text-left w-20">분류</th><th className="px-3 py-1.5 text-left">규격</th></tr></thead>
                  <tbody>
                    {parsed.map((p, i) => (
                      <tr key={i} className={`border-t ${!p.valid ? 'bg-red-50 text-red-600' : ''}`}>
                        <td className="px-3 py-1 font-medium">{p.name || '(없음)'}</td>
                        <td className="px-3 py-1 text-gray-500">{p.category || '미분류'}</td>
                        <td className="px-3 py-1">{p.specs.length ? p.specs.join(', ') : <span className="text-gray-400">-</span>}</td>
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
          <button onClick={save} disabled={validRows.length === 0 || saving} className="px-5 py-2 bg-emerald-600 text-white rounded font-medium hover:bg-emerald-700 disabled:bg-gray-300">{saving ? '저장중...' : '저장'}</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   레시피 DB (폐기금액 계산용) — 신규 섹션
   Firestore: recipes/{code} = { code, name, ingredients: [{seq,name,gPerPiece}] }
   ============================================================ */

interface RecipeIngredient {
  seq: number;
  name: string;
  gPerPiece: number;
}
interface RecipeDoc {
  code: string;
  name: string;
  ingredients: RecipeIngredient[];
}

function RecipeDB({ onCountChange }: { onCountChange: (n: number) => void }) {
  const [recipes, setRecipes] = useState<RecipeDoc[]>([]);
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(collection(db, 'recipes'), (snap) => {
      const list: RecipeDoc[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as RecipeDoc), code: d.id }));
      list.sort((a, b) => a.code.localeCompare(b.code));
      setRecipes(list);
      onCountChange(list.length);
    });
  }, [onCountChange]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter((r) =>
      r.code.toLowerCase().includes(q) ||
      (r.name || '').toLowerCase().includes(q) ||
      (r.ingredients || []).some((i) => i.name.toLowerCase().includes(q))
    );
  }, [recipes, search]);

  const delRecipe = async (code: string) => {
    if (!confirm(`${code} 레시피를 삭제할까요?`)) return;
    await deleteDoc(doc(db, 'recipes', code));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 코드/제품명/원재료 검색..."
          className="flex-1 min-w-[240px] border rounded-md px-3 py-2 text-sm" />
        <span className="text-xs text-gray-500">{filtered.length}/{recipes.length}개</span>
        <button onClick={() => setShowImport(true)} className="px-3 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">📋 일괄 입력</button>
      </div>
      {recipes.length === 0 ? (
        <div className="p-12 text-center text-gray-400 text-sm border rounded-lg">등록된 레시피가 없습니다 — 📋 일괄 입력 으로 엑셀에서 페이스트</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left">코드</th>
                <th className="px-3 py-2 text-left">제품명</th>
                <th className="px-3 py-2 text-right">원재료수</th>
                <th className="px-3 py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((r) => (
                <>
                  <tr key={r.code} className="border-t hover:bg-slate-50">
                    <td className="px-3 py-1.5 font-mono">{r.code}</td>
                    <td className="px-3 py-1.5">{r.name}</td>
                    <td className="px-3 py-1.5 text-right">{r.ingredients?.length || 0}</td>
                    <td className="px-3 py-1.5 text-right">
                      <button onClick={() => setExpanded(expanded === r.code ? null : r.code)}
                        className="text-xs text-blue-600 hover:underline">{expanded === r.code ? '닫기' : '보기'}</button>
                      <button onClick={() => delRecipe(r.code)} className="text-xs text-red-500 hover:underline ml-2">삭제</button>
                    </td>
                  </tr>
                  {expanded === r.code && (
                    <tr className="border-t bg-slate-50">
                      <td colSpan={4} className="p-3">
                        <table className="w-full text-xs">
                          <thead className="text-gray-500">
                            <tr>
                              <th className="text-right pr-2 w-12">순번</th>
                              <th className="text-left">원재료</th>
                              <th className="text-right pr-2 w-32">식재료필요량(g)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(r.ingredients || []).map((ing) => (
                              <tr key={ing.seq} className="border-t border-gray-200">
                                <td className="text-right pr-2 text-gray-500">{ing.seq}</td>
                                <td>{ing.name}</td>
                                <td className="text-right pr-2 font-mono">{(ing.gPerPiece || 0).toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
          {filtered.length > 200 && (
            <div className="px-3 py-2 text-xs text-gray-500 bg-slate-50 border-t">처음 200개만 표시됨. 검색으로 좁히세요.</div>
          )}
        </div>
      )}
      {showImport && <RecipeImportModal onClose={() => setShowImport(false)} />}
    </div>
  );
}

function RecipeImportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const parse = (): { recipes: RecipeDoc[]; errors: string[] } => {
    const lines = text.trim().split('\n').map((l) => l.split('\t'));
    const errors: string[] = [];
    if (lines.length < 2) return { recipes: [], errors: ['데이터가 없습니다'] };

    // 헤더 정규화: 공백·괄호단위·줄바꿈 제거하고 비교
    const norm = (s: string) => (s || '').replace(/\s+/g, '').replace(/\(.*?\)/g, '').trim();

    // raw 환산량 컬럼 후보 (있는 것 중 우선순위 첫 번째 사용)
    const RAW_CANDIDATES = ['식재료필요량', '식재료소요량', '필요량', '소요량', '총투입량'];

    const hIdx = lines.findIndex((r) => {
      const cells = r.map(norm);
      return cells.includes('제품코드') && cells.includes('원재료') &&
        RAW_CANDIDATES.some((cand) => cells.includes(cand));
    });
    if (hIdx < 0) {
      errors.push('헤더(제품코드 / 원재료 / 식재료 필요량 [또는 총투입량]) 행을 찾을 수 없습니다');
      return { recipes: [], errors };
    }
    const header = lines[hIdx].map(norm);
    const codeCol = header.indexOf('제품코드');
    const nameCol = header.indexOf('제품명');
    const seqCol = header.indexOf('순번');
    const ingCol = header.indexOf('원재료');
    let rawCol = -1;
    for (const cand of RAW_CANDIDATES) {
      rawCol = header.indexOf(cand);
      if (rawCol >= 0) break;
    }
    if (codeCol < 0 || ingCol < 0 || rawCol < 0) {
      errors.push('필수 컬럼(제품코드/원재료/식재료필요량) 누락');
      return { recipes: [], errors };
    }
    const map = new Map<string, RecipeDoc>();
    for (let i = hIdx + 1; i < lines.length; i++) {
      const r = lines[i];
      const code = (r[codeCol] || '').trim();
      const ingName = (r[ingCol] || '').trim();
      const gStr = (r[rawCol] || '').trim().replace(/,/g, '');
      if (!code || !ingName) continue;
      const g = parseFloat(gStr);
      if (isNaN(g) || g <= 0) continue;
      const prodName = nameCol >= 0 ? (r[nameCol] || '').trim() : '';
      const seq = seqCol >= 0 ? (parseInt((r[seqCol] || '').trim(), 10) || 0) : 0;
      let rec = map.get(code);
      if (!rec) {
        rec = { code, name: prodName, ingredients: [] };
        map.set(code, rec);
      }
      if (prodName && !rec.name) rec.name = prodName;
      rec.ingredients.push({ seq: seq || rec.ingredients.length + 1, name: ingName, gPerPiece: g });
    }
    // 순번 정렬
    Array.from(map.values()).forEach((r) => r.ingredients.sort((a, b) => a.seq - b.seq));
    return { recipes: Array.from(map.values()), errors };
  };

  const preview = useMemo(() => (text.trim() ? parse() : { recipes: [], errors: [] }), [text]);

  const save = async () => {
    if (preview.recipes.length === 0) return;
    setSaving(true);
    try {
      // Firestore writeBatch 는 500개 제한 → 청크 분할
      const CHUNK = 400;
      for (let i = 0; i < preview.recipes.length; i += CHUNK) {
        const batch = writeBatch(db);
        preview.recipes.slice(i, i + CHUNK).forEach((r) => {
          batch.set(doc(db, 'recipes', r.code), {
            code: r.code, name: r.name || '',
            ingredients: r.ingredients,
            updatedAt: new Date().toISOString(),
          });
        });
        await batch.commit();
      }
      alert(`${preview.recipes.length}개 레시피 저장됨`);
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b flex items-center justify-between bg-blue-50">
          <h3 className="font-bold text-gray-800">📋 레시피 일괄 입력</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="text-xs text-gray-600 bg-slate-50 p-3 rounded border">
            엑셀에서 <b>헤더 포함 표 전체</b>를 복사해서 붙여넣으세요 (탭 구분).<br />
            필수 컬럼: <b>제품코드</b> / <b>원재료</b> / <b>식재료 필요량</b> (없으면 총투입량). 선택: 제품명, 순번.<br />
            나머지 컬럼(배합비, 비가식부수율, 공정수율, 바트당투입량 등)은 자동으로 무시됩니다.
            같은 제품코드의 여러 행이 한 레시피로 묶여요.
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)}
            placeholder="제품코드	제품명	순번	원재료	... 식재료 필요량 ..."
            className="w-full h-48 border rounded p-2 text-xs font-mono" />
          {text.trim() && (
            <div className="text-xs">
              <div className="font-bold mb-1">미리보기 ({preview.recipes.length}개 제품)</div>
              {preview.errors.length > 0 && <div className="text-red-600 mb-1">{preview.errors.join(', ')}</div>}
              {preview.recipes.slice(0, 5).map((r) => (
                <div key={r.code} className="border-t py-1">
                  <span className="font-mono font-bold">{r.code}</span> {r.name} — 원재료 {r.ingredients.length}종
                </div>
              ))}
              {preview.recipes.length > 5 && <div className="text-gray-400">... 외 {preview.recipes.length - 5}개</div>}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-2 border rounded text-sm font-medium hover:bg-gray-100">취소</button>
          <button onClick={save} disabled={saving || preview.recipes.length === 0}
            className="ml-auto px-5 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:bg-gray-300">
            {saving ? '저장중...' : `${preview.recipes.length}개 저장`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   원재료 단가 DB
   Firestore: materialPrices/{normalizedName} = { name, pricePerGram, unit, updatedAt }
   ============================================================ */

interface MaterialPriceDoc {
  id: string;
  name: string;
  pricePerGram: number;
  updatedAt?: string;
}

function normalizeName(n: string): string {
  return (n || '').trim().toLowerCase().replace(/\s+/g, '');
}

function MaterialPriceDB({ onCountChange }: { onCountChange: (n: number) => void }) {
  const [prices, setPrices] = useState<MaterialPriceDoc[]>([]);
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState<number>(0);

  useEffect(() => {
    return onSnapshot(collection(db, 'materialPrices'), (snap) => {
      const list: MaterialPriceDoc[] = [];
      snap.forEach((d) => {
        const data = d.data() as { name?: string; pricePerGram?: number; updatedAt?: string };
        list.push({ id: d.id, name: data.name || d.id, pricePerGram: Number(data.pricePerGram) || 0, updatedAt: data.updatedAt });
      });
      list.sort((a, b) => a.name.localeCompare(b.name));
      setPrices(list);
      onCountChange(list.length);
    });
  }, [onCountChange]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return prices;
    return prices.filter((p) => p.name.toLowerCase().includes(q));
  }, [prices, search]);

  const updatePrice = async (id: string, name: string, v: number) => {
    await setDoc(doc(db, 'materialPrices', id), { name, pricePerGram: v, updatedAt: new Date().toISOString() }, { merge: true });
  };
  const addOne = async () => {
    if (!newName.trim() || newPrice <= 0) return;
    const id = normalizeName(newName);
    await setDoc(doc(db, 'materialPrices', id), { name: newName.trim(), pricePerGram: newPrice, updatedAt: new Date().toISOString() });
    setNewName(''); setNewPrice(0);
  };
  const delPrice = async (id: string, name: string) => {
    if (!confirm(`'${name}' 단가를 삭제할까요?`)) return;
    await deleteDoc(doc(db, 'materialPrices', id));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 원재료명 검색..."
          className="flex-1 min-w-[200px] border rounded-md px-3 py-2 text-sm" />
        <span className="text-xs text-gray-500">{filtered.length}/{prices.length}개</span>
        <button onClick={() => setShowImport(true)} className="px-3 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">📋 일괄 입력</button>
      </div>
      {/* 한 개 추가 */}
      <div className="flex items-center gap-2 flex-wrap bg-slate-50 border rounded p-2">
        <span className="text-xs text-gray-600">+ 하나 추가:</span>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="원재료명"
          className="flex-1 min-w-[150px] border rounded px-2 py-1 text-sm" />
        <input type="number" value={newPrice || ''} onChange={(e) => setNewPrice(Number(e.target.value) || 0)} placeholder="₩/g"
          className="w-28 border rounded px-2 py-1 text-sm text-right" />
        <button onClick={addOne} disabled={!newName.trim() || newPrice <= 0}
          className="px-3 py-1 bg-emerald-600 text-white rounded text-xs font-medium hover:bg-emerald-700 disabled:bg-gray-300">추가</button>
      </div>
      {prices.length === 0 ? (
        <div className="p-12 text-center text-gray-400 text-sm border rounded-lg">등록된 단가가 없습니다 — 📋 일괄 입력 으로 추가하세요</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left">원재료명</th>
                <th className="px-3 py-2 text-right w-32">단가 (₩/g)</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 300).map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="px-3 py-1.5">{p.name}</td>
                  <td className="px-3 py-1 text-right">
                    <input type="number" defaultValue={p.pricePerGram}
                      onBlur={(e) => {
                        const v = Number(e.target.value) || 0;
                        if (v !== p.pricePerGram) updatePrice(p.id, p.name, v);
                      }}
                      className="w-24 border rounded px-2 py-1 text-right text-sm" step="0.01" />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button onClick={() => delPrice(p.id, p.name)} className="text-xs text-red-500 hover:underline">삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 300 && (
            <div className="px-3 py-2 text-xs text-gray-500 bg-slate-50 border-t">처음 300개만 표시됨</div>
          )}
        </div>
      )}
      {showImport && <PriceImportModal onClose={() => setShowImport(false)} />}
    </div>
  );
}

function PriceImportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => {
    const lines = text.trim().split('\n');
    const list: { name: string; price: number }[] = [];
    for (const line of lines) {
      const parts = line.split(/[\t,]/).map((s) => s.trim());
      if (parts.length < 2) continue;
      const name = parts[0];
      const price = parseFloat((parts[1] || '').replace(/[^\d.]/g, ''));
      if (!name || isNaN(price) || price <= 0) continue;
      list.push({ name, price });
    }
    return list;
  }, [text]);

  const save = async () => {
    if (parsed.length === 0) return;
    setSaving(true);
    try {
      const CHUNK = 400;
      for (let i = 0; i < parsed.length; i += CHUNK) {
        const batch = writeBatch(db);
        parsed.slice(i, i + CHUNK).forEach((p) => {
          const id = normalizeName(p.name);
          batch.set(doc(db, 'materialPrices', id), {
            name: p.name, pricePerGram: p.price, updatedAt: new Date().toISOString(),
          });
        });
        await batch.commit();
      }
      alert(`${parsed.length}개 단가 저장됨`);
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[92vh]">
        <div className="px-5 py-4 border-b flex items-center justify-between bg-blue-50">
          <h3 className="font-bold text-gray-800">📋 단가 일괄 입력</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="text-xs text-gray-600 bg-slate-50 p-3 rounded border">
            한 줄에 한 원재료. 형식: <code className="bg-white px-1 rounded">원재료명[탭 또는 콤마]단가</code>
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'순수본베이스\t5.2\n닭가슴살\t12.5\n무\t0.8'}
            className="w-full h-48 border rounded p-2 text-xs font-mono" />
          {text.trim() && (
            <div className="text-xs">
              <div className="font-bold mb-1">미리보기 ({parsed.length}개)</div>
              {parsed.slice(0, 8).map((p, i) => (
                <div key={i} className="border-t py-1 flex justify-between">
                  <span>{p.name}</span>
                  <span className="font-mono">{p.price} ₩/g</span>
                </div>
              ))}
              {parsed.length > 8 && <div className="text-gray-400">... 외 {parsed.length - 8}개</div>}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-2 border rounded text-sm font-medium hover:bg-gray-100">취소</button>
          <button onClick={save} disabled={saving || parsed.length === 0}
            className="ml-auto px-5 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:bg-gray-300">
            {saving ? '저장중...' : `${parsed.length}개 저장`}
          </button>
        </div>
      </div>
    </div>
  );
}
