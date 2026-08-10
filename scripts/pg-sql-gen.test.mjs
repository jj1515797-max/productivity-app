/**
 * pg-sql-gen 검증 — 합성 데이터로 SQL 생성 후 실제 PostgreSQL 에 적재하고 건수·값을 대조한다.
 * 실행:  node scripts/pg-sql-gen.test.mjs <psql경로> <접속인자...>
 *   예)  node scripts/pg-sql-gen.test.mjs /usr/lib/postgresql/16/bin/psql -h /tmp -p 5433 -U postgres
 */
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { createCollector, validateSql } from '../src/lib/pgSqlGen.mjs';

const PSQL = process.argv[2] || 'psql';
const CONN = process.argv.slice(3);
const SQL_PATH = '/tmp/pg_sql_gen_test.sql';
const DB = 'ssbon_gen_test';

const c = createCollector({ batchSize: 500 });

/* ── 엣지 케이스 데이터 ────────────────────────────────────────── */
// 1) 타입 판정: 정수 / 실수 / 정수+실수 혼합 / 불리언 / 문자열 / 타입혼합
c.addDoc('typing/d1', { i: 10, f: 1.5, mix: 3, b: true, s: 'a', clash: 1 });
c.addDoc('typing/d2', { i: 20, f: 2.5, mix: 4.25, b: false, s: 'b', clash: 'text' });
c.addDoc('typing/d3', { i: 30, f: 3.5, mix: 5, b: true, s: 'c', clash: true });

// 2) 문자열 이스케이프: 작은따옴표, 백슬래시, 개행, 유니코드/이모지, SQL 주입 흉내
c.addDoc('escaping/e1', {
  quote: "한우(볶음)-후,완료기 'test'",
  backslash: 'C:\\path\\to\\file',
  newline: 'line1\nline2\ttab',
  unicode: '순수본 🍲 미음',
  injection: "'); DROP TABLE typing; --",
});

// 3) 배열·객체 → JSONB 원본 보존 (중첩 포함)
c.addDoc('nested/n1', {
  arr: [1, 2, 3],
  strArr: ['3mm', '5mm'],
  obj: { a: 1, b: { c: 'deep', d: [true, null, 2.5] } },
  objArr: [{ seq: 1, name: '당근', gPerPiece: 22.6 }, { seq: 2, name: "대'파", gPerPiece: 5 }],
  empty: [],
  emptyObj: {},
});

// 4) NULL / 필드 누락 (문서마다 스키마가 다른 경우)
c.addDoc('sparse/s1', { always: 'x', sometimes: 'here', nullField: null });
c.addDoc('sparse/s2', { always: 'y' });

// 5) 서브컬렉션 병합 → doc_id 충돌 (PK 가 doc_path 로 가야 함)
c.addDoc('days/2026-07-01/items/A01', { code: 'A01', totalQty: 13, date: '2026-07-01' });
c.addDoc('days/2026-07-02/items/A01', { code: 'A01', totalQty: 20, date: '2026-07-02' });
c.addDoc('days/2026-07-01/machines/1호기/entries/x1', { code: 'A01', actualProduction: 5, date: '2026-07-01' });

// 6) 설정 문서 → config_docs (path + data JSONB)
c.addDoc('appMeta/notifySettings', { enabled: true, emails: 'a@b.com', webAppUrl: 'https://x' });
c.addDoc('settings/analyticsAuth', { password: 'p@ss' });

// 7) 500행 배치 경계 (배치 2개가 나와야 함)
for (let i = 0; i < 501; i++) c.addDoc(`bulk/b${String(i).padStart(4, '0')}`, { n: i, date: '2026-08-05' });

/* ── SQL 생성 ──────────────────────────────────────────────────── */
const { sql, stats, docCount } = c.build({ header: 'synthetic test' });
writeFileSync(SQL_PATH, sql, 'utf8');

const run = (args, opts = {}) => execFileSync(PSQL, [...CONN, ...args], { encoding: 'utf8', ...opts });
const one = (db, q) => run(['-d', db, '-tAc', q]).trim();

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

