/** 용기분석 > 재고 정합성 — 재고조사 투입량 vs 이론사용량 검증
 *
 *  투입량 = 기초재고 + 당월입고 − 기말재고   (구매팀 값 직접 입력도 가능)
 *  이론사용량 = 그 달 생산량(EA) — 용기분석과 같은 숫자를 씀
 *  차이 = 투입량 − 이론사용량 → 실제 로스여야 하며, 음수면 어딘가 틀린 것
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, setDoc, writeBatch } from 'firebase/firestore';
import ExcelJS from 'exceljs';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadContainerMonth, isPastMonth } from '../lib/containerLoad';
import {
  MATERIALS, SOURCE_LABEL, analyze, emptyEntry,
  type StockEntry, type TheoryMonth, type Severity, type MonthRow,
  type TheorySource, type MaterialDef, type TheorySpec,
} from '../lib/containerStock';

/** 합계 행은 구성 자재의 입력값을 그대로 더한다 (직접 입력하지 않는다) */
function sumEntry(parts: (StockEntry | undefined)[]): StockEntry {
  const add = (f: keyof StockEntry) => {
    const vs = parts.map((p) => (p ? (p[f] as number | null | undefined) : null)).filter((v) => v != null) as number[];
    return vs.length ? vs.reduce((a, b) => a + b, 0) : null;
  };
  return { open: add('open'), inbound: add('inbound'), close: add('close'), input: add('input') };
}

/** 이론사용량은 생산 데이터에서 계산한 파생값이지만, 한 달치 계산에 34개 쿼리가 든다.
 *  사람마다 다시 돌릴 이유가 없으므로 계산한 사람이 DB 에 올려 모두가 같이 쓴다.
 *  지난달 값은 그 달이 끝난 뒤 계산된 것만 신뢰한다 (진행중 부분집계 배제). */
const THEORY_DOC = '_theory';
interface TheoryCell extends TheoryMonth { ts: number }

const usable = (m: string, c: TheoryCell | undefined): boolean => {
  if (!c) return false;
  if (c.m1 == null) return false;          // 호기별 값이 없는 옛 저장분
  if (!isPastMonth(m)) return Date.now() - c.ts < 5 * 60 * 1000;
  const [y, mm] = m.split('-').map(Number);
  return c.ts >= new Date(y, mm, 1).getTime();
};

const nf = (n: number) => Math.round(n).toLocaleString();
/** 롤처럼 개수가 적은 자재는 반올림하면 오차가 커 보인다 — 소수 첫째 자리까지 보여준다 */
const mk = (d: number) => (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const pctS = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);

const SEV: Record<Severity, { bg: string; bar: string; icon: string; label: string }> = {
  critical: { bg: 'bg-red-50 border-red-300', bar: 'bg-red-600', icon: '🚨', label: '반드시 확인' },
  warn: { bg: 'bg-amber-50 border-amber-300', bar: 'bg-amber-500', icon: '⚠️', label: '확인 권장' },
  info: { bg: 'bg-sky-50 border-sky-300', bar: 'bg-sky-500', icon: 'ℹ️', label: '참고' },
  ok: { bg: 'bg-emerald-50 border-emerald-300', bar: 'bg-emerald-500', icon: '✅', label: '정상' },
};

const FLAG_STYLE: Record<string, { chip: string; text: string; bar: string }> = {
  ok: { chip: 'bg-emerald-100 text-emerald-700', text: '정상', bar: '#10b981' },
  timing: { chip: 'bg-amber-100 text-amber-700', text: '이월오차', bar: '#f59e0b' },
  bad: { chip: 'bg-red-100 text-red-700', text: '이상', bar: '#ef4444' },
  none: { chip: 'bg-gray-100 text-gray-400', text: '미입력', bar: '#cbd5e1' },
};

