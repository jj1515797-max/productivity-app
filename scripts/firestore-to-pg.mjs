/**
 * Firestore → PostgreSQL 전체 덤프 (구조 DDL + 데이터 INSERT 한 파일)
 * 사내 서버 이관용. 서비스 계정(firebase-admin)으로 접속한다.
 *
 * ── 왜 서비스 계정인가 ────────────────────────────────────────────
 *  REST + API키 방식은 (a) listCollectionIds 403 → 컬렉션 자동탐색 불가,
 *  (b) 대량 조회 시 429 로 막힘. 서비스 계정은 둘 다 해당 없음.
 *
 * ── 실행 방법 (본인 PC) ───────────────────────────────────────────
 *  1) Firebase Console → ⚙ 프로젝트 설정 → "서비스 계정" 탭
 *     → "새 비공개 키 생성" → JSON 다운로드 → serviceAccount.json 으로 저장
 *  2) npm i firebase-admin
 *  3) node scripts/firestore-to-pg.mjs
 *     (옵션)  node scripts/firestore-to-pg.mjs ./serviceAccount.json ./out.sql
 *  4) 생성된 .sql 을 PostgreSQL 에 적재:
 *       createdb ssbon && psql -d ssbon -v ON_ERROR_STOP=1 -f ssbon_firestore_pg.sql
 *
 *  ⚠ serviceAccount.json 은 DB 전체 접근 키 → 외부 공유·깃 커밋 금지 (.gitignore 등록됨)
 *  ⚠ 읽기는 무료 한도(하루 5만 문서)를 소모함. 야간 실행 권장.
 *
 * ── 설계 규칙 ─────────────────────────────────────────────────────
 *  · 컬렉션 1:1 이관 (구조 재설계 없음). 경로에서 문서ID 세그먼트를 접어 테이블명 생성
 *      days/{date}/items                 → days__items
 *      days/{date}/machines/{m}/entries  → days__machines__entries
 *    원본 경로는 doc_path 컬럼에 그대로 보존 → 역추적·복원 가능
 *  · 타입은 실제 데이터 관찰로 판정, 배열·객체는 JSONB 원본 보존
 *  · PK: doc_id 가 테이블 내 유일하면 doc_id, 아니면(여러 상위문서 병합) doc_path
 *  · date 컬럼 존재 시 인덱스, INSERT 는 500행씩, 전체 BEGIN/COMMIT
 *
 *  SQL 생성 로직은 scripts/pg-sql-gen.mjs 에 분리되어 있고
 *  scripts/pg-sql-gen.test.mjs 가 실제 PostgreSQL 적재로 검증한다.
 */
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { createCollector, validateSql } from '../src/lib/pgSqlGen.mjs';

/* ── 사전 점검: 준비물 없으면 무엇을 해야 하는지 알려주고 종료 ── */
const die = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };
let admin;
try {
  admin = (await import('firebase-admin')).default;
} catch {
  die(`[준비 필요] firebase-admin 이 설치되어 있지 않습니다.\n\n  npm i firebase-admin\n\n설치 후 다시 실행하세요.`);
}

