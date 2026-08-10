/**
 * Firestore 문서 → PostgreSQL DDL/INSERT 생성기 (순수 로직, 외부 의존성 없음)
 * firestore-to-pg.mjs 가 이 모듈을 사용하고, pg-sql-gen.test.mjs 가 실제 PostgreSQL 로 검증한다.
 */

/** 경로에서 문서ID 세그먼트를 접어 테이블명 생성: days/{d}/items → days__items */
export const tableName = (docPath) =>
  docPath.split('/').filter((_, i) => i % 2 === 0).join('__').replace(/[^A-Za-z0-9_]/g, '_');

/** Firestore/JS 값 → { kind, js } (배열·객체는 구조 그대로 유지) */
export function decode(v) {
  if (v === null || v === undefined) return { kind: 'null', js: null };
  if (typeof v === 'boolean') return { kind: 'bool', js: v };
  if (typeof v === 'number') return { kind: Number.isInteger(v) ? 'int' : 'double', js: v };
  if (typeof v === 'string') return { kind: 'text', js: v };
  if (typeof v?.toDate === 'function') return { kind: 'text', js: v.toDate().toISOString() };  // Timestamp
  if (v instanceof Date) return { kind: 'text', js: v.toISOString() };
  if (typeof v?.latitude === 'number' && typeof v?.longitude === 'number')
    return { kind: 'json', js: { lat: v.latitude, lng: v.longitude } };                         // GeoPoint
  if (typeof v?.path === 'string' && typeof v?.id === 'string') return { kind: 'text', js: v.path }; // DocumentReference
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return { kind: 'text', js: v.toString('base64') };
  if (Array.isArray(v)) return { kind: 'json', js: v.map((x) => decode(x).js) };
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = decode(val).js;
    return { kind: 'json', js: o };
  }
  return { kind: 'text', js: String(v) };
}

/** 관찰된 kind 집합 → PostgreSQL 타입 */
export function pgType(kinds) {
  if (!kinds || kinds.size === 0) return 'TEXT';
  if (kinds.has('json')) return 'JSONB';
  if (kinds.size === 1) {
    if (kinds.has('int')) return 'BIGINT';
    if (kinds.has('double')) return 'NUMERIC';
    if (kinds.has('bool')) return 'BOOLEAN';
    return 'TEXT';
  }
  if ([...kinds].every((k) => k === 'int' || k === 'double')) return 'NUMERIC';
  return 'TEXT';
}

export const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function lit(cell, type) {
  if (!cell || cell.js === null || cell.js === undefined) return 'NULL';
  const v = cell.js;
  if (type === 'JSONB') return `${q(JSON.stringify(v))}::jsonb`;
  if (type === 'BIGINT' || type === 'NUMERIC')
    return (cell.kind === 'int' || cell.kind === 'double') ? String(v) : q(JSON.stringify(v));
  if (type === 'BOOLEAN') return cell.kind === 'bool' ? (v ? 'TRUE' : 'FALSE') : 'NULL';
  return q(cell.kind === 'json' ? JSON.stringify(v) : v);
}

/**
 * SQL 구조 검증.
 * 주의: 문자열 리터럴 안에 괄호·따옴표가 그대로 들어있으므로(예: "한우(볶음)-후"),
 *       리터럴을 먼저 제거한 뒤에 균형을 세야 의미가 있다.
 */
