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
import admin from 'firebase-admin';
import { readFileSync, writeFileSync, statSync } from 'fs';
import { createCollector, validateSql } from './pg-sql-gen.mjs';

const keyPath = process.argv[2] || './serviceAccount.json';
const outPath = process.argv[3] || './ssbon_firestore_pg.sql';
const PAGE = 1000;   // 커서 페이징 크기 (누락 방지)

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = admin.firestore();
const collector = createCollector();

let docCount = 0;
/** 컬렉션 전량 수집 (커서 페이징) + 각 문서의 서브컬렉션 재귀 */
async function walk(colRef, parentPath) {
  const path = parentPath ? `${parentPath}/${colRef.id}` : colRef.id;
  let last = null, n = 0;
  for (;;) {
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
  }
  if (n) console.error(`  · ${path}: ${n}`);
}

async function main() {
  console.error('컬렉션 자동탐색 후 수집 시작…');
  const roots = await db.listCollections();
  console.error(`루트 컬렉션 ${roots.length}개`);
  for (const c of roots) await walk(c, '');

  const { sql, stats } = collector.build({ header: `generated: ${new Date().toISOString()}` });
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
  writeFileSync('./dump_stats.json', JSON.stringify({ stats, docCount, sizeBytes: size, ...v }, null, 2));
}
main().catch((e) => { console.error('실패:', e); process.exit(1); });
