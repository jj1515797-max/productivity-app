# DB 백업 가져오기 · 복원하기

앱의 **분석 → 설정 → DB 백업** 에서 「💾 DB 백업 파일 만들기」를 누르면
① 그 기기에 `.sql` 파일이 내려오고 ② 설정해 둔 **private 저장소**에 압축본이 올라간다.

## 어디에 있나

백업 전용 private 저장소(앱 저장소가 아니다 — 그쪽은 공개라 못 올린다)의 고정 경로:

```
db/latest.sql.gz     Firestore 전체 → PostgreSQL 덤프 (gzip)
db/latest.json       날짜·문서수·테이블수·크기·복원 명령 (작은 파일)
```

**같은 경로에 덮어쓴다.** 항상 최신본이 그 자리에 있고, 지난 버전은 git 히스토리에 남는다.

## 새 세션에서 가져가는 순서

1. 그 private 저장소를 세션에 붙인다 (`add_repo` → 안내대로 clone).
2. **먼저 `db/latest.json` 을 읽어라.** 언제 뽑힌 것인지, 문서 몇 건인지, 중간에 끊긴 백업인지
   (`incomplete` 가 null 이 아니면 불완전) 를 여기서 확인한다.
3. SQL 이 필요하면 압축을 푼다.

```bash
gunzip -c db/latest.sql.gz > /tmp/ssbon.sql      # 풀어서 보기
gunzip -c db/latest.sql.gz | head -100           # 앞부분만 훑기
```

> **파일 읽기 API 로는 못 읽는다.** gz 는 보통 1MB 를 넘고 GitHub Contents API 의 읽기 한도가 1MB 다.
> 반드시 **clone** 해서 디스크에서 읽어라.

## PostgreSQL 에 복원

```bash
createdb ssbon
gunzip -c db/latest.sql.gz | psql ssbon
```

덤프는 `BEGIN;` … `COMMIT;` 으로 감싸여 있고, 테이블마다
`DROP TABLE IF EXISTS … CASCADE;` → `CREATE TABLE` → `INSERT`(500행 묶음) 순서다.
그래서 **같은 DB 에 여러 번 넣어도 안전**하다 (매번 갈아끼운다).

## 덤프 구조 — 읽을 때 알아야 할 것

- 테이블명은 Firestore 경로에서 **컬렉션 이름만** 뽑아 `__` 로 이은 것이다.
  `days/2026-09-13/items` → `days__items`,
  `days/2026-09-13/machines/1호기/entries` → `days__machines__entries`.
  **날짜·호기는 테이블명에 없다** — `doc_path` 컬럼에 원본 경로가 그대로 남아 있으니 거기서 꺼내라.
- 모든 테이블에 `doc_id`, `doc_path` 가 있다. PK 는 그 테이블에서 `doc_id` 가 유일하면 `doc_id`,
  아니면 `doc_path` 다 (`days__items` 처럼 날짜만 다르고 코드가 반복되면 자동으로 `doc_path`).
- `appMeta` · `settings` · `_config` 문서는 전부 **`config_docs`** 한 테이블에 모이고
  본문은 `data` JSONB 통짜다.
- 배열·객체 필드는 JSONB 로 원본 구조를 유지한다. Timestamp 는 ISO 문자열.
- `date` 컬럼이 있는 테이블에는 `idx_{테이블}_date` 인덱스가 자동으로 붙는다.

## 핵심 테이블 (현황·입력 데이터)

| 테이블 | 원본 경로 | 무엇 |
|---|---|---|
| `days__items` | `days/{날짜}/items/{코드}` | 그날 만들 품목과 계획 수량 |
| `days__machines__entries` | `days/{날짜}/machines/{호기}/entries/{자동ID}` | 호기별 생산 실적 |
| `days__logistics` | `days/{날짜}/logistics/{코드}` | 잔여량(물류) 수정 |
| `days__ambient` | `days/{날짜}/ambient/{제품명}` | 실온 생산량 |
| `productSettings` | `productSettings/{문서}` | 제품 DB (코드·이름·중량) |
| `config_docs` | `appMeta/*`, `settings/*` | 설정·진행률 요약 |

생산량을 다시 계산할 거라면 `docs/MES-CORE-SPEC.md` **3부(현황↔입력 연결)** 를 반드시 읽어라.
`days__items` 와 `days__machines__entries` 를 단순히 더하면 안 되고,
그날 `days__logistics` 가 있느냐에 따라 계산이 달라진다.

## 주의

- **백업 저장소는 private 이어야 한다.** 이 덤프에는 생산량·단가·거래처·직원 이름이 전부 들어 있다.
  앱이 공개 저장소로는 업로드를 거부하지만, 저장소를 나중에 공개로 바꾸지 않도록 조심하라.
- 백업은 Firestore **읽기 한도(무료 하루 5만)** 를 현장 앱과 공유한다. 근무 중에 돌리면
  현장 태블릿 조회가 막힐 수 있다. 퇴근 후에 돌려라.
- 30MB 를 넘으면 업로드가 거부된다 (한 번에 보내기 무리). 그때는 내려받은 파일을 직접 올려라.