/* ── 안전장치 ───────────────────────────────────────────────────
 *  이 스크립트는 읽기 전용이다 (쓰기·삭제 API 미사용 → 운영 데이터 불변).
 *  단, 문서 읽기는 프로젝트 일일 무료 쿼터(5만/일)를 라이브 앱과 공유한다.
 *  → MAX_READS 로 상한을 두고, 초과하면 즉시 중단해 앱 사용에 지장이 없게 한다.
 */
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name, def) => {
  const f = process.argv.find((a) => a.startsWith(`--${name}=`));
  return f ? f.split('=')[1] : def;
};
const keyPath = args[0] || './serviceAccount.json';
const outPath = args[1] || './ssbon_firestore_pg.sql';
const MAX_READS = Number(flag('max-reads', 40000));   // 무료 5만 중 여유 1만 남김
const ONLY = (flag('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean); // 특정 컬렉션만
const PACE_MS = Number(flag('pace', 120));            // 페이지 사이 간격(버스트 방지)
const PAGE = 1000;   // 커서 페이징 크기 (누락 방지)

class BudgetExceeded extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(keyPath)) {
  die(`[준비 필요] 서비스 계정 키 파일이 없습니다: ${keyPath}\n\n` +
      `  1) Firebase Console → ⚙ 프로젝트 설정 → "서비스 계정" 탭\n` +
      `  2) "새 비공개 키 생성" → JSON 다운로드\n` +
      `  3) 이 폴더에 serviceAccount.json 으로 저장 후 다시 실행\n\n` +
      `  ※ 이 키는 DB 전체 접근 권한입니다. 외부 공유·깃 커밋 금지 (.gitignore 등록됨)`);
}
let svc;
try { svc = JSON.parse(readFileSync(keyPath, 'utf8')); }
catch (e) { die(`[오류] 키 파일을 읽을 수 없습니다 (${keyPath}): ${e.message}`); }
if (!svc.project_id) die(`[오류] 서비스 계정 키 형식이 아닙니다: ${keyPath}`);
console.error(`프로젝트: ${svc.project_id}`);
admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();
const collector = createCollector();

let docCount = 0;
/** 컬렉션 전량 수집 (커서 페이징) + 각 문서의 서브컬렉션 재귀 — 읽기 전용 */
async function walk(colRef, parentPath) {
  const path = parentPath ? `${parentPath}/${colRef.id}` : colRef.id;
  let last = null, n = 0;
  for (;;) {
    if (docCount >= MAX_READS) throw new BudgetExceeded(path);
    let q = colRef.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      collector.addDoc(`${path}/${doc.id}`, doc.data());
      n++; docCount++;
      const subs = await doc.ref.listCollections();
      for (const sc of subs) await walk(sc, `${path}/${doc.id}`);
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
    if (PACE_MS) await sleep(PACE_MS);   // 버스트 방지 (라이브 앱 영향 최소화)
  }
  if (n) console.error(`  · ${path}: ${n}`);
}

async function main() {
  console.error('※ 읽기 전용 — 운영 데이터는 변경되지 않습니다.');
  console.error(`※ 읽기 상한 ${MAX_READS.toLocaleString()}건 (초과 시 중단), 페이지 간격 ${PACE_MS}ms\n`);
  console.error('컬렉션 자동탐색 후 수집 시작…');
  let roots = await db.listCollections();
  if (ONLY.length) {
    roots = roots.filter((c) => ONLY.includes(c.id));
    console.error(`--only 지정: ${ONLY.join(', ')}`);
  }
  console.error(`루트 컬렉션 ${roots.length}개`);

  let incomplete = null;
  try {
    for (const c of roots) await walk(c, '');
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    incomplete = e.message;
    console.error(`\n⚠ 읽기 상한(${MAX_READS.toLocaleString()})에 도달해 중단했습니다. 중단 지점: ${incomplete}`);
    console.error('  라이브 앱 쿼터 보호를 위한 정상 동작입니다. 아래 파일은 "불완전 덤프"입니다.');
    console.error(`  이어서 받으려면: --only=<남은컬렉션> 으로 나눠 실행하거나 --max-reads 를 조정하세요.`);
  }

  const header = incomplete
    ? `generated: ${new Date().toISOString()}  ⚠ 불완전(읽기 상한 도달, 중단: ${incomplete})`
    : `generated: ${new Date().toISOString()}`;
  const { sql, stats } = collector.build({ header });
  writeFileSync(outPath, sql, 'utf8');
  const size = statSync(outPath).size;

  const v = validateSql(sql);   // 문자열 리터럴 제외하고 구조 검사

  console.error('\n===== 테이블별 건수 =====');
  stats.forEach((s) => console.error(
    `${s.table.padEnd(34)} ${String(s.rows).padStart(7)} 행  (컬럼 ${s.cols}, INSERT ${s.inserts}, PK ${s.pk})`));
  console.error('=========================');
  console.error(`테이블 ${stats.length} / 총 ${docCount.toLocaleString()} 문서`);
  console.error(`파일: ${outPath}  (${(size / 1024 / 1024).toFixed(2)} MB)`);
  console.error(`검증: DROP ${v.nDrop} / CREATE ${v.nCreate} / INSERT ${v.nInsert} / INDEX ${v.nIndex}`);
  console.error(`      괄호 ${v.parenBalanced ? 'OK' : 'NG'} · 따옴표 ${v.quotesBalanced ? 'OK' : 'NG'} · BEGIN/COMMIT ${v.wrapped ? 'OK' : 'NG'}`);
  console.error(`\n적재:  createdb ssbon && psql -d ssbon -v ON_ERROR_STOP=1 -f ${outPath}`);
  console.error(`대조:  psql -d ssbon -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"`);
  if (incomplete) console.error(`\n⚠ 이 덤프는 불완전합니다 (중단: ${incomplete}) — 이관 전 반드시 재수집하세요.`);
  writeFileSync('./dump_stats.json', JSON.stringify({ stats, docCount, sizeBytes: size, incomplete, ...v }, null, 2));
  if (incomplete) process.exitCode = 2;   // 스크립트 성공으로 오인하지 않도록
}
main().catch((e) => { console.error('실패:', e); process.exit(1); });
