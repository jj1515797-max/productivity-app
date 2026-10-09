/** 설정 › 월별 생산수량 (원재료수율 분석용)
 *  앱을 쓰기 전 달(작년 등)의 마감 기준 품목별 생산수량을 월 단위로 붙여넣는다.
 *  원재료수율 분석은 앱 생산 데이터가 없는 달에만 이 값을 쓴다. 날짜별 생산 화면과는 섞지 않는다. */
import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, deleteDoc, doc, getDocs, limit, onSnapshot, query, setDoc, where } from 'firebase/firestore';
import { db } from '../firebase';
import { canonicalShort } from '../lib/codeUtil';
import { PM_COL, ambientKey, parseProductionPaste, toDoc } from '../lib/productionMonthly';
import type { ProductionMonthlyDoc } from '../lib/productionMonthly';

const prevMonth = () => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear() - 1}-${String(d.getMonth() + 1).padStart(2, '0')}`;   // 기본: 작년 같은 달 쯤
};
const shiftM = (m: string, n: number) => {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export default function ProductionMonthlyPanel() {
  const [month, setMonth] = useState(prevMonth);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState<ProductionMonthlyDoc[]>([]);
  const [coldKeys, setColdKeys] = useState<Set<string> | null>(null);
  const [ambKeys, setAmbKeys] = useState<Set<string> | null>(null);
  // 실온 ERP 품목코드(SSB…) → 실온 레시피 제품명 (설정 › 실온이유식 품목코드 연결에서 넣은 것)
  const [ambCode, setAmbCode] = useState<Map<string, string>>(new Map());
  const [appHasData, setAppHasData] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => onSnapshot(collection(db, PM_COL), (s) => {
    const a: ProductionMonthlyDoc[] = [];
    s.forEach((d) => a.push(d.data() as ProductionMonthlyDoc));
    setSaved(a.sort((x, y) => y.month.localeCompare(x.month)));
  }), []);

  // 레시피 연결 확인용 — 원재료수율 분석과 같은 우선순위 (분석용 레시피가 있으면 그것, 없으면 현장 레시피)
  useEffect(() => {
    (async () => {
      const [ry, r, ay, a] = await Promise.all([
        getDocs(collection(db, 'recipesYield')), getDocs(collection(db, 'recipes')),
        getDocs(collection(db, 'ambientRecipesYield')), getDocs(collection(db, 'ambientRecipes')),
      ]);
      const cold = new Set<string>();
      (ry.size > 0 ? ry : r).forEach((d) => { const v = d.data() as { code?: string }; const k = canonicalShort(v.code || d.id); if (k) cold.add(k); });
      const amb = new Set<string>();
      (ay.size > 0 ? ay : a).forEach((d) => { const v = d.data() as { name?: string }; amb.add(d.id); if (v.name) amb.add(ambientKey(v.name)); });
      const codes = new Map<string, string>();
      [a, ay].forEach((col) => col.forEach((d) => {
        const v = d.data() as { name?: string; code?: string };
        if (v.code && !codes.has(v.code.trim().toUpperCase())) codes.set(v.code.trim().toUpperCase(), v.name || d.id);
      }));
      setAmbCode(codes);
      setColdKeys(cold); setAmbKeys(amb);
    })().catch(() => { setColdKeys(new Set()); setAmbKeys(new Set()); });
  }, []);

  // 그 달에 앱 생산 데이터가 있나 — 있으면 수율분석은 앱 데이터를 쓴다는 걸 미리 알려 준다
  useEffect(() => {
    setAppHasData(null);
    getDocs(query(collectionGroup(db, 'items'), where('date', '>=', `${month}-01`), where('date', '<=', `${month}-31`), limit(1)))
      .then((s) => setAppHasData(!s.empty)).catch(() => setAppHasData(false));
  }, [month]);

  const parsed = useMemo(() => {
    const p0 = parseProductionPaste(text);
    // SSB… 처럼 실온 품목코드로 붙여넣은 줄 → 그 코드가 연결된 실온 레시피 제품명으로 바꾼다
    return { ...p0, rows: p0.rows.map((r) => {
      const nm = r.kind === 'ambient' ? ambCode.get(r.raw.trim().toUpperCase()) : undefined;
      return nm ? { ...r, raw: nm, name: nm, key: ambientKey(nm) } : r;
    }) };
  }, [text, ambCode]);
  const docPreview = useMemo(() => (parsed.rows.length ? toDoc(month, parsed.rows) : null), [parsed, month]);
  const matchOf = (kind: 'cold' | 'ambient', key: string) =>
    kind === 'cold' ? (coldKeys ? coldKeys.has(key) : null) : (ambKeys ? ambKeys.has(key) : null);
  const rowsAgg = useMemo(() => {
    if (!docPreview) return [];
    return [
      ...Object.entries(docPreview.cold).map(([k, q]) => ({ kind: 'cold' as const, key: k, name: docPreview.names[k] || '', qty: q })),
      ...Object.entries(docPreview.ambient).map(([k, q]) => ({ kind: 'ambient' as const, key: k, name: docPreview.names[k] || k, qty: q })),
    ];
  }, [docPreview]);
  const unmatched = rowsAgg.filter((r) => matchOf(r.kind, r.key) === false);
  const unmatchedQty = unmatched.reduce((s, r) => s + r.qty, 0);
  const existing = saved.find((x) => x.month === month);

  const save = async () => {
    if (!docPreview) return;
    if (existing && !confirm(`${month} 에 이미 저장된 수량(${existing.total.toLocaleString()}개)이 있습니다. 새 값으로 바꿀까요?`)) return;
    setBusy(true); setMsg(null);
    try {
      await setDoc(doc(db, PM_COL, month), docPreview);
      setMsg(`✅ ${month} 저장 — ${rowsAgg.length}품목 · ${docPreview.total.toLocaleString()}개`);
      setText('');
    } catch (e: any) {
      setMsg(`⚠ 저장 실패: ${e?.message || e}`);
    } finally { setBusy(false); }
  };
  const remove = async (m: string) => {
    if (!confirm(`${m} 월별 생산수량을 지울까요?`)) return;
    await deleteDoc(doc(db, PM_COL, m));
  };

  return (
    <div className="space-y-3">
      <div className="bg-teal-50 border border-teal-200 rounded p-2.5 text-xs text-teal-900 leading-relaxed">
        앱을 쓰기 전 달(작년 등)의 <b>마감 기준 품목별 생산수량</b>을 월 단위로 넣습니다. <b>원재료수율 분석 전용</b>입니다.<br />
        · 원재료수율 분석은 <b>앱 생산 데이터가 없는 달에만</b> 이 값을 씁니다 (앱 데이터가 있는 달은 지금과 똑같이 앱 데이터).<br />
        · 형식: <b>코드 / (품목명) / 생산수량</b> — 엑셀에서 복사해 붙여넣기. 머리글은 자동으로 건너뜁니다. A-001-01 같은 ERP 코드도 됩니다.<br />
        · 실온이유식은 <b>SSB 품목코드</b>(설정 › 실온이유식 품목코드 연결에 넣어 둔 것) 또는 <b>제품명</b>(예: TOGO_한우야채진밥)을 첫 칸에 넣으세요. 같은 코드가 여러 줄이면 합칩니다.
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <b className="text-sm">월</b>
        <button onClick={() => setMonth(shiftM(month, -1))} className="px-2 py-1 border rounded">◀</button>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="border rounded px-2 py-1 font-mono" />
        <button onClick={() => setMonth(shiftM(month, 1))} className="px-2 py-1 border rounded">▶</button>
        {existing && <span className="text-xs bg-blue-50 text-blue-800 border border-blue-200 rounded px-2 py-0.5">저장됨 {existing.total.toLocaleString()}개 · {existing.rows}줄</span>}
        {appHasData === true && <span className="text-xs bg-amber-50 text-amber-800 border border-amber-300 rounded px-2 py-0.5">⚠ 이 달은 앱 생산 데이터가 있어 수율분석은 앱 데이터를 씁니다 (넣어도 참고용)</span>}
      </div>

      <textarea value={text} onChange={(e) => { setText(e.target.value); setMsg(null); }} rows={8}
        placeholder={'품목코드\t품목명\t생산수량\nF-553-01\t설렁탕\t1,234\nA-001-01\t순수쌀미음\t500\nTOGO_한우야채진밥\t\t320'}
        className="w-full border rounded p-2 font-mono text-xs" />
      {parsed.errors.length > 0 && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
          {parsed.errors.slice(0, 5).map((e) => <div key={e}>{e}</div>)}{parsed.errors.length > 5 && <div>외 {parsed.errors.length - 5}건</div>}
        </div>
      )}

      {docPreview && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 flex-wrap text-sm">
            <span><b>{rowsAgg.length}</b>품목 · 합계 <b>{docPreview.total.toLocaleString()}</b>개</span>
            <span className="text-gray-500">냉장 {Object.keys(docPreview.cold).length} · 실온 {Object.keys(docPreview.ambient).length}</span>
            {!coldKeys ? <span className="text-gray-500">레시피 연결 확인 중… (몇 초 걸립니다)</span>
              : unmatched.length > 0
              ? <span className="text-rose-700 font-bold">레시피 없음 {unmatched.length}품목 ({unmatchedQty.toLocaleString()}개) — 표준소요에서 빠집니다</span>
              : coldKeys && <span className="text-emerald-700 font-bold">✔ 전 품목 레시피 연결됨</span>}
            <button onClick={save} disabled={busy}
              className="ml-auto px-4 py-2 bg-teal-600 text-white rounded font-bold disabled:bg-gray-300">
              {busy ? '저장 중…' : `${month} 로 저장`}
            </button>
          </div>
          <div className="border rounded max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0 text-gray-600">
                <tr><th className="px-2 py-1 text-left">코드 / 제품</th><th className="px-2 py-1 text-left">품목명</th><th className="px-2 py-1 text-left">구분</th><th className="px-2 py-1 text-right">생산수량</th><th className="px-2 py-1 text-left">레시피</th></tr>
              </thead>
              <tbody className="divide-y">
                {[...rowsAgg].sort((a, b) => Number(matchOf(a.kind, a.key) !== false) - Number(matchOf(b.kind, b.key) !== false) || a.key.localeCompare(b.key)).map((r) => {
                  const m = matchOf(r.kind, r.key);
                  return (
                    <tr key={r.kind + r.key} className={m === false ? 'bg-rose-50' : ''}>
                      <td className="px-2 py-1 font-mono font-bold">{r.kind === 'cold' ? r.key : r.name}</td>
                      <td className="px-2 py-1 text-gray-600">{r.kind === 'cold' ? r.name : ''}</td>
                      <td className="px-2 py-1">{r.kind === 'cold' ? '냉장' : '실온'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{r.qty.toLocaleString()}</td>
                      <td className="px-2 py-1">{m === null ? '…' : m ? <span className="text-emerald-700">✔</span> : <span className="text-rose-700 font-bold">없음</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {msg && <div className={`text-sm rounded px-3 py-2 ${msg.startsWith('✅') ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>{msg}</div>}

      <div>
        <div className="text-sm font-bold text-gray-700 mb-1">저장된 달 <span className="font-normal text-gray-500">{saved.length}개월</span></div>
        {saved.length === 0 ? <div className="text-xs text-gray-400">아직 없습니다</div> : (
          <div className="flex flex-wrap gap-2">
            {saved.map((x) => (
              <span key={x.month} className={`inline-flex items-center gap-2 border rounded-lg px-2.5 py-1 text-sm ${x.month === month ? 'border-teal-500 bg-teal-50' : 'bg-white'}`}>
                <button onClick={() => setMonth(x.month)} className="font-mono font-bold">{x.month}</button>
                <span className="text-gray-500 text-xs">{x.total.toLocaleString()}개</span>
                <button onClick={() => remove(x.month)} className="text-rose-500 text-xs" title="지우기">✕</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
