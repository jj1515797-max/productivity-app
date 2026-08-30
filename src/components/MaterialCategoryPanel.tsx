/** 원재료 카테고리 DB 관리 패널 (설정 › 원재료분석용 DB)
 *
 *  materialCategories/{c_코드 | n_이름} = { code, name, category }
 *
 *  입력 방법 두 가지를 같이 준다.
 *   1) 붙여넣기 — 엑셀에서 코드/원재료명/카테고리 3열을 통째로
 *   2) 목록에서 지정 — 재고평가현황에 있는 원재료를 쭉 띄우고 드롭다운으로 찍기
 *  실무에서는 (1)로 한 번에 넣고, 신규 자재만 (2)로 메꾸는 흐름이 된다.
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, getDocs, onSnapshot, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import {
  CategoryDoc, UNCLASSIFIED, categoryDocId, parseCategoryPaste,
} from '../lib/materialCategory';
import { normalizeCode } from '../lib/codeUtil';
import { normalizeMaterialName } from '../lib/wasteCompute';

/** 처음 화면이 비어 있으면 막막하니 흔한 분류를 제안만 해둔다 (강제 아님) */
const SUGGESTED = [
  '육류', '해산물', '가공품', '두부류', '잎채소류', '뿌리채소류',
  '작물류', '잡곡 및 견과류', '과일류', '조미료·양념', '유지류', '기타',
];

interface MatRef { key: string; code: string; name: string }