export function validateSql(sql) {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");   // 문자열 리터럴 제거
  const open = (stripped.match(/\(/g) || []).length;
  const close = (stripped.match(/\)/g) || []).length;
  const quotesLeft = (stripped.match(/'/g) || []).length;  // 짝수여야 함(모두 '' 로 치환됨)
  return {
    nCreate: (sql.match(/^CREATE TABLE /gm) || []).length,
    nDrop: (sql.match(/^DROP TABLE /gm) || []).length,
    nInsert: (sql.match(/^INSERT INTO /gm) || []).length,
    nIndex: (sql.match(/^CREATE INDEX /gm) || []).length,
    parenBalanced: open === close,
    quotesBalanced: quotesLeft % 2 === 0,
    wrapped: /^BEGIN;$/m.test(sql) && /^COMMIT;$/m.test(sql),
    open, close,
  };
}

/** 수집기: addDoc 으로 문서를 넣고 build() 로 SQL 문자열을 얻는다 */
export function createCollector({ configCollections = new Set(['appMeta', 'settings', '_config']), batchSize = 500 } = {}) {
  const tables = new Map();
  let docCount = 0;

  function addDoc(docPath, data) {
    const segs = docPath.split('/');
    const docId = segs[segs.length - 1];
    const isConfig = configCollections.has(segs[0]);
    const tname = isConfig ? 'config_docs' : tableName(docPath);
    if (!tables.has(tname)) tables.set(tname, { rows: [], kinds: new Map() });
    const t = tables.get(tname);
    docCount++;

    if (isConfig) {
      const obj = {};
      for (const [k, v] of Object.entries(data || {})) obj[k] = decode(v).js;
      t.rows.push({ doc_id: docId, doc_path: docPath, data: { kind: 'json', js: obj } });
      t.kinds.set('data', new Set(['json']));
      return;
    }
    const row = { doc_id: docId, doc_path: docPath };
    for (const [k, v] of Object.entries(data || {})) {
      const d = decode(v);
      row[k] = d;
      if (!t.kinds.has(k)) t.kinds.set(k, new Set());
      if (d.kind !== 'null') t.kinds.get(k).add(d.kind);
    }
    t.rows.push(row);
  }

  function build({ header = '' } = {}) {
    const out = [];
    out.push(`-- 순수본 1공장 MES — Firestore 전체 덤프 (PostgreSQL)`);
    out.push(`-- ${header}`);
    out.push(`-- 컬렉션 1:1 이관 · 원본 경로는 doc_path 보존 · 배열/객체는 JSONB 원본 유지`);
    out.push(`SET client_encoding = 'UTF8';`);
    out.push(`BEGIN;`, '');

    const stats = [];
    for (const tname of [...tables.keys()].sort()) {
      const t = tables.get(tname);
      const cols = [];
      const seen = new Set();
      for (const r of t.rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
      const dataCols = cols.filter((c) => c !== 'doc_id' && c !== 'doc_path');
      const typeOf = Object.fromEntries(dataCols.map((c) => [c, pgType(t.kinds.get(c))]));
      const pkIsDocId = new Set(t.rows.map((r) => r.doc_id)).size === t.rows.length;

      out.push(`DROP TABLE IF EXISTS "${tname}" CASCADE;`);
      out.push(`CREATE TABLE "${tname}" (\n` + [
        `  "doc_id" TEXT NOT NULL${pkIsDocId ? ' PRIMARY KEY' : ''}`,
        `  "doc_path" TEXT NOT NULL${pkIsDocId ? '' : ' PRIMARY KEY'}`,
        ...dataCols.map((c) => `  "${c}" ${typeOf[c]}`),
      ].join(',\n') + `\n);`);

      const allCols = ['doc_id', 'doc_path', ...dataCols];
      const colList = allCols.map((c) => `"${c}"`).join(', ');
      let inserts = 0;
      for (let i = 0; i < t.rows.length; i += batchSize) {
        const vals = t.rows.slice(i, i + batchSize).map((r) =>
          '  (' + allCols.map((c) =>
            c === 'doc_id' ? q(r.doc_id) : c === 'doc_path' ? q(r.doc_path) : lit(r[c], typeOf[c])
          ).join(', ') + ')');
        out.push(`INSERT INTO "${tname}" (${colList}) VALUES\n${vals.join(',\n')};`);
        inserts++;
      }
      if (dataCols.includes('date')) out.push(`CREATE INDEX "idx_${tname}_date" ON "${tname}" ("date");`);
      out.push('');
      stats.push({ table: tname, rows: t.rows.length, cols: allCols.length, inserts, pk: pkIsDocId ? 'doc_id' : 'doc_path', types: typeOf });
    }
    out.push(`COMMIT;`);
    return { sql: out.join('\n') + '\n', stats, docCount };
  }

  return { addDoc, build, tables };
}