/* ───────────────────────── 그래프 ───────────────────────── */
function DiffChart({ rows, lossLimit, dec }: { rows: MonthRow[]; lossLimit: number; dec: number }) {
  const f = mk(dec);
  const g = (n: number) => `${n > 0 ? '+' : ''}${f(n)}`;
  const W = 1000, H = 260, PL = 64, PR = 56, PT = 18, PB = 28;
  const iw = W - PL - PR, ih = H - PT - PB;
  const vals: number[] = [];
  rows.forEach((r) => {
    if (r.diff !== null) vals.push(r.diff);
    if (r.cumDiff !== null) vals.push(r.cumDiff);
    if (r.theory) vals.push(r.theory * lossLimit);
  });
  const max = Math.max(1, ...vals.map(Math.abs));
  const y = (v: number) => PT + ih / 2 - (v / max) * (ih / 2) * 0.92;
  const cw = iw / Math.max(1, rows.length);
  const bw = Math.min(34, cw * 0.5);

  const cumPts = rows
    .map((r, i) => (r.cumDiff === null ? null : `${PL + cw * (i + 0.5)},${y(r.cumDiff)}`))
    .filter(Boolean).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 260 }}>
      {/* 정상 로스 범위 밴드 */}
      {rows.map((r, i) => r.theory ? (
        <rect key={`b${r.month}`} x={PL + cw * i + 1} width={Math.max(0, cw - 2)}
          y={y(r.theory * lossLimit)} height={Math.max(1, y(0) - y(r.theory * lossLimit))}
          fill="#10b981" opacity={0.07} />
      ) : null)}
      <line x1={PL} x2={PL + iw} y1={y(0)} y2={y(0)} stroke="#334155" strokeWidth={1.5} />
      {/* 막대 */}
      {rows.map((r, i) => {
        if (r.diff === null) return null;
        const cx = PL + cw * (i + 0.5);
        const y0 = y(0), y1 = y(r.diff);
        return (
          <g key={r.month}>
            <rect x={cx - bw / 2} y={Math.min(y0, y1)} width={bw} height={Math.max(1.5, Math.abs(y1 - y0))}
              rx={2} fill={FLAG_STYLE[r.flag].bar} opacity={0.88} />
            <text x={cx} y={r.diff >= 0 ? Math.min(y0, y1) - 4 : Math.max(y0, y1) + 12}
              textAnchor="middle" fontSize={10.5} fontWeight={700}
              fill={FLAG_STYLE[r.flag].bar}>{g(r.diff)}</text>
          </g>
        );
      })}
      {/* 누적선 */}
      {cumPts && <polyline points={cumPts} fill="none" stroke="#1e293b" strokeWidth={2.5} strokeLinejoin="round" />}
      {rows.map((r, i) => r.cumDiff === null ? null : (
        <circle key={`c${r.month}`} cx={PL + cw * (i + 0.5)} cy={y(r.cumDiff)} r={3.2} fill="#1e293b" />
      ))}
      {/* 축 */}
      {rows.map((r, i) => (
        <text key={`x${r.month}`} x={PL + cw * (i + 0.5)} y={H - 9} textAnchor="middle"
          fontSize={11} fill="#64748b">{Number(r.month.slice(5, 7))}월</text>
      ))}
      <text x={PL - 8} y={y(0) + 4} textAnchor="end" fontSize={10} fill="#334155">0</text>
      <text x={PL - 8} y={y(max * 0.92) + 4} textAnchor="end" fontSize={10} fill="#94a3b8">{f(max * 0.92)}</text>
      <text x={PL - 8} y={y(-max * 0.92) + 4} textAnchor="end" fontSize={10} fill="#94a3b8">-{f(max * 0.92)}</text>
    </svg>
  );
}

