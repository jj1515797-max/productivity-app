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
import { collection, doc, getDocs, onSnapshot, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { canonicalShort, normalizeCode } from '../lib/codeUtil';
import { normalizeMaterialName } from '../lib/wasteCompute';
import {
  BomIndex, BomIngredient, MasterIngredient, ProductReport, ResolvedRow,
  cleanName, parseDevSheet, resolveSheet,
} from '../lib/devRecipeMatch';

const KIND_LABEL: Record<string, { t: string; cls: string }> = {
  exact:    { t: '완전일치',  cls: 'bg-emerald-100 text-emerald-800' },
  clean:    { t: '표기차',    cls: 'bg-emerald-50 text-emerald-700' },
  contains: { t: '포함관계',  cls: 'bg-amber-100 text-amber-800' },
  fuzzy:    { t: '유사',      cls: 'bg-amber-100 text-amber-800' },
  master:   { t: '원재료 ERP코드', cls: 'bg-sky-100 text-sky-800' },
  leftover: { t: '잔여배정',  cls: 'bg-purple-100 text-purple-800' },
  none:     { t: '못 찾음',   cls: 'bg-rose-100 text-rose-800' },
};

interface Override { code: string; name: string }

export default function DevRecipeImport() {
  const [text, setText] = useState('');
  const [rawBom, setRawBom] = useState<BomIndex>(new Map());
  const [bomMaster, setBomMaster] = useState<MasterIngredient[]>([]);
  const [erpMaster, setErpMaster] = useState<MasterIngredient[]>([]);
  const [packW, setPackW] = useState<Map<string, number>>(new Map());
  const [prodName, setProdName] = useState<Map<string, string>>(new Map());
  const [docIdOf, setDocIdOf] = useState<Map<string, string>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [onlyReview, setOnlyReview] = useState(true);
  const [ov, setOv] = useState<Record<string, Override>>({});   // 행키 → 사람이 고른 값
  const [mFilter, setMFilter] = useState<Record<string, string>>({});   // 목록 검색어
  const [mCode, setMCode] = useState<Record<string, string>>({});       // ERP 코드 직접 입력
  const [applyAll, setApplyAll] = useState(true);   // 같은 이름은 한 번에
  const [lastBulk, setLastBulk] = useState<{ name: string; n: number } | null>(null);
  const [regBusy, setRegBusy] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  /** 기존 BOM·제품 DB 를 읽어온다 (읽기 전용) */
  const load = async () => {
    setLoading(true);
    try {
      // 정제수처럼 '배합비엔 있고 현장 BOM 엔 없는' 원재료가 있다.
      // BOM 만 후보로 쓰면 영원히 못 찾으므로 설정 › 원재료 ERP 코드까지 읽는다.
      const [rs, ps, inv] = await Promise.all([
        getDocs(collection(db, 'recipes')),
        getDocs(collection(db, 'productSettings')),
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
      const all = new Map<string, MasterIngredient>();
      useCount.forEach((v, c) => all.set(c, { name: v.name, code: c, uses: v.uses, src: 'bom' }));
      inv?.forEach((d) => {
        const v = d.data() as { code?: string; name?: string };
        const c = normalizeCode(v.code || '');
        if (!c || !v.name || all.has(c)) return;
        all.set(c, { name: v.name, code: c, uses: 0, src: 'erp' });
      });
      setRawBom(b);
      setBomMaster([...all.values()]);
      setPackW(pw); setProdName(pn); setDocIdOf(idMap); setLoaded(true);
    } catch (e: any) {
      alert(`기존 DB 를 읽지 못했습니다: ${e?.message || e}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  /* 설정 › 원재료 ERP 코드는 실시간으로 본다.
     한 번만 읽으면 '설정에서 방금 등록했는데 여기선 아직 없다' 가 생긴다. */
  useEffect(() => onSnapshot(collection(db, 'materialErpCodes'), (snap) => {
    const list: MasterIngredient[] = [];
    snap.forEach((d) => {
      const v = d.data() as { code?: string; name?: string };
      const c = normalizeCode(v.code || d.id);
      if (c && v.name) list.push({ name: v.name, code: c, uses: 0, src: 'erp' });
    });
    setErpMaster(list);
  }, () => {}), []);

  /** BOM 안의 원재료 이름도 ERP 정본 이름으로 바꿔 둔다.
   *  같은 코드인데 화면마다 다른 이름이 뜨면 '이게 맞나' 싶어진다. */
  const bom = useMemo(() => {
    if (erpMaster.length === 0) return rawBom;
    const byCode = new Map(erpMaster.map((m) => [m.code, m.name]));
    const out: BomIndex = new Map();
    rawBom.forEach((list, k) => {
      out.set(k, list.map((ing) => {
        const c = normalizeCode(ing.code || '');
        const n = c ? byCode.get(c) : undefined;
        return n ? { ...ing, name: n } : ing;
      }));
    });
    return out;
  }, [rawBom, erpMaster]);

  /** BOM 쪽 + ERP 코드 쪽을 합친 최종 후보 목록.
   *  같은 코드면 '설정 › 원재료 ERP 코드' 의 이름을 우선한다 — 그쪽이 정본이고,
   *  BOM 이름은 현장 표기라 제각각이다. (BOM 이름을 우선하면 방금 등록한
   *  '정제수' 가 BOM 의 '정제수(후투입)' 에 덮여 목록에서 사라진다)
   *  BOM 이름도 버리지 않고 별칭 후보로 같이 둔다 — 시트가 어느 쪽으로 쓰든 잡히게. */
  const master = useMemo(() => {
    const erpByCode = new Map(erpMaster.map((m) => [m.code, m]));
    const out: MasterIngredient[] = [];
    const seen = new Set<string>();
    const push = (m: MasterIngredient) => {
      const k = `${m.code}|${normalizeMaterialName(m.name)}`;
      if (seen.has(k)) return;
      seen.add(k); out.push(m);
    };
    bomMaster.forEach((m) => {
      const e = erpByCode.get(m.code);
      if (e) push({ ...m, name: e.name });      // ERP 이름 우선
      push({ ...m, alias: true });               // BOM 이름도 별칭으로 (정본은 아니다)
    });
    erpMaster.forEach((m) => push(m));
    return out.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  }, [bomMaster, erpMaster]);

  const parsed = useMemo(() => (text.trim() ? parseDevSheet(text)
    : { rows: [], skipped: [], errors: [], headerUsed: false }), [text]);

  const reports: ProductReport[] = useMemo(() => {
    if (!loaded || parsed.rows.length === 0) return [];
    return resolveSheet(
      parsed.rows, bom, master,
      (short) => packW.get(short) ?? null,
      (short) => prodName.get(short) || '',
      parsed.skipped,
    );
  }, [parsed, bom, master, packW, prodName, loaded]);

  const rowKey = (p: ProductReport, r: ResolvedRow, i: number) => `${p.short}|${i}|${r.rawName}`;
  const effOf = (p: ProductReport, r: ResolvedRow, i: number) => {
    const o = ov[rowKey(p, r, i)];
    return o ? { code: o.code, name: o.name, manual: true } : { code: r.match.code, name: r.match.name, manual: false };
  };

  /** 한 행에서 고른 값을 같은 이름의 다른 행에도 적용한다.
   *  개발 시트에서 이름이 같으면 같은 원재료다 — 50개 제품에서 같은 걸 50번 고를 이유가 없다.
   *  이미 확정된 행은 건드리지 않는다 (제품별로 다른 규격을 쓴 경우를 보존). */
  const choose = (key: string, rawName: string, val: Override | null) => {
    const next = { ...ov };
    if (!val) { delete next[key]; setOv(next); setLastBulk(null); return; }
    next[key] = val;
    let n = 0;
    if (applyAll) {
      const target = normalizeMaterialName(rawName);
      reports.forEach((p) => p.rows.forEach((r, i) => {
        const k = rowKey(p, r, i);
        if (k === key) return;
        if (normalizeMaterialName(r.rawName) !== target) return;
        if (ov[k]) return;              // 사람이 이미 고른 건 안 건드림
        if (r.match.code && !r.match.needsReview) return;   // 자동 확정된 것도 안 건드림
        next[k] = val; n++;
      }));
    }
    setOv(next);
    setLastBulk(n > 0 ? { name: rawName, n } : null);
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
    // 44건이라도 이름 기준으로는 몇 종뿐일 수 있다 — 실제로 몇 번 고르면 되는지 보여준다
    const names = new Set<string>();
    reports.forEach((p) => p.rows.forEach((r, i) => {
      if (!effOf(p, r, i).code) names.add(normalizeMaterialName(r.rawName));
    }));
    return { total, auto, review, unresolved, manual, prods: reports.length, unresolvedNames: names.size };
  }, [reports, ov]);

  // 배합비는 품목코드별 합계가 반드시 100% 다. 어긋나면 뭔가 잘못 읽은 것이므로 저장을 막는다.
  const badSum = reports.filter((p) => Math.abs(p.pctSum - 100) > 0.5);
  const canSave = reports.length > 0 && stat.unresolved === 0
    && reports.every((p) => p.packWeight !== null) && badSum.length === 0;

  const save = async () => {
    if (!canSave) return;
    const noCode = reports.flatMap((p) => p.rows.map((r, i) => effOf(p, r, i)).filter((e) => !e.code));
    if (noCode.length > 0) { alert(`ERP 코드가 비어 있는 행이 ${noCode.length}건 있습니다.`); return; }
    const skipN = reports.reduce((s2, p) => s2 + p.skipped.length, 0);
    const msg = [
      `분석용 레시피 DB(recipesYield)에 ${reports.length}개 제품을 저장합니다.`,
      '',
      '· 현장 BOM(레시피 DB)은 건드리지 않습니다.',
      '· 개발이 쪼개 놓은 줄은 합치지 않고 그대로 저장합니다.',
      skipN > 0 ? `· 배합비 칸이 '삭제' 인 ${skipN}행은 빼고 저장합니다.` : '',
      `· 전 제품 배합비 합계 100% 확인 완료.`,
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

  /** 설정 › 원재료 ERP 코드에 없는 코드를 이 화면에서 바로 등록한다.
   *  한 번 등록해 두면 다음 제품부터는 이름으로 자동 매칭된다. */
  const registerCode = async (key: string, code: string, name: string) => {
    const c = normalizeCode(code);
    if (!c || !name.trim()) return;
    if (!confirm(`설정 › 원재료 ERP 코드에 등록합니다.\n\n  ${c}  ${name}\n\n다음부터는 이름만으로 자동 매칭됩니다.`)) return;
    setRegBusy(key);
    try {
      await setDoc(doc(db, 'materialErpCodes', c), { code: c, name: name.trim() }, { merge: true });
      choose(key, name, { code: c, name: name.trim() });
    } catch (e: any) {
      alert(`등록 실패: ${e?.message || e}`);
    } finally { setRegBusy(''); }
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
        · 배합비 칸에 <b>‘삭제’</b> 라고 적힌 줄은 <b>빼고</b> 계산합니다 (무엇을 뺐는지 제품마다 보여줍니다).<br />
        · <b>정제수처럼 현장 BOM 에 없는 원재료</b>도 설정 › 원재료 ERP 코드에서 찾습니다.
        거기에도 없으면 <b>ERP 코드를 직접 입력</b>하고 <b>＋ 마스터 등록</b> 으로 바로 추가할 수 있습니다
        (한 번 등록하면 다음 제품부터 이름만으로 자동 매칭됩니다).
      </div>

      {/* 입력 */}
      <div className="border rounded p-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs font-semibold text-gray-700">배합비 시트 붙여넣기</div>
          <div className="text-[11px] text-gray-500">
            {loading ? '기존 BOM · 원재료 ERP 코드 읽는 중...'
              : loaded ? <>참조 BOM <b>{bom.size}</b>개 제품 · 원재료 <b>{master.length}</b>종
                (BOM {master.filter((m) => m.src === 'bom').length} + 원재료 ERP코드 {master.filter((m) => m.src === 'erp').length})
                <button onClick={load} className="ml-2 underline hover:text-gray-800">다시 읽기</button></>
              : '기존 BOM 을 읽지 못했습니다'}
          </div>
        </div>
        <div className="text-[11px] text-gray-500">
          <b>제품코드 / (제품명) / 원재료명 / 배합비%</b> — 탭 또는 쉼표 구분. 머리글이 있으면 자동 인식합니다.
          배합비는 <b>품목코드별 합계가 100%</b>여야 합니다 — 아니면 저장을 막습니다.
          엑셀에서 값으로 붙여 <code className="bg-gray-100 px-1 rounded">0.3369</code> 처럼 들어와도
          <b>제품 단위 합계를 보고</b> 자동으로 %로 바꿉니다 (0.19% 같은 소량 원재료는 그대로 둡니다).
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
          <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
            {([
              ['제품', stat.prods, '개', 'text-gray-800'],
              ['자동 확정', stat.auto, '건', 'text-emerald-700'],
              ['확인 권장', stat.review, '건', 'text-amber-700'],
              ['직접 지정', stat.manual, '건', 'text-blue-700'],
              ['미확정', stat.unresolved, '건', stat.unresolved > 0 ? 'text-rose-700' : 'text-gray-400'],
              ['골라야 할 이름', stat.unresolvedNames, '종', stat.unresolvedNames > 0 ? 'text-rose-700' : 'text-gray-400'],
              ['삭제 표시로 뺌', parsed.skipped.length, '행', 'text-gray-500'],
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
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
              <b>같은 이름은 한 번에</b>
            </label>
            <span className="text-gray-400">
              한 번 고르면 <b>같은 원재료명 전부</b>에 적용됩니다 (이미 정해진 행은 그대로)
            </span>
            <button onClick={save} disabled={!canSave || saving}
              className="ml-auto bg-indigo-600 text-white rounded px-4 py-1.5 font-semibold disabled:bg-gray-300">
              {saving ? '저장중...' : `분석용 레시피로 저장 (${stat.prods}개 제품)`}
            </button>
          </div>
          {!canSave && (
            <div className="text-xs text-rose-700">
              {stat.unresolved > 0 && <div>· 미확정 {stat.unresolved}건을 먼저 지정해야 저장할 수 있습니다.</div>}
              {badSum.length > 0 && (
                <div>· <b>배합비 합계가 100%가 아닌 제품 {badSum.length}개</b>:
                  {' '}{badSum.slice(0, 6).map((p) => `${p.prodCode} ${p.pctSum.toFixed(2)}%`).join(', ')}
                  {badSum.length > 6 && ' 외'}
                  {' '}→ 열을 잘못 잡았거나 빠진 줄이 있는지 확인하세요.</div>
              )}
              {reports.some((p) => p.packWeight === null) && (
                <div>· 포장중량이 없는 제품이 있습니다: {reports.filter((p) => p.packWeight === null).slice(0, 8).map((p) => p.prodCode).join(', ')}
                  {reports.filter((p) => p.packWeight === null).length > 8 && ' 외'} → 설정 › 제품 DB 에서 입력</div>
              )}
            </div>
          )}
          {lastBulk && (
            <div className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded px-3 py-1.5">
              ✔ <b>{lastBulk.name}</b> — 같은 이름 <b>{lastBulk.n}건</b>에 함께 적용했습니다.
              <button onClick={() => setLastBulk(null)} className="ml-2 underline">닫기</button>
            </div>
          )}
          {done && <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">✅ {done}</div>}

          {/* 제품별 */}
          <div className="space-y-2 max-h-[720px] overflow-y-auto">
            {reports.map((p) => {
              // '확인 필요' = 미확정 + 자동확정이지만 근거가 약한 것 + 사람이 손댄 것
              // 지금 이 순간 기준으로 '아직 안 쓰인 BOM 원재료'. 사람이 고를 때마다 줄어든다.
              const usedNow = new Set(p.rows.map((r, k) => effOf(p, r, k).code).filter(Boolean));
              const skippedNow = new Set(p.skipped.map((x) => cleanName(x.rawName)));
              const leftoverBom = (bom.get(p.short) || [])
                .map((ing) => ({ name: ing.name, code: normalizeCode(ing.code || '') }))
                .filter((m, k, a) => m.code && !usedNow.has(m.code)
                  && !skippedNow.has(cleanName(m.name))
                  && a.findIndex((y) => y.code === m.code) === k);
              const bomCodes = new Set((bom.get(p.short) || [])
                .map((ing) => normalizeCode(ing.code || '')).filter(Boolean));
              const inProductBom = (c: string) => !!c && bomCodes.has(c);
              const shown = p.rows.map((r, i) => ({ r, i })).filter(({ r, i }) => {
                if (!onlyReview) return true;
                const e = effOf(p, r, i);
                // BOM 에 남은 게 있으면, 그 제품 BOM 밖을 잡은 행도 보여준다 —
                // 짝을 바꿔야 할 후보가 바로 그 행들이다
                if (leftoverBom.length > 0 && !inProductBom(e.code)) return true;
                return !e.code || e.manual || r.match.needsReview;
              });
              // 확인할 행이 없어도 카드는 남긴다 — 삭제·쪼개짐·누락 안내가 같이 사라지면 안 된다
              return (
                <div key={p.short} className="border rounded bg-white">
                  <div className="px-3 py-2 border-b bg-slate-50 flex items-baseline gap-2 flex-wrap text-xs">
                    <b className="text-sm text-gray-800">{p.prodCode}</b>
                    <span className="text-gray-600">{p.name || p.rows[0]?.prodName}</span>
                    <span className="text-gray-400">
                      {p.rows.length}행{p.skipped.length > 0 && ` (삭제 ${p.skipped.length})`}
                    </span>
                    <span className={Math.abs(p.pctSum - 100) > 0.5 ? 'text-rose-600 font-bold' : 'text-gray-500'}>
                      합계 {fmt(p.pctSum)}%
                    </span>
                    <span className={p.packWeight === null ? 'text-rose-600 font-bold' : 'text-gray-500'}>
                      포장중량 {p.packWeight === null ? '미등록' : `${p.packWeight}g`}
                    </span>
                    {leftoverBom.length > 0 && (
                      <span className="bg-orange-100 text-orange-800 rounded px-1.5 py-0.5 font-semibold">
                        BOM 잔여 {leftoverBom.length}종
                      </span>
                    )}
                  </div>

                  {p.problems.length > 0 && (
                    <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900">
                      {p.problems.map((x, i) => <div key={i}>· {x}</div>)}
                    </div>
                  )}
                  {p.skipped.length > 0 && (
                    <div className="px-3 py-1.5 bg-gray-100 border-b text-[11px] text-gray-600">
                      · 배합비 칸이 <b>‘{p.skipped[0].mark}’</b> 라 <b>{p.skipped.length}행을 뺐습니다</b>:
                      {' '}<b>{p.skipped.map((x) => x.rawName).join(', ')}</b>
                    </div>
                  )}
                  {p.dupCodes.length > 0 && (
                    <div className="px-3 py-1.5 bg-blue-50 border-b border-blue-200 text-[11px] text-blue-900">
                      · 같은 원재료가 여러 줄로 쪼개져 있습니다 (합치지 않고 그대로 저장):
                      {p.dupCodes.map((d) => ` ${d.name} ${d.count}줄(합 ${fmt(d.pct)}%)`).join(' ·')}
                    </div>
                  )}
                  {/* 자동 매칭 시점이 아니라 '지금' 기준으로 센다.
                      사람이 고른 걸 반영 안 하면, 이미 짝지어 준 원재료가 계속 남아 있다고 뜬다. */}
                  {leftoverBom.length > 0 && (
                    <div className="px-3 py-1.5 bg-orange-50 border-b border-orange-200 text-[11px] text-orange-900">
                      · <b>아직 아무 줄에도 안 쓰인 BOM 원재료 {leftoverBom.length}종</b>:
                      {' '}<b>{leftoverBom.map((m) => m.name).join(', ')}</b>
                      {' '}— 개발이 뺀 것인지, 아니면 시트의 다른 이름이 이것인지 확인하세요.
                    </div>
                  )}

                  {shown.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-emerald-700">
                      ✓ 전 행 자동 확정 — 확인할 것이 없습니다
                      <button onClick={() => setOnlyReview(false)} className="ml-2 underline hover:text-emerald-900">전체 보기</button>
                    </div>
                  ) : (
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
                          // 시트 이름과 정규화 후 완전히 같은 원재료 (여러 개일 수 있다)
                          const devN = normalizeMaterialName(r.rawName);
                          const sameName = devN
                            ? master.filter((m) => normalizeMaterialName(m.name) === devN)
                            : [];
                          const inSame = (code: string) => sameName.some((m) => m.code === code);
                          return (
                            <tr key={i} className={!e.code ? 'bg-rose-50' : e.manual ? 'bg-blue-50/50' : ''}>
                              <td className="px-2 py-1.5">
                                <div className="text-gray-800">{r.rawName}</div>
                                <span className={`inline-block mt-0.5 text-[10px] px-1.5 rounded ${e.manual ? 'bg-blue-100 text-blue-800' : k.cls}`}>
                                  {e.manual ? '직접 지정' : k.t}{!e.manual && r.match.score > 0 && r.match.kind !== 'exact' && ` ${Math.round(r.match.score * 100)}%`}
                                </span>
                                {/* 이 행이 이 제품 BOM 밖의 원재료를 잡고 있는데 BOM 엔 아직 남은 게 있다.
                                    하나씩 열어보지 않아도 어디를 볼지 바로 알 수 있게 표시한다. */}
                                {leftoverBom.length > 0 && !inProductBom(e.code) && (
                                  <span className="inline-block mt-0.5 ml-1 text-[10px] px-1.5 rounded bg-orange-100 text-orange-800"
                                    title={`이 제품 BOM 에 아직 안 쓰인 원재료: ${leftoverBom.map((m) => m.name).join(', ')}`}>
                                    BOM 잔여 {leftoverBom.length}
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-1.5">
                                <select
                                  value={selVal}
                                  onChange={(ev) => {
                                    const v = ev.target.value;
                                    if (!v) choose(rowKey(p, r, i), r.rawName, null);
                                    else { const [c, nm] = v.split('||'); choose(rowKey(p, r, i), r.rawName, { code: c, name: nm }); }
                                  }}
                                  className={`border rounded px-1.5 py-1 w-full ${!e.code
                                    ? 'border-rose-400 text-rose-700'
                                    : e.manual ? 'border-blue-400 text-blue-800' : ''}`}
                                >
                                  <option value="">— 고르세요 —</option>
                                  {/* 지금 고른 값은 무조건 맨 위에 둔다.
                                      아래 목록에 같은 값이 있어도 상관없다 — 브라우저는 첫 항목을 잡는다.
                                      이걸 조건부로 넣으면 이름이 한 글자만 달라도 '고르세요' 로 비어 보인다. */}
                                  {e.code && (
                                    <option value={selVal}>
                                      ✓ {e.name || r.rawName} · {e.code}
                                    </option>
                                  )}
                                  {/* 시트에 적힌 이름과 '똑같은' 원재료가 있으면 무조건 맨 위.
                                      점수·격차 판정과 무관하게 눈에 보여야 바로 고를 수 있다. */}
                                  {!q && sameName.length > 0 && (
                                    <optgroup label="── 이름이 같은 원재료 ──">
                                      {sameName.map((m) => (
                                        <option key={'sn' + m.code} value={`${m.code}||${m.name}`}>
                                          {m.name} · {m.code}
                                        </option>
                                      ))}
                                    </optgroup>
                                  )}
                                  {/* 이 제품 BOM 에서 아직 아무도 안 가져간 원재료를 맨 위에 둔다.
                                      '소고기 → 한우(익,민찌)' 처럼 이름이 안 겹치는 건 이 목록에서 고르게 된다.
                                      점수순 추천만 보여주면 정작 필요한 것이 아래로 묻힌다. */}
                                  {!q && leftoverBom.length > 0 && (
                                    <optgroup label={`── 이 제품 BOM 에 남은 원재료 (${leftoverBom.length}) ──`}>
                                      {leftoverBom.filter((m) => !inSame(m.code)).map((m) => (
                                        <option key={'lb' + m.code} value={`${m.code}||${m.name}`}>
                                          {m.name} · {m.code}
                                        </option>
                                      ))}
                                    </optgroup>
                                  )}
                                  {/* 검색어가 있으면 추천/전체를 나누지 않는다.
                                      나눠 두면 이미 추천에 있는 항목이 전체에서 빠져 '없음' 처럼 보인다 */}
                                  {q ? (
                                    <optgroup label={`── 검색 "${q}" ──`}>
                                      {master.filter((m) => m.name.includes(q) || m.code.includes(q))
                                        .slice(0, 300).map((m) => (
                                          <option key={m.code} value={`${m.code}||${m.name}`}>
                                            {m.name} · {m.code}{m.src === 'erp' ? ' · ERP코드' : ''}
                                          </option>
                                        ))}
                                    </optgroup>
                                  ) : (
                                    <>
                                      <optgroup label="── 추천 후보 ──">
                                        {cands.filter((c) => c.code && !inSame(c.code)
                                          && !leftoverBom.some((m) => m.code === c.code)).map((c) => (
                                          <option key={c.code + c.name} value={`${c.code}||${c.name}`}>
                                            {c.name} ({Math.round(c.score * 100)}%){c.src === 'erp' ? ' · ERP코드' : ''}
                                          </option>
                                        ))}
                                      </optgroup>
                                      <optgroup label="── 전체 원재료 ──">
                                        {master.filter((m) => !inSame(m.code)
                                          && !cands.some((c) => c.code === m.code)
                                          && !leftoverBom.some((x) => x.code === m.code))
                                          .slice(0, 300).map((m) => (
                                            <option key={m.code} value={`${m.code}||${m.name}`}>
                                              {m.name} · {m.code}{m.src === 'erp' ? ' · ERP코드' : ''}
                                            </option>
                                          ))}
                                      </optgroup>
                                    </>
                                  )}
                                </select>
                                {!e.code && r.match.why && (
                                  <div className="mt-1 text-[11px] text-rose-700">↳ {r.match.why}</div>
                                )}
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
                                        choose(rowKey(p, r, i), r.rawName, { code, name: hit?.name || r.rawName });
                                      }}
                                      placeholder="ERP 코드 직접 입력"
                                      className="border rounded px-1.5 py-0.5 text-[11px] w-32 font-mono" />
                                    {(() => {
                                      const typed = normalizeCode(mCode[rowKey(p, r, i)] || '');
                                      if (!typed || master.some((m) => m.code === typed)) return null;
                                      const k = rowKey(p, r, i);
                                      return (
                                        <button
                                          onClick={() => registerCode(k, typed, r.rawName)}
                                          disabled={regBusy === k}
                                          title={`설정 › 원재료 ERP 코드에 "${typed} ${r.rawName}" 로 등록`}
                                          className="text-[11px] border border-indigo-300 text-indigo-700 rounded px-1.5 py-0.5 hover:bg-indigo-50 disabled:text-gray-400 whitespace-nowrap">
                                          {regBusy === k ? '등록중' : '＋ 마스터 등록'}
                                        </button>
                                      );
                                    })()}
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
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
