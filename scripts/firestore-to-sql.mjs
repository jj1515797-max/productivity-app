/**
 * Firestore → SQL(.sql) 덤프 스크립트  (리스크관리팀 raw DB 공유용)
 *
 * 우리 앱 DB는 Firestore(NoSQL)라 mysqldump가 안 됨.
 * 이 스크립트가 모든 컬렉션/서브컬렉션을 훑어서 CREATE TABLE + INSERT 문으로 뽑아줌.
 *
 * ── 실행 방법 (본인 PC에서, 이 환경 아님) ──────────────────────────
 * 1) Firebase Console → ⚙ 프로젝트 설정 → "서비스 계정" 탭
 *    → "새 비공개 키 생성" → JSON 다운로드 → 이 폴더에 serviceAccount.json 으로 저장
 * 2) 터미널에서:
 *      npm i firebase-admin
 *      node scripts/firestore-to-sql.mjs
 * 3) 같은 폴더에 raw_ssbon_mes_export.sql 생성됨 → 리스크팀에 전달
 *
 * 옵션:  node scripts/firestore-to-sql.mjs [키파일] [출력파일]
 *   예)  node scripts/firestore-to-sql.mjs ./serviceAccount.json ./raw_ssbon_mes_export.sql
 *
 * ⚠ serviceAccount.json 은 절대 깃/외부 공유 금지 (전체 DB 접근 권한). .gitignore 에 등록됨.
 */
import admin from 'firebase-admin';
import { readFileSync, writeFileSync } from 'fs';

const keyPath = process.argv[2] || './serviceAccount.json';
const outPath = process.argv[3] || './raw_ssbon_mes_export.sql';

const svc = JSON.parse(readFileSync(keyPath, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();

// 테이블명: 컬렉션 경로에서 문서ID 세그먼트는 접어버림
//   days/2026-07-01/items  →  days__items   (모든 날짜가 한 테이블로, 원본경로는 _path 컬럼에 보존)
function tableName(path) {
  const segs = path.split('/');
  return segs.filter((_, i) => i % 2 === 0).join('__').replace(/[^A-Za-z0-9_]/g, '_');
}

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (typeof v.toDate === 'function') return v.toDate().toISOString(); // Firestore Timestamp
    return JSON.stringify(v); // 배열·중첩객체·GeoPoint 등은 JSON 문자열로
  }
  return v;
}

const tables = new Map(); // tableName → { cols:Set, rows:[] }

async function walk(colRef, parentPath) {
  const path = parentPath ? `${parentPath}/${colRef.id}` : colRef.id;
  const tname = tableName(path);
  if (!tables.has(tname)) tables.set(tname, { cols: new Set(['_id', '_path']), rows: [] });
  const t = tables.get(tname);

  const snap = await colRef.get();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const row = { _id: doc.id, _path: `${path}/${doc.id}` };
    for (const [k, v] of Object.entries(data)) { row[k] = cellValue(v); t.cols.add(k); }
    t.rows.push(row);
    // 서브컬렉션 재귀
    const subs = await doc.ref.listCollections();
    for (const sc of subs) await walk(sc, `${path}/${doc.id}`);
  }
  console.error(`  · ${tname}: ${t.rows.length} rows`);
}

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

console.error('Firestore 덤프 시작…');
const roots = await db.listCollections();
for (const c of roots) await walk(c, '');

let sql = `-- 순수본 1공장 MES raw export (Firestore → SQL)\n`;
sql += `-- generated: ${new Date().toISOString()}\n`;
sql += `-- project: fp-01-b64f7\n`;
sql += `SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n`;

for (const [tname, t] of tables) {
  const cols = Array.from(t.cols);
  sql += `DROP TABLE IF EXISTS \`${tname}\`;\n`;
  sql += `CREATE TABLE \`${tname}\` (\n${cols.map((c) => `  \`${c}\` TEXT`).join(',\n')}\n) DEFAULT CHARSET=utf8mb4;\n`;
  for (const r of t.rows) {
    sql += `INSERT INTO \`${tname}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map((c) => esc(r[c])).join(', ')});\n`;
  }
  sql += '\n';
}

writeFileSync(outPath, sql, 'utf8');
console.error(`\n완료 → ${outPath}  (테이블 ${tables.size}개)`);
