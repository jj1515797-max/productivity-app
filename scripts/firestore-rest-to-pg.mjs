/**
 * Firestore → PostgreSQL SQL 덤프 (REST API, API 키)
 *
 *  - 루트 컬렉션: documents.list (pageSize=300 + pageToken 페이징)
 *  - 서브컬렉션 : runQuery(allDescendants) + __name__ 커서 페이징
 *  - 테이블명   : 경로에서 문서ID 세그먼트를 접음 (days/{d}/items → days__items)
 *
 *  주의: listCollectionIds 는 API 키로 403(관리자 권한 필요) → 컬렉션 자동탐색 불가.
 *        아래 후보 목록은 코드베이스에서 추출한 것이며, 코드에 없는 컬렉션은 누락될 수 있음.
 */
const KEY = 'AIzaSyB2NvRGbKLOHrhBcUKOoiAzwCNpBxTrmPQ';
const PID = 'fp-01-b64f7';
const BASE = `https://firestore.googleapis.com/v1/projects/${PID}/databases/(default)/documents`;

// 루트 컬렉션 후보 (코드 참조 + 레거시/고아 데이터 포함한 superset)
const ROOTS = [
  'productSettings', 'materials', 'recipes', 'subRecipes', 'ambientRecipes',
  'materialPrices', 'materialPricesInventory', 'materialPricesMonthly', 'materialOutflow',
  'materialErpCodes', 'supplierCodes', 'members', 'productivity',
  'monthlyStats', 'monthlyMeta', 'under10Manual', 'visits',
  'attendanceSnapshot', 'attendanceMeta', 'analyticsGraphs',
  'appMeta', 'settings', 'purchaseInbound',
];
// 서브컬렉션 ID (컬렉션그룹 쿼리로 전량 수집)
const GROUPS = ['items', 'logistics', 'ambient', 'scoop', 'scoopFlags', 'entries', 'records', 'movements', 'requests'];
// config_docs 로 보낼 설정성 최상위 컬렉션
const CONFIG_COLLECTIONS = new Set(['appMeta', 'settings']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, init, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, init);
    if (res.ok) return res.json();
    if (res.status === 403 || res.status === 404) return { __err: res.status };
    await sleep(500 * (i + 1));
    if (i === tries - 1) throw new Error(`${res.status} ${url.slice(0, 120)} ${await res.text()}`);
  }
}

/** 경로 → 테이블명: 짝수 인덱스(컬렉션) 세그먼트만 이어붙임 */
function tableName(docPath) {
  const segs = docPath.split('/');
  return segs.filter((_, i) => i % 2 === 0).join('__').replace(/[^A-Za-z0-9_]/g, '_');
}
function pathAfterDocuments(name) {
  return name.split('/documents/')[1];
}

/** Firestore value → { kind, js } */
function decode(v) {
  if (v === null || v === undefined) return { kind: 'null', js: null };
  if ('nullValue' in v) return { kind: 'null', js: null };
  if ('booleanValue' in v) return { kind: 'bool', js: v.booleanValue };
  if ('integerValue' in v) return { kind: 'int', js: v.integerValue };
  if ('doubleValue' in v) return { kind: 'double', js: v.doubleValue };
  if ('stringValue' in v) return { kind: 'text', js: v.stringValue };
  if ('timestampValue' in v) return { kind: 'text', js: v.timestampValue };
  if ('referenceValue' in v) return { kind: 'text', js: v.referenceValue };
  if ('bytesValue' in v) return { kind: 'text', js: v.bytesValue };
  if ('geoPointValue' in v) return { kind: 'json', js: v.geoPointValue };
  if ('arrayValue' in v) return { kind: 'json', js: (v.arrayValue.values || []).map((x) => decode(x).js) };
  if ('mapValue' in v) {
    const o = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = decode(val).js;
    return { kind: 'json', js: o };
  }
  return { kind: 'json', js: v };
}

const tables = new Map(); // tname → { rows:[], kinds: Map<col, Set<kind>> }
function addDoc(name, fields) {
  const docPath = pathAfterDocuments(name);
  const segs = docPath.split('/');
  const docId = segs[segs.length - 1];
  const rootCol = segs[0];
  const isConfig = CONFIG_COLLECTIONS.has(rootCol);
  const tname = isConfig ? 'config_docs' : tableName(docPath);

  if (!tables.has(tname)) tables.set(tname, { rows: [], kinds: new Map() });
  const t = tables.get(tname);

  if (isConfig) {
    const data = {};
    for (const [k, v] of Object.entries(fields || {})) data[k] = decode(v).js;
    t.rows.push({ doc_path: docPath, doc_id: docId, data: { kind: 'json', js: data } });
    t.kinds.set('data', new Set(['json']));
    return;
  }
  const row = { doc_path: docPath, doc_id: docId };
  for (const [k, v] of Object.entries(fields || {})) {
    const d = decode(v);
    row[k] = d;
    if (!t.kinds.has(k)) t.kinds.set(k, new Set());
    if (d.kind !== 'null') t.kinds.get(k).add(d.kind);
  }
  t.rows.push(row);
}

async function pullRoot(col) {
  let token = null, n = 0;
  do {
    const url = `${BASE}/${col}?pageSize=300&key=${KEY}` + (token ? `&pageToken=${encodeURIComponent(token)}` : '');
    const j = await req(url);
    if (j.__err) { console.error(`  ! ${col}: HTTP ${j.__err}`); return 0; }
    (j.documents || []).forEach((d) => { addDoc(d.name, d.fields); n++; });
    token = j.nextPageToken || null;
  } while (token);
  console.error(`  · ${col}: ${n}`);
  return n;
}

