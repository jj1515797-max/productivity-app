import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { AMBIENT_CATEGORIES, AMBIENT_PRODUCTS, CATEGORY_STYLES, productSlug } from '../lib/ambientProducts';
import type { AmbientEntry } from '../types';

export default function AmbientInputModal({
  open, onClose, defaultDate,
}: { open: boolean; onClose: () => void; defaultDate: string }) {
  const [date, setDate] = useState(defaultDate);
  const [entries, setEntries] = useState<(AmbientEntry & { docId: string })[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [qty, setQty] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => { if (open) setDate(defaultDate); }, [open, defaultDate]);

  useEffect(() => {
    if (!open) return;
    return onSnapshot(collection(db, 'days', date, 'ambient'), (snap) => {
      const list: (AmbientEntry & { docId: string })[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as AmbientEntry), docId: d.id }));
      list.sort((a, b) => a.productName.localeCompare(b.productName));
      setEntries(list);
    });
  }, [open, date]);

  const grouped = useMemo(() => {
    const g: Record<string, typeof AMBIENT_PRODUCTS> = {};
    AMBIENT_CATEGORIES.forEach((c) => { g[c] = []; });
    AMBIENT_PRODUCTS.forEach((p) => { g[p.category].push(p); });
    return g;
  }, []);

  const totalEntries = entries.reduce((s, e) => s + (e.qty || 0), 0);

  const save = async () => {
    if (!selected || qty <= 0) return;
    setSaving(true);
    try {
      const product = AMBIENT_PRODUCTS.find((p) => p.name === selected);
      if (!product) return;
      const slug = productSlug(selected);
      const existing = entries.find((e) => e.productName === selected);
      const newQty = (existing?.qty || 0) + qty;
      await setDoc(doc(db, 'days', date, 'ambient', slug), {
        productName: selected,
        category: product.category,
        qty: newQty,
        date,
      });
      setQty(0);
      setSelected(null);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (docId: string, name: string) => {
    if (!confirm(`'${name}' 기록을 삭제할까요?`)) return;
    await deleteDoc(doc(db, 'days', date, 'ambient', docId));
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b flex items-center justify-between bg-gradient-to-r from-orange-50 to-amber-50">
          <div>
            <h3 className="text-lg font-bold text-gray-800">상온 생산량 입력</h3>
            <div className="text-xs text-gray-500 mt-0.5">제품 카테고리는 자동으로 분류됩니다</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-gray-200 text-gray-500 text-lg" aria-label="닫기">×</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-6 py-5 space-y-5">
            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-sm font-medium text-gray-700">날짜</label>
              <input
                type="date"
                value={date}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                className="border rounded px-3 py-1.5 text-sm"
              />
              <div className="relative flex-1 min-w-[220px]">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="🔍 품목 검색..."
                  className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm"
                    aria-label="검색어 지우기"
                  >×</button>
                )}
              </div>
              <span className="text-sm text-gray-600 whitespace-nowrap">
                <span className="font-semibold text-gray-800">{entries.length}</span>개 품목 / 총
                <span className="font-bold text-orange-600 ml-1">{totalEntries.toLocaleString()}</span> EA
              </span>
            </div>

            {entries.length > 0 && (
              <div className="border rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-slate-50 border-b text-xs font-semibold text-gray-700">기 입력 내역</div>
                <table className="w-full text-sm">
                  <tbody>
                    {entries.map((e) => {
                      const cat = (e.category || '순수본') as keyof typeof CATEGORY_STYLES;
                      const style = CATEGORY_STYLES[cat] || CATEGORY_STYLES['순수본'];
                      return (
                        <tr key={e.docId} className="border-t">
                          <td className="px-3 py-2">
                            <span className={`inline-block w-2 h-2 rounded-full ${style.chip} mr-2 align-middle`} />
                            <span className="text-xs text-gray-500 mr-2">{e.category}</span>
                            <span className="font-medium">{e.productName}</span>
                          </td>
                          <td className="px-3 py-2 text-right font-bold text-orange-700 w-24">{(e.qty || 0).toLocaleString()} EA</td>
                          <td className="px-3 py-2 text-right w-16">
                            <button onClick={() => remove(e.docId, e.productName)} className="text-xs text-red-500 hover:underline">삭제</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="space-y-4">
              <div className="text-sm font-semibold text-gray-700">제품 선택</div>
              {AMBIENT_CATEGORIES.map((cat) => {
                const style = CATEGORY_STYLES[cat];
                const allList = grouped[cat] || [];
                const list = search
                  ? allList.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
                  : allList;
                if (allList.length === 0) return null;
                if (search && list.length === 0) return null;
                return (
                  <div key={cat}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`inline-block w-3 h-3 rounded-full ${style.chip}`} />
                      <span className="text-xs font-bold text-gray-600">{cat}</span>
                      <span className="text-xs text-gray-400">({list.length}{search && ` / ${allList.length}`})</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {list.map((p) => {
                        const active = selected === p.name;
                        const has = entries.some((e) => e.productName === p.name);
                        return (
                          <button
                            key={p.name}
                            onClick={() => setSelected(p.name)}
                            className={`text-left px-3 py-2 rounded-md border text-sm transition ${
                              active
                                ? 'bg-orange-500 text-white border-orange-500 shadow'
                                : `${style.soft} ${style.text} ${style.border} hover:brightness-95`
                            }`}
                          >
                            <div className="text-xs leading-tight">{p.name.replace(`${cat}_`, '').replace('순수본_', '')}</div>
                            {has && !active && <div className="text-[10px] mt-0.5 text-gray-500">기 입력</div>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {search && AMBIENT_CATEGORIES.every((cat) => {
                const all = grouped[cat] || [];
                return all.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())).length === 0;
              }) && (
                <div className="text-center text-sm text-gray-400 py-8">
                  '{search}' 검색 결과가 없습니다
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t bg-slate-50 px-6 py-4 flex items-center gap-3 flex-wrap">
          {selected ? (
            <>
              <span className="text-sm text-gray-600">선택:</span>
              <span className="text-sm font-bold text-gray-800">{selected}</span>
              <div className="flex items-center gap-2 ml-auto">
                <button
                  onClick={() => setQty(Math.max(0, qty - 10))}
                  className="w-10 h-10 border rounded text-lg hover:bg-gray-100"
                >−</button>
                <input
                  type="number"
                  value={qty || ''}
                  onChange={(e) => setQty(Number(e.target.value) || 0)}
                  placeholder="수량"
                  className="w-28 border rounded px-3 py-2 text-center font-bold"
                />
                <button
                  onClick={() => setQty(qty + 10)}
                  className="w-10 h-10 border rounded text-lg hover:bg-gray-100"
                >+</button>
                <button
                  onClick={save}
                  disabled={qty <= 0 || saving}
                  className="px-5 py-2 bg-orange-600 text-white rounded font-medium hover:bg-orange-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {saving ? '저장중...' : '추가'}
                </button>
              </div>
            </>
          ) : (
            <span className="text-sm text-gray-500">위에서 제품을 선택하세요</span>
          )}
          <button onClick={onClose} className="px-4 py-2 border rounded text-sm font-medium text-gray-700 hover:bg-gray-100 ml-auto">
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
