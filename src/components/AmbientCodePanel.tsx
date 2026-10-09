/** 설정 › 실온이유식 품목코드 연결 — ERP 품목코드를 실온 레시피(현장 + 분석용)에 한 번에 넣는다.
 *  붙여넣기: 품목코드 / ERP 품목명 ([베본]실완_한우야채진밥 처럼). 브랜드·단계 접두어를 떼고 이름으로 자동 매칭. */
import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { matchAmbCodes, parseAmbCodes } from '../lib/ambientCode';
import type { AmbRecipeRef } from '../lib/ambientCode';

export default function AmbientCodePanel() {
  const [field, setField] = useState<AmbRecipeRef[]>([]);     // 현장 실온 레시피
  const [yieldDb, setYieldDb] = useState<AmbRecipeRef[]>([]); // 분석용 실온 레시피
  const [text, setText] = useState('');
  const [pick, setPick] = useState<Record<number, string>>({});   // 줄번호 → 직접 고른 레시피 ID ('' = 연결 안 함)
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => onSnapshot(collection(db, 'ambientRecipes'), (s) =>
    setField(s.docs.map((d) => ({ id: d.id, name: (d.data() as any).name || d.id, code: (d.data() as any).code || '' })))), []);
  useEffect(() => onSnapshot(collection(db, 'ambientRecipesYield'), (s) =>
    setYieldDb(s.docs.map((d) => ({ id: d.id, name: (d.data() as any).name || d.id, code: (d.data() as any).code || '' })))), []);

  // 후보는 현장 + 분석용 레시피를 합친 이름 목록 (문서 ID 가 같으면 같은 제품)
  const recipes = useMemo(() => {
    const m = new Map<string, AmbRecipeRef>();
    [...field, ...yieldDb].forEach((r) => { if (!m.has(r.id)) m.set(r.id, r); });
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [field, yieldDb]);
  const rows = useMemo(() => matchAmbCodes(parseAmbCodes(text), recipes), [text, recipes]);
  const eff = (r: { line: number; recipeId: string | null }) => (r.line in pick ? pick[r.line] || null : r.recipeId);
  const nameOf = (id: string) => recipes.find((x) => x.id === id)?.name || id;
  const codeNow = (id: string) => field.find((x) => x.id === id)?.code || yieldDb.find((x) => x.id === id)?.code || '';

  const linked = rows.filter((r) => eff(r));
  // 한 레시피에 코드가 둘 이상 붙으면 마지막 것만 남는다 — 미리 알린다
  const dupRecipe = (() => {
    const c = new Map<string, string[]>();
    linked.forEach((r) => c.set(eff(r)!, [...(c.get(eff(r)!) || []), r.code]));
    return [...c].filter(([, v]) => v.length > 1);
  })();

  const save = async () => {
    if (linked.length === 0) return;
    const changes = linked.filter((r) => codeNow(eff(r)!) && codeNow(eff(r)!) !== r.code);
    if (changes.length > 0 && !confirm(`이미 다른 코드가 들어 있는 레시피 ${changes.length}개를 새 코드로 바꿉니다:\n${changes.slice(0, 6).map((r) => `${nameOf(eff(r)!)}: ${codeNow(eff(r)!)} → ${r.code}`).join('\n')}\n\n진행할까요?`)) return;
    setBusy(true); setMsg(null);
    try {
      const fieldIds = new Set(field.map((x) => x.id));
      const yieldIds = new Set(yieldDb.map((x) => x.id));
      const writes: Promise<void>[] = [];
      linked.forEach((r) => {
        const id = eff(r)!;
        if (fieldIds.has(id)) writes.push(updateDoc(doc(db, 'ambientRecipes', id), { code: r.code }));
        if (yieldIds.has(id)) writes.push(updateDoc(doc(db, 'ambientRecipesYield', id), { code: r.code }));
      });
      const res = await Promise.allSettled(writes);
      const bad = res.filter((x) => x.status === 'rejected').length;
      setMsg(bad === 0
        ? `✅ ${linked.length}개 제품에 품목코드 저장 (현장 실온 레시피 + 분석용 실온 레시피)`
        : `⚠ ${bad}건 저장 실패 — 다시 눌러 주세요`);
      if (bad === 0) { setText(''); setPick({}); }
    } finally { setBusy(false); }
  };

  const noCode = recipes.filter((r) => !codeNow(r.id));

  return (
    <div className="space-y-3">
      <div className="bg-teal-50 border border-teal-200 rounded p-2.5 text-xs text-teal-900 leading-relaxed">
        ERP 의 <b>품목코드 / 품목명</b> 두 칸을 붙여넣으면 실온 레시피와 이름으로 자동 연결해 <b>현장 실온 레시피와 분석용 실온 레시피 둘 다</b>에 코드를 넣습니다.<br />
        · 이름에서 <b>[베본]·[본키]</b> 와 <b>실완_ · 실후_ · 실중_ · 실_</b> 를 떼고 비교합니다 ([베본]→순수본, [본키]→본죽키즈, TOGO 는 그대로).<br />
        · 넣어 두면 「월별 생산수량」 에 SSB 코드로 붙여넣어도 실온 제품으로 연결됩니다.
      </div>
      <textarea value={text} onChange={(e) => { setText(e.target.value); setPick({}); setMsg(null); }} rows={6}
        placeholder={'SSB55130016\t[베본]실완_한우야채진밥\nSSB55120054\t[본키]실_한우야채죽'} className="w-full border rounded p-2 font-mono text-xs" />
      {rows.length > 0 && (
        <>
          <div className="flex items-center gap-3 flex-wrap text-sm">
            <span>연결 <b className="text-emerald-700">{linked.length}</b> / {rows.length}</span>
            {rows.length - linked.length > 0 && <span className="text-rose-700 font-bold">못 찾음 {rows.length - linked.length}</span>}
            {dupRecipe.length > 0 && <span className="text-amber-700">⚠ 한 레시피에 코드 여러 개: {dupRecipe.map(([id, cs]) => `${nameOf(id)}(${cs.join(', ')})`).join(' · ')} — 마지막 코드만 남습니다</span>}
            <button onClick={save} disabled={busy || linked.length === 0}
              className="ml-auto px-4 py-2 bg-teal-600 text-white rounded font-bold disabled:bg-gray-300">{busy ? '저장 중…' : `품목코드 저장 (${linked.length}개)`}</button>
          </div>
          <div className="border rounded max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0 text-gray-600">
                <tr><th className="px-2 py-1 text-left">품목코드</th><th className="px-2 py-1 text-left">ERP 품목명</th><th className="px-2 py-1 text-left">→ 실온 레시피</th><th className="px-2 py-1 text-left">지금 코드</th></tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => {
                  const id = eff(r);
                  const cur = id ? codeNow(id) : '';
                  return (
                    <tr key={r.line} className={!id ? 'bg-rose-50' : ''}>
                      <td className="px-2 py-1 font-mono font-bold">{r.code}</td>
                      <td className="px-2 py-1">{r.erpName}</td>
                      <td className="px-2 py-1">
                        <select value={id || ''} onChange={(e) => setPick({ ...pick, [r.line]: e.target.value })}
                          className={`border rounded px-1.5 py-0.5 w-64 ${!id ? 'border-rose-400 text-rose-700' : ''}`}>
                          <option value="">— 연결 안 함 —</option>
                          {recipes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                        {!id && r.why && <div className="text-[10px] text-rose-600 mt-0.5">{r.why}</div>}
                      </td>
                      <td className="px-2 py-1 font-mono">{cur ? (cur === r.code ? <span className="text-emerald-700">✔ 같음</span> : <span className="text-amber-700">{cur} → 바뀜</span>) : <span className="text-gray-400">없음</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {msg && <div className={`text-sm rounded px-3 py-2 ${msg.startsWith('✅') ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>{msg}</div>}
      <div className="text-xs text-gray-600">
        <b>코드 없는 실온 레시피 {noCode.length}개</b>{noCode.length > 0 && `: ${noCode.map((r) => r.name).join(', ')}`}
      </div>
    </div>
  );
}
