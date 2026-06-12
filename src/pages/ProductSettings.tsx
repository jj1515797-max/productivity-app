import { Fragment, useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, getCountFromServer, getDocs, onSnapshot, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import type { Material, ProductSetting } from '../types';
import { canonicalShort, convertErpCode } from '../lib/codeUtil';
import { CODE_KEY_PREFIX, normalizeCode, normalizeMaterialName } from '../lib/wasteCompute';

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
  const [showSubRecipeDB, setShowSubRecipeDB] = useState(false);
  const [subRecipeCount, setSubRecipeCount] = useState<number | null>(null);
  const [showAmbientRecipeDB, setShowAmbientRecipeDB] = useState(false);
  const [showInventoryPriceDB, setShowInventoryPriceDB] = useState(false);
  const [inventoryPriceCount, setInventoryPriceCount] = useState<number | null>(null);
  const [showBulk, setShowBulk] = useState(false);
  const [showWeightBulk, setShowWeightBulk] = useState(false);
  const [materials, setMaterials] = useState<Material[]>([]);
  // 헤더에 표시할 총개수만 가볍게 (count aggregation = 1읽기)
  const [productCount, setProductCount] = useState<number | null>(null);
  const [materialCount, setMaterialCount] = useState<number | null>(null);
  const [recipeCount, setRecipeCount] = useState<number | null>(null);
  const [ambientRecipeCount, setAmbientRecipeCount] = useState<number | null>(null);

  useEffect(() => {
    getCountFromServer(collection(db, 'productSettings')).then((s) => setProductCount(s.data().count)).catch(() => {});
    getCountFromServer(collection(db, 'materials')).then((s) => setMaterialCount(s.data().count)).catch(() => {});
    getCountFromServer(collection(db, 'recipes')).then((s) => setRecipeCount(s.data().count)).catch(() => {});
    getCountFromServer(collection(db, 'subRecipes')).then((s) => setSubRecipeCount(s.data().count)).catch(() => {});
    getCountFromServer(collection(db, 'ambientRecipes')).then((s) => setAmbientRecipeCount(s.data().count)).catch(() => {});
    getCountFromServer(collection(db, 'materialPricesInventory')).then((s) => setInventoryPriceCount(s.data().count)).catch(() => {});
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
        {showRecipeDB && <RecipeDB onCountChange={setRecipeCount} collectionName="recipes" label="레시피" />}
      </Section>

      {/* 반제품 레시피 DB 섹션 (1g 단위, 분석에서 재귀 전개) */}
      <Section
        icon="🧪"
        title="반제품 레시피 DB"
        badge={subRecipeCount !== null ? `${subRecipeCount}개` : '...'}
        open={showSubRecipeDB}
        onToggle={() => setShowSubRecipeDB(!showSubRecipeDB)}
      >
        {showSubRecipeDB && (
          <div className="space-y-2">
            <div className="bg-emerald-50 border border-emerald-200 rounded p-2.5 text-xs text-emerald-800">
              <b>반제품(중간 가공품) BOM</b>입니다. <code className="bg-white px-1 rounded">PB-Z-001 순수본베이스</code>, <code className="bg-white px-1 rounded">PB-Z-002 디포리육수</code> 같은 자가제조 중간품에 들어가는 원물을 등록하세요.<br/>
              단위 = <b>반제품 1g 제조 시 원물 g</b> (예: 정제수 0.919 = 디포리육수 1g 만들 때 정제수 0.919g 투입).<br/>
              분석1/2 에서 이 코드를 만나면 자동으로 원물 단위까지 풀어서 계산합니다. 반제품 자체에는 단가 안 넣어도 됩니다.
            </div>
            <RecipeDB onCountChange={setSubRecipeCount} collectionName="subRecipes" label="반제품 레시피" />
          </div>
        )}
      </Section>

      {/* 실온이유식 레시피 DB 섹션 (1회 배합 기준) */}
      <Section
        icon="🍼"
        title="실온이유식 레시피 DB"
        badge={ambientRecipeCount !== null ? `${ambientRecipeCount}개` : '...'}
        open={showAmbientRecipeDB}
        onToggle={() => setShowAmbientRecipeDB(!showAmbientRecipeDB)}
      >
        {showAmbientRecipeDB && <AmbientRecipeDB onCountChange={setAmbientRecipeCount} />}
      </Section>

      {/* 원재료 단가 섹션 — 재고평가현황 (출고수량·출고금액 → 단가 자동산출. 분석1/2 + 폐기 공용) */}
      <Section
        icon="💾"
        title="원재료단가 (재고평가현황)"
        badge={inventoryPriceCount !== null ? `${inventoryPriceCount}개` : '...'}
        open={showInventoryPriceDB}
        onToggle={() => setShowInventoryPriceDB(!showInventoryPriceDB)}
      >
        {showInventoryPriceDB && (
          <div className="space-y-2">
            <div className="bg-blue-50 border border-blue-200 rounded p-2.5 text-xs text-blue-800">
              ERP 재고평가현황에서 <b>원재료코드 / 원재료명 / 출고수량(g) / 출고금액(₩)</b> 4컬럼을 붙여넣으세요.
              <b className="ml-1">단가 = 출고금액 ÷ 출고수량</b> 으로 자동 산출되며, <b>원재료분석1·2 + 폐기금액</b> 계산에 모두 사용됩니다.
            </div>
            <MaterialPriceDB onCountChange={setInventoryPriceCount} collectionName="materialPricesInventory" />
          </div>
        )}
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
  code?: string;
}
interface RecipeDoc {
  code: string;
  name: string;
  ingredients: RecipeIngredient[];
}

function RecipeDB({ onCountChange, collectionName = 'recipes', label = '레시피' }: { onCountChange: (n: number) => void; collectionName?: string; label?: string }) {
  const COL = collectionName;
  const [recipes, setRecipes] = useState<RecipeDoc[]>([]);
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(collection(db, COL), (snap) => {
      const list: RecipeDoc[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as RecipeDoc), code: d.id }));
      list.sort((a, b) => a.code.localeCompare(b.code));
      setRecipes(list);
      onCountChange(list.length);
    });
  }, [onCountChange, COL]);

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
    await deleteDoc(doc(db, COL, code));
  };

  // 식재료필요량(gPerPiece) 인라인 수정 → 해당 레시피 문서 ingredients 통째로 갱신
  const updateGram = async (recipe: RecipeDoc, seq: number, newVal: number) => {
    const next = (recipe.ingredients || []).map((ing) =>
      ing.seq === seq ? { ...ing, gPerPiece: newVal } : ing
    );
    await updateDoc(doc(db, COL, recipe.code), {
      ingredients: next,
      updatedAt: new Date().toISOString(),
    });
  };
  const updateIngCode = async (recipe: RecipeDoc, seq: number, newCode: string) => {
    const trimmed = newCode.trim();
    const next = (recipe.ingredients || []).map((ing) => {
      if (ing.seq !== seq) return ing;
      const copy: RecipeIngredient = { ...ing };
      if (trimmed) copy.code = trimmed; else delete copy.code;
      return copy;
    });
    await updateDoc(doc(db, COL, recipe.code), {
      ingredients: next,
      updatedAt: new Date().toISOString(),
    });
  };

  // 원재료코드 일괄변경 — 같은 이름의 원재료가 여러 레시피에 들어있을 때 코드를 한 번에 교정
  const [codeFixing, setCodeFixing] = useState(false);
  const bulkCodeFix = async () => {
    const nameIn = prompt('코드를 일괄 변경할 원재료명을 입력하세요 (예: 돼지슬라이스):');
    if (!nameIn?.trim()) return;
    const target = normalizeMaterialName(nameIn);
    const hits = recipes.filter((r) => (r.ingredients || []).some((i) => normalizeMaterialName(i.name) === target));
    if (hits.length === 0) { alert(`'${nameIn}' 를 쓰는 레시피가 없습니다 (이름 정확히 일치해야 함)`); return; }
    const sample = hits[0].ingredients.find((i) => normalizeMaterialName(i.name) === target);
    const codeIn = prompt(`'${nameIn}' 사용 레시피 ${hits.length}개 발견 (현재 코드: ${sample?.code || '없음'}).\n새 원재료코드를 입력하세요 (비우면 코드 제거):`);
    if (codeIn === null) return;
    const newCode = codeIn.trim();
    setCodeFixing(true);
    try {
      const CHUNK = 400;
      for (let i = 0; i < hits.length; i += CHUNK) {
        const batch = writeBatch(db);
        hits.slice(i, i + CHUNK).forEach((r) => {
          const next = (r.ingredients || []).map((ing) => {
            if (normalizeMaterialName(ing.name) !== target) return ing;
            const copy: RecipeIngredient = { ...ing };
            if (newCode) copy.code = newCode; else delete copy.code;
            return copy;
          });
          batch.update(doc(db, COL, r.code), { ingredients: next, updatedAt: new Date().toISOString() });
        });
        await batch.commit();
      }
      alert(`레시피 ${hits.length}개의 '${nameIn}' 코드를 '${newCode || '(제거)'}' 로 변경했습니다`);
    } catch (e: any) {
      alert(`변경 실패: ${e?.message || e}`);
    } finally { setCodeFixing(false); }
  };

  // 일괄 삭제 (전체 또는 필터된 목록)
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const bulkDelete = async (target: RecipeDoc[]) => {
    if (target.length === 0) return;
    const isFiltered = target.length !== recipes.length;
    const label = isFiltered ? `검색결과 ${target.length}개` : `전체 ${target.length}개`;
    const confirmText = `삭제`;
    const input = prompt(`⚠️ ${label} 레시피를 모두 삭제합니다.\n되돌릴 수 없습니다. 진행하려면 "${confirmText}" 를 입력하세요.`);
    if (input !== confirmText) return;
    setBulkDeleting(true);
    try {
      const CHUNK = 400;
      for (let i = 0; i < target.length; i += CHUNK) {
        const batch = writeBatch(db);
        target.slice(i, i + CHUNK).forEach((r) => batch.delete(doc(db, COL, r.code)));
        await batch.commit();
      }
      alert(`${target.length}개 삭제됨`);
    } finally { setBulkDeleting(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 코드/제품명/원재료 검색..."
          className="flex-1 min-w-[240px] border rounded-md px-3 py-2 text-sm" />
        <span className="text-xs text-gray-500">{filtered.length}/{recipes.length}개</span>
        <button onClick={() => setShowImport(true)} className="px-3 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">📋 일괄 입력</button>
        <button onClick={bulkCodeFix} disabled={codeFixing}
          className="px-3 py-2 bg-indigo-600 text-white rounded text-sm font-medium hover:bg-indigo-700 disabled:bg-gray-300"
          title="같은 이름의 원재료가 들어간 모든 레시피의 원재료코드를 한 번에 변경">
          {codeFixing ? '변경중...' : '🔧 원재료코드 일괄변경'}
        </button>
        {search.trim() && filtered.length > 0 && filtered.length !== recipes.length && (
          <button onClick={() => bulkDelete(filtered)} disabled={bulkDeleting}
            className="px-3 py-2 bg-orange-600 text-white rounded text-sm font-medium hover:bg-orange-700 disabled:bg-gray-300">
            🗑️ 검색결과 삭제 ({filtered.length})
          </button>
        )}
        {recipes.length > 0 && (
          <button onClick={() => bulkDelete(recipes)} disabled={bulkDeleting}
            className="px-3 py-2 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 disabled:bg-gray-300">
            {bulkDeleting ? '삭제중...' : `🗑️ 전체 삭제 (${recipes.length})`}
          </button>
        )}
      </div>
      {recipes.length === 0 ? (
        <div className="p-12 text-center text-gray-400 text-sm border rounded-lg">등록된 레시피가 없습니다 — 📋 일괄 입력 으로 엑셀에서 페이스트</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="max-h-[600px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-gray-600 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2 text-left">코드</th>
                <th className="px-3 py-2 text-left">제품명</th>
                <th className="px-3 py-2 text-right">원재료수</th>
                <th className="px-3 py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
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
                              <th className="text-left w-28">원재료코드</th>
                              <th className="text-right pr-2 w-32">식재료필요량(g)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(r.ingredients || []).map((ing) => (
                              <tr key={ing.seq} className="border-t border-gray-200">
                                <td className="text-right pr-2 text-gray-500">{ing.seq}</td>
                                <td>{ing.name}</td>
                                <td className="py-0.5">
                                  <input
                                    key={`${r.code}-${ing.seq}-code-${ing.code || ''}`}
                                    type="text"
                                    defaultValue={ing.code || ''}
                                    placeholder="-"
                                    onBlur={(e) => {
                                      const v = e.target.value;
                                      if (v !== (ing.code || '')) updateIngCode(r, ing.seq, v);
                                    }}
                                    className="w-24 border rounded px-2 py-0.5 text-xs font-mono focus:ring-1 focus:ring-blue-400"
                                  />
                                </td>
                                <td className="text-right pr-1 py-0.5">
                                  <input
                                    key={`${r.code}-${ing.seq}-${ing.gPerPiece}`}
                                    type="number"
                                    step="0.001"
                                    defaultValue={ing.gPerPiece ?? 0}
                                    onBlur={(e) => {
                                      const v = parseFloat(e.target.value);
                                      if (!isNaN(v) && v >= 0 && v !== ing.gPerPiece) updateGram(r, ing.seq, v);
                                    }}
                                    className="w-28 border rounded px-2 py-0.5 text-right text-xs font-mono focus:ring-1 focus:ring-blue-400"
                                  />
                                </td>
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
          </div>
        </div>
      )}
      {showImport && <RecipeImportModal onClose={() => setShowImport(false)} collectionName={COL} label={label} />}
    </div>
  );
}

function RecipeImportModal({ onClose, collectionName = 'recipes', label = '레시피' }: { onClose: () => void; collectionName?: string; label?: string }) {
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
    // 원재료 ERP코드 컬럼 (선택) — 단가 매칭 우선키
    const MATCODE_CANDIDATES = [
      '원재료erp코드', '원재료erp', '원재료코드', 'erp코드', 'erp',
      '자재코드', '품목코드', '재료코드', '재료erp코드', '원재료품목코드',
    ];
    let matCodeCol = -1;
    for (const cand of MATCODE_CANDIDATES) {
      matCodeCol = header.findIndex((h) => h.toLowerCase() === cand);
      if (matCodeCol >= 0) break;
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
      const matCode = matCodeCol >= 0 ? (r[matCodeCol] || '').trim() : '';
      let rec = map.get(code);
      if (!rec) {
        rec = { code, name: prodName, ingredients: [] };
        map.set(code, rec);
      }
      if (prodName && !rec.name) rec.name = prodName;
      const ing: RecipeIngredient = { seq: seq || rec.ingredients.length + 1, name: ingName, gPerPiece: g };
      if (matCode) ing.code = matCode;
      rec.ingredients.push(ing);
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
          batch.set(doc(db, collectionName, r.code), {
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
          <h3 className="font-bold text-gray-800">📋 {label} 일괄 입력</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="text-xs text-gray-600 bg-slate-50 p-3 rounded border">
            엑셀에서 <b>헤더 포함 표 전체</b>를 복사해서 붙여넣으세요 (탭 구분).<br />
            필수 컬럼: <b>제품코드</b> / <b>원재료</b> / <b>식재료 필요량</b> (없으면 총투입량). 선택: 제품명, 순번.<br />
            <b className="text-blue-700">원재료코드</b>(ERP) 컬럼이 있으면 단가표와 코드로 매칭돼요 (이름이 조금 달라도 OK).<br />
            나머지 컬럼(배합비, 비가식부수율, 공정수율, 바트당투입량 등)은 자동으로 무시됩니다.
            같은 제품코드의 여러 행이 한 레시피로 묶여요.
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)}
            placeholder="제품코드	제품명	순번	원재료	... 식재료 필요량 ..."
            className="w-full h-48 border rounded p-2 text-xs font-mono" />
          {text.trim() && (() => {
            const totalIng = preview.recipes.reduce((s, r) => s + r.ingredients.length, 0);
            const codedIng = preview.recipes.reduce((s, r) => s + r.ingredients.filter((i) => i.code).length, 0);
            return (
              <div className="text-xs">
                <div className="font-bold mb-1">
                  미리보기 ({preview.recipes.length}개 제품 · 원재료 {totalIng}건)
                  <span className={`ml-2 ${codedIng === totalIng && totalIng > 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {codedIng === 0 ? '⚠️ 원재료코드 컬럼 미인식 — 헤더 확인 필요'
                      : codedIng === totalIng ? `✓ 코드 ${codedIng}/${totalIng} 인식`
                      : `⚠️ 코드 ${codedIng}/${totalIng} 만 인식 — 일부 행에 코드 비어있음`}
                  </span>
                </div>
                {preview.errors.length > 0 && <div className="text-red-600 mb-1">{preview.errors.join(', ')}</div>}
                {preview.recipes.slice(0, 5).map((r) => (
                  <div key={r.code} className="border-t py-1">
                    <span className="font-mono font-bold">{r.code}</span> {r.name} — 원재료 {r.ingredients.length}종
                    <span className="text-gray-400 ml-2">(코드: {r.ingredients.filter((i) => i.code).length}/{r.ingredients.length})</span>
                  </div>
                ))}
                {preview.recipes.length > 5 && <div className="text-gray-400">... 외 {preview.recipes.length - 5}개</div>}
              </div>
            );
          })()}
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
   원재료 단가 DB (월별 관리)
   Firestore: materialPricesMonthly/{month__normalizedName}
              = { month, name, pricePerGram, code, updatedAt }
   폐기금액은 폐기 날짜의 月 단가로 계산. 그 月 단가 없으면 "단가 없음".
   ============================================================ */

interface MaterialPriceDoc {
  id: string;
  name: string;
  pricePerGram: number;   // 실제 분석에 쓰이는 단가 (출고 있으면 출고금액÷출고수량, 없으면 manualPrice)
  manualPrice?: number;   // 기초단가 (출고 데이터 없을 때 폴백)
  priceSource?: 'actual' | 'manual';  // 단가 산출 방식
  code?: string;
  updatedAt?: string;
}

// 숫자 문자열에서 콤마/기호 제거 후 파싱
function parseNumStr(s: string): number { return Number((s || '').replace(/[^\d.-]/g, '')) || 0; }
// 천단위 콤마 포맷 (정수)
function fmtInt(n: number): string { return n ? Math.round(n).toLocaleString() : ''; }

function normalizeName(n: string): string {
  return (n || '').trim().toLowerCase().replace(/\s+/g, '');
}
function priceDocId(month: string, name: string): string {
  // Firestore doc ID 제약: '/' 금지, '.', '__' 도 시스템 예약. 슬래시·점·#·?·[·] 등을 _ 로 치환
  const safe = normalizeName(name).replace(/[\/\.#\?\[\]\*]/g, '_');
  return `${month}__${safe}`;
}
function thisMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonthStr(m: string, delta: number): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function MaterialPriceDB({ onCountChange, collectionName = 'materialPricesMonthly' }: { onCountChange: (n: number) => void; collectionName?: string }) {
  const COL = collectionName;
  const [month, setMonth] = useState(thisMonthStr());
  const [allDocs, setAllDocs] = useState<(MaterialPriceDoc & { month: string })[]>([]);
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newPrice, setNewPrice] = useState<string>('');  // 문자열 유지 — '0' (정제수 0원) 도 입력 가능
  const [newOutG, setNewOutG] = useState<string>('');
  const [newOutAmt, setNewOutAmt] = useState<string>('');
  const [newManual, setNewManual] = useState<string>('');
  const [legacyCount, setLegacyCount] = useState(0);
  const [migrating, setMigrating] = useState(false);
  const isInventory = COL === 'materialPricesInventory';

  // 재고평가현황 모드: 출고수량/출고금액 (materialOutflow/{month}) 같이 표시·편집
  const [outflowG, setOutflowG] = useState<Record<string, number>>({});
  const [outflowAmt, setOutflowAmt] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!isInventory) return;
    return onSnapshot(doc(db, 'materialOutflow', month), (snap) => {
      const d = snap.data() as { outflowGrams?: Record<string, number>; outflowAmounts?: Record<string, number> } | undefined;
      setOutflowG(d?.outflowGrams || {});
      setOutflowAmt(d?.outflowAmounts || {});
    });
  }, [isInventory, month]);
  const ingKey = (p: { name: string; code?: string }) =>
    p.code ? (CODE_KEY_PREFIX + normalizeCode(p.code)) : normalizeMaterialName(p.name);
  // 출고 있으면 실측단가(출고금액÷출고수량), 없으면 기초단가(manualPrice) 폴백
  const effPrice = (g: number, amt: number, manual: number | undefined): { price: number; source: 'actual' | 'manual' } =>
    g > 0 ? { price: amt / g, source: 'actual' } : { price: manual || 0, source: 'manual' };

  // 출고 수정 → outflow 문서 + 단가 자동 재계산해 단가 doc 갱신
  const updateOutflow = async (p: MaterialPriceDoc & { month: string }, g: number | null, amt: number | null) => {
    const key = ingKey(p);
    const nextG = { ...outflowG };
    const nextAmt = { ...outflowAmt };
    if (g !== null) { if (g > 0) nextG[key] = g; else delete nextG[key]; }
    if (amt !== null) { if (amt >= 0) nextAmt[key] = amt; else delete nextAmt[key]; }
    setOutflowG(nextG); setOutflowAmt(nextAmt);
    await setDoc(doc(db, 'materialOutflow', month), {
      outflowGrams: nextG, outflowAmounts: nextAmt, updatedAt: new Date().toISOString(),
    }, { merge: false }).catch(() => {});
    const { price, source } = effPrice(nextG[key] || 0, nextAmt[key] ?? 0, p.manualPrice);
    await setDoc(doc(db, COL, p.id), { pricePerGram: price, priceSource: source, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  };

  // 기초단가 수정 → manualPrice 저장 + (출고 없으면) pricePerGram 갱신
  const updateManualPrice = async (p: MaterialPriceDoc & { month: string }, manual: number) => {
    const key = ingKey(p);
    const g = outflowG[key] || 0;
    const amt = outflowAmt[key] ?? 0;
    const { price, source } = effPrice(g, amt, manual);
    await setDoc(doc(db, COL, p.id), { manualPrice: manual, pricePerGram: price, priceSource: source, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  };

  useEffect(() => {
    return onSnapshot(collection(db, COL), (snap) => {
      const list: (MaterialPriceDoc & { month: string })[] = [];
      snap.forEach((d) => {
        const data = d.data() as { month?: string; name?: string; pricePerGram?: number; manualPrice?: number; priceSource?: 'actual' | 'manual'; code?: string; updatedAt?: string };
        list.push({ id: d.id, month: data.month || '', name: data.name || '', pricePerGram: Number(data.pricePerGram) || 0, manualPrice: data.manualPrice !== undefined ? Number(data.manualPrice) : undefined, priceSource: data.priceSource, code: data.code, updatedAt: data.updatedAt });
      });
      setAllDocs(list);
    });
  }, [COL]);

  // 레거시(flat) 단가 존재 여부 — 매입단가 컬렉션에서만 의미 있음
  useEffect(() => {
    if (COL !== 'materialPricesMonthly') return;
    getCountFromServer(collection(db, 'materialPrices')).then((s) => setLegacyCount(s.data().count)).catch(() => {});
  }, [COL]);

  const prices = useMemo(
    () => allDocs.filter((d) => d.month === month).sort((a, b) => a.name.localeCompare(b.name)),
    [allDocs, month]
  );
  useEffect(() => { onCountChange(prices.length); }, [prices.length, onCountChange]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return prices;
    return prices.filter((p) => p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q));
  }, [prices, search]);

  const updatePrice = async (id: string, v: number) => {
    await setDoc(doc(db, COL, id), { pricePerGram: v, updatedAt: new Date().toISOString() }, { merge: true });
  };
  const updateCode = async (id: string, code: string) => {
    await setDoc(doc(db, COL, id), { code: code.trim(), updatedAt: new Date().toISOString() }, { merge: true });
  };
  const addOne = async () => {
    if (!newName.trim()) return;
    let p: number;
    const extra: Record<string, number | string> = {};
    if (isInventory) {
      const g = parseNumStr(newOutG);
      const amt = parseNumStr(newOutAmt);
      const manual = newManual.trim() ? parseNumStr(newManual) : undefined;
      const hasOutflow = g > 0;
      if (!hasOutflow && manual === undefined) return;  // 출고도 없고 기초단가도 없으면 추가 불가
      const { price, source } = effPrice(g, amt, manual);
      p = price;
      extra.priceSource = source;
      if (manual !== undefined) extra.manualPrice = manual;
      // 출고 문서에 기록 (있을 때만)
      if (hasOutflow) {
        const key = newCode.trim() ? (CODE_KEY_PREFIX + normalizeCode(newCode)) : normalizeMaterialName(newName);
        const nextG = { ...outflowG, [key]: g };
        const nextAmt = { ...outflowAmt, [key]: amt };
        setOutflowG(nextG); setOutflowAmt(nextAmt);
        await setDoc(doc(db, 'materialOutflow', month), {
          outflowGrams: nextG, outflowAmounts: nextAmt, updatedAt: new Date().toISOString(),
        }, { merge: false }).catch(() => {});
      }
    } else {
      p = parseFloat(newPrice);
      if (isNaN(p) || p < 0) return;  // 0원 허용 (정제수 등)
    }
    await setDoc(doc(db, COL, priceDocId(month, newName)), {
      month, name: newName.trim(), pricePerGram: p, ...extra,
      ...(newCode.trim() ? { code: newCode.trim() } : {}),
      updatedAt: new Date().toISOString(),
    });
    setNewName(''); setNewCode(''); setNewPrice(''); setNewOutG(''); setNewOutAmt(''); setNewManual('');
  };
  const delPrice = async (id: string, name: string) => {
    if (!confirm(`[${month}] '${name}' 단가를 삭제할까요?`)) return;
    await deleteDoc(doc(db, COL, id));
  };

  // 일괄 삭제 (이 月 전체 또는 검색결과)
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const bulkDelete = async (target: MaterialPriceDoc[]) => {
    if (target.length === 0) return;
    const isFiltered = target.length !== prices.length;
    const label = isFiltered ? `검색결과 ${target.length}개` : `${month} 전체 ${target.length}개`;
    const input = prompt(`⚠️ ${label} 원재료 단가를 삭제합니다.\n되돌릴 수 없습니다. 진행하려면 "삭제" 를 입력하세요.`);
    if (input !== '삭제') return;
    setBulkDeleting(true);
    try {
      const CHUNK = 400;
      for (let i = 0; i < target.length; i += CHUNK) {
        const batch = writeBatch(db);
        target.slice(i, i + CHUNK).forEach((p) => batch.delete(doc(db, COL, p.id)));
        await batch.commit();
      }
      alert(`${target.length}개 삭제됨`);
    } finally { setBulkDeleting(false); }
  };

  // 레거시(flat) 단가 → 2026-05 로 1회 이전
  const migrateLegacy = async () => {
    const targetMonth = '2026-05';
    if (!confirm(`기존 단가 ${legacyCount}개를 ${targetMonth} 단가로 가져올까요?`)) return;
    setMigrating(true);
    try {
      const snap = await getDocs(collection(db, 'materialPrices'));
      const items: { name: string; pricePerGram: number; code?: string }[] = [];
      snap.forEach((d) => {
        const data = d.data() as { name?: string; pricePerGram?: number; code?: string };
        items.push({ name: data.name || d.id, pricePerGram: Number(data.pricePerGram) || 0, code: data.code });
      });
      const CHUNK = 400;
      for (let i = 0; i < items.length; i += CHUNK) {
        const batch = writeBatch(db);
        items.slice(i, i + CHUNK).forEach((it) => {
          batch.set(doc(db, 'materialPricesMonthly', priceDocId(targetMonth, it.name)), {
            month: targetMonth, name: it.name, pricePerGram: it.pricePerGram,
            ...(it.code ? { code: it.code } : {}),
            updatedAt: new Date().toISOString(),
          });
        });
        await batch.commit();
      }
      alert(`${items.length}개를 ${targetMonth} 단가로 이전했습니다.`);
      setMonth(targetMonth);
      setLegacyCount(0);
    } finally { setMigrating(false); }
  };

  return (
    <div className="space-y-3">
      {/* 월 선택 */}
      <div className="flex items-center gap-2 flex-wrap bg-amber-50 border border-amber-200 rounded p-2">
        <span className="text-sm font-bold text-amber-800">📅 기준월</span>
        <button onClick={() => setMonth(shiftMonthStr(month, -1))} className="w-7 h-7 rounded hover:bg-amber-100">◀</button>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="border rounded px-2 py-1 text-sm font-bold" />
        <button onClick={() => setMonth(shiftMonthStr(month, 1))} className="w-7 h-7 rounded hover:bg-amber-100">▶</button>
        <span className="text-xs text-amber-700">{isInventory ? `이 달 데이터는 ${month} 원재료분석1·2 + 폐기금액 계산에 사용됩니다` : `이 달 단가는 ${month} 폐기금액 계산에 사용됩니다`}</span>
        {legacyCount > 0 && (
          <button onClick={migrateLegacy} disabled={migrating}
            className="ml-auto px-3 py-1.5 text-xs rounded bg-purple-600 text-white font-semibold hover:bg-purple-700 disabled:bg-gray-300">
            {migrating ? '이전 중...' : `📦 기존 단가 ${legacyCount}개 → 5월로 가져오기`}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 원재료명·코드 검색..."
          className="flex-1 min-w-[200px] border rounded-md px-3 py-2 text-sm" />
        <span className="text-xs text-gray-500">{filtered.length}/{prices.length}개</span>
        <button onClick={() => setShowImport(true)} className="px-3 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">📋 일괄 입력</button>
        {search.trim() && filtered.length > 0 && filtered.length !== prices.length && (
          <button onClick={() => bulkDelete(filtered)} disabled={bulkDeleting}
            className="px-3 py-2 bg-orange-600 text-white rounded text-sm font-medium hover:bg-orange-700 disabled:bg-gray-300">
            🗑️ 검색결과 삭제 ({filtered.length})
          </button>
        )}
        {prices.length > 0 && (
          <button onClick={() => bulkDelete(prices)} disabled={bulkDeleting}
            className="px-3 py-2 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 disabled:bg-gray-300">
            {bulkDeleting ? '삭제중...' : `🗑️ ${month} 전체 삭제 (${prices.length})`}
          </button>
        )}
      </div>
      {/* 한 개 추가 */}
      <div className="flex items-center gap-2 flex-wrap bg-slate-50 border rounded p-2">
        <span className="text-xs text-gray-600">+ {month} 추가:</span>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="원재료명"
          className="flex-1 min-w-[150px] border rounded px-2 py-1 text-sm" />
        <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="원재료코드(선택)"
          className="w-32 border rounded px-2 py-1 text-sm font-mono" />
        {isInventory ? (
          <>
            <input value={newOutG} onChange={(e) => setNewOutG(e.target.value)} placeholder="출고수량(g)" inputMode="numeric"
              className="w-28 border rounded px-2 py-1 text-sm text-right" />
            <input value={newOutAmt} onChange={(e) => setNewOutAmt(e.target.value)} placeholder="출고금액(₩)" inputMode="numeric"
              className="w-28 border rounded px-2 py-1 text-sm text-right" />
            <input value={newManual} onChange={(e) => setNewManual(e.target.value)} placeholder="기초단가(출고無시)"
              className="w-28 border rounded px-2 py-1 text-sm text-right" title="출고수량/금액이 없을 때 사용할 단가" />
            <span className="text-xs text-gray-400 w-28 text-right">
              {(() => {
                const g = parseNumStr(newOutG); const a = parseNumStr(newOutAmt);
                if (g > 0) return `실측 ${(a / g).toFixed(4)} ₩/g`;
                if (newManual.trim()) return `기초 ${parseNumStr(newManual).toFixed(4)} ₩/g`;
                return '단가 -';
              })()}
            </span>
          </>
        ) : (
          <input type="number" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="₩/g (0 가능)" min="0"
            className="w-28 border rounded px-2 py-1 text-sm text-right" />
        )}
        <button onClick={addOne}
          disabled={!newName.trim() || (isInventory
            ? !(parseNumStr(newOutG) > 0) && !newManual.trim()
            : newPrice.trim() === '' || parseFloat(newPrice) < 0 || isNaN(parseFloat(newPrice)))}
          className="px-3 py-1 bg-emerald-600 text-white rounded text-xs font-medium hover:bg-emerald-700 disabled:bg-gray-300">추가</button>
      </div>
      {prices.length === 0 ? (
        <div className="p-12 text-center text-gray-400 text-sm border rounded-lg">{month} 데이터가 없습니다 — 📋 일괄 입력 으로 추가하세요</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="max-h-[600px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-gray-600 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2 text-left">원재료명</th>
                <th className="px-3 py-2 text-left w-32">원재료코드</th>
                {isInventory && <th className="px-3 py-2 text-right w-28">출고수량 (g)</th>}
                {isInventory && <th className="px-3 py-2 text-right w-28">출고금액 (₩)</th>}
                {isInventory && <th className="px-3 py-2 text-right w-24">기초단가<span className="block text-[10px] font-normal text-gray-400">출고無 시 사용</span></th>}
                <th className="px-3 py-2 text-right w-32">단가 (₩/g){isInventory && <span className="block text-[10px] font-normal text-gray-400">실측=금액÷수량</span>}</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const key = ingKey(p);
                const g = outflowG[key] || 0;
                const amt = outflowAmt[key] ?? 0;
                const isManual = !(g > 0);  // 출고 없으면 기초단가 사용
                const effective = g > 0 ? (amt / g) : (p.manualPrice || 0);
                return (
                <tr key={p.id} className={`border-t ${isManual && isInventory ? 'bg-amber-50/40' : ''}`}>
                  <td className="px-3 py-1.5">{p.name}</td>
                  <td className="px-3 py-1 text-left">
                    <input key={`${p.id}-${p.code || ''}`} defaultValue={p.code || ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (p.code || '')) updateCode(p.id, v);
                      }}
                      placeholder="-"
                      className="w-24 border rounded px-2 py-1 text-sm font-mono" />
                  </td>
                  {isInventory && (
                    <td className="px-3 py-1 text-right">
                      <input key={`${p.id}-g-${g}`} defaultValue={fmtInt(g)} inputMode="numeric"
                        onBlur={(e) => {
                          const v = parseNumStr(e.target.value);
                          if (v !== g) updateOutflow(p, v, null);
                          else e.target.value = fmtInt(g);
                        }}
                        placeholder="-"
                        className="w-24 border rounded px-2 py-1 text-right text-sm" />
                    </td>
                  )}
                  {isInventory && (
                    <td className="px-3 py-1 text-right">
                      <input key={`${p.id}-amt-${amt}`} defaultValue={fmtInt(amt)} inputMode="numeric"
                        onBlur={(e) => {
                          const v = parseNumStr(e.target.value);
                          if (v !== amt) updateOutflow(p, null, v);
                          else e.target.value = fmtInt(amt);
                        }}
                        placeholder="-"
                        className="w-24 border rounded px-2 py-1 text-right text-sm" />
                    </td>
                  )}
                  {isInventory && (
                    <td className="px-3 py-1 text-right">
                      <input key={`${p.id}-manual-${p.manualPrice ?? ''}`} defaultValue={p.manualPrice ?? ''} type="number" step="0.0001"
                        onBlur={(e) => {
                          const v = Number(e.target.value) || 0;
                          if (v !== (p.manualPrice || 0)) updateManualPrice(p, v);
                        }}
                        placeholder="-"
                        className="w-20 border rounded px-2 py-1 text-right text-sm" />
                    </td>
                  )}
                  <td className="px-3 py-1 text-right">
                    {isInventory ? (
                      <span className="font-mono text-gray-700">
                        {effective ? effective.toFixed(4) : '-'}
                        {isManual ? <span className="ml-1 text-[10px] text-amber-600 font-sans">기초</span>
                                  : <span className="ml-1 text-[10px] text-blue-500 font-sans">실측</span>}
                      </span>
                    ) : (
                      <input type="number" key={`${p.id}-${p.pricePerGram}`} defaultValue={p.pricePerGram}
                        onBlur={(e) => {
                          const v = Number(e.target.value) || 0;
                          if (v !== p.pricePerGram) updatePrice(p.id, v);
                        }}
                        className="w-24 border rounded px-2 py-1 text-right text-sm" step="0.01" />
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button onClick={() => delPrice(p.id, p.name)} className="text-xs text-red-500 hover:underline">삭제</button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
      {showImport && <PriceImportModal month={month} collectionName={COL} withOutflow={COL === 'materialPricesInventory'} onClose={() => setShowImport(false)} />}
    </div>
  );
}

function PriceImportModal({ month, onClose, collectionName = 'materialPricesMonthly', withOutflow = false }: { month: string; onClose: () => void; collectionName?: string; withOutflow?: boolean }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => {
    // 탭이 있으면 탭으로만 분리(숫자 천단위 콤마 보존), 없으면 콤마로 분리
    const splitLine = (l: string) => (l.includes('\t') ? l.split('\t') : l.split(',')).map((s) => s.trim());
    const rows = text.trim().split('\n').map(splitLine);
    const list: { name: string; price: number; code: string; outflowG?: number; outflowAmt?: number; manualPrice?: number; source: 'actual' | 'manual' }[] = [];
    if (rows.length === 0) return list;

    // 헤더 감지: 원재료/품목명 + 단가/가격 컬럼이 있는 행
    const norm = (s: string) => (s || '').replace(/\s+/g, '').replace(/\(.*?\)/g, '').toLowerCase();
    const NAME_H = ['원재료', '원재료명', '품목명', '품명', 'name'];
    const PRICE_H = ['단가', '가격', 'price', 'g단가'];
    const MANUAL_H = ['기초단가', '기준단가', '표준단가', 'basePrice', 'baseprice'];
    const CODE_H = ['원재료코드', 'erp코드', '원재료erp코드', '자재코드', '품목코드', '코드', 'code'];
    const OUTG_H = ['출고수량', '출고량', '실출고', '실사용량', '실제출고', '실제출고량', '실제출고수량', 'outflow', 'outflowg'];
    const OUTAMT_H = ['출고금액', '실사용금액', '실제출고금액', '출고가액', 'amount', 'outflowamt'];
    let nameCol = 0, priceCol = 1, codeCol = -1, outGCol = -1, outAmtCol = -1, manualCol = -1, startRow = 0;
    // 헤더 행 = 원재료명 컬럼 + (단가 또는 출고수량) 컬럼이 있는 행
    const hRow = rows.findIndex((r) => {
      const c = r.map(norm);
      return c.some((x) => NAME_H.includes(x)) && (c.some((x) => PRICE_H.includes(x)) || c.some((x) => OUTG_H.includes(x)) || c.some((x) => MANUAL_H.includes(x)));
    });
    if (hRow >= 0) {
      const h = rows[hRow].map(norm);
      nameCol = h.findIndex((x) => NAME_H.includes(x));
      manualCol = h.findIndex((x) => MANUAL_H.includes(x));
      priceCol = h.findIndex((x) => PRICE_H.includes(x) && !MANUAL_H.includes(x));
      codeCol = h.findIndex((x) => CODE_H.includes(x));
      outGCol = h.findIndex((x) => OUTG_H.includes(x));
      outAmtCol = h.findIndex((x) => OUTAMT_H.includes(x));
      startRow = hRow + 1;
    } else if (withOutflow) {
      // 헤더 없음 (재고평가현황): 기본 = 원재료코드 [탭] 원재료명 [탭] 출고수량 [탭] 출고금액 [탭] 기초단가(선택)
      // 첫 컬럼이 숫자코드(5자리 이상)면 코드 우선 배치로 판단
      const codeFirst = rows.slice(0, 5).filter((r) => /^\d{5,}$/.test((r[0] || '').replace(/[-\s]/g, ''))).length >= Math.min(rows.length, 3);
      if (codeFirst) { codeCol = 0; nameCol = 1; outGCol = 2; outAmtCol = 3; manualCol = 4; priceCol = -1; }
      else { nameCol = 0; codeCol = 1; outGCol = 2; outAmtCol = 3; manualCol = 4; priceCol = -1; }
    } else {
      // 헤더 없음 (일반): 원재료명 [탭] 단가 [탭] 코드
      nameCol = 0; priceCol = 1;
      const cols = rows[0]?.length || 0;
      codeCol = cols >= 3 ? 2 : -1;
    }

    for (let i = startRow; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[nameCol] || '').trim();
      if (!name) continue;
      const code = codeCol >= 0 ? (r[codeCol] || '').trim() : '';
      const explicit = priceCol >= 0 ? parseFloat((r[priceCol] || '').replace(/[^\d.]/g, '')) : NaN;
      const og = outGCol >= 0 ? parseFloat((r[outGCol] || '').replace(/[^\d.]/g, '')) : NaN;
      const oa = outAmtCol >= 0 ? parseFloat((r[outAmtCol] || '').replace(/[^\d.]/g, '')) : NaN;
      const manual = manualCol >= 0 ? parseFloat((r[manualCol] || '').replace(/[^\d.]/g, '')) : NaN;
      const hasOutflow = !isNaN(og) && og > 0 && !isNaN(oa) && oa >= 0;
      // 단가 우선순위: 출고금액÷출고수량(실측) > 명시 단가 > 기초단가
      let price = NaN; let source: 'actual' | 'manual' = 'manual';
      if (hasOutflow) { price = oa / og; source = 'actual'; }
      else if (!isNaN(explicit)) { price = explicit; source = 'manual'; }
      else if (!isNaN(manual)) { price = manual; source = 'manual'; }
      if (isNaN(price) || price < 0) continue;
      const item: typeof list[number] = { name, price, code, source };
      if (!isNaN(manual)) item.manualPrice = manual;
      else if (!hasOutflow && !isNaN(explicit)) item.manualPrice = explicit;  // 명시단가를 기초단가로 보존
      if (withOutflow && hasOutflow) { item.outflowG = og; item.outflowAmt = oa; }
      list.push(item);
    }
    return list;
  }, [text, withOutflow]);

  // 미리보기/저장에 쓸 통계
  const outflowCount = parsed.filter((p) => p.outflowG !== undefined).length;
  const manualCount = parsed.filter((p) => p.source === 'manual').length;

  const save = async () => {
    if (parsed.length === 0) return;
    setSaving(true);
    try {
      // 1) 단가 일괄 저장
      const CHUNK = 400;
      for (let i = 0; i < parsed.length; i += CHUNK) {
        const batch = writeBatch(db);
        parsed.slice(i, i + CHUNK).forEach((p) => {
          batch.set(doc(db, collectionName, priceDocId(month, p.name)), {
            month, name: p.name, pricePerGram: p.price, priceSource: p.source,
            ...(p.manualPrice !== undefined ? { manualPrice: p.manualPrice } : {}),
            ...(p.code ? { code: p.code } : {}),
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        });
        await batch.commit();
      }

      // 2) 출고 입력이 같이 있으면 materialOutflow/{month} 에 병합 저장
      //    키 규칙은 MaterialAnalysis2 와 동일: 코드 우선(CODE_KEY_PREFIX + normalizeCode), 없으면 normalizeMaterialName
      if (withOutflow && outflowCount > 0) {
        const outflowGrams: Record<string, number> = {};
        const outflowAmounts: Record<string, number> = {};
        parsed.forEach((p) => {
          if (p.outflowG === undefined && p.outflowAmt === undefined) return;
          const key = p.code ? (CODE_KEY_PREFIX + normalizeCode(p.code)) : normalizeMaterialName(p.name);
          if (p.outflowG !== undefined) outflowGrams[key] = p.outflowG;
          if (p.outflowAmt !== undefined) outflowAmounts[key] = p.outflowAmt;
        });
        await setDoc(doc(db, 'materialOutflow', month), {
          outflowGrams, outflowAmounts, updatedAt: new Date().toISOString(),
        }, { merge: true });
      }

      const msg = withOutflow
        ? `${month} ${parsed.length}개 저장됨 (실측 ${outflowCount} · 기초단가 ${manualCount})`
        : `${month} 단가 ${parsed.length}개 저장됨`;
      alert(msg);
      onClose();
    } catch (e: any) {
      console.error('[PriceImport save]', e);
      const msg = String(e?.message || e);
      if (msg.includes('permission') || msg.includes('PERMISSION_DENIED') || msg.includes('Missing or insufficient')) {
        alert(`저장 실패 — Firestore 보안 규칙에서 컬렉션 쓰기가 막혀 있습니다.\n\nFirebase Console > Firestore > 규칙 에서 아래 줄을 추가하세요:\n\nmatch /${collectionName}/{doc} {\n  allow read, write: if request.auth != null;\n}${withOutflow ? `\n\nmatch /materialOutflow/{doc} {\n  allow read, write: if request.auth != null;\n}` : ''}`);
      } else {
        alert(`저장 실패: ${msg}`);
      }
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className={`bg-white rounded-xl shadow-2xl w-full ${withOutflow ? 'max-w-3xl' : 'max-w-xl'} overflow-hidden flex flex-col max-h-[92vh]`}>
        <div className="px-5 py-4 border-b flex items-center justify-between bg-blue-50">
          <h3 className="font-bold text-gray-800">📋 {month} {withOutflow ? '재고평가현황 일괄 입력' : '단가 일괄 입력'}</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="text-xs text-gray-600 bg-slate-50 p-3 rounded border">
            <b className="text-amber-700">{month}</b> 데이터로 저장됩니다. 한 줄에 한 원재료.<br />
            {withOutflow ? (
              <>형식: <code className="bg-white px-1 rounded">원재료코드 [탭] 원재료명 [탭] 출고수량(g) [탭] 출고금액(₩) [탭] 기초단가(선택)</code><br />
              <b className="text-indigo-700">단가 = 출고금액 ÷ 출고수량</b> 자동 산출. 출고가 없는 원재료(케일·곤드레 등)는 <b className="text-amber-700">기초단가</b>로 계산됩니다.<br /></>
            ) : (
              <>형식: <code className="bg-white px-1 rounded">원재료명 [탭] 단가 [탭] 원재료코드 (선택)</code><br /></>
            )}
            <b className="text-blue-700">원재료코드</b>를 넣으면 레시피와 코드로 매칭돼요 (이름이 조금 달라도 OK).
            헤더 줄을 같이 붙여도 자동 인식합니다.
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)}
            placeholder={withOutflow
              ? '10110001\t멥쌀(유기농)\t10843771\t37182474\n10110002\t찹쌀\t1796457\t10564389\n9999999\t정제수\t50000000\t0'
              : '캐슈넛(인도산)\t23.18\tM0123\n닭가슴살(무항생제)\t5.00\tM0456\n무\t4.00'}
            className="w-full h-48 border rounded p-2 text-xs font-mono" />
          {text.trim() && (
            <div className="text-xs">
              <div className="font-bold mb-1">
                미리보기 ({parsed.length}개{withOutflow ? ` · 실측 ${outflowCount} · 기초단가 ${manualCount}` : ''})
              </div>
              {parsed.slice(0, 8).map((p, i) => (
                <div key={i} className="border-t py-1 flex justify-between gap-2 items-center">
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="font-mono text-gray-400 w-20 text-right">{p.code || '-'}</span>
                  <span className="font-mono w-24 text-right">{Number(p.price.toFixed(4))} ₩/g</span>
                  {withOutflow && (
                    <span className={`w-10 text-center text-[10px] rounded ${p.source === 'actual' ? 'text-blue-600' : 'text-amber-600'}`}>{p.source === 'actual' ? '실측' : '기초'}</span>
                  )}
                  {withOutflow && <>
                    <span className={`font-mono w-20 text-right ${p.outflowG ? 'text-indigo-600' : 'text-gray-300'}`}>{p.outflowG ? p.outflowG.toLocaleString() + 'g' : '-'}</span>
                    <span className={`font-mono w-24 text-right ${p.outflowAmt ? 'text-indigo-600' : 'text-gray-300'}`}>{p.outflowAmt ? p.outflowAmt.toLocaleString() + '원' : '-'}</span>
                  </>}
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

/* ============================================================
   실온이유식 레시피 DB (1회 배합 기준)
   Firestore: ambientRecipes/{normalizedName}
              = { name, batchPieces, ingredients: [{seq, name, gPerBatch, code?}], updatedAt }
   ============================================================ */

interface AmbientRecipeDoc {
  id: string;
  name: string;
  batchPieces: number;
  ingredients: { seq: number; name: string; gPerBatch: number; code?: string }[];
  updatedAt?: string;
}

function ambientDocId(name: string): string {
  return normalizeName(name);
}

function AmbientRecipeDB({ onCountChange }: { onCountChange: (n: number) => void }) {
  const [recipes, setRecipes] = useState<AmbientRecipeDoc[]>([]);
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  useEffect(() => {
    return onSnapshot(collection(db, 'ambientRecipes'), (snap) => {
      const list: AmbientRecipeDoc[] = [];
      snap.forEach((d) => {
        const data = d.data() as Omit<AmbientRecipeDoc, 'id'>;
        list.push({
          id: d.id,
          name: data.name || d.id,
          batchPieces: Number(data.batchPieces) || 1100,
          ingredients: data.ingredients || [],
          updatedAt: data.updatedAt,
        });
      });
      list.sort((a, b) => a.name.localeCompare(b.name));
      setRecipes(list);
      onCountChange(list.length);
    });
  }, [onCountChange]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      r.ingredients.some((i) => i.name.toLowerCase().includes(q))
    );
  }, [recipes, search]);

  const updateBatchPieces = async (r: AmbientRecipeDoc, v: number) => {
    if (v <= 0) return;
    await updateDoc(doc(db, 'ambientRecipes', r.id), {
      batchPieces: v,
      updatedAt: new Date().toISOString(),
    });
  };
  const updateGram = async (r: AmbientRecipeDoc, seq: number, v: number) => {
    if (v < 0) return;
    const next = r.ingredients.map((ing) => ing.seq === seq ? { ...ing, gPerBatch: v } : ing);
    await updateDoc(doc(db, 'ambientRecipes', r.id), {
      ingredients: next,
      updatedAt: new Date().toISOString(),
    });
  };
  const updateIngCode = async (r: AmbientRecipeDoc, seq: number, newCode: string) => {
    const trimmed = newCode.trim();
    const next = r.ingredients.map((ing) => {
      if (ing.seq !== seq) return ing;
      const copy: AmbientRecipeDoc['ingredients'][number] = { ...ing };
      if (trimmed) copy.code = trimmed; else delete copy.code;
      return copy;
    });
    await updateDoc(doc(db, 'ambientRecipes', r.id), {
      ingredients: next,
      updatedAt: new Date().toISOString(),
    });
  };
  const delRecipe = async (r: AmbientRecipeDoc) => {
    if (!confirm(`'${r.name}' 실온 레시피를 삭제할까요?`)) return;
    await deleteDoc(doc(db, 'ambientRecipes', r.id));
  };
  const bulkDelete = async (target: AmbientRecipeDoc[]) => {
    if (target.length === 0) return;
    const isFiltered = target.length !== recipes.length;
    const label = isFiltered ? `검색결과 ${target.length}개` : `전체 ${target.length}개`;
    const input = prompt(`⚠️ ${label} 실온 레시피를 삭제합니다.\n진행하려면 "삭제" 를 입력하세요.`);
    if (input !== '삭제') return;
    setBulkDeleting(true);
    try {
      const CHUNK = 400;
      for (let i = 0; i < target.length; i += CHUNK) {
        const batch = writeBatch(db);
        target.slice(i, i + CHUNK).forEach((r) => batch.delete(doc(db, 'ambientRecipes', r.id)));
        await batch.commit();
      }
      alert(`${target.length}개 삭제됨`);
    } finally { setBulkDeleting(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 제품명·원재료 검색..."
          className="flex-1 min-w-[240px] border rounded-md px-3 py-2 text-sm" />
        <span className="text-xs text-gray-500">{filtered.length}/{recipes.length}개</span>
        <button onClick={() => setShowImport(true)} className="px-3 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">📋 일괄 입력</button>
        {search.trim() && filtered.length > 0 && filtered.length !== recipes.length && (
          <button onClick={() => bulkDelete(filtered)} disabled={bulkDeleting}
            className="px-3 py-2 bg-orange-600 text-white rounded text-sm font-medium hover:bg-orange-700 disabled:bg-gray-300">
            🗑️ 검색결과 삭제 ({filtered.length})
          </button>
        )}
        {recipes.length > 0 && (
          <button onClick={() => bulkDelete(recipes)} disabled={bulkDeleting}
            className="px-3 py-2 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 disabled:bg-gray-300">
            {bulkDeleting ? '삭제중...' : `🗑️ 전체 삭제 (${recipes.length})`}
          </button>
        )}
      </div>
      {recipes.length === 0 ? (
        <div className="p-12 text-center text-gray-400 text-sm border rounded-lg">등록된 실온 레시피가 없습니다 — 📋 일괄 입력으로 추가하세요</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="max-h-[600px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-gray-600 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2 text-left">제품명</th>
                  <th className="px-3 py-2 text-right w-36">1회 배합 포장수</th>
                  <th className="px-3 py-2 text-right w-20">원재료수</th>
                  <th className="px-3 py-2 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="border-t hover:bg-slate-50">
                      <td className="px-3 py-1.5">{r.name}</td>
                      <td className="px-3 py-1 text-right">
                        <input type="number" key={`${r.id}-${r.batchPieces}`} defaultValue={r.batchPieces}
                          onBlur={(e) => {
                            const v = Number(e.target.value) || 0;
                            if (v > 0 && v !== r.batchPieces) updateBatchPieces(r, v);
                          }}
                          className="w-24 border rounded px-2 py-1 text-right text-sm" step="1" min="1" />
                      </td>
                      <td className="px-3 py-1.5 text-right">{r.ingredients.length}</td>
                      <td className="px-3 py-1.5 text-right">
                        <button onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                          className="text-xs text-blue-600 hover:underline">{expanded === r.id ? '닫기' : '보기'}</button>
                        <button onClick={() => delRecipe(r)} className="text-xs text-red-500 hover:underline ml-2">삭제</button>
                      </td>
                    </tr>
                    {expanded === r.id && (
                      <tr className="border-t bg-slate-50">
                        <td colSpan={4} className="p-3">
                          <table className="w-full text-xs">
                            <thead className="text-gray-500">
                              <tr>
                                <th className="text-right pr-2 w-12">순번</th>
                                <th className="text-left">원재료</th>
                                <th className="text-left w-28">원재료코드</th>
                                <th className="text-right pr-2 w-36">배합비(1세트, g)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.ingredients.map((ing) => (
                                <tr key={ing.seq} className="border-t border-gray-200">
                                  <td className="text-right pr-2 text-gray-500">{ing.seq}</td>
                                  <td>{ing.name}</td>
                                  <td className="py-0.5">
                                    <input
                                      key={`${r.id}-${ing.seq}-code-${ing.code || ''}`}
                                      type="text"
                                      defaultValue={ing.code || ''}
                                      placeholder="-"
                                      onBlur={(e) => {
                                        const v = e.target.value;
                                        if (v !== (ing.code || '')) updateIngCode(r, ing.seq, v);
                                      }}
                                      className="w-24 border rounded px-2 py-0.5 text-xs font-mono focus:ring-1 focus:ring-blue-400"
                                    />
                                  </td>
                                  <td className="text-right pr-1 py-0.5">
                                    <input type="number" step="0.001" min="0"
                                      key={`${r.id}-${ing.seq}-${ing.gPerBatch}`}
                                      defaultValue={ing.gPerBatch ?? 0}
                                      onBlur={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (!isNaN(v) && v >= 0 && v !== ing.gPerBatch) updateGram(r, ing.seq, v);
                                      }}
                                      className="w-28 border rounded px-2 py-0.5 text-right text-xs font-mono focus:ring-1 focus:ring-blue-400" />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {showImport && <AmbientRecipeImportModal onClose={() => setShowImport(false)} />}
    </div>
  );
}

function AmbientRecipeImportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const parse = (): { recipes: { name: string; ingredients: { seq: number; name: string; gPerBatch: number; code?: string }[] }[]; errors: string[] } => {
    const lines = text.trim().split('\n').map((l) => l.split('\t'));
    const errors: string[] = [];
    if (lines.length < 1) return { recipes: [], errors: ['데이터가 없습니다'] };

    const norm = (s: string) => (s || '').replace(/\s+/g, '').replace(/\(.*?\)/g, '').trim();
    const NAME_CANDIDATES = ['제품명', '품목명', '품명'];
    const SEQ_CANDIDATES = ['순서', '순번', 'seq'];
    const ING_CANDIDATES = ['원재료명', '원재료', '재료명'];
    const G_CANDIDATES = ['배합비1세트', '배합비', '배합비g', '1세트', '1회배합', '1회배합g', '배합량'];
    const CODE_CANDIDATES = ['원재료코드', '원재료erp코드', 'erp코드', '자재코드', '품목코드', '재료코드', '코드'];

    const findCol = (cells: string[], cands: string[]) => {
      for (const c of cands) { const i = cells.findIndex((x) => x.toLowerCase() === c); if (i >= 0) return i; }
      return -1;
    };
    const hIdx = lines.findIndex((r) => {
      const cells = r.map((c) => norm(c).toLowerCase());
      return findCol(cells, NAME_CANDIDATES.map((s) => s.toLowerCase())) >= 0 &&
             findCol(cells, ING_CANDIDATES.map((s) => s.toLowerCase())) >= 0 &&
             findCol(cells, G_CANDIDATES.map((s) => s.toLowerCase())) >= 0;
    });

    let nameCol: number, seqCol: number, ingCol: number, gCol: number, codeCol: number, startRow: number;
    if (hIdx >= 0) {
      const header = lines[hIdx].map((c) => norm(c).toLowerCase());
      nameCol = findCol(header, NAME_CANDIDATES.map((s) => s.toLowerCase()));
      seqCol = findCol(header, SEQ_CANDIDATES.map((s) => s.toLowerCase()));
      ingCol = findCol(header, ING_CANDIDATES.map((s) => s.toLowerCase()));
      gCol = findCol(header, G_CANDIDATES.map((s) => s.toLowerCase()));
      codeCol = findCol(header, CODE_CANDIDATES.map((s) => s.toLowerCase()));
      startRow = hIdx + 1;
    } else {
      // 헤더 없음 → 위치 기반: 제품명 / 순서 / 원재료명 / 배합비 / 원재료코드(선택)
      // 두 번째 칸이 정수면 순서 컬럼 있음으로 간주
      const first = lines[0];
      const hasSeq = first.length >= 4 && /^\d+$/.test((first[1] || '').trim());
      if (hasSeq) { nameCol = 0; seqCol = 1; ingCol = 2; gCol = 3; codeCol = first.length >= 5 ? 4 : -1; }
      else { nameCol = 0; seqCol = -1; ingCol = 1; gCol = 2; codeCol = first.length >= 4 ? 3 : -1; }
      startRow = 0;
    }
    if (nameCol < 0 || ingCol < 0 || gCol < 0) {
      errors.push('컬럼(제품명/원재료명/배합비) 인식 실패');
      return { recipes: [], errors };
    }

    const map = new Map<string, { name: string; ingredients: { seq: number; name: string; gPerBatch: number; code?: string }[] }>();
    for (let i = startRow; i < lines.length; i++) {
      const r = lines[i];
      const name = (r[nameCol] || '').trim();
      const ingName = (r[ingCol] || '').trim();
      const gStr = (r[gCol] || '').trim().replace(/,/g, '');
      if (!name || !ingName) continue;
      const g = parseFloat(gStr);
      if (isNaN(g) || g < 0) continue;
      const seq = seqCol >= 0 ? (parseInt((r[seqCol] || '').trim(), 10) || 0) : 0;
      const matCode = codeCol >= 0 ? (r[codeCol] || '').trim() : '';
      let rec = map.get(name);
      if (!rec) { rec = { name, ingredients: [] }; map.set(name, rec); }
      const ing: { seq: number; name: string; gPerBatch: number; code?: string } = {
        seq: seq || rec.ingredients.length + 1, name: ingName, gPerBatch: g,
      };
      if (matCode) ing.code = matCode;
      rec.ingredients.push(ing);
    }
    Array.from(map.values()).forEach((r) => r.ingredients.sort((a, b) => a.seq - b.seq));
    return { recipes: Array.from(map.values()), errors };
  };

  const preview = useMemo(() => (text.trim() ? parse() : { recipes: [], errors: [] }), [text]);

  const save = async () => {
    if (preview.recipes.length === 0) return;
    setSaving(true);
    try {
      const CHUNK = 400;
      for (let i = 0; i < preview.recipes.length; i += CHUNK) {
        const batch = writeBatch(db);
        preview.recipes.slice(i, i + CHUNK).forEach((r) => {
          batch.set(doc(db, 'ambientRecipes', ambientDocId(r.name)), {
            name: r.name,
            batchPieces: 1100, // 기본값. 등록 후 인라인 수정
            ingredients: r.ingredients,
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        });
        await batch.commit();
      }
      alert(`${preview.recipes.length}개 실온 레시피 저장됨`);
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b flex items-center justify-between bg-blue-50">
          <h3 className="font-bold text-gray-800">📋 실온이유식 레시피 일괄 입력</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="text-xs text-gray-600 bg-slate-50 p-3 rounded border">
            형식: <b>제품명 / 순서 / 원재료명 / 배합비(1세트) / 원재료코드</b> (탭 구분). <b>헤더 줄은 없어도 됩니다</b> — 데이터만 붙여도 인식.<br />
            <b className="text-blue-700">5번째 원재료코드</b>를 넣으면 단가 매칭 시 <b>코드 우선</b>(없으면 원재료명)으로 계산돼요. 배합비는 g 단위(콤마 OK).<br />
            같은 제품명의 여러 행이 한 레시피로 자동 묶이고, <b>1회 배합 포장수</b>는 기본 1100개로 저장(등록 후 인라인 수정).
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'제품명\t순서\t원재료명\t배합비(1세트)\t원재료코드\n순수본_한우야채진밥\t1\t백미\t50000\t10110001\n순수본_한우야채진밥\t2\t한우(슬라이스)\t5000\t10620045'}
            className="w-full h-48 border rounded p-2 text-xs font-mono" />
          {text.trim() && (() => {
            const totalIng = preview.recipes.reduce((s, r) => s + r.ingredients.length, 0);
            const codedIng = preview.recipes.reduce((s, r) => s + r.ingredients.filter((i) => i.code).length, 0);
            return (
              <div className="text-xs">
                <div className="font-bold mb-1">
                  미리보기 ({preview.recipes.length}개 제품 · 원재료 {totalIng}건)
                  <span className={`ml-2 ${codedIng === totalIng && totalIng > 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {codedIng === 0 ? '⚠️ 원재료코드 미인식 (이름으로 매칭됨)'
                      : codedIng === totalIng ? `✓ 코드 ${codedIng}/${totalIng}`
                      : `⚠️ 코드 ${codedIng}/${totalIng}`}
                  </span>
                </div>
                {preview.errors.length > 0 && <div className="text-red-600 mb-1">{preview.errors.join(', ')}</div>}
                {preview.recipes.slice(0, 6).map((r) => (
                  <div key={r.name} className="border-t py-1">
                    <span className="font-bold">{r.name}</span> — 원재료 {r.ingredients.length}종
                    <span className="text-gray-400 ml-2">(코드 {r.ingredients.filter((i) => i.code).length}/{r.ingredients.length})</span>
                  </div>
                ))}
                {preview.recipes.length > 6 && <div className="text-gray-400">... 외 {preview.recipes.length - 6}개</div>}
              </div>
            );
          })()}
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