/* ── 정적 검증 ────────────────────────────────────────────────── */
const v = validateSql(sql);
console.log('\n[정적 검증]');
check('CREATE = DROP = 테이블 수', v.nCreate === stats.length && v.nDrop === stats.length, `CREATE ${v.nCreate} / DROP ${v.nDrop} / 테이블 ${stats.length}`);
check('괄호 균형 (문자열 리터럴 제외)', v.parenBalanced, `( ${v.open} / ) ${v.close}`);
check('따옴표 균형', v.quotesBalanced);
check('BEGIN/COMMIT 감쌈', v.wrapped);
check('DROP ... CASCADE', (sql.match(/^DROP TABLE IF EXISTS .* CASCADE;$/gm) || []).length === stats.length);
check('데이터 내 괄호가 검사를 속이지 않음(리터럴 제거 검증)',
  /한우\(볶음\)/.test(sql) && v.parenBalanced, '괄호 포함 데이터가 있는데도 균형 OK');
const bulk = stats.find((s) => s.table === 'bulk');
check('INSERT 500행 배치 (501행 → 2문장)', bulk?.inserts === 2, `inserts=${bulk?.inserts}`);
check('date 컬럼 인덱스 생성', (sql.match(/^CREATE INDEX /gm) || []).length >= 3);