/* ───────────────────────── 본체 ───────────────────────── */
export default function ContainerStockTab() {
  const nowY = Number(todayKey().slice(0, 4));
  const [year, setYear] = useState(nowY);
  const [matId, setMatId] = useState(MATERIALS[0].id);
  const [lossLimit, setLossLimit] = useState(0.03);
  const [stock, setStock] = useState<Record<string, Record<string, StockEntry>>>({});   // month -> matId -> entry
  const [theory, setTheory] = useState<Record<string, TheoryMonth>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteField, setPasteField] = useState<keyof StockEntry>('input');
  const [pasteStart, setPasteStart] = useState(1);
  const [pasteText, setPasteText] = useState('');
  const [srcOverride, setSrcOverride] = useState<Record<string, TheorySource>>({});

  const months = useMemo(() => {
    const cap = year === nowY ? Number(todayKey().slice(5, 7)) : 12;
    return Array.from({ length: cap }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  }, [year, nowY]);

  const mat = MATERIALS.find((m) => m.id === matId)!;
  const readOnly = !!mat.sum;
  const dec = mat.perUnit > 1 ? 1 : 0;          // 롤은 소수 첫째 자리까지
  const un = mk(dec);
  const usgn = (n: number) => `${n > 0 ? '+' : ''}${un(n)}`;

  /* 재고 입력값 불러오기 (컬렉션 전체 1회) */
  useEffect(() => {
    let cancelled = false;
    getDocs(collection(db, 'containerStock')).then((snap) => {
      if (cancelled) return;
      const next: Record<string, Record<string, StockEntry>> = {};
      snap.forEach((d) => {
        if (d.id === THEORY_DOC) {
          const raw = d.data() as Record<string, TheoryCell>;
          const seen: Record<string, TheoryMonth> = {};
          Object.entries(raw).forEach(([m, c]) => { if (usable(m, c)) seen[m] = c; });
          setTheory((p) => ({ ...seen, ...p }));
          return;
        }
        if (d.id === '_config') {
          const c = d.data() as { sources?: Record<string, TheorySource>; lossLimit?: number };
          setSrcOverride(c.sources || {});
          if (typeof c.lossLimit === 'number') setLossLimit(c.lossLimit);
          return;
        }
        if (d.id.startsWith('_')) return;      // 설정용 문서는 월이 아니다
        next[d.id] = d.data() as Record<string, StockEntry>;
      });
      setStock(next);
    }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; };
  }, []);

  // 저장 안 한 채로 창을 닫거나 새로고침하면 입력이 날아간다
  useEffect(() => {
    if (!dirty.size) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const missing = months.filter((m) => !theory[m]);
  // 제품 DB 에 없어 용기 구분을 못 한 수량 — 그만큼 이론사용량이 적게 잡힌다
  const unknownMonths = months.filter((m) => (theory[m]?.unknown || 0) > 0);
  const unknownTotal = unknownMonths.reduce((s2, m) => s2 + (theory[m]?.unknown || 0), 0);

  const loadTheory = useCallback(async (list: string[]) => {
    setErr('');
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      setBusy(`생산량 계산 중… ${m} (${i + 1}/${list.length})`);
      try {
        const r = await loadContainerMonth(m);
        const t: TheoryMonth = {
          small: r.small, large: r.large, ambient: r.ambient, unknown: r.unknown,
          m1: r.m1, m2: r.m2, m3: r.m3, mUnassigned: r.mUnassigned,
        };
        setTheory((p) => ({ ...p, [m]: t }));
        // 다른 사람이 같은 계산을 다시 돌리지 않도록 바로 올린다
        await setDoc(doc(db, 'containerStock', THEORY_DOC), { [m]: { ...t, ts: Date.now() } }, { merge: true });
      } catch (e) {
        setErr(`${m} 계산 실패: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
    setBusy('');
  }, []);

  const specOf = (mm: MaterialDef): TheorySpec | TheorySpec[] => {
    const one = (x: MaterialDef): TheorySpec => ({ src: srcOverride[x.id] || x.source, perUnit: x.perUnit });
    return mm.sum ? mm.sum.map((id) => one(MATERIALS.find((x) => x.id === id)!)) : one(mm);
  };
  const rawEntry = (m: string, id: string): StockEntry => stock[m]?.[id] || emptyEntry();
  const entryFor = (m: string, mm: MaterialDef): StockEntry =>
    mm.sum ? sumEntry(mm.sum.map((id) => stock[m]?.[id])) : rawEntry(m, mm.id);
  const entryOf = (m: string): StockEntry => entryFor(m, mat);

  const setField = (m: string, field: keyof StockEntry, raw: string) => {
    if (readOnly) return;
    const t = raw.replace(/[,\s]/g, '');
    const v = t === '' ? null : Number(t);
    if (v !== null && !Number.isFinite(v)) return;
    setStock((p) => ({ ...p, [m]: { ...(p[m] || {}), [matId]: { ...rawEntry(m, matId), [field]: v } } }));
    setDirty((p) => new Set(p).add(m));
  };

  const save = async () => {
    if (!dirty.size) return;
    setSaving(true); setErr('');
    try {
      const batch = writeBatch(db);
      dirty.forEach((m) => {
        if (m === '_config') batch.set(doc(db, 'containerStock', '_config'), { sources: srcOverride, lossLimit }, { merge: true });
        else batch.set(doc(db, 'containerStock', m), stock[m] || {}, { merge: true });
      });
      await batch.commit();
      setDirty(new Set());
    } catch (e) {
      setErr(`저장 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setSaving(false); }
  };

  const applyPaste = () => {
    if (readOnly) { setErr('합계 행에는 직접 넣을 수 없습니다. 아래 세 자재에 각각 넣으면 자동으로 더해집니다.'); return; }
    // 엑셀에서 복사하면 1,234 처럼 천단위 콤마가 붙어 온다.
    // 탭·줄바꿈·공백이 있으면 그게 칸 구분이고, 콤마는 전부 천단위로 본다.
    // 구분자가 콤마밖에 없을 때(CSV 한 줄)만 콤마로 나눈다.
    const src = pasteText.replace(/\((\s*[\d,.]+\s*)\)/g, '-$1');   // 엑셀 음수 표기 (1,234) → -1234
    const hasSpaceDelim = /[\t\n\r ]/.test(src.trim());
    const nums = (hasSpaceDelim ? src.split(/[\t\n\r ]+/) : src.split(','))
      .map((t) => t.replace(/,/g, '').trim())
      .filter((t) => /^-?\d+(\.\d+)?$/.test(t))
      .map(Number);
    if (!nums.length) { setErr('붙여넣은 내용에서 숫자를 찾지 못했습니다.'); return; }
    setErr('');
    const next = { ...stock };
    const touched = new Set(dirty);
    nums.forEach((v, i) => {
      const mi = pasteStart - 1 + i;
      if (mi > 11) return;
      const m = `${year}-${String(mi + 1).padStart(2, '0')}`;
      const cur = next[m]?.[matId] || emptyEntry();
      next[m] = { ...(next[m] || {}), [matId]: { ...cur, [pasteField]: v } };
      touched.add(m);
    });
    setStock(next); setDirty(touched); setPasteText(''); setPasteOpen(false);
  };

  const entries = useMemo(() => {
    const o: Record<string, StockEntry> = {};
    months.forEach((m) => { o[m] = entryOf(m); });
    return o;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months, stock, matId]);

  const matSpec = specOf(mat);
  const a = useMemo(() => analyze(months, entries, theory, matSpec, lossLimit),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [months, entries, theory, JSON.stringify(matSpec), lossLimit]);

  /* 자재 타일용 요약 (선택 안 된 것도 한눈에) */
  const tiles = useMemo(() => MATERIALS.map((mm) => {
    const e: Record<string, StockEntry> = {};
    months.forEach((m) => { e[m] = entryFor(m, mm); });
    const r = analyze(months, e, theory, specOf(mm), lossLimit);
    return {
      mat: mm, filled: r.filledCount, rate: r.totalLossRate, diff: r.totalDiff,
      bad: r.rows.filter((x) => x.flag === 'bad').length,
      timing: r.rows.filter((x) => x.flag === 'timing').length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [months, stock, theory, lossLimit, srcOverride]);

  const download = async () => {
    const wb = new ExcelJS.Workbook();
    const thin = { style: 'thin' as const, color: { argb: 'FFCBD5E1' } };
    const border = { top: thin, left: thin, right: thin, bottom: thin };
    for (const mm of MATERIALS) {
      const e: Record<string, StockEntry> = {};
      months.forEach((m) => { e[m] = entryFor(m, mm); });
      const r = analyze(months, e, theory, specOf(mm), lossLimit);
      const ws = wb.addWorksheet(mm.label);
      ws.columns = [{ width: 10 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 14 },
        { width: 14 }, { width: 14 }, { width: 13 }, { width: 11 }, { width: 13 }, { width: 12 }, { width: 44 }];
      ws.addRow([`${mm.label} — ${year}년 재고 정합성`
        + (mm.perUnit > 1 ? ` (단위: ${mm.unit} · 1롤 ${mm.perUnit.toLocaleString()}개)` : ` (단위: ${mm.unit})`)]);
      ws.mergeCells('A1:L1');
      ws.getCell('A1').font = { size: 14, bold: true };
      ws.addRow([]);
      const head = ws.addRow(['월', '기초재고', '당월입고', '기말재고', '투입량(계산)',
        '투입량(구매팀)', '투입량(적용)', '이론사용량', '차이', '로스율', '판정', '비고']);
      head.eachCell((c) => {
        c.font = { bold: true }; c.alignment = { horizontal: 'center' };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
        c.border = border;
      });
      r.rows.forEach((x) => {
        const note = x.flag === 'timing' ? `이월오차 — ${x.cluster} 합치면 정상`
          : x.flag === 'bad' ? (x.diff! < 0 ? '이론사용량이 투입량보다 많음 — 확인 필요' : '로스 기준 초과 — 확인 필요')
          : x.flag === 'ok' ? '' : '미입력';
        const row = ws.addRow([`${Number(x.month.slice(5, 7))}월`,
          x.entry.open, x.entry.inbound, x.entry.close, x.calcInput,
          x.entry.input, x.input, x.theory, x.diff, x.lossRate, FLAG_STYLE[x.flag].text, note]);
        row.eachCell((c, i) => {
          c.border = border;
          c.alignment = { horizontal: i === 12 ? 'left' : 'center' };
          if (i >= 2 && i <= 9) c.numFmt = mm.perUnit > 1 ? '#,##0.0' : '#,##0';
          if (i === 10) c.numFmt = '0.00%';
        });
        if (x.flag === 'bad') row.getCell(9).font = { bold: true, color: { argb: 'FFDC2626' } };
        else if (x.flag === 'timing') row.getCell(9).font = { bold: true, color: { argb: 'FFD97706' } };
      });
      const tot = ws.addRow(['합계', null, null, null, null, null, r.totalInput, r.totalTheory,
        r.totalDiff, r.totalLossRate, '', '']);
      tot.eachCell((c, i) => {
        c.border = border; c.font = { bold: true }; c.alignment = { horizontal: 'center' };
        if (i >= 7 && i <= 9) c.numFmt = mm.perUnit > 1 ? '#,##0.0' : '#,##0';
        if (i === 10) c.numFmt = '0.00%';
      });
      ws.addRow([]);
      const fh = ws.addRow(['진단']); fh.font = { bold: true };
      r.findings.forEach((f) => {
        const row = ws.addRow([SEV[f.severity].label, f.title]);
        ws.mergeCells(row.number, 2, row.number, 12);
        row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
        const d = ws.addRow(['', f.detail]);
        ws.mergeCells(d.number, 2, d.number, 12);
        d.getCell(2).alignment = { wrapText: true, vertical: 'top' };
        d.getCell(2).font = { color: { argb: 'FF64748B' }, size: 10 };
      });
      ws.views = [{ state: 'frozen', ySplit: 3 }];
    }
    const buf = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const el = document.createElement('a'); el.href = url; el.download = `용기재고정합성_${year}.xlsx`; el.click();
    URL.revokeObjectURL(url);
  };

  const cell = 'w-full px-1.5 py-1 text-right tabular-nums border rounded text-xs focus:ring-1 focus:ring-blue-400 outline-none';

  return (
    <div className="space-y-4">
      {/* 툴바 */}
      <div className="bg-white border rounded-lg p-3 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <button onClick={() => setYear(year - 1)} className="w-8 h-8 rounded hover:bg-gray-100">◀</button>
          <span className="font-extrabold text-lg tabular-nums">{year}년</span>
          <button onClick={() => setYear(year + 1)} disabled={year >= nowY}
            className="w-8 h-8 rounded hover:bg-gray-100 disabled:text-gray-300">▶</button>
        </div>
        <span className="text-gray-300">|</span>
        <label className="text-xs text-gray-600 flex items-center gap-1">
          정상 로스 기준
          <input type="number" step={0.1} min={0} max={20} value={(lossLimit * 100).toFixed(1)}
            onChange={(e) => { setLossLimit(Math.max(0, Number(e.target.value) || 0) / 100); setDirty((p) => new Set(p).add('_config')); }}
            className="w-16 border rounded px-1.5 py-1 text-right tabular-nums" />%
        </label>
        {busy && <span className="text-xs text-blue-600 font-semibold">{busy}</span>}
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => setPasteOpen((v) => !v)} disabled={readOnly}
            title={readOnly ? '합계 행에는 직접 넣을 수 없습니다' : ''}
            className="px-2.5 py-1.5 text-xs rounded border hover:bg-gray-50 disabled:text-gray-300">📋 엑셀 붙여넣기</button>
          <button onClick={() => loadTheory(missing.length ? missing : months)} disabled={!!busy}
            className="px-2.5 py-1.5 text-xs rounded border hover:bg-gray-50 disabled:text-gray-300">
            {missing.length ? `📊 생산량 불러오기 (${missing.length}개월)` : '🔄 생산량 다시 계산'}
          </button>
          <button onClick={download} disabled={!!busy}
            className="px-2.5 py-1.5 text-xs rounded border hover:bg-gray-50">📥 엑셀</button>
          <button onClick={save} disabled={!dirty.size || saving}
            className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white font-bold hover:bg-blue-700 disabled:bg-gray-300">
            {saving ? '저장 중…' : dirty.size ? `저장 (${dirty.size}개월)` : '저장됨'}
          </button>
        </div>
        <div className="w-full text-xs">
          {dirty.size > 0 ? (
            <span className="text-amber-700 font-semibold">
              ⚠ 아직 저장 안 된 입력이 있습니다 — <b>저장</b>을 눌러야 다른 사람 화면에도 보입니다.
            </span>
          ) : (
            <span className="text-gray-400">
              입력값은 저장하면 회사 DB 에 올라가 모두가 같은 숫자를 봅니다. 생산량(이론사용량)도 한 번 계산해 두면 모두가 같이 씁니다.
            </span>
          )}
        </div>
      </div>

      {err && <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">{err}</div>}

      {pasteOpen && (
        <div className="bg-slate-50 border rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <b className="text-gray-700">{mat.label}</b>
            <select value={pasteField} onChange={(e) => setPasteField(e.target.value as keyof StockEntry)}
              className="border rounded px-2 py-1">
              <option value="input">투입량 (구매팀 값)</option>
              <option value="open">기초재고</option>
              <option value="inbound">당월입고</option>
              <option value="close">기말재고</option>
            </select>
            <span className="text-gray-500">를</span>
            <select value={pasteStart} onChange={(e) => setPasteStart(Number(e.target.value))}
              className="border rounded px-2 py-1">
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}월</option>)}
            </select>
            <span className="text-gray-500">부터 순서대로 채웁니다. 엑셀에서 가로 한 줄을 그대로 복사해 붙여넣으세요. <b>(1,234)</b> 같은 괄호 음수도 인식합니다.</span>
          </div>
          <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={3}
            placeholder={'342,466\t360,372\t334,896\t…'}
            className="w-full border rounded p-2 text-sm font-mono" />
          <div className="flex gap-2">
            <button onClick={applyPaste} disabled={!pasteText.trim()}
              className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white font-bold disabled:bg-gray-300">채우기</button>
            <button onClick={() => { setPasteOpen(false); setPasteText(''); }}
              className="px-3 py-1.5 text-xs rounded border">취소</button>
          </div>
        </div>
      )}

      {/* 자재 타일 — 용기 한 줄, 필름 한 줄 */}
      {(['용기', '필름'] as const).map((g) => (
        <div key={g}>
          <div className="text-xs font-bold text-gray-500 mb-1.5 px-0.5">{g}</div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {tiles.filter((t) => t.mat.group === g).map((t) => {
              const on = t.mat.id === matId;
              return (
                <button key={t.mat.id} onClick={() => setMatId(t.mat.id)}
                  className={`text-left rounded-xl p-3.5 border-2 transition ${
                    on ? 'border-blue-500 bg-blue-50/60 shadow-sm'
                       : t.mat.sum ? 'border-gray-300 bg-slate-50 hover:border-gray-400'
                       : 'border-gray-200 bg-white hover:border-gray-300'}`}>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-bold text-gray-800 text-sm">{t.mat.label}</span>
                    {t.mat.perUnit > 1 && !t.mat.sum && (
                      <span className="text-[10px] text-gray-400 font-normal">1롤 {nf(t.mat.perUnit)}개</span>
                    )}
                    {t.mat.sum && <span className="px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600 text-[10px] font-bold">자동합산</span>}
                    {t.bad > 0 && <span className="px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[10px] font-bold">이상 {t.bad}</span>}
                    {t.bad === 0 && t.timing > 0 && <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold">이월 {t.timing}</span>}
                    {t.bad === 0 && t.timing === 0 && t.filled > 0 && <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">정상</span>}
                  </div>
                  {t.filled === 0 ? (
                    <div className="text-2xl font-extrabold text-gray-300 mt-1">미입력</div>
                  ) : (
                    <>
                      <div className={`text-3xl font-extrabold tabular-nums mt-1 ${
                        t.rate === null ? 'text-gray-400' : t.rate < 0 ? 'text-red-600' : t.rate > lossLimit ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {pctS(t.rate)}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        누적 로스율 · {mk(t.mat.perUnit > 1 ? 1 : 0)(t.diff)}{t.mat.unit} · {t.filled}개월
                      </div>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* 요약 4카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label={`투입량 합계 (${mat.unit})`} sub="재고조사 기준 실제 소모" v={un(a.totalInput)} />
        <Card label={`이론사용량 합계 (${mat.unit})`}
          sub={mat.perUnit > 1 ? `생산량 ÷ ${nf(mat.perUnit)}개(1롤) · 로스 0%` : '생산량 기준 · 로스 0%'}
          v={un(a.totalTheory)} />
        <Card label="실질 로스" sub={`투입 − 이론 (${mat.unit})`}
          v={usgn(a.totalDiff)} tone={a.totalDiff < 0 ? 'bad' : 'ok'} />
        <Card label="누적 로스율" sub={`기준 ${(lossLimit * 100).toFixed(1)}% 이내면 정상`}
          v={pctS(a.totalLossRate)}
          tone={a.totalLossRate === null ? undefined : a.totalLossRate < 0 ? 'bad' : a.totalLossRate > lossLimit ? 'warn' : 'ok'} />
      </div>

      {missing.length > 0 && (
        <div className="bg-sky-50 border border-sky-300 rounded-lg p-3 text-sm text-sky-800">
          📊 이론사용량이 아직 없는 달이 {missing.length}개 있습니다 ({missing.map((m) => `${Number(m.slice(5, 7))}월`).join(', ')}).
          위의 <b>「생산량 불러오기」</b>를 누르면 생산 데이터에서 자동으로 계산합니다. 한 번 계산하면 회사 DB 에 올라가 <b>다른 사람 컴퓨터에서도 그대로</b> 보입니다.
        </div>
      )}

      {unknownTotal > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800">
          ⚠ 제품 DB 에 없어 용기 구분을 못 한 생산량이 <b>{nf(unknownTotal)}개</b> 있습니다
          ({unknownMonths.map((m) => `${Number(m.slice(5, 7))}월`).join(', ')}).
          그만큼 <b>이론사용량이 실제보다 적게</b> 잡혀 차이가 부풀려집니다.
          설정 → 제품 DB 에 해당 코드를 등록하면 자동으로 반영됩니다. 어느 품목인지는 <b>「월별 사용량」 탭</b>에서 미분류로 확인할 수 있습니다.
        </div>
      )}

      {/* 그래프 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
          <span className="font-bold text-gray-800 text-sm">{mat.label} · 월별 차이와 누적 <span className="text-xs font-normal text-gray-400">({mat.unit})</span></span>
          <span className="ml-auto flex items-center gap-3 text-[11px] text-gray-600">
            <Legend c="#10b981" t="정상" /><Legend c="#f59e0b" t="이월오차" /><Legend c="#ef4444" t="이상" />
            <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-slate-800" />누적</span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-emerald-500/10 border border-emerald-300" />정상 로스 범위</span>
          </span>
        </div>
        <div className="p-3">
          <DiffChart rows={a.rows} lossLimit={lossLimit} dec={dec} />
          <p className="text-xs text-gray-500 mt-1 px-1">
            막대 = 그 달 <b>투입량 − 이론사용량</b>. 굵은 선 = 누적. <b>막대가 0 아래(음수)</b>면 용기를 쓰지 않고 제품을 만들었다는 뜻이라 불가능한 값입니다.
            막대가 위아래로 톱니처럼 흔들려도 <b>누적선이 완만하게 우상향</b>하면 총량은 맞습니다 — 한 달 기말재고 오차가 다음 달에 되돌아온 것뿐입니다.
          </p>
        </div>
      </div>

      {/* 진단 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 font-bold text-gray-800 text-sm">
          자동 진단 <span className="text-xs text-gray-500 font-normal">· {mat.label} · 심각한 순</span>
        </div>
        {a.findings.length === 0 ? (
          <div className="p-10 text-center text-gray-400 text-sm">
            {a.filledCount === 0 ? '재고조사 값을 입력하면 자동으로 분석합니다.' : '짚을 것이 없습니다.'}
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {a.findings.map((f, i) => (
              <div key={i} className={`border rounded-lg overflow-hidden flex ${SEV[f.severity].bg}`}>
                <div className={`w-1.5 shrink-0 ${SEV[f.severity].bar}`} />
                <div className="p-3">
                  <div className="font-bold text-gray-800 text-sm">{SEV[f.severity].icon} {f.title}</div>
                  <div className="text-xs text-gray-600 mt-1 leading-relaxed">{f.detail}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 입력 표 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
          <span className="font-bold text-gray-800 text-sm">{mat.label} · 월별 입력</span>
          <span className="text-xs text-gray-500">
            {readOnly
              ? `${mat.sum!.map((id) => MATERIALS.find((x) => x.id === id)!.label).join(' + ')} 을 그대로 더한 값입니다. 고치려면 각 자재에서 수정하세요.`
              : '기초·입고·기말을 넣으면 투입량이 자동 계산됩니다. 구매팀 투입량만 있으면 그 칸만 채우세요.'}
          </span>
          {!readOnly && (
            <label className="ml-auto text-xs text-gray-600 flex items-center gap-1.5">
              이론사용량 기준
              <select value={(srcOverride[mat.id] || mat.source)}
                onChange={(e) => { setSrcOverride((p) => ({ ...p, [mat.id]: e.target.value as TheorySource })); setDirty((p) => new Set(p).add('_config')); }}
                className="border rounded px-2 py-1 text-xs">
                {(Object.keys(SOURCE_LABEL) as TheorySource[]).map((k) => (
                  <option key={k} value={k}>{SOURCE_LABEL[k]}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-gray-600">
              <tr>
                <th className="px-2 py-2 w-14">월</th>
                <th className="px-2 py-2 w-24">기초재고</th>
                <th className="px-2 py-2 w-24">당월입고</th>
                <th className="px-2 py-2 w-24">기말재고</th>
                <th className="px-2 py-2 w-24 text-right">투입량<div className="text-[10px] font-normal text-gray-400">기초+입고−기말</div></th>
                <th className="px-2 py-2 w-24">투입량<div className="text-[10px] font-normal text-gray-400">구매팀 직접</div></th>
                <th className="px-2 py-2 w-24 text-right">이론사용량<div className="text-[10px] font-normal text-gray-400">{mat.unit}</div></th>
                <th className="px-2 py-2 w-24 text-right">차이</th>
                <th className="px-2 py-2 w-20 text-right">로스율</th>
                <th className="px-2 py-2 w-24">판정</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {a.rows.map((r) => {
                const e = r.entry;
                const mismatch = e.input !== null && r.calcInput !== null && e.input !== r.calcInput;
                return (
                  <tr key={r.month} className={dirty.has(r.month) ? 'bg-blue-50/50' : 'hover:bg-slate-50/60'}>
                    <td className="px-2 py-1 text-center font-bold text-gray-700">{Number(r.month.slice(5, 7))}월</td>
                    {(['open', 'inbound', 'close'] as const).map((f) => (
                      <td key={f} className="px-1.5 py-1">
                        <input value={e[f] === null ? '' : e[f]!.toLocaleString()} onChange={(ev) => setField(r.month, f, ev.target.value)}
                          inputMode="numeric" disabled={readOnly}
                          className={`${cell} ${readOnly ? 'bg-slate-100 text-gray-600' : ''}`} />
                      </td>
                    ))}
                    <td className={`px-2 py-1 text-right tabular-nums ${mismatch ? 'text-amber-600 font-bold' : 'text-gray-500'}`}>
                      {r.calcInput === null ? '—' : nf(r.calcInput)}
                    </td>
                    <td className="px-1.5 py-1">
                      <input value={e.input === null ? '' : e.input.toLocaleString()} onChange={(ev) => setField(r.month, 'input', ev.target.value)}
                        inputMode="numeric" disabled={readOnly}
                        className={`${cell} ${readOnly ? 'bg-slate-100 text-gray-600' : e.input !== null ? 'bg-blue-50/60 font-semibold' : ''}`} />
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-700">
                      {r.theory === null ? <span className="text-gray-300">미계산</span> : un(r.theory)}
                    </td>
                    <td className={`px-2 py-1 text-right tabular-nums font-bold ${
                      r.diff === null ? 'text-gray-300' : r.diff < 0 ? 'text-red-600' : 'text-gray-800'}`}>
                      {r.diff === null ? '—' : usgn(r.diff)}
                    </td>
                    <td className={`px-2 py-1 text-right tabular-nums ${
                      r.lossRate === null ? 'text-gray-300' : r.lossRate < 0 ? 'text-red-600' : r.lossRate > lossLimit ? 'text-amber-600' : 'text-gray-600'}`}>
                      {pctS(r.lossRate)}
                    </td>
                    <td className="px-2 py-1 text-center">
                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${FLAG_STYLE[r.flag].chip}`}>
                        {FLAG_STYLE[r.flag].text}{r.flag === 'timing' && r.cluster ? ` ${r.cluster}` : ''}
                      </span>
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-slate-50 font-bold">
                <td className="px-2 py-2 text-center">합계</td>
                <td colSpan={5} />
                <td className="px-2 py-2 text-right tabular-nums">{un(a.totalTheory)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${a.totalDiff < 0 ? 'text-red-600' : 'text-gray-800'}`}>{usgn(a.totalDiff)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{pctS(a.totalLossRate)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 읽는 법 */}
      <details className="bg-white border rounded-lg">
        <summary className="px-4 py-2.5 cursor-pointer font-bold text-gray-800 text-sm select-none">📖 읽는 방법</summary>
        <div className="px-4 pb-4 text-xs text-gray-600 space-y-2 leading-relaxed">
          <p><b>1) 투입량</b> = 기초재고 + 당월입고 − 기말재고. 창고에서 실제로 빠져나간 수량입니다.
            구매팀에서 받은 값이 있으면 오른쪽 칸에 넣으세요. 둘 다 넣으면 서로 맞는지 자동으로 대조합니다.</p>
          <p><b>2-1) 필름 기준.</b> 필름은 용기 구분이 아니라 호기로 갈립니다 — 1·2호기가 2열기, 3호기가 4열기,
            레토르트는 실온 생산량입니다. 잔여량만 있고 호기 입력이 없는 날은 어느 호기인지 알 수 없는데,
            그런 수량은 <b>2열기(1·2호기)로 잡습니다</b>.
            그리고 필름은 롤로 세므로 <b>생산량 ÷ 롤당 포장수</b>가 이론사용량입니다 —
            2열 필름은 1롤 6,450개, 4열 필름은 1롤 12,900개입니다.
            반쯤 쓴 롤을 어느 달로 세느냐에 따라 한 롤이 통째로 움직이므로, <b>±1롤은 정상으로 봅니다</b>.</p>
          <p><b>2) 이론사용량</b> = 그 달 생산량(EA). 1개 만들면 용기 1개니까, 로스가 0%일 때 써야 할 최소 수량입니다.
            용기분석 첫 탭의 숫자와 같은 계산입니다.</p>
          <p><b>3) 차이 = 투입 − 이론</b> 은 <b>항상 0 이상</b>이어야 합니다. 파손·시운전·불량만큼 더 쓰니까요.
            <span className="text-red-600 font-semibold"> 음수면 용기 없이 제품을 만들었다는 뜻이라 물리적으로 불가능</span>하고,
            재고조사·입고·생산량 중 하나가 틀린 것입니다.</p>
          <p><b>4) 이월오차 판정.</b> 한 달이 크게 음수인데 옆 달이 그만큼 양수라면 수량이 틀린 게 아닙니다.
            <b>어느 한 달의 기말재고가 틀리면 그 값이 그대로 다음 달 기초재고가 되기 때문에</b>,
            오차가 다음 달에 반대 부호로 되돌아옵니다 — 실사 날짜와는 상관없이 생기는 현상입니다.
            이 도구는 최대 3개월까지 합쳐 보고, 합쳐서 정상 범위로 돌아오면 <span className="text-amber-600 font-semibold">이월오차</span>로 표시하고
            <b>오차가 처음 생긴 달</b>을 짚어 줍니다. 그 달의 실사표와 월말 입고 전표를 보시면 됩니다.</p>
          <p><b>5) 누적선이 진짜 답입니다.</b> 월별 막대는 한 달치 오차가 되돌아오며 흔들리지만, 누적은 상쇄되어 남습니다.
            누적선이 완만하게 우상향하면 정상, 계속 아래로 내려가면 입고 누락이나 생산량 과다집계를 의심하세요.</p>
          <p><b>6) 기초재고 연속성.</b> 이번 달 기초재고는 지난달 기말재고와 같아야 합니다. 다르면 장부가 끊긴 것이라
            그 달 투입량 자체를 믿을 수 없어 <span className="text-red-600 font-semibold">가장 먼저</span> 짚어 줍니다.</p>
        </div>
      </details>
    </div>
  );
}

function Legend({ c, t }: { c: string; t: string }) {
  return <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: c }} />{t}</span>;
}

function Card({ label, sub, v, tone }: { label: string; sub: string; v: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const c = tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : tone === 'ok' ? 'text-emerald-600' : 'text-gray-800';
  return (
    <div className="bg-white border rounded-xl p-4">
      <div className="text-xs text-gray-500 font-semibold">{label}</div>
      <div className={`text-3xl font-extrabold tabular-nums mt-1 ${c}`}>{v}</div>
      <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>
    </div>
  );
}
