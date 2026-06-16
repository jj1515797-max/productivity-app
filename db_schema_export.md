# 생산관리 시스템 DB 스키마 명세서 (Firestore → RDBMS 이관용)

## 앱 개요
- **이름**: 순수본 1공장 생산관리 시스템 (안돈)
- **핵심 목적**: 일별 생산 계획(items), 기계별 실제 생산 입력, 잔여량(물류), 실온이유식 생산, 폐기, 재배합, 원재료비/분석, 근태/생산성, 자재 입출고를 한 곳에서 관리하고 월별 분석/원가 산출까지 처리하는 사내 통합 생산관리 SPA.
- **현재 저장소**: Google Firebase Firestore (NoSQL). 본 문서는 RDBMS 이관을 위해 컬렉션/문서를 정규화한 명세이다.

> **마스터 데이터 도메인 표기 규약** (전사 ERP/공통 시스템에서 받아와야 할 컬럼)
> `[완제품]` · `[원재료]` · `[부재료]` · `[사용자/권한]` · `[공장코드]` · `[창고코드]` · `[부서/파트]`

---

## 0. 공통 설계 노트
- **공장(factory_code)**: 현재 앱은 "순수본 1공장" 전제로 운영. 이관 시 모든 트랜잭션 테이블에 `factory_code [공장코드]` FK 컬럼을 추가해야 다공장 확장 가능. 명세 표에는 공통 컬럼으로 표시.
- **날짜 컬럼**: 화면/조회에서는 `YYYY-MM-DD` 문자열 키를 쓰지만 RDBMS에서는 `DATE` 타입 권장.
- **자동ID 컬렉션** (`addDoc`)은 `BIGINT AUTO_INCREMENT PRIMARY KEY`로 매핑.
- **합성ID 컬렉션** (`{date}__{name}`, `{date}_{visitorId}` 등)은 원본 문서ID도 보관(가독성·역추적)하되 PK는 별도 surrogate key로 분리 권장.
- **수정 시점**: 다수 문서에 `updatedAt` (ISO string) / `createdAt` 가 있음 → `TIMESTAMP` 매핑.
- **enum 값**(예: 출근/연차/반차…)은 코드테이블 분리 권장(아래 31장).

---