async function pullGroup(cid) {
  let cursor = null, n = 0;
  for (;;) {
    const q = {
      structuredQuery: {
        from: [{ collectionId: cid, allDescendants: true }],
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        limit: 500,
        ...(cursor ? { startAt: { values: [{ referenceValue: cursor }], before: false } } : {}),
      },
    };
    const j = await req(`${BASE}:runQuery?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q),
    });
    if (j.__err) { console.error(`  ! ${cid}: HTTP ${j.__err}`); return 0; }
    const docs = (Array.isArray(j) ? j : []).filter((x) => x.document).map((x) => x.document);
    if (docs.length === 0) break;
    docs.forEach((d) => { addDoc(d.name, d.fields); n++; });
    cursor = docs[docs.length - 1].name;
    if (docs.length < 500) break;
  }
  console.error(`  · [group] ${cid}: ${n}`);
  return n;
}

/* ---------- SQL 생성 ---------- */
function pgType(kinds) {
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
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
function lit(cell, type) {
  if (cell === undefined || cell === null || cell.js === null || cell.js === undefined) return 'NULL';
  const v = cell.js;
  if (type === 'JSONB') return `${q(JSON.stringify(v))}::jsonb`;
  if (type === 'BIGINT' || type === 'NUMERIC') {
    if (cell.kind === 'json' || cell.kind === 'bool') return q(JSON.stringify(v));
    return String(v);
  }
  if (type === 'BOOLEAN') return cell.kind === 'bool' ? (v ? 'TRUE' : 'FALSE') : 'NULL';
  if (cell.kind === 'json') return q(JSON.stringify(v));
  return q(v);
}

async function main() {
  console.error('== 루트 컬렉션 ==');
  for (const c of ROOTS) await pullRoot(c);
  console.error('== 서브컬렉션(컬렉션그룹) ==');
  for (const g of GROUPS) await pullGroup(g);

  const out = [];
  const stamp = new Date().toISOString();
  out.push(`-- 순수본 1공장 MES — Firestore → PostgreSQL 전체 덤프`);
  out.push(`-- project: ${PID}   generated: ${stamp}`);
  out.push(`-- 주의: listCollectionIds(403)로 컬렉션 자동탐색 불가 → 코드베이스 기반 목록으로 수집함`);
  out.push(`SET client_encoding = 'UTF8';`);
  out.push(`BEGIN;`);
  out.push('');

  const stats = [];
  const names = [...tables.keys()].sort();
  for (const tname of names) {
    const t = tables.get(tname);
    const cols = [];
    const seen = new Set();
    for (const r of t.rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    const dataCols = cols.filter((c) => c !== 'doc_path' && c !== 'doc_id');
    const typeOf = {};
    dataCols.forEach((c) => { typeOf[c] = pgType(t.kinds.get(c)); });

    // doc_id 가 테이블 내 유일하면 PK, 아니면(서브컬렉션 병합) doc_path 를 PK
    const ids = new Set(t.rows.map((r) => r.doc_id));
    const pkIsDocId = ids.size === t.rows.length;

    out.push(`DROP TABLE IF EXISTS "${tname}" CASCADE;`);
    const defs = [
      `  "doc_id" TEXT NOT NULL${pkIsDocId ? ' PRIMARY KEY' : ''}`,
      `  "doc_path" TEXT NOT NULL${pkIsDocId ? '' : ' PRIMARY KEY'}`,
      ...dataCols.map((c) => `  "${c}" ${typeOf[c]}`),
    ];
    out.push(`CREATE TABLE "${tname}" (\n${defs.join(',\n')}\n);`);

    const allCols = ['doc_id', 'doc_path', ...dataCols];
    const colList = allCols.map((c) => `"${c}"`).join(', ');
    let inserts = 0;
    for (let i = 0; i < t.rows.length; i += 500) {
      const chunk = t.rows.slice(i, i + 500);
      const vals = chunk.map((r) => {
        const cells = allCols.map((c) => {
          if (c === 'doc_id') return q(r.doc_id);
          if (c === 'doc_path') return q(r.doc_path);
          return lit(r[c], typeOf[c]);
        });
        return `  (${cells.join(', ')})`;
      });
      out.push(`INSERT INTO "${tname}" (${colList}) VALUES\n${vals.join(',\n')};`);
      inserts++;
    }
    if (dataCols.includes('date')) {
      out.push(`CREATE INDEX "idx_${tname}_date" ON "${tname}" ("date");`);
    }
    out.push('');
    stats.push({ table: tname, rows: t.rows.length, cols: allCols.length, inserts, pk: pkIsDocId ? 'doc_id' : 'doc_path', dateIdx: dataCols.includes('date') });
  }

  out.push(`COMMIT;`);
  const sql = out.join('\n') + '\n';
  const { writeFileSync } = await import('fs');
  const outPath = process.argv[2] || './ssbon_firestore_pg.sql';
  writeFileSync(outPath, sql, 'utf8');
  writeFileSync('./dump_stats.json', JSON.stringify(stats, null, 2), 'utf8');
  console.error(`\n완료 → ${outPath}`);
  console.error(`테이블 ${stats.length}개 / 총 ${stats.reduce((s, x) => s + x.rows, 0)} 행`);
}
main().catch((e) => { console.error('실패:', e); process.exit(1); });
