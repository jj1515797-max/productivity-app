/** 개발 배합비 시트 → 분석용 레시피(recipesYield) 변환기
 *
 *  개발에서 받은 배합비 %는 수율을 안 먹인 순수 배합이라 원재료수율 분석에 딱 맞다.
 *  다만 ERP 코드가 없고 이름 표기가 제각각이라 그대로는 못 쓴다.
 *  기존 BOM(recipes)을 '참조만' 해서 코드를 채워준다.
 *
 *  · 저장 대상은 recipesYield 뿐이다. 현장 BOM(recipes)은 절대 건드리지 않는다.
 *  · 개발이 쪼개 놓은 줄은 합치지 않는다. 준 그대로 저장한다.
 *  · 애매한 매칭은 조용히 확정하지 않고 화면에 띄워 사람이 고르게 한다.
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { canonicalShort, normalizeCode } from '../lib/codeUtil';
import {
  BomIndex, BomIngredient, MasterIngredient, ProductReport, ResolvedRow,
  parseDevSheet, resolveSheet,
} from '../lib/devRecipeMatch';

const KIND_LABEL: Record<string, { t: string; cls: string }> = {
  exact:    { t: '완전일치',  cls: 'bg-emerald-100 text-emerald-800' },
  clean:    { t: '표기차',    cls: 'bg-emerald-50 text-emerald-700' },
  contains: { t: '포함관계',  cls: 'bg-amber-100 text-amber-800' },
  fuzzy:    { t: '유사',      cls: 'bg-amber-100 text-amber-800' },
  master:   { t: 'ERP 마스터', cls: 'bg-sky-100 text-sky-800' },
  leftover: { t: '잔여배정',  cls: 'bg-purple-100 text-purple-800' },
  none:     { t: '못 찾음',   cls: 'bg-rose-100 text-rose-800' },
};

interface Override { code: string; name: string }

export default function DevRecipeImport() {
  const [text, setText] = useState('');
  const [bom, setBom] = useState<BomIndex>(new Map());
  const [master, setMaster] = useState<MasterIngredient[]>([]);
  const [packW, setPackW] = useState<Map<string, number>>(new Map());
  const [prodName, setProdName] = useState<Map<string, string>>(new Map());
  const [docIdOf, setDocIdOf] = useState<Map<string, string>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [onlyReview, setOnlyReview] = useState(true);
  const [ov, setOv] = useState<Record<string, Override>>({});   // 행키 → 사람이 고른 값
  const [mFilter, setMFilter] = useState<Record<string, string>>({});   // 목록 검색어
  const [mCode, setMCode] = useState<Record<string, string>>({});       // ERP 코드 직접 입력
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  /** 기존 BOM·제품 DB 를 읽어온다 (읽기 전용) */
  const load = async () => {
    setLoading(true);
    try {
      // 정제수처럼 '배합비엔 있고 현장 BOM 엔 없는' 원재료가 있다.
      // BOM 만 후보로 쓰면 영원히 못 찾으므로 ERP 코드 마스터까지 읽는다.
      const [rs, ps, erp, inv] = await Promise.all([
        getDocs(collection(db, 'recipes')),
        getDocs(collection(db, 'productSettings')),
        getDocs(collection(db, 'materialErpCodes')).catch(() => null),
        getDocs(collection(db, 'materialPricesInventory')).catch(() => null),
      ]);
      const b: BomIndex = new Map();
      const useCount = new Map<string, { name: string; code: string; uses: number }>();
      const idMap = new Map<string, string>();
      rs.forEach((d) => {
        const v = d.data() as { code?: string; name?: string; ingredients?: { name: string; code?: string }[] };
        const short = canonicalShort(v.code || d.id);
        if (!short) return;
        idMap.set(short, d.id);
        const list: BomIngredient[] = (v.ingredients || []).map((i) => ({ name: i.name, code: i.code }));
        b.set(short, [...(b.get(short) || []), ...list]);
        list.forEach((i) => {
          const c = normalizeCode(i.code || '');
          if (!c) return;
          const e = useCount.get(c) || { name: i.name, code: c, uses: 0 };
          e.uses++; useCount.set(c, e);
        });
      });
      const pw = new Map<string, number>();
      const pn = new Map<string, string>();
      ps.forEach((d) => {
        const v = d.data() as { code?: string; name?: string; packWeight?: number };
        const short = canonicalShort(v.code || d.id);
        if (!short) return;
        if (typeof v.packWeight === 'number' && v.packWeight > 0) pw.set(short, v.packWeight);
        if (v.name) pn.set(short, v.name);
      });
      // BOM 에서 모은 것 + ERP 코드 마스터 + 재고평가현황. 코드 기준으로 합친다.
      const all = new Map<string, MasterIngredient>();
      useCount.forEach((v, c) => all.set(c, { name: v.name, code: c, uses: v.uses, src: 'bom' }));
      const addExt = (code?: string, name?: string) => {
        const c = normalizeCode(code || '');
        if (!c || !name) return;
        const e = all.get(c);
        if (e) { if (!e.name) e.name = name; return; }   // BOM 이름을 우선한다
        all.set(c, { name, code: c, uses: 0, src: 'erp' });
      };
      erp?.forEach((d) => { const v = d.data() as { code?: string; name?: string }; addExt(v.code || d.id, v.name); });
      inv?.forEach((d) => { const v = d.data() as { code?: string; name?: string }; addExt(v.code, v.name); });
      setBom(b);
      setMaster([...all.values()].sort((a, x) => x.uses - a.uses || a.name.localeCompare(x.name)));
      setPackW(pw); setProdName(pn); setDocIdOf(idMap); setLoaded(true);
    } catch (e: any) {
      alert(`기존 DB 를 읽지 못했습니다: ${e?.message || e}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const parsed = useMemo(() => (text.trim() ? parseDevSheet(text) : { rows: [], errors: [], headerUsed: false }), [text]);

  const reports: ProductReport[] = useMemo(() => {
    if (!loaded || parsed.rows.length === 0) return [];
    return resolveSheet(
      parsed.rows, bom, master,
      (short) => packW.get(short) ?? null,
      (short) => prodName.get(short) || '',
    );
  }, [parsed, bom, master, packW, prodName, loaded]);

  const rowKey = (p: ProductReport, r: ResolvedRow, i: number) => `${p.short}|${i}|${r.rawName}`;
  const effOf = (p: ProductReport, r: ResolvedRow, i: number) => {
    const o = ov[rowKey(p, r, i)];
    return o ? { code: o.code, name: o.name, manual: true } : { code: r.match.code, name: r.match.name, manual: false };
  };

  const stat = useMemo(() => {
    let total = 0, auto = 0, review = 0, unresolved = 0, manual = 0;
    reports.forEach((p) => p.rows.forEach((r, i) => {
      total++;
      const e = effOf(p, r, i);
      if (e.manual) { manual++; return; }
      if (!e.code) unresolved++;
      else if (r.match.needsReview) review++;
      else auto++;
    }));
    return { total, auto, review, unresolved, manual, prods: reports.length };
  }, [reports, ov]);

  const canSave = reports.length > 0 && stat.unresolved === 0
    && reports.every((p) => p.packWeight !== null);

  const save = async () => {
    if (!canSave) return;
    const noCode = reports.flatMap((p) => p.rows.map((r, i) => effOf(p, r, i)).filter((e) => !e.code));
    if (noCode.length > 0) { alert(`ERP 코드가 비어 있는 행이 ${noCode.length}건 있습니다.`); return; }
    const bad = reports.filter((p) => Math.abs(p.pctSum - 100) > 0.5);
    const msg = [
      `분석용 레시피 DB(recipesYield)에 ${reports.length}개 제품을 저장합니다.`,
      '',
      '· 현장 BOM(레시피 DB)은 건드리지 않습니다.',
      '· 개발이 쪼개 놓은 줄은 합치지 않고 그대로 저장합니다.',
      bad.length > 0 ? `\n⚠ 배합비 합계가 100%가 아닌 제품 ${bad.length}개: ${bad.slice(0, 5).map((p) => `${p.prodCode}(${p.pctSum.toFixed(1)}%)`).join(', ')}` : '',
      '',
      '진행할까요?',
    ].filter(Boolean).join('\n');
    if (!confirm(msg)) return;

    setSaving(true); setDone(null);
    try {
      const CHUNK = 200;
      for (let i = 0; i < reports.length; i += CHUNK) {
        const batch = writeBatch(db);
        reports.slice(i, i + CHUNK).forEach((p) => {
          const id = docIdOf.get(p.short) || p.prodCode;
          batch.set(doc(db, 'recipesYield', id), {
            code: p.prodCode,
            name: p.name || p.rows[0]?.prodName || '',
            packWeight: p.packWeight,
            pctSum: Math.round(p.pctSum * 10000) / 10000,
            source: 'dev-batch',
            ingredients: p.rows.map((r, k) => {
              const e = effOf(p, r, k);
              return {
                seq: k + 1,
                name: e.name || r.rawName,
                code: e.code,
                gPerPiece: r.gPerPiece ?? 0,
                pct: r.pct,          // 원본 배합비도 남겨 나중에 대조할 수 있게
                devName: r.rawName,  // 개발 시트 원본 표기
              };
            }),
            updatedAt: new Date().toISOString(),
          }, { merge: false });
        });
        await batch.commit();
      }
      setDone(`${reports.length}개 제품 · ${stat.total}행 저장 완료`);
      setText(''); setOv({});
    } catch (e: any) {
      alert(`저장 실패: ${e?.message || e}`);
    } finally { setSaving(false); }
  };

  const fmt = (v: number, d = 2) => v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });

  return (
    <div className="space-y-3">
      <div className="bg-indigo-50 border border-indigo-200 rounded p-2.5 text-xs text-indigo-900">
        개발에서 받은 <b>배합비 % 시트</b>를 붙여넣으면 <b>기존 BOM 을 참조해 ERP 코드를 채워</b>
        분석용 레시피로 바꿔줍니다.<br />
        · 저장 대상은 <b>분석용 레시피 DB(recipesYield)</b> 뿐입니다 — <b>현장 BOM(레시피 DB)은 건드리지 않습니다.</b><br />
        · 개발이 쪼개 놓은 줄은 <b>합치지 않고 그대로</b> 저장합니다 (사용량 계산 때 코드 기준으로 합산됩니다).<br />
        · 애매한 매칭은 <b>확정하지 않고 후보만</b> 보여줍니다. 드롭다운에서 직접 고르세요.<br />
        · <b>정제수처럼 현장 BOM 에 없는 원재료</b>도 ERP 코드 마스터에서 찾습니다.
        거기에도 없으면 <b>ERP 코드를 직접 입력</b>할 수 있습니다.
      </div>

      {/* 입력 */}
      <div className="border rounded p-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs font-semibold text-gray-700">배합비 시트 붙여넣기</div>
          <div className="text-[11px] text-gray-500">
            {loading ? '기존 BOM · ERP 마스터 읽는 중...'
              : loaded ? <>참조 BOM <b>{bom.size}</b>개 제품 · 원재료 <b>{master.length}</b>종
                (BOM {master.filter((m) => m.src === 'bom').length} + ERP 마스터 {master.filter((m) => m.src === 'erp').length})
                <button onClick={load} className="ml-2 underline hover:text-gray-800">다시 읽기</button></>
              : '기존 BOM 을 읽지 못했습니다'}
          </div>
        </div>
        <div className="text-[11px] text-gray-500">
          <b>제품코드 / (제품명) / 원재료명 / 배합비%</b> — 탭 또는 쉼표 구분. 머리글이 있으면 자동 인식합니다.
          배합비가 <code className="bg-gray-100 px-1 rounded">0.9165</code> 처럼 백분율 서식이면 자동으로 %로 바꿉니다.
        </div>
        <textarea value={text} onChange={(e) => { setText(e.target.value); setOv({}); setDone(null); }}
          placeholder={'품목코드\t제품명\t원재료명\t배합비(%)\nE-001\t순수쌀미음\t정제수\t91.65\nE-001\t순수쌀미음\t맵쌀\t8.35'}
          className="w-full h-32 border rounded p-2 font-mono text-xs" />
        {parsed.errors.length > 0 && (
          <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
            {parsed.errors.slice(0, 6).map((e, i) => <div key={i}>{e}</div>)}
            {parsed.errors.length > 6 && <div className="text-rose-500">외 {parsed.errors.length - 6}건</div>}
          </div>
        )}
      </div>

      {reports.length > 0 && (
        <>
          {/* 요약 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {([
              ['제품', stat.prods, '개', 'text-gray-800'],
              ['자동 확정', stat.auto, '건', 'text-emerald-700'],
              ['확인 권장', stat.review, '건', 'text-amber-700'],
              ['직접 지정', stat.manual, '건', 'text-blue-700'],
              ['미확정', stat.unresolved, '건', stat.unresolved > 0 ? 'text-rose-700' : 'text-gray-400'],
            ] as const).map(([l, v, u, c]) => (
              <div key={l} className="border rounded px-3 py-2 bg-white">
                <div className="text-[11px] text-gray-500">{l}</div>
                <div className={`text-xl font-bold tabular-nums ${c}`}>{v}<span className="text-xs font-normal text-gray-400 ml-0.5">{u}</span></div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 flex-wrap text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
              <b>확인 필요한 행만 보기</b>
            </label>
            <span className="text-gray-400">완전일치는 숨겨서 손댈 것만 남깁니다</span>
            <button onClick={save} disabled={!canSave || saving}
              className="ml-auto bg-indigo-600 text-white rounded px-4 py-1.5 font-semibold disabled:bg-gray-300">
              {saving ? '저장중...' : `분석용 레시피로 저장 (${stat.prods}개 제품)`}
            </button>
          </div>
          {!canSave && (
            <div className="text-xs text-rose-700">
              {stat.unresolved > 0 && <div>· 미확정 {stat.unresolved}건을 먼저 지정해야 저장할 수 있습니다.</div>}
              {reports.some((p) => p.packWeight === null) && (
                <div>· 포장중량이 없는 제품이 있습니다: {reports.filter((p) => p.packWeight === null).slice(0, 8).map((p) => p.prodCode).join(', ')}
                  {reports.filter((p) => p.packWeight === null).length > 8 && ' 외'} → 설정 › 제품 DB 에서 입력</div>
              )}
            </div>
          )}
          {done && <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">✅ {done}</div>}

          {/* 제품별 */}
          <div className="space-y-2 max-h-[720px] overflow-y-auto">
            {reports.map((p) => {
              // '확인 필요' = 미확정 + 자동확정이지만 근거가 약한 것 + 사람이 손댄 것
              const shown = p.rows.map((r, i) => ({ r, i })).filter(({ r, i }) => {
                if (!onlyReview) return true;
                const e = effOf(p, r, i);
                return !e.code || e.manual || r.match.needsReview;
              });
              if (onlyReview && shown.length === 0 && p.problems.length === 0) return null;
              return (
                <div key={p.short} className="border rounded bg-white">
                  <div className="px-3 py-2 border-b bg-slate-50 flex items-baseline gap-2 flex-wrap text-xs">
                    <b className="text-sm text-gray-800">{p.prodCode}</b>
                    <span className="text-gray-600">{p.name || p.rows[0]?.prodName}</span>
                    <span className="text-gray-400">{p.rows.length}행</span>
                    <span className={Math.abs(p.pctSum - 100) > 0.5 ? 'text-rose-600 font-bold' : 'text-gray-500'}>
                      합계 {fmt(p.pctSum)}%
                    </span>
                    <span className={p.packWeight === null ? 'text-rose-600 font-bold' : 'text-gray-500'}>
                      포장중량 {p.packWeight === null ? '미등록' : `${p.packWeight}g`}
                    </span>
                  </div>

                  {p.problems.length > 0 && (
                    <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900">
                      {p.problems.map((x, i) => <div key={i}>· {x}</div>)}
                    </div>
                  )}
                  {p.dupCodes.length > 0 && (
                    <div className="px-3 py-1.5 bg-blue-50 border-b border-blue-200 text-[11px] text-blue-900">
                      · 같은 원재료가 여러 줄로 쪼개져 있습니다 (합치지 않고 그대로 저장):
                      {p.dupCodes.map((d) => ` ${d.name} ${d.count}줄(합 ${fmt(d.pct)}%)`).join(' ·')}
                    </div>
                  )}
                  {p.missingFromDev.length > 0 && (
                    <div className="px-3 py-1.5 bg-orange-50 border-b border-orange-200 text-[11px] text-orange-900">
                      · BOM 에는 있는데 이 시트엔 없는 원재료: <b>{p.missingFromDev.map((m) => m.name).join(', ')}</b>
                      {' '}— 개발이 뺀 것인지 확인하세요.
                    </div>
                  )}

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-white text-gray-500 border-b">
                        <tr>
                          <th className="px-2 py-1.5 text-left w-44">개발 시트 원재료명</th>
                          <th className="px-2 py-1.5 text-left w-64">→ 매칭 결과 (직접 고를 수 있음)</th>
                          <th className="px-2 py-1.5 text-left w-24">ERP 코드</th>
                          <th className="px-2 py-1.5 text-right w-20">배합비%</th>
                          <th className="px-2 py-1.5 text-right w-20">g/개</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y tabular-nums">
                        {shown.map(({ r, i }) => {
                          const e = effOf(p, r, i);
                          const k = KIND_LABEL[e.manual ? 'exact' : r.match.kind];
                          const cands = r.match.candidates;
                          const selVal = e.code ? `${e.code}||${e.name}` : '';
                          const q = (mFilter[rowKey(p, r, i)] || '').trim();
                          return (
                            <tr key={i} className={!e.code ? 'bg-rose-50' : e.manual ? 'bg-blue-50/50' : ''}>
                              <td className="px-2 py-1.5">
                                <div className="text-gray-800">{r.rawName}</div>
                                <span className={`inline-block mt-0.5 text-[10px] px-1.5 rounded ${e.manual ? 'bg-blue-100 text-blue-800' : k.cls}`}>
                                  {e.manual ? '직접 지정' : k.t}{!e.manual && r.match.score > 0 && r.match.kind !== 'exact' && ` ${Math.round(r.match.score * 100)}%`}
                                </span>
                              </td>
                              <td className="px-2 py-1.5">
                                <select
                                  value={selVal}
                                  onChange={(ev) => {
                                    const v = ev.target.value;
                                    const next = { ...ov };
                                    if (!v) delete next[rowKey(p, r, i)];
                                    else { const [c, n] = v.split('||'); next[rowKey(p, r, i)] = { code: c, name: n }; }
                                    setOv(next);
                                  }}
                                  className={`border rounded px-1.5 py-1 w-full ${!e.code ? 'border-rose-400 text-rose-700' : ''}`}
                                >
                                  <option value="">— 고르세요 —</option>
                                  {/* 직접 입력한 코드가 마스터에 없으면 목록에 값이 없어
                                      '고르세요' 로 남는다. 넣어줘야 무엇이 선택됐는지 보인다 */}
                                  {e.code && !master.some((m) => m.code === e.code)
                                    && !cands.some((c) => c.code === e.code) && (
                                    <option value={selVal}>{e.name || r.rawName} · {e.code} · 직접 입력</option>
                                  )}
                                  {/* 검색어가 있으면 추천/전체를 나누지 않는다.
                                      나눠 두면 이미 추천에 있는 항목이 전체에서 빠져 '없음' 처럼 보인다 */}
                                  {q ? (
                                    <optgroup label={`── 검색 "${q}" ──`}>
                                      {master.filter((m) => m.name.includes(q) || m.code.includes(q))
                                        .slice(0, 300).map((m) => (
                                          <option key={m.code} value={`${m.code}||${m.name}`}>
                                            {m.name} · {m.code}{m.src === 'erp' ? ' · ERP' : ''}
                                          </option>
                                        ))}
                                    </optgroup>
                                  ) : (
                                    <>
                                      <optgroup label="── 추천 후보 ──">
                                        {cands.filter((c) => c.code).map((c) => (
                                          <option key={c.code + c.name} value={`${c.code}||${c.name}`}>
                                            {c.name} ({Math.round(c.score * 100)}%){c.src === 'erp' ? ' · ERP' : ''}
                                          </option>
                                        ))}
                                      </optgroup>
                                      <optgroup label="── 전체 원재료 ──">
                                        {master.filter((m) => !cands.some((c) => c.code === m.code))
                                          .slice(0, 300).map((m) => (
                                            <option key={m.code} value={`${m.code}||${m.name}`}>
                                              {m.name} · {m.code}{m.src === 'erp' ? ' · ERP' : ''}
                                            </option>
                                          ))}
                                      </optgroup>
                                    </>
                                  )}
                                </select>
                                {(!e.code || r.match.needsReview) && (
                                  <div className="mt-1 flex gap-1">
                                    <input
                                      value={mFilter[rowKey(p, r, i)] || ''}
                                      onChange={(ev) => setMFilter({ ...mFilter, [rowKey(p, r, i)]: ev.target.value })}
                                      placeholder="목록 검색 (이름·코드)"
                                      className="border rounded px-1.5 py-0.5 text-[11px] flex-1 min-w-0" />
                                    <input
                                      value={mCode[rowKey(p, r, i)] || ''}
                                      onChange={(ev) => setMCode({ ...mCode, [rowKey(p, r, i)]: ev.target.value })}
                                      onBlur={(ev) => {
                                        const code = normalizeCode(ev.target.value);
                                        if (!code) return;
                                        const hit = master.find((m) => m.code === code);
                                        setOv({ ...ov, [rowKey(p, r, i)]: { code, name: hit?.name || r.rawName } });
                                      }}
                                      placeholder="ERP 코드 직접 입력"
                                      className="border rounded px-1.5 py-0.5 text-[11px] w-32 font-mono" />
                                  </div>
                                )}
                              </td>
                              <td className="px-2 py-1.5 font-mono text-gray-500">{e.code || <span className="text-rose-600">미확정</span>}</td>
                              <td className="px-2 py-1.5 text-right">{fmt(r.pct)}</td>
                              <td className="px-2 py-1.5 text-right text-gray-700">
                                {r.gPerPiece === null ? <span className="text-rose-600">—</span> : fmt(r.gPerPiece, 3)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