## 1. `product_settings` — 제품 설정 (냄비/바트, 포장중량)
**의미**: 제품코드별 생산 타입(냄비/바트) 및 포장중량(g) 마스터. (`productSettings`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| product_code | 제품코드 | VARCHAR(40) | PK | N | **[완제품]** | 제품 단축코드(A01 등) |
| product_type | 제품타입 | ENUM('냄비','바트') | — | Y | — | 생산 라인 구분 |
| product_name | 제품명 | VARCHAR(120) | — | Y | **[완제품]** | 표시명 |
| pack_weight_g | 포장중량 | DECIMAL(10,2) | — | Y | — | 1EA 포장 중량(g) |
| updated_at | 수정일시 | TIMESTAMP | — | Y | — | |

---

## 2. `materials` — 원재료 마스터
**의미**: 원재료 마스터 카탈로그(이름·카테고리·규격·단위). (`materials`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| material_id | 원재료ID | VARCHAR(40) | PK | N | **[원재료]** | 문서ID (자체 슬러그) |
| name | 원재료명 | VARCHAR(120) | UQ | N | **[원재료]** | |
| category | 카테고리 | VARCHAR(40) | — | Y | — | |
| specs_json | 규격목록 | JSON | — | Y | — | `['3mm','5mm']` |
| unit | 단위 | VARCHAR(10) | — | Y | — | 'kg','g' 등 |

---

## 3. `recipes` — 냉장 제품 레시피 헤더 & `recipe_ingredients` — 라인
**의미**: 제품 BOM(1EA 생산에 필요한 원재료 g). Firestore에서 `recipes/{code}.ingredients[]` 배열 → RDBMS에선 헤더/라인 2테이블로 정규화.

### 3-1. `recipes`
| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| product_code | 제품코드 | VARCHAR(40) | PK / FK→product_settings | N | **[완제품]** | |
| product_name | 제품명 | VARCHAR(120) | — | Y | **[완제품]** | |
| updated_at | 수정일시 | TIMESTAMP | — | Y | — | |

### 3-2. `recipe_ingredients`
| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| line_id | 라인ID | BIGINT | PK AUTO | N | — | surrogate |
| product_code | 제품코드 | VARCHAR(40) | FK→recipes | N | **[완제품]** | |
| seq | 순번 | INT | — | N | — | 표시 순서 |
| ingredient_name | 원재료명 | VARCHAR(120) | — | N | **[원재료]** | |
| ingredient_code | 원재료ERP코드 | VARCHAR(40) | — | Y | **[원재료]** | ERP 코드 |
| g_per_piece | EA당투입g | DECIMAL(14,6) | — | N | — | |

---

## 4. `sub_recipes` & `sub_recipe_ingredients` — 반제품 BOM (1g 단위)
**의미**: 순수본베이스·디포리육수 같은 자가 제조 중간품. **1g 제조 시 원물 g**를 저장 → 분석 시 재귀 전개. (`subRecipes`)

### 4-1. `sub_recipes`
| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| sub_code | 반제품코드 | VARCHAR(40) | PK | N | **[부재료]** 또는 **[원재료]** | PB-Z-001 등 사내코드 |
| sub_name | 반제품명 | VARCHAR(120) | — | Y | — | |
| updated_at | 수정일시 | TIMESTAMP | — | Y | — | |

### 4-2. `sub_recipe_ingredients`
| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| line_id | 라인ID | BIGINT | PK AUTO | N | — | |
| sub_code | 반제품코드 | VARCHAR(40) | FK→sub_recipes | N | — | |
| seq | 순번 | INT | — | N | — | |
| ingredient_name | 원재료명 | VARCHAR(120) | — | N | **[원재료]** | |
| ingredient_code | 원재료ERP코드 | VARCHAR(40) | — | Y | **[원재료]** | |
| g_per_unit | 반제품1g당투입g | DECIMAL(14,6) | — | N | — | 합 ≈ 1.0 |

---

## 5. `ambient_recipes` & `ambient_recipe_ingredients` — 실온이유식 1배합 레시피
**의미**: 1배합(예: 200kg)당 원물 g + 1배합 생산 EA수. (`ambientRecipes`)

### 5-1. `ambient_recipes`
| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| ambient_id | 실온제품ID | VARCHAR(80) | PK | N | **[완제품]** | normalizedName 슬러그 |
| product_name | 제품명 | VARCHAR(120) | — | N | **[완제품]** | |
| batch_pieces | 1배합생산EA | INT | — | N | — | 1배합 = 몇 EA |
| updated_at | 수정일시 | TIMESTAMP | — | Y | — | |

### 5-2. `ambient_recipe_ingredients`
| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| line_id | 라인ID | BIGINT | PK AUTO | N | — | |
| ambient_id | 실온제품ID | VARCHAR(80) | FK→ambient_recipes | N | — | |
| seq | 순번 | INT | — | N | — | |
| ingredient_name | 원재료명 | VARCHAR(120) | — | N | **[원재료]** | |
| ingredient_code | 원재료ERP코드 | VARCHAR(40) | — | Y | **[원재료]** | |
| g_per_batch | 1배합당투입g | DECIMAL(14,4) | — | N | — | |

---

## 6. `material_prices` — 월별 원재료 단가 (재고평가현황·매입)
**의미**: 월별 원재료 단가. 현재 `materialPricesInventory`(실측: 출고금액/출고수량 자동 산출)와 레거시 `materialPricesMonthly`(매입단가)·`materialPrices`(레거시 flat)를 통합. `source` 컬럼으로 구분.

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| price_id | 단가ID | BIGINT | PK AUTO | N | — | |
| month_ym | 기준월 | CHAR(7) | UQ① | N | — | 'YYYY-MM' |
| ingredient_name | 원재료명 | VARCHAR(120) | UQ① | N | **[원재료]** | |
| ingredient_code | 원재료ERP코드 | VARCHAR(40) | — | Y | **[원재료]** | |
| price_per_gram | g당단가 | DECIMAL(14,6) | — | N | — | ₩/g |
| manual_price | 기초단가 | DECIMAL(14,6) | — | Y | — | 실측 없을 때 폴백 |
| price_source | 단가구분 | ENUM('actual','manual') | — | Y | — | 산출방식 |
| price_kind | 단가종류 | ENUM('inventory','purchase') | — | N | — | inventory(현행) / purchase(레거시) |
| updated_at | 수정일시 | TIMESTAMP | — | Y | — | |

UQ① = `(month_ym, ingredient_name, price_kind)` 복합 unique.

---

## 7. `material_outflow` — 월별 원재료 실제 출고 (ERP 재고평가)
**의미**: 월별로 원재료별 실측 출고수량/금액. 분석2의 역배분 입력. (`materialOutflow/{month}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| outflow_id | 출고ID | BIGINT | PK AUTO | N | — | |
| month_ym | 기준월 | CHAR(7) | UQ① | N | — | |
| ingredient_key | 원재료키 | VARCHAR(80) | UQ① | N | **[원재료]** | code 우선, 없으면 name |
| ingredient_name | 원재료명 | VARCHAR(120) | — | Y | **[원재료]** | |
| ingredient_code | 원재료ERP코드 | VARCHAR(40) | — | Y | **[원재료]** | |
| outflow_g | 출고수량(g) | DECIMAL(18,4) | — | Y | — | |
| outflow_amount | 출고금액(₩) | DECIMAL(18,2) | — | Y | — | |
| updated_at | 수정일시 | TIMESTAMP | — | Y | — | |

---

## 8. `monthly_meta` — 월별 생산금액 등 메타
**의미**: 월별 총생산금액(분석2 연동비율용). (`monthlyMeta/{month}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| month_ym | 기준월 | CHAR(7) | PK | N | — | 'YYYY-MM' |
| production_amount | 생산금액 | DECIMAL(18,2) | — | Y | — | ₩ |
| updated_at | 수정일시 | TIMESTAMP | — | Y | — | |

---

## 9. `daily_items` — 일별 품목 계획·실적
**의미**: 그날 생산 계획(쿠팡/마켓컬리/샘플 등)과 실제생산수량. (`days/{date}/items/{code}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| date | 일자 | DATE | PK① | N | — | |
| product_code | 제품코드 | VARCHAR(40) | PK① / FK→product_settings | N | **[완제품]** | |
| product_name | 제품명 | VARCHAR(120) | — | Y | **[완제품]** | |
| order_qty | 발주수량 | INT | — | Y | — | 자사 |
| coupang_qty | 쿠팡수량 | INT | — | Y | — | |
| marketkurly_qty | 마켓컬리수량 | INT | — | Y | — | |
| sample_qty | 샘플수량 | INT | — | Y | — | |
| total_qty | 총수량(목표) | INT | — | N | — | 합계 |
| actual_production | 실제생산 | INT | — | Y | — | 합계 (대시보드 표시) |
| cooling_end_time | 냉각종료시간 | TIME | — | Y | — | |
| factory_code | 공장코드 | VARCHAR(20) | FK | Y | **[공장코드]** | 다공장 확장용 |

---

## 10. `machine_entries` — 기계별 생산 입력
**의미**: 호기(1·2·3호기)별 실제생산/추가생산 입력 이벤트. (`days/{date}/machines/{machine}/entries/{auto}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| entry_id | 입력ID | BIGINT | PK AUTO | N | — | |
| date | 일자 | DATE | IDX | N | — | |
| machine | 기계 | ENUM('1호기','2호기','3호기') | — | N | — | |
| product_code | 제품코드 | VARCHAR(40) | FK→product_settings | N | **[완제품]** | |
| actual_production | 실제생산 | INT | — | Y | — | |
| additional_production | 추가생산 | INT | — | Y | — | |
| work_time | 작업시각 | VARCHAR(10) | — | Y | — | 'HH:MM' |
| additional_work_time | 추가작업시각 | VARCHAR(10) | — | Y | — | |
| factory_code | 공장코드 | VARCHAR(20) | FK | Y | **[공장코드]** | |

---

## 11. `external_pack_entries` — 외포장 라인 (1·2·3호기 외포장)
**의미**: 외포장 생산 이벤트 (기계 entry 와 유사한 구조). 현재는 동일 컬렉션의 별도 doc 형태가 아니라 별도 페이지 데이터셋. 타입 `ExternalPackEntry` 참고.

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| entry_id | 입력ID | BIGINT | PK AUTO | N | — | |
| date | 일자 | DATE | IDX | N | — | |
| machine | 기계 | ENUM('1호기','2호기','3호기') | — | N | — | |
| product_code | 제품코드 | VARCHAR(40) | FK→product_settings | N | **[완제품]** | |
| product_name | 제품명 | VARCHAR(120) | — | Y | **[완제품]** | |
| order_qty | 발주수량 | INT | — | Y | — | |
| shipped_qty | 출하수량 | INT | — | Y | — | |
| actual_production | 실제생산 | INT | — | Y | — | |
| shortage | 부족수량 | INT | — | Y | — | |
| additional_production | 추가생산 | INT | — | Y | — | |

---

## 12. `daily_logistics` — 일별 잔여량/물류
**의미**: ERP 등에서 받은 그 날의 코드별 잔여수량/물류 보정. (`days/{date}/logistics/{code}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| date | 일자 | DATE | PK① | N | — | |
| product_code | 제품코드 | VARCHAR(40) | PK① / FK→product_settings | N | **[완제품]** | 단축코드 |
| erp_code | ERP코드 | VARCHAR(40) | — | Y | **[완제품]** | 원본 ERP코드 |
| qty | 수량 | INT | — | N | — | 잔여(보정) 수량 |

---

## 13. `ambient_entries` — 일별 실온이유식 생산 입력
**의미**: 그 날 실온이유식 제품별 생산 EA. (`days/{date}/ambient/{slug}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| date | 일자 | DATE | PK① | N | — | |
| ambient_id | 실온제품ID | VARCHAR(80) | PK① / FK→ambient_recipes | N | **[완제품]** | |
| product_name | 제품명 | VARCHAR(120) | — | N | **[완제품]** | |
| category | 카테고리 | VARCHAR(40) | — | Y | — | |
| qty | 생산수량 | INT | — | N | — | EA |

---

## 14. `remix_entries` — 일별 재배합
**의미**: 재배합 발생 코드/수량. (`remix/{date}/items/{code}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| date | 일자 | DATE | PK① | N | — | |
| product_code | 제품코드 | VARCHAR(40) | PK① / FK→product_settings | N | **[완제품]** | |
| qty | 재배합수량 | INT | — | Y | — | |
| count | 재배합건수 | INT | — | Y | — | 보통 1 |

---

## 15. `waste_entries` — 일별 폐기
**의미**: 폐기 발생 이벤트(제품코드·수량·제외 원재료). (`waste/{date}/entries/{auto}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| waste_id | 폐기ID | BIGINT | PK AUTO | N | — | |
| date | 일자 | DATE | IDX | N | — | |
| product_code | 제품코드 | VARCHAR(40) | FK→product_settings | N | **[완제품]** | |
| product_name | 제품명 | VARCHAR(120) | — | Y | **[완제품]** | |
| qty | 폐기수량 | INT | — | N | — | |
| excluded_ingredients_json | 제외원재료목록 | JSON | — | Y | **[원재료]** | 폐기금액 계산에서 제외 |
| created_at | 등록일시 | TIMESTAMP | — | Y | — | |

---

## 16. `inventory_movements` — 자재 입출고
**의미**: 창고별 자재 입·출고 이벤트. (`inventory/{date}/movements/{auto}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| movement_id | 이동ID | BIGINT | PK AUTO | N | — | |
| date | 일자 | DATE | IDX | N | — | |
| type | 이동구분 | ENUM('입고','출고') | — | N | — | |
| warehouse_no | 창고번호 | TINYINT (1~7) | — | N | **[창고코드]** | |
| material_name | 자재명 | VARCHAR(120) | — | N | **[원재료]** 또는 **[부재료]** | |
| spec | 규격 | VARCHAR(40) | — | Y | — | |
| qty | 수량 | DECIMAL(14,3) | — | N | — | |
| unit | 단위 | VARCHAR(10) | — | Y | — | 'g' 기본 |
| incoming_date | 입고일자 | DATE | — | Y | — | 입고 시 |
| expiry_date | 소비기한 | DATE | — | Y | — | 출고 시 |
| done | 완료여부 | BOOLEAN | — | N | — | |
| counterpart | 거래처 | VARCHAR(120) | — | Y | — | (deprecated) |
| note | 비고 | VARCHAR(500) | — | Y | — | (deprecated) |
| created_at | 등록일시 | TIMESTAMP | — | Y | — | |

---

## 17. `inventory_requests` — 자재 요청
**의미**: 자재 요청 메모(todo 형식). (`inventory/{date}/requests/{auto}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| request_id | 요청ID | BIGINT | PK AUTO | N | — | |
| date | 일자 | DATE | IDX | N | — | |
| text | 요청내용 | VARCHAR(500) | — | N | — | |
| done | 완료여부 | BOOLEAN | — | N | — | |
| created_at | 등록일시 | TIMESTAMP | — | Y | — | |

---

## 18. `members` — 인원 마스터
**의미**: 정직원 마스터. (`members/{auto}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| member_id | 사원ID | VARCHAR(40) | PK | N | **[사용자/권한]** | 사번 또는 surrogate |
| name | 이름 | VARCHAR(60) | — | N | **[사용자/권한]** | |
| dept | 부서/파트 | VARCHAR(60) | — | Y | **[부서/파트]** | |
| active | 재직여부 | BOOLEAN | — | N | — | |
| leave_from | 휴직시작 | DATE | — | Y | — | |
| leave_to | 휴직종료 | DATE | — | Y | — | inclusive |
| created_at | 등록일시 | TIMESTAMP | — | Y | — | |

---

## 19. `attendance_records` — 일별 근태 기록
**의미**: 사원별 출근/연차 등 상태. (`attendance/{date}/records/{memberId}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| date | 일자 | DATE | PK① | N | — | |
| member_id | 사원ID | VARCHAR(40) | PK① / FK→members | N | **[사용자/권한]** | |
| name | 이름 | VARCHAR(60) | — | N | — | 스냅샷 |
| status | 단일상태 | ENUM | — | Y | — | 구버전 호환 |
| statuses_json | 복합상태목록 | JSON | — | Y | — | 우선 사용 |
| note | 비고 | VARCHAR(500) | — | Y | — | |

상태 enum 값: `출근, 연차, 반차, 반반차, 결혼반차, 생일반차, 병가, 경조사, 휴무` → 별도 `attendance_status_codes` 테이블로 분리 권장(`code`, `label`, `leave_weight DECIMAL(3,2)`).

---

## 20. `attendance_meta_day` — 근태 일자 메타 (필요인원 등)
**의미**: 그 날의 파트별 필요인원/AR(일용직)·특이사항. (`attendanceMeta/{date}` & `attendanceMeta/_month_{YYYY-MM}` & `attendanceMeta/_default`)

### 20-1. 일자 메타 `attendance_meta_day`
| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| date | 일자 | DATE | PK | N | — | |
| need_heads_json | 파트별필요인원 | JSON | — | Y | **[부서/파트]** | `{"pp":5,"bg":4,...}` |
| ar_total | AR총원 | INT | — | Y | — | 일용직 |
| ar_present | AR출근 | INT | — | Y | — | |
| ar_names | AR명단 | VARCHAR(1000) | — | Y | — | 자유텍스트 |

### 20-2. 월 특이사항 `attendance_meta_month`
| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| month_ym | 기준월 | CHAR(7) | PK | N | — | |
| note | 특이사항 | TEXT | — | Y | — | |

### 20-3. 기본 필요인원 `attendance_meta_default`
| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| singleton_id | 단일행ID | TINYINT | PK | N | — | 항상 1 |
| need_heads_json | 기본필요인원 | JSON | — | Y | **[부서/파트]** | |

---

## 21. `attendance_snapshot` — 일자 근태 스냅샷
**의미**: 과거 분석을 위해 그 날의 직원 목록(재직·휴직 포함)을 통째로 저장. (`attendanceSnapshot/{date}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| date | 일자 | DATE | PK | N | — | |
| members_json | 사원스냅샷 | JSON | — | N | **[사용자/권한]** | id,name,dept,active,leaveFrom/To 배열 |
| saved_at | 저장시각 | TIMESTAMP | — | Y | — | |

---

## 22. `productivity_daily` — 일별 생산성 입력
**의미**: 단계(전처리/배합/취반기/화구/내포장)별 인원·시작/종료 시각, 출근/연차, pot/bat 수량. (`productivity/{date}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| date | 일자 | DATE | PK | N | — | |
| pot_qty | 냄비생산수 | INT | — | Y | — | |
| bat_qty | 바트생산수 | INT | — | Y | — | |
| attend_total | 출근수 | INT | — | Y | — | 정직원+AR |
| leave_days | 연차환산일 | DECIMAL(5,2) | — | Y | — | |
| pp_people | 전처리인원 | INT | — | Y | **[부서/파트]** | |
| pp_start | 전처리시작 | VARCHAR(10) | — | Y | — | HH:MM |
| pp_end | 전처리종료 | VARCHAR(10) | — | Y | — | |
| bg_people | 배합인원 | INT | — | Y | **[부서/파트]** | |
| bg_start | 배합시작 | VARCHAR(10) | — | Y | — | |
| bg_end | 배합종료 | VARCHAR(10) | — | Y | — | |
| ck_people | 취반기인원 | INT | — | Y | **[부서/파트]** | |
| ck_start | 취반기시작 | VARCHAR(10) | — | Y | — | |
| ck_end | 취반기종료 | VARCHAR(10) | — | Y | — | |
| fl_people | 화구인원 | INT | — | Y | **[부서/파트]** | |
| fl_start | 화구시작 | VARCHAR(10) | — | Y | — | |
| fl_end | 화구종료 | VARCHAR(10) | — | Y | — | |
| pk_people | 내포장인원 | INT | — | Y | **[부서/파트]** | |
| pk_start | 내포장시작 | VARCHAR(10) | — | Y | — | |
| pk_end | 내포장종료 | VARCHAR(10) | — | Y | — | |

> 정규화하려면 `productivity_daily_stage(date, stage_key, people, start_time, end_time)` 로 분리하고 stage 코드테이블(`stage_codes(stage_key,label,sort_order)`)을 따로 두는 게 깔끔.

---

## 23. `monthly_stats_override` — 월 수동 보정
**의미**: 분석 페이지에서 월별 자동집계를 수동 덮어쓰기. (`monthlyStats/{YYYY-MM}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| month_ym | 기준월 | CHAR(7) | PK | N | — | |
| total_qty | 총수량 | INT | — | Y | — | |
| remaining | 잔여량 | INT | — | Y | — | |
| remix_count | 재배합건수 | INT | — | Y | — | |
| item_count | 품목수 | INT | — | Y | — | |
| work_days | 작업일수 | INT | — | Y | — | |

---

## 24. `analytics_graphs` — 그래프용 시계열 저장
**의미**: remix·surplus 등 그래프 포인트 캐시. (`analyticsGraphs/{key}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| graph_key | 그래프키 | VARCHAR(40) | PK① | N | — | 'remix','surplus' |
| month_ym | 기준월 | CHAR(7) | PK① | N | — | |
| value | 값 | DECIMAL(18,4) | — | Y | — | |

---

## 25. `under10_manual_override` — 10ea미만 보정
**의미**: 10ea미만 페이지 수동 보정. (`under10Manual/{YYYY-MM}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| month_ym | 기준월 | CHAR(7) | PK | N | — | |
| payload_json | 보정값 | JSON | — | Y | — | 가변 키-값 |

---

## 26. `material_aliases` — 분석화면 원재료 별칭
**의미**: 같은 이름·여러 코드의 원재료를 사용자가 표시명으로 별칭 부여. (`appMeta/materialAliases`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| ingredient_key | 원재료키 | VARCHAR(80) | PK | N | **[원재료]** | code 우선 |
| display_name | 표시명(별칭) | VARCHAR(120) | — | N | — | |
| updated_at | 수정일시 | TIMESTAMP | — | Y | — | |

---

## 27. `notify_settings` — 생산완료 알림 설정
**의미**: Apps Script 웹앱 Gmail 알림 설정. (`appMeta/notifySettings`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| singleton_id | 단일행ID | TINYINT | PK | N | — | 항상 1 |
| enabled | 사용여부 | BOOLEAN | — | N | — | |
| web_app_url | 웹앱URL | VARCHAR(500) | — | Y | — | Apps Script |
| emails | 받는이메일 | VARCHAR(500) | — | Y | **[사용자/권한]** | 콤마구분 |
| updated_at | 수정일시 | TIMESTAMP | — | Y | — | |

---

## 28. `notify_log` — 알림 발송 이력
**의미**: 멀티 클라이언트 중복 방지(하루 1통). (`appMeta/notifyLog`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| sent_date | 발송일 | DATE | PK | N | — | |
| sent_at | 발송시각 | TIMESTAMP | — | N | — | |

---

## 29. `app_settings` — 앱 공통 설정
**의미**: 분석 페이지 비밀번호 등. (`settings/analyticsAuth`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| setting_key | 설정키 | VARCHAR(40) | PK | N | — | 'analyticsAuth' |
| value_json | 값 | JSON | — | Y | — | `{password:"..."}` |
| updated_at | 수정일시 | TIMESTAMP | — | Y | — | |

---

## 30. `visits` — 접속 이력 (오늘 접속자 수 카운트)
**의미**: 일자별 방문자(브라우저) 카운트. (`visits/{date}_{visitorId}`)

| 컬럼명(영문) | 컬럼명(한글) | 타입 | PK·FK | NULL | 연동 마스터 도메인 | 설명 |
|---|---|---|---|---|---|---|
| date | 일자 | DATE | PK① | N | — | |
| visitor_id | 방문자ID | VARCHAR(40) | PK① | N | — | 클라이언트 랜덤ID |
| last_seen | 마지막접속 | TIMESTAMP | — | Y | — | |

---

## 31. 코드 테이블 (정규화 보조)
- `attendance_status_codes(code PK, label, leave_weight DECIMAL(3,2))` — 출근/연차 등 9종
- `stage_codes(stage_key PK, label, sort_order)` — pp/bg/ck/fl/pk
- `factory_codes(factory_code PK, factory_name)` **[공장코드]**
- `warehouse_codes(warehouse_no PK, name)` **[창고코드]**
- `dept_codes(dept_code PK, dept_name)` **[부서/파트]**
- `ingredient_master(ingredient_code PK, name, kind ENUM('원재료','부재료','반제품'))` **[원재료]/[부재료]** — `recipe_ingredients.ingredient_code`, `material_outflow.ingredient_code`, `material_prices.ingredient_code`, `inventory_movements.material_name(→code)` 의 외래키 대상
- `product_master(product_code PK, product_name, kind ENUM('완제품(냉장)','실온이유식','반제품'))` **[완제품]** — `product_settings.product_code` 등의 외래키 대상

---

## 32. 관계성 요약 (ER 핵심)
- **product_master (1)** ─< **product_settings (1)** ─< **recipes (1)** ─< **recipe_ingredients (N)** >─ **ingredient_master (1)**
- **sub_recipes (1)** ─< **sub_recipe_ingredients (N)** >─ **ingredient_master (1)** ; sub_recipes 는 recipe_ingredients 에서 ingredient 로도 참조될 수 있음(반제품 재귀)
- **ambient_recipes (1)** ─< **ambient_recipe_ingredients (N)** >─ **ingredient_master (1)**
- **daily_items (N)** >─ **product_settings (1)** ; 같은 `(date, product_code)` 쌍이 PK
- **machine_entries (N)** >─ **product_settings (1)** ; `(date, machine, product_code)` 다대일
- **daily_logistics (N)** >─ **daily_items (1)** by `(date, product_code)`
- **ambient_entries (N)** >─ **ambient_recipes (1)** ; `(date, ambient_id)` PK
- **remix_entries (N)** >─ **product_settings (1)**
- **waste_entries (N)** >─ **product_settings (1)**
- **inventory_movements/requests (N)** >─ **warehouse_codes**, **ingredient_master**
- **members (1)** ─< **attendance_records (N)** by `(date, member_id)`
- **attendance_meta_day (1:1 with DATE)**, **attendance_meta_month (1:1 with YYYY-MM)**, **attendance_meta_default (singleton)**
- **productivity_daily (1:1 with DATE)** ; 스테이지 컬럼 다수(정규화 권장)
- **material_prices (1)** ─< 분석2 / 폐기 / 분석1 계산 시 조인 (도메인 [원재료])
- **material_outflow (N per month)** ─ 분석2 역배분 입력
- **monthly_meta**, **monthly_stats_override**, **analytics_graphs**, **under10_manual_override** — 모두 `month_ym` 단일키 메타
- **material_aliases** — 분석화면 표시명 매핑(독립)
- **notify_settings (singleton)**, **notify_log (per DATE)**, **app_settings (per key)** — 시스템 설정
- **visits (per (date, visitor_id))** — 보조 로그

## 33. RDBMS 이관 시 권고
1. **마스터 데이터 우선 정착**: `product_master`·`ingredient_master`·`factory_codes`·`warehouse_codes`·`dept_codes`·`members(사번/권한)` 를 ERP에서 받아 먼저 채우고, 본 명세의 트랜잭션 테이블 FK를 모두 마스터로 연결.
2. **공장코드(`factory_code`) 추가**: 현재 단일공장 가정으로 코드에 없지만, 트랜잭션성 테이블 11개(`daily_items`/`machine_entries`/`external_pack_entries`/`daily_logistics`/`ambient_entries`/`remix_entries`/`waste_entries`/`inventory_movements`/`inventory_requests`/`attendance_records`/`productivity_daily`)에 `factory_code` 컬럼 추가 후 복합 PK 또는 추가 인덱스로 사용.
3. **enum 분리**: 출근상태·기계·이동구분·단가구분 등 enum 은 모두 코드 테이블로 분리해 다국어/추가 상태 확장 대비.
4. **JSON 컬럼**(`statuses_json`, `need_heads_json`, `excluded_ingredients_json`, `members_json` 등)은 분석/조회가 빈번한 키는 별도 정규화 테이블로 옮기는 것이 장기적으로 유리.
5. **이관 매핑 키**: 현재 Firestore 문서ID(`{date}__{name}` 등)는 보조 컬럼으로 남기되, PK는 surrogate(BIGINT)로 통일.
6. **금액·g 컬럼 정밀도**: 모두 `DECIMAL(precision, scale)` 사용 — 출고수량 등 큰 수는 `(18,4)`, 단가 g당은 `(14,6)` 권장.

---
*이 명세서는 현재 운영 중인 Firebase Firestore 컬렉션 구조를 RDBMS 표준 테이블로 직역한 1차 청사진이다. 실제 이관 전 ERP 마스터(특히 [원재료]/[완제품]/[사용자]/[공장]) 코드 체계와 매핑 룰을 확정하고, FK 무결성 위배 데이터는 사전 클렌징이 필요하다.*