/* ── 실제 PostgreSQL 적재 ─────────────────────────────────────── */
console.log('\n[PostgreSQL 적재]');
try {
  run(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB}`]);
  run(['-d', 'postgres', '-c', `CREATE DATABASE ${DB}`]);
  const out = run(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SQL_PATH], { stdio: ['ignore', 'pipe', 'pipe'] });
  check('psql 적재 (ON_ERROR_STOP=1)', true, out.trim().split('\n').length + '개 명령 실행');
} catch (e) {
  check('psql 적재 (ON_ERROR_STOP=1)', false, String(e.stderr || e.message).slice(0, 300));
  process.exit(1);
}

/* ── 건수 대조 ────────────────────────────────────────────────── */
console.log('\n[건수 대조: 생성값 vs DB 실제]');
let totalDb = 0;
for (const s of stats) {
  const n = Number(one(DB, `SELECT count(*) FROM "${s.table}"`));
  totalDb += n;
  check(`${s.table}`, n === s.rows, `기대 ${s.rows} / 실제 ${n}`);
}
check('총 문서 수 일치', totalDb === docCount, `기대 ${docCount} / 실제 ${totalDb}`);

/* ── 타입·값 무결성 ───────────────────────────────────────────── */
console.log('\n[타입 판정]');
const typeOf = (t, col) => one(DB, `SELECT data_type FROM information_schema.columns WHERE table_name='${t}' AND column_name='${col}'`);
check('정수만 → bigint', typeOf('typing', 'i') === 'bigint', typeOf('typing', 'i'));
check('실수 → numeric', typeOf('typing', 'f') === 'numeric', typeOf('typing', 'f'));
check('정수+실수 혼합 → numeric', typeOf('typing', 'mix') === 'numeric', typeOf('typing', 'mix'));
check('불리언 → boolean', typeOf('typing', 'b') === 'boolean', typeOf('typing', 'b'));
check('문자열 → text', typeOf('typing', 's') === 'text', typeOf('typing', 's'));
check('타입 충돌 → text 폴백', typeOf('typing', 'clash') === 'text', typeOf('typing', 'clash'));
check('배열 → jsonb', typeOf('nested', 'arr') === 'jsonb', typeOf('nested', 'arr'));
check('객체 → jsonb', typeOf('nested', 'obj') === 'jsonb', typeOf('nested', 'obj'));

console.log('\n[값 보존]');
check('작은따옴표 원문 보존',
  one(DB, `SELECT quote FROM escaping`) === "한우(볶음)-후,완료기 'test'");
check('백슬래시 보존', one(DB, `SELECT backslash FROM escaping`) === 'C:\\path\\to\\file');
check('유니코드/이모지 보존', one(DB, `SELECT unicode FROM escaping`) === '순수본 🍲 미음');
check('주입 문자열이 데이터로만 저장', one(DB, `SELECT injection FROM escaping`) === "'); DROP TABLE typing; --");
check('주입 후에도 typing 테이블 생존', Number(one(DB, `SELECT count(*) FROM typing`)) === 3);

console.log('\n[JSONB 파싱·구조]');
check('중첩 객체 경로 조회', one(DB, `SELECT obj->'b'->>'c' FROM nested`) === 'deep');
check('배열 요소 조회', one(DB, `SELECT arr->>1 FROM nested`) === '2');
// camelCase 컬럼은 PostgreSQL 이 소문자로 접으므로 조회 시 반드시 큰따옴표로 감싸야 함
check('객체배열 내부 값', one(DB, `SELECT "objArr"->1->>'name' FROM nested`) === "대'파");
check('실수 정밀도 보존', one(DB, `SELECT "objArr"->0->>'gPerPiece' FROM nested`) === '22.6');
check('빈 배열 보존', one(DB, `SELECT arr FROM nested WHERE empty = '[]'::jsonb`) !== '');
check('모든 jsonb 유효', Number(one(DB, `SELECT count(*) FROM nested WHERE obj IS NOT NULL AND jsonb_typeof(obj)='object'`)) === 1);

console.log('\n[NULL / 스키마 불균일]');
check('누락 필드 → NULL', one(DB, `SELECT sometimes IS NULL FROM sparse WHERE doc_id='s2'`) === 't');
check('명시적 null → NULL', one(DB, `SELECT "nullField" IS NULL FROM sparse WHERE doc_id='s1'`) === 't');

console.log('\n[식별자 대소문자 — 이관 시 주의]');
check('camelCase 컬럼명 원문 보존', one(DB, `SELECT count(*) FROM information_schema.columns WHERE table_name='nested' AND column_name='objArr'`) === '1');
check('따옴표 없이 조회하면 실패(소문자 폴딩)', (() => {
  try { one(DB, `SELECT objArr FROM nested`); return false; } catch { return true; }
})(), 'PostgreSQL 조회 시 "objArr" 처럼 큰따옴표 필요');

console.log('\n[PK 전략]');
const pkCol = (t) => one(DB, `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='${t}'::regclass AND i.indisprimary`);
check('충돌 없으면 doc_id PK', pkCol('typing') === 'doc_id', pkCol('typing'));
check('doc_id 충돌 시 doc_path PK', pkCol('days__items') === 'doc_path', pkCol('days__items'));
check('days__items 두 날짜 A01 모두 보존', Number(one(DB, `SELECT count(*) FROM days__items WHERE doc_id='A01'`)) === 2);
check('머신 entries 별도 테이블 분리', Number(one(DB, `SELECT count(*) FROM days__machines__entries`)) === 1);
check('doc_path 원본 경로 보존',
  one(DB, `SELECT doc_path FROM days__machines__entries`) === 'days/2026-07-01/machines/1호기/entries/x1');

console.log('\n[config_docs]');
check('설정 문서가 config_docs 로', Number(one(DB, `SELECT count(*) FROM config_docs`)) === 2);
check('config data JSONB 조회', one(DB, `SELECT data->>'emails' FROM config_docs WHERE doc_id='notifySettings'`) === 'a@b.com');
check('config 경로 보존', one(DB, `SELECT doc_path FROM config_docs WHERE doc_id='analyticsAuth'`) === 'settings/analyticsAuth');
check('appMeta/settings 테이블 미생성', Number(one(DB, `SELECT count(*) FROM information_schema.tables WHERE table_name IN ('appMeta','settings')`)) === 0);

console.log('\n[인덱스]');
check('date 인덱스 실제 존재', Number(one(DB, `SELECT count(*) FROM pg_indexes WHERE indexname='idx_days__items_date'`)) === 1);

console.log(`\n${fail === 0 ? '전체 통과' : `실패 ${fail}건`}  (테이블 ${stats.length} / 행 ${docCount})`);
process.exit(fail === 0 ? 0 : 1);