export default function MaterialCategoryPanel() {
  const [docs, setDocs] = useState<CategoryDoc[]>([]);
  const [mats, setMats] = useState<MatRef[]>([]);
  const [loadingMats, setLoadingMats] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyUnset, setOnlyUnset] = useState(true);
  const [newCat, setNewCat] = useState('');

  useEffect(() => onSnapshot(collection(db, 'materialCategories'), (snap) => {
    const list: CategoryDoc[] = [];
    snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<CategoryDoc, 'id'>) }));
    setDocs(list);
  }), []);

  /** 재고평가현황(=ERP 원재료 마스터)에서 원재료 목록을 한 번만 읽어온다 */
  const loadMaterials = async () => {
    setLoadingMats(true);
    try {
      const snap = await getDocs(collection(db, 'materialPricesInventory'));
      const map = new Map<string, MatRef>();
      snap.forEach((d) => {
        const v = d.data() as { name?: string; code?: string };
        const name = (v.name || '').trim();
        const code = (v.code || '').trim();
        if (!name && !code) return;
        const key = code ? `c_${normalizeCode(code)}` : `n_${normalizeMaterialName(name)}`;
        if (!map.has(key)) map.set(key, { key, code, name });
      });
      setMats([...map.values()].sort((a, b) => a.name.localeCompare(b.name)));
    } finally { setLoadingMats(false); }
  };

  const byId = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);

  /** 등록된 카테고리 이름 (사용 건수와 함께) */
  const cats = useMemo(() => {
    const m = new Map<string, number>();
    docs.forEach((d) => { const c = (d.category || '').trim(); if (c) m.set(c, (m.get(c) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [docs]);
  const catNames = useMemo(() => {
    const s = new Set(cats.map((c) => c[0]));
    SUGGESTED.forEach((c) => s.add(c));
    return [...s];
  }, [cats]);

  const preview = useMemo(() => (text.trim() ? parseCategoryPaste(text) : { rows: [], errors: [] }), [text]);

  const savePaste = async () => {
    if (preview.rows.length === 0) return;
    setSaving(true);
    try {
      const CHUNK = 400;
      for (let i = 0; i < preview.rows.length; i += CHUNK) {
        const batch = writeBatch(db);
        preview.rows.slice(i, i + CHUNK).forEach((r) => {
          batch.set(doc(db, 'materialCategories', categoryDocId(r.code, r.name)), {
            code: r.code, name: r.name, category: r.category,
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        });
        await batch.commit();
      }
      alert(`${preview.rows.length}건 저장했습니다`);
      setText('');
    } catch (e: any) {
      alert(`저장 실패: ${e?.message || e}`);
    } finally { setSaving(false); }
  };

  const setOne = async (m: MatRef, category: string) => {
    const id = categoryDocId(m.code, m.name);
    if (!category) { await deleteDoc(doc(db, 'materialCategories', id)).catch(() => {}); return; }
    await setDoc(doc(db, 'materialCategories', id), {
      code: m.code, name: m.name, category, updatedAt: new Date().toISOString(),
    }, { merge: true });
  };

  const view = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mats.filter((m) => {
      if (onlyUnset && byId.has(m.key)) return false;
      if (!q) return true;
      return m.name.toLowerCase().includes(q) || m.code.toLowerCase().includes(q);
    });
  }, [mats, search, onlyUnset, byId]);

  const unsetCount = mats.filter((m) => !byId.has(m.key)).length;

  return (
    <div className="space-y-3">
      <div className="bg-teal-50 border border-teal-200 rounded p-2.5 text-xs text-teal-900">
        원재료를 <b>ERP 코드 기준</b>으로 묶어 분석 화면의 <b>카테고리 타일</b>(육류·해산물·잎채소류 …)을 만듭니다.
        분류명은 <b>직접 정하시면 되고</b>, 아래 목록에 없는 이름을 입력해도 그대로 새 분류가 됩니다.<br />
        코드가 없는 원재료는 <b>이름으로 2차 매칭</b>합니다. 어느 쪽으로도 못 찾은 건 분석 화면에
        <b> ‘{UNCLASSIFIED}’ 타일</b>로 항상 표시되니, 빠뜨려도 숫자가 조용히 사라지진 않습니다.
      </div>

      {/* 등록된 분류 현황 */}
      <div className="border rounded p-2.5">
        <div className="text-xs font-semibold text-gray-700 mb-1.5">
          등록된 분류 {cats.length}종 · 원재료 {docs.length}건
        </div>
        {cats.length === 0 ? (
          <div className="text-xs text-gray-400">아직 없습니다. 아래에서 붙여넣거나 목록에서 지정하세요.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {cats.map(([c, n]) => (
              <span key={c} className="inline-flex items-center gap-1 bg-slate-100 text-slate-700 rounded-full px-2.5 py-0.5 text-xs">
                {c}<span className="text-slate-400">{n}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 붙여넣기 */}
      <div className="border rounded p-2.5 space-y-2">
        <div className="text-xs font-semibold text-gray-700">① 엑셀에서 붙여넣기</div>
        <div className="text-[11px] text-gray-500">
          <b>코드 / 원재료명 / 카테고리</b> 3열 (탭 구분). 2열이면 <b>(코드 또는 이름) / 카테고리</b> 로 읽습니다.
          첫 줄이 머리글이면 자동으로 건너뜁니다.
        </div>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'11320010\t한우(익,민찌)\t육류\n11510022\t아욱\t잎채소류'}
          className="w-full h-28 border rounded p-2 font-mono text-xs"
        />
        {preview.errors.length > 0 && (
          <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
            {preview.errors.slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
            {preview.errors.length > 5 && <div className="text-rose-500">외 {preview.errors.length - 5}건</div>}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={savePaste}
            disabled={saving || preview.rows.length === 0}
            className="bg-teal-600 text-white rounded px-3 py-1.5 text-sm disabled:bg-gray-300"
          >
            {saving ? '저장중...' : `${preview.rows.length}건 저장`}
          </button>
          {preview.rows.length > 0 && (
            <span className="text-xs text-gray-500">
              분류 {new Set(preview.rows.map((r) => r.category)).size}종
            </span>
          )}
        </div>
      </div>

      {/* 목록에서 지정 */}
      <div className="border rounded p-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs font-semibold text-gray-700">② 목록에서 지정 (재고평가현황 기준)</div>
          <button onClick={loadMaterials} disabled={loadingMats}
            className="text-xs border rounded px-2 py-1 hover:bg-gray-50 disabled:text-gray-400">
            {loadingMats ? '불러오는 중...' : mats.length ? '다시 불러오기' : '원재료 목록 불러오기'}
          </button>
        </div>

        {mats.length > 0 && (
          <>
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="원재료명·코드 검색" className="border rounded px-2 py-1 w-48" />
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={onlyUnset} onChange={(e) => setOnlyUnset(e.target.checked)} />
                미지정만 보기
              </label>
              <span className={unsetCount > 0 ? 'text-rose-600 font-semibold' : 'text-emerald-600'}>
                미지정 {unsetCount}건 / 전체 {mats.length}건
              </span>
              <input value={newCat} onChange={(e) => setNewCat(e.target.value)}
                placeholder="새 분류명 (선택 후 일괄지정용)" className="border rounded px-2 py-1 w-52" />
            </div>
            <div className="max-h-96 overflow-auto border rounded">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr className="text-gray-600">
                    <th className="px-2 py-1.5 text-left w-28">코드</th>
                    <th className="px-2 py-1.5 text-left">원재료명</th>
                    <th className="px-2 py-1.5 text-left w-56">카테고리</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {view.slice(0, 400).map((m) => {
                    const cur = byId.get(m.key)?.category || '';
                    return (
                      <tr key={m.key} className="hover:bg-slate-50">
                        <td className="px-2 py-1 font-mono text-gray-500">{m.code || '—'}</td>
                        <td className="px-2 py-1 text-gray-800">{m.name}</td>
                        <td className="px-2 py-1">
                          <div className="flex items-center gap-1">
                            <select
                              value={catNames.includes(cur) ? cur : (cur ? '__other__' : '')}
                              onChange={(e) => { if (e.target.value !== '__other__') setOne(m, e.target.value); }}
                              className={`border rounded px-1.5 py-0.5 w-40 ${cur ? 'text-gray-800' : 'text-gray-400'}`}
                            >
                              <option value="">— 미지정 —</option>
                              {catNames.map((c) => <option key={c} value={c}>{c}</option>)}
                              {cur && !catNames.includes(cur) && <option value="__other__">{cur}</option>}
                            </select>
                            {newCat.trim() && (
                              <button onClick={() => setOne(m, newCat.trim())}
                                title={`'${newCat.trim()}' 로 지정`}
                                className="text-teal-700 border border-teal-300 rounded px-1.5 py-0.5 hover:bg-teal-50">
                                ←
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {view.length > 400 && (
                <div className="text-[11px] text-gray-400 px-2 py-1.5">
                  {view.length}건 중 400건만 표시했습니다. 검색으로 좁혀주세요.
                </div>
              )}
              {view.length === 0 && (
                <div className="text-xs text-emerald-700 px-2 py-3 text-center">
                  {onlyUnset ? '미지정 원재료가 없습니다 👍' : '검색 결과가 없습니다'}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
