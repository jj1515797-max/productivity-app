# 순수본 1공장 MES — 현황·입력 재현 사양서

> 이 문서는 **다른 Claude Code 세션에 그대로 붙여넣는 프롬프트**다.
> 목적: 이 앱의 **현황(대시보드)** 과 **입력(1·2·3호기, 외포장-1/2/3)** 을 지금과 똑같이 다시 만든다.
> 이 두 부분이 앱의 심장이다. 나머지 분석 화면은 전부 여기서 쌓인 데이터를 읽어 가공할 뿐이다.

---

## 0부 — 무엇을 만드는가

### 0.1 한 줄 요약

한국 식품공장(순수본 1공장)의 **냉장이유식 생산 현황판 + 현장 입력 단말**이다.
사무실 PC 는 현황을 보고, 각 라인의 태블릿은 자기 호기 화면만 열어 실적을 찍는다.
**두 화면은 Firestore 실시간 구독으로 묶여 있어, 현장에서 숫자를 넣는 즉시 현황판이 바뀐다.**

### 0.2 기술 스택 (그대로 맞출 것)

| | |
|---|---|
| 프레임워크 | React 18.3 + TypeScript 5.7 |
| 빌드 | Vite 6 (`@vitejs/plugin-react`) |
| 라우팅 | react-router-dom 7 (BrowserRouter) |
| 스타일 | Tailwind CSS 3.4 (+ postcss, autoprefixer) |
| 데이터 | Firebase 11 — Firestore + Auth |
| 엑셀 | exceljs 4.4 (쓰기), xlsx 0.18 (읽기) |
| 배포 | GitHub Pages |

**상태관리 라이브러리를 쓰지 않는다.** 화면마다 `useState` + Firestore `onSnapshot` 구독이 전부다.
서버 상태가 곧 단일 진실이고, 화면은 그것을 비추기만 한다. Redux·Zustand·React Query 를 넣지 마라 —
지금 구조가 단순해서 유지되는 것이다.

### 0.3 프로젝트 설정

`package.json` 스크립트:
```
dev      vite
build    tsc -b && vite build && cp dist/index.html dist/404.html
preview  vite preview
```

`build` 의 `cp dist/index.html dist/404.html` 이 중요하다. GitHub Pages 는 SPA 라우팅을 모르므로
`/machine/1` 로 직접 들어오면 404 가 난다. 404 페이지를 index.html 로 복사해 두면 그때도 앱이 뜬다.

`vite.config.ts`:
```ts
base: '/productivity-app/'
```
저장소 이름이 바뀌면 이 값도 바꿔야 한다. 안 그러면 배포본에서 에셋 경로가 전부 깨진다.

### 0.4 Firebase

`src/firebase.ts` 에서 초기화하고 `db`(Firestore), `auth`, `app` 을 export 한다.
설정값은 **코드에 그대로 박혀 있다** — 환경변수를 쓰지 않는다.
Firestore 웹 API 키는 공개되어도 되는 값이고(접근 제어는 보안 규칙이 한다),
이 앱은 사내 전용이라 빌드 파이프라인을 단순하게 두었다. 새로 만들 때도 같은 방식으로 두면 된다.

```
apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId
```
새 Firebase 프로젝트를 쓸 거면 이 여섯 값만 갈아끼운다.

### 0.5 배포

`.github/workflows/deploy.yml` — `main` 브랜치에 push 될 때만 배포한다.

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: pages
  cancel-in-progress: true
```

`concurrency.cancel-in-progress: true` 때문에 **새 배포가 진행 중인 배포를 취소한다.**
연달아 push 하면 앞의 배포가 죽는다 — 정상 동작이니 놀라지 마라.
그리고 **브랜치에만 push 하면 배포가 나가지 않는다.** 반드시 `main` 에 올려야 한다.

빌드 단계: `actions/checkout@v4` → `setup-node@v4` (node 20, npm 캐시) → `npm ci` → `npm run build`
→ `upload-pages-artifact@v3` (path: dist) → deploy.

### 0.6 이 사양서를 읽는 순서

문서 순서 그대로 읽으면 된다: 1부 뼈대 → 2부 데이터 모델 → **3부 연결 규칙** → 4부 현황 → 5·6부 입력 → 7부 부속.

**3부가 이 앱의 핵심이다.** '그날 얼마 만들었나' 를 확정하는 규칙인데, 이게 틀리면
화면은 멀쩡해 보여도 모든 분석 숫자가 조용히 틀어진다. 4~6부는 그 규칙을 화면에 입힌 것뿐이다.

구현을 마쳤으면 **부록 A(놓치기 쉬운 규칙 222건)** 를 하나씩 대조하라. 거기 적힌 것들이
실제로 이 앱을 만들면서 한 번씩 틀렸던 자리다.


---

# 1부 — 앱 뼈대 (라우팅·네비게이션·권한·조회날짜)

## 앱 뼈대 — 라우팅·네비게이션·권한·실시간 상태

이 문서는 순수본 1공장 MES 웹앱의 **껍데기**(진입점, 라우터, 상단/서브 네비게이션, 분석 잠금, 조회 날짜 공유, 접속자 집계, 알림, Firebase 초기화)를 재현하기 위한 사양이다. 각 페이지 내부(현황/입력 화면의 표·계산)는 별도 문서가 다룬다.

---

### 1. 기술 스택·빌드·배포

- React 18.3 + TypeScript 5.7 + Vite 6 + Tailwind 3.4, 라우터는 `react-router-dom` 7, 데이터는 Firebase 11 (Firestore). 엑셀은 `exceljs` + `xlsx`.
- `vite.config.ts` 의 `base` 는 `'/productivity-app/'` 로 고정. GitHub Pages 서브경로 배포 전제다.
- 빌드 스크립트: `tsc -b && vite build && cp dist/index.html dist/404.html`.
  **`404.html` 복사가 핵심이다.** GitHub Pages 에는 SPA 리라이트가 없어서, `/productivity-app/machine/1` 같은 딥링크를 새로고침하면 404 가 뜬다. `index.html` 을 `404.html` 로 복사해 두어야 같은 번들이 서빙되고 라우터가 경로를 처리한다.
- 배포는 `.github/workflows/deploy.yml` — `main` 푸시 또는 수동 실행 시 Node 20 에서 `npm ci && npm run build` 후 `dist` 를 `upload-pages-artifact@v3` → `deploy-pages@v4`. concurrency group `pages`, `cancel-in-progress: true`.
- `index.html`: `lang="ko"`, 뷰포트에 `maximum-scale=1.0, user-scalable=no` (현장 태블릿 확대 방지), `robots` 와 `googlebot` 모두 `noindex, nofollow` (사내 앱이라 검색 노출 차단). `<title>1공장 MES</title>`. `<body class="bg-slate-50">`.
- `src/index.css`: Tailwind 3단 지시자 + `html, body, #root { height: 100% }` + body 폰트 `-apple-system, BlinkMacSystemFont, 'Pretendard', 'Apple SD Gothic Neo', sans-serif`.
- `tailwind.config.js` 의 커스텀 색: `complete: '#86efac'`, `warning: '#fde68a'`, `danger: '#fca5a5'`.

### 2. 진입점 (`src/main.tsx`)

`ReactDOM.createRoot(document.getElementById('root')!)` 에 다음 순서로 렌더한다:
`<React.StrictMode>` → `<BrowserRouter basename="/productivity-app">` → `<App />`.

`basename` 은 Vite `base` 와 반드시 같은 문자열이어야 한다(끝 슬래시 유무만 다름). StrictMode 때문에 개발 모드에서 모든 `useEffect` 가 두 번 실행되므로, 뼈대의 부수효과(방문 기록 쓰기 등)는 전부 멱등해야 한다.

### 3. App 루트 레이아웃 (`src/App.tsx`)

`App` 은 훅 두 개를 호출하고 3개 블록을 세로로 쌓는다.

- 호출 훅: `useTrackVisit()` (접속자 기록), `useCompletionAlert()` (생산 완료 알림 구독).
- 루트 엘리먼트: `<div className="min-h-screen bg-gray-100 flex flex-col">`
- 자식 순서: `<Header />`, `<SubNav />`, `<MainContainer />`.

#### MainContainer 폭 규칙

`useLocation().pathname` 으로 "넓은 화면" 여부를 판정한다. 다음 중 하나로 **시작**하면 넓은 화면:
`/analytics/monthly`, `/analytics/remix`, `/analytics/productivity`, `/analytics/material`, `/analytics/remain-analysis`, `/analytics/yield`, `/attendance`, `/inventory`.

`<main className={\`flex-1 ${wide ? 'max-w-screen-2xl' : 'max-w-screen-xl'} w-full mx-auto px-4 py-5\`}>` 안에 `<Routes>` 를 둔다. 기본은 `max-w-screen-xl`.

### 4. 라우트 전체 지도

`<Routes>` 안의 선언 순서 그대로:

| 경로 | 컴포넌트 | 비고 |
|---|---|---|
| `/` | `Dashboard` | 현황(대시보드) |
| `/machine/:id` | `Machine` | 입력 — `:id` 는 `1`/`2`/`3`, 화면에서 `${id}호기` 로 조립 |
| `/external/:id` | `ExternalPack` | 외포장 — `:id` 는 `1`/`2`/`3` |
| `/scoop` | `Scoop` | 내포장 |
| `/scoop/board` | `Scoop` (`board` prop = true) | 내포장 현황판. 같은 컴포넌트가 `board` 가 truthy 면 `<BoardView …>` 를 대신 렌더 |
| `/remaining` | `Remaining` | **잠금 없음** |
| `/report` | `Report` | **잠금 없음** |
| `/import` | `Import` | **잠금 없음**, 네비게이션 메뉴에 없는 숨은 경로 |
| `/analytics` | `Analytics` | 이하 14개는 `AnalyticsGate` 의 자식 라우트 |
| `/analytics/monthly` | `AnalyticsMonthly` | |
| `/analytics/remaining` | `Remaining` | `/remaining` 과 동일 컴포넌트, 이쪽만 잠김 |
| `/analytics/remain-analysis` | `RemainAnalysis` | |
| `/analytics/remix` | `Remix` | |
| `/analytics/productivity` | `Productivity` | |
| `/analytics/under10` | `Under10` | |
| `/analytics/waste` | `Waste` | |
| `/analytics/report` | `Report` | `/report` 과 동일 컴포넌트, 이쪽만 잠김 |
| `/analytics/material` | `MaterialAnalysis` | |
| `/analytics/scoop` | `ScoopAnalysis` | |
| `/analytics/container` | `ContainerAnalysis` | |
| `/analytics/yield` | `YieldAnalysis` | |
| `/analytics/settings` | `ProductSettings` | |
| `/attendance` | `Attendance` | 조직도 |
| `/attendance/productivity` | `ProductivityInput` | |
| `/inventory` | `Inventory` | |
| `/purchase/inbound` | `Inbound` | |
| `/purchase/history` | `InboundHistory` | |

**catch-all(`*`) 라우트가 없다.** 일치하는 경로가 없으면 헤더·서브네비는 그대로 뜨고 본문만 비어 있는 화면이 된다.

게이트는 `<Route element={<AnalyticsGate />}>` 로 감싼 레이아웃 라우트이며, `AnalyticsGate` 가 통과 시 `<Outlet />` 을 렌더한다. 즉 `/analytics*` 전부가 잠기고 `/report`, `/remaining`, `/import` 는 잠기지 않는다 — 이건 버그가 아니라 현재 동작이다.

### 5. 섹션 판정 (`getSection`)

`Section` 타입: `'dashboard' | 'input' | 'analytics' | 'purchase' | 'attendance' | 'inventory'`.

pathname 을 위에서부터 다음 순서로 검사해 첫 매치를 반환한다.

1. `/machine` 또는 `/external` 또는 `/scoop` 로 시작 → `input`
2. `/analytics` 로 시작, **또는** pathname 이 정확히 `/report`, **또는** 정확히 `/remaining` → `analytics`
3. `/purchase` 로 시작 → `purchase`
4. `/attendance` 로 시작 → `attendance`
5. `/inventory` 로 시작 → `inventory`
6. 그 외 전부 → `dashboard`

`/import` 는 어디에도 안 걸려서 `dashboard` 로 분류된다(헤더의 '현황' 이 활성 표시됨).

### 6. 상단 헤더 (`Header`)

`<header className="bg-blue-700 text-white sticky top-0 z-20">`. 내부는 두 덩어리.

#### 6-1. 로고 줄 (항상 표시)

`px-3 sm:px-5 py-2 sm:py-2.5 flex items-center gap-3 sm:gap-4`

- 왼쪽: 흰 배경 박스(`bg-white rounded px-1.5 py-0.5 sm:px-2 sm:py-1 flex items-center shadow`) 안에 `<Logo height={28} />`.
- 그 옆 2줄 텍스트(`leading-tight`):
  - 1줄: **`순수본 1공장 MES`** (`font-bold text-xs sm:text-sm`)
  - 2줄: 오늘 날짜 라벨 (`text-blue-100 text-[10px] sm:text-xs`). 포맷은 **`M/D(요일)`** — `${today.getMonth()+1}/${today.getDate()}(${days[today.getDay()]})`, 요일 배열은 `['일','월','화','수','목','금','토']`. 앞자리 0 패딩 없음. 예: `9/13(일)`.
- 가운데: `<div className="flex-1" />` 스페이서.
- 오른쪽: PC 전용 네비 (`hidden sm:flex gap-1 items-center`).

`Logo` 컴포넌트는 저장소 루트의 `image.png` 를 `import logoUrl from '../../image.png'` 로 가져와 `<img src={logoUrl} alt="순수본" height={height} style={{ height, width: 'auto', display: 'block' }} />` 로 그린다. `height` 기본값 38, 헤더에서는 28 을 넘긴다.

#### 6-2. 메인 메뉴 6개 (`rightLinks`)

선언 순서와 정확한 문자열:

| 순서 | section | to | label | icon |
|---|---|---|---|---|
| 0 | `dashboard` | `/` | `현황` | — |
| 1 | `input` | `/machine/1` | `입력` | — |
| 2 | `analytics` | `/analytics` | `분석` | — |
| 3 | `purchase` | `/purchase/inbound` | `구매` | `🛒` |
| 4 | `attendance` | `/attendance` | `조직도` | `📅` |
| 5 | `inventory` | `/inventory` | `재고관리` | `📦` |

활성 판정은 URL 비교가 아니라 **`getSection(pathname) === l.section`** 이다. 그래서 `/machine/3` 에 있어도 '입력' 이 활성이고, `/analytics/waste` 에서도 '분석' 이 활성이다.

- 활성 스타일: `bg-white text-blue-700`. 비활성: `text-blue-100 hover:bg-blue-800` (모바일은 `active:bg-blue-800`).
- PC 링크 공통 클래스: `px-3 py-1.5 text-sm rounded font-medium transition flex items-center gap-1.5 select-none`.
- 구분선: `attendance` 항목이면서 인덱스 > 0 일 때, 링크 **앞에** `<span className="w-px h-5 bg-blue-400 mx-1.5" aria-hidden />` 를 넣는다. 즉 `구매` 와 `조직도` 사이에 세로 선 하나. (조건상 실제로는 `attendance` 하나에만 걸린다.)
- 아이콘이 있으면 라벨 앞에 `<span className="text-xs">{icon}</span>`.

#### 6-3. 모바일 네비 (두 번째 줄)

`<nav className="sm:hidden grid grid-cols-6 gap-0.5 px-1.5 pb-1.5 bg-blue-700">` — 6개를 화면폭 6등분. 각 항목은 세로 배치(`flex flex-col items-center justify-center gap-0.5`), 아이콘은 `text-sm leading-none`, 라벨은 `leading-none`, 버튼 클래스 `px-1 py-1.5 text-xs rounded font-medium transition select-none`.

#### 6-4. 분석 로그아웃 버튼

`onAnalytics = pathname.startsWith('/analytics')` 이고 `localStorage` 에 `analyticsAuthedAt` 키가 **존재하기만 하면** 버튼을 보인다(TTL 검사 안 함).

- PC: `🔓 로그아웃`, 클래스 `ml-2 px-2.5 py-1 text-xs rounded bg-blue-800 hover:bg-blue-900 text-blue-100 hover:text-white font-medium flex items-center gap-1`, `title="분석 로그아웃"`.
- 모바일: 그리드 맨 아래 전체폭 `col-span-6 mt-1 py-1 text-[11px] rounded bg-blue-800 text-blue-100 font-medium`, 라벨 `🔓 분석 로그아웃`.
- 동작: `localStorage.removeItem('analyticsAuthedAt')` 후 **`window.location.reload()`**. (상태 갱신이 아니라 새로고침이다.)

### 7. 서브 네비게이션 (`SubNav`)

`getSection(pathname)` 으로 탭 배열을 고르고, 배열이 비어 있으면(`dashboard`) **컴포넌트 자체를 렌더하지 않는다**(`return null`).

컨테이너: `<div className="bg-white border-b border-gray-200 sticky top-[52px] z-10">` → 안쪽 `max-w-screen-xl mx-auto px-4` → `<nav className="flex overflow-x-auto scrollbar-none">` (가로 스크롤).

탭 링크 클래스: `px-4 py-3 text-sm whitespace-nowrap border-b-2 transition font-medium`.
활성: `border-blue-600 text-blue-700` / 비활성: `border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300`.

활성 판정: 탭에 `exact: true` 가 있으면 `pathname === to`, 아니면 **`pathname.startsWith(to)`**. (NavLink 의 `isActive` 를 쓰지 않고 직접 계산한다. `end={t.exact}` 는 별개로 넘긴다.)

`SUB_TABS` 전문 (라벨·경로 그대로):

- `dashboard`: **빈 배열** (현황 화면엔 서브탭 없음)
- `input`:
  `1호기`→`/machine/1`, `2호기`→`/machine/2`, `3호기`→`/machine/3`,
  `외포장-1`→`/external/1`, `외포장-2`→`/external/2`, `외포장-3`→`/external/3`,
  `내포장`→`/scoop`, `내포장 현황판`→`/scoop/board`
- `analytics`:
  `일별요약`→`/analytics` (**exact**), `월별현황`→`/analytics/monthly`, `잔여량`→`/analytics/remaining`,
  `잔여량분석`→`/analytics/remain-analysis`, `잔여량/재배합`→`/analytics/remix`, `생산성`→`/analytics/productivity`,
  `10ea미만`→`/analytics/under10`, `폐기`→`/analytics/waste`, `금속CCP`→`/analytics/report`,
  `원재료분석`→`/analytics/material`, `내포장분석`→`/analytics/scoop`, `용기분석`→`/analytics/container`,
  `원재료수율분석`→`/analytics/yield`, `설정`→`/analytics/settings`
- `purchase`: `입고`→`/purchase/inbound`, `입고이력`→`/purchase/history`
- `attendance`: `조직도`→`/attendance` (**exact**), `생산성 입력`→`/attendance/productivity`
- `inventory`: `재고관리`→`/inventory`

### 8. 분석 접근 제한 — `AnalyticsGate`

**비밀번호 방식이다. Firebase Auth 계정이 아니다.**

- 비밀번호 출처: Firestore 문서 **`settings/analyticsAuth`** 의 **`password`** 필드(문자열). `getDoc` 1회, 실시간 구독 아님.
- 세션 저장소: `localStorage` 키 **`analyticsAuthedAt`**, 값은 로그인 성공 시각의 `Date.now()` 를 문자열로 저장. TTL 은 **12시간** (`12 * 60 * 60 * 1000`).
- `isAuthed()` 규칙: 키 없으면 false. 숫자 변환값이 0/NaN 이거나 `Date.now() - ts > TTL` 이면 **키를 삭제하고** false.

마운트 시 흐름:

1. 문서를 읽어 `password` 를 상태에 넣는다(없으면 `''`).
2. **`password` 가 빈 문자열이면 무조건 통과**(`setAuthed(true)`) — 즉 설정 문서가 없거나 비번을 비워두면 분석이 전면 개방된다.
3. 비번이 있으면 `isAuthed()` 로 판정. 통과면 `authed`. 실패했는데 **읽기 직전에 키가 있었다면**(`wasAuthed`) `expired = true` 로 만료 안내를 띄운다.
4. 끝나면(성공·실패 무관, `finally`) `loaded = true`.

화면 상태:

- 로딩 중: `<div className="text-center text-gray-400 text-sm py-20">로딩 중...</div>`
- 잠금 화면: `flex items-center justify-center py-20` 안에 `bg-white border rounded-xl shadow-lg p-8 w-full max-w-sm` 카드.
  - 자물쇠 이모지 `🔒` (`text-4xl mb-3`), 제목 **`비밀번호를 입력하세요`** (`text-xl font-bold text-gray-800 tracking-tight`).
  - 만료 시 그 아래 배지: **`세션이 만료되었습니다 (12시간) — 다시 로그인 해주세요`** (`text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2`).
  - 입력창: `type="password"`, `autoFocus`, placeholder **`비밀번호`**, 클래스 `w-full border rounded-md px-3 py-2.5 text-base text-center font-mono tracking-wider focus:outline-none focus:ring-2`. 오류 상태면 `border-red-400 focus:ring-red-200`, 아니면 `focus:ring-blue-200`. **Enter 키로 제출**, 입력이 바뀌면 오류 표시를 즉시 끈다.
  - 오류 문구: **`비밀번호가 틀렸습니다`** (`text-xs text-red-600 text-center mt-2`).
  - 버튼: **`확인`**, 입력이 비어 있으면 `disabled` (`disabled:bg-gray-300 disabled:cursor-not-allowed`), 평소 `bg-blue-700 hover:bg-blue-800 text-white py-2.5 rounded-md font-semibold w-full mt-4`.
  - 하단 안내: **`한번 로그인하면 12시간 동안 유지됩니다`** (`text-[10px] text-gray-400 text-center mt-3`).
  - 틀리면 카드가 흔들린다: 컴포넌트가 `<style>` 로 `@keyframes shake`(0%/100% translateX(0), 25% -8px, 75% 8px)와 `.animate-shake { animation: shake 0.4s ease-in-out; }` 를 인라인 주입하고, `shake` 를 **500ms** 뒤에 끈다(애니메이션은 400ms).
- 통과: `<Outlet />` 만 렌더.

비교는 `input === password` 단순 문자열 일치 — 공백 트림도, 해시도 없다.

### 9. 조회 날짜 (viewDate)

전 화면이 공유하는 "지금 보고 있는 날짜" 를 `localStorage` 한 칸에 둔다. (`src/lib/viewDate.ts`)

- 키: **`viewDate`**. 저장 형태는 JSON `{ date: string, chosenOn: string }` — `date` 는 보려는 날, `chosenOn` 은 그 선택을 한 날(`todayKey()`).
- `saveViewDate(date)`: `{ date, chosenOn: todayKey() }` 를 `JSON.stringify` 해서 저장.
- `loadViewDate()`:
  1. 키가 없으면 `todayKey()`.
  2. JSON 파싱 성공 &&`parsed.chosenOn === todayKey()` 면 `parsed.date` 반환.
  3. 파싱 실패(구버전: 그냥 `"YYYY-MM-DD"` 문자열이 저장돼 있던 시절)면 그 값이 오늘과 같을 때만 반환.
  4. 그 외 전부 `todayKey()`.

즉 **"어제 과거 날짜를 보다가 오늘 다시 열면 자동으로 오늘로 리셋된다"** 가 `chosenOn` 의 존재 이유다. 같은 날 안에서는 페이지를 옮겨 다녀도 날짜가 따라온다.

사용 패턴(모든 페이지 공통): `const [date, setDate] = useState(loadViewDate);` — **초기화 함수로 전달**해 마운트 시 1회만 읽고, `useEffect(() => { saveViewDate(date); }, [date])` 로 바뀔 때마다 저장한다. 사용처: `Dashboard`, `Machine`, `ExternalPack`, `Report`, `Analytics`, `Attendance`, `ProductivityInput`.

#### 오늘이 아닌 날을 볼 때 화면 차이

- **Dashboard(`/`)**: 날짜 네비게이션 줄에 `‹`/`›` 버튼(각 `w-8 h-8 … border border-gray-300 bg-white`), 가운데 라벨(`font-semibold text-gray-800 text-base`), `<input type="date">`, 그리고 오늘이 아닐 때만 **`오늘로`** 버튼(`text-xs px-2.5 py-1 rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium`)이 추가로 나타난다. 라벨 포맷은 **`YYYY.MM.DD (요일)`** (`dateLabel`, 월·일 2자리 패딩).
  또한 **`viewDate !== todayKey()` 이면 `appMeta/dailyProgress` 진행률 문서를 쓰지 않는다** — 과거 날짜를 열어봤다고 오늘 진행률이 덮이면 안 되기 때문.
- **Machine(`/machine/:id`)**: 제목 `{machine} 입력` 옆에 `<input type="date">`. 오늘이 아니면 `오늘로` 버튼(`px-3 py-1 text-xs rounded bg-blue-100 text-blue-700 font-medium hover:bg-blue-200`)과 경고 문구 **`⚠ 과거 날짜에 입력 중`** (`text-xs text-orange-600 font-medium`)이 함께 뜬다. **입력 자체는 막지 않는다.**
- **ExternalPack(`/external/:id`)**: 동일 구조, 경고 문구만 **`⚠ 과거 날짜 보는 중`**.
- **Analytics·Report·Attendance·ProductivityInput·Inventory** 도 같은 톤의 `오늘로` 버튼을 갖는다.

#### 입력 페이지의 자동 날짜 롤오버 (중요)

`Machine` 과 `ExternalPack` 은 마운트 후 **60초(`60_000ms`)마다** `effectiveTodayKey()` 를 계산해 현재 `date` 와 다르면 **무조건 `setDate(eff)`** 한다. 자정을 넘겨 화면을 켜둔 태블릿이 어제 날짜에 계속 입력하는 사고를 막으려는 장치다.

부작용: **이 두 화면에서 손으로 고른 과거 날짜는 최대 60초 안에 오늘로 되돌아간다.** (그리고 `saveViewDate` 가 다시 불려 공유 `viewDate` 도 오늘로 바뀐다.) `useEffect` 의존성이 `[date]` 라 날짜가 바뀔 때마다 인터벌이 재설정되고, 언마운트 시 `clearInterval` 한다.

### 10. 날짜 유틸 (`src/lib/dateUtil.ts`)

전부 **브라우저 로컬 타임존** 기준이다. UTC 변환·`toISOString()` 을 절대 쓰지 않는다(한국에서 `toISOString().slice(0,10)` 을 쓰면 09시 이전이 전날로 밀리는 버그가 나므로 의도적으로 배제).

- `todayKey()` → `YYYY-MM-DD`. `getFullYear()`, `String(getMonth()+1).padStart(2,'0')`, `String(getDate()).padStart(2,'0')` 를 `-` 로 join.
- `effectiveTodayKey()` → "입력 페이지용 오늘". 현재 시각의 **`getHours() < 2` 이면 하루를 뺀 뒤** 같은 포맷으로 만든다. 주석 그대로 *"새벽 2시 이전이면 전날로 본다(야간조 보호)"*. 00:00~01:59 사이의 야간조 입력이 다음 날짜 문서로 새는 걸 막는다.
- `shiftDateKey(key, delta)` → `key` 를 `-` 로 쪼개 숫자로 만든 뒤 `new Date(y, m-1, d+delta)` 로 로컬 Date 를 만들고 다시 `YYYY-MM-DD` 로 포맷. 월말/연말 넘김이 자동 처리된다.
- `formatTime(d = new Date())` → `HH:MM` (24시간, 2자리 패딩). 초 없음.

주의: `Dashboard.tsx` 는 `shiftDateKey` 를 import 하지 않고 **자기 파일 안에 같은 로직의 `shiftDate` 와 `dateLabel` 을 따로 갖고 있다**(주석: "타임존 버그 없는 날짜 이동"). 재현 시 둘 다 존재해도 되고 공용으로 합쳐도 결과는 같다.

Firestore 의 날짜 키는 전부 이 `YYYY-MM-DD` 문자열이며, 월 단위 화면들은 `todayKey().slice(0, 7)` 로 `YYYY-MM` 을 얻는다.

### 11. 접속자 표시 (presence, `src/lib/presence.ts`)

"실시간 presence"가 아니라 **오늘 이 앱을 연 기기 수 집계**다.

- 기기 식별자 `getVisitorId()`: `localStorage` 키 **`visitorId`**. 없으면 `` `${Date.now()}-${Math.random().toString(36).slice(2, 12)}` `` 로 만들어 저장. 브라우저 저장소를 지우면 새 방문자로 센다.
- `useTrackVisit()` — `App` 최상단에서 1회 호출(`[]` 의존성).
  - 쓰기 경로: **`visits/{date}_{visitorId}`** (문서 ID 가 `날짜_방문자ID`).
  - 필드: `date`(=`todayKey()`), `visitorId`, `lastSeen: serverTimestamp()`.
  - `setDoc` 이므로 같은 기기가 같은 날 몇 번 새로고침해도 문서는 1개(멱등). 실패는 `.catch(() => {})` 로 조용히 무시.
  - **하루 1회 청소**: `localStorage['visitsCleanupDate']` 가 오늘과 다르면 `query(collection(db,'visits'), where('date','<', date))` 로 과거 문서를 전부 읽어 개별 `deleteDoc` 하고, 성공 시 `visitsCleanupDate` 에 오늘을 기록한다. 삭제 실패도 조용히 무시.
- `useTodayVisitorCount()` — `query(collection(db,'visits'), where('date','==', todayKey()))` 를 `onSnapshot` 으로 구독하고 **`snap.size`** 를 그대로 카운트로 쓴다. `useEffect` 가 `onSnapshot` 의 해제 함수를 그대로 반환하므로 언마운트 시 구독이 끊긴다.
- **사용처는 `Report`(생산 내역 조회) 한 곳뿐**이다. 표시 모양: 초록 알약 배지 `inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-50 border border-green-200 text-xs text-green-700 font-medium` 안에 깜빡이는 점(`w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse`)과 문구 **`오늘 방문자 {visitors}명`**.
- 하루 안에서는 값이 줄지 않는다(접속 종료를 기록하지 않음). 자정이 지나도 열려 있는 탭은 재구독하지 않으므로 카운트가 어제 날짜에 멈춘다.

### 12. 생산 완료 알림 — 헤더 롱프레스 (`src/lib/completionAlert.ts`)

뼈대에 박혀 있는 기기별 알림 장치다.

- 켜짐 여부: `localStorage['completionAlert:on'] === '1'`. 마지막 알림 날짜: `localStorage['completionAlert:notified']`. 저장 접근은 전부 try/catch(시크릿 모드 대비).
- **켜고 끄는 법: 헤더의 `현황` 메뉴를 5초 꾹 누른다.** `useLongPress(onLong, ms = 5000)` 훅:
  - 포인터 이벤트 `onPointerDown` 에서 타이머 시작, `onPointerUp`/`onPointerLeave`/`onPointerCancel` 에서 취소.
  - 누르는 동안 `holding` 이 true → PC 링크에 `ring-2 ring-amber-300 scale-95`, 모바일엔 `ring-2 ring-amber-300` 이 붙는다.
  - 발동되면 `firedRef` 를 세우고, **이어지는 `click` 을 `preventDefault`+`stopPropagation` 으로 삼킨다**(`consumeClick`). 안 그러면 꾹 누른 뒤 `/` 로 이동해버린다.
  - `holding` 중의 `onContextMenu` 는 막는다(모바일 길게눌러 메뉴 방지).
  - `현황` 링크에만 붙고, `title="5초 꾹 누르면 생산 완료 알림을 켜고 끌 수 있습니다"` 를 갖는다.
- `toggleAlertByLongPress()`:
  - 이미 켜져 있으면 `confirm('이 기기의 생산 완료 알림을 끌까요?')` → 확인 시 끔.
  - 꺼져 있으면: `Notification` 미지원 브라우저면 `alert('이 브라우저는 알림을 지원하지 않습니다.\n(iPhone 은 Safari 에서 "홈 화면에 추가" 후 사용해 주세요)')`.
  - 지원하면 3줄 안내 `confirm`("· 진행률이 100% 가 되면 알림이 뜹니다 (하루 1회) / · 확인을 누른 이 기기에만 갑니다 (PC·휴대폰 각각 따로 설정) / · 브라우저가 켜져 있어야 합니다 (다른 탭에 있어도 됩니다)") → `Notification.requestPermission()` → 거부면 `alert('알림 권한이 거부되어 있습니다.\n브라우저 주소창 옆 자물쇠(ⓘ) → 알림 → 허용 으로 바꿔주세요.')`.
  - 성공하면 켜고 테스트 알림 `('알림이 켜졌습니다', '오늘 생산이 100% 완료되면 이 기기로 알려드립니다.', 'ssbon-alert-test')` 를 즉시 쏜다.
- 표시: 켜져 있으면 PC 는 라벨 뒤에 `🔔`(`title="생산 완료 알림 켜짐"`), 모바일은 라벨 문자열에 `' 🔔'` 를 덧붙인다.
- 상태 동기화: 토글 후 `window.dispatchEvent(new Event('ssbon:alert-changed'))` 를 쏘고, `useCompletionAlert` 는 이 커스텀 이벤트를 듣고 `isAlertOn()` 을 다시 읽는다(`Header` 와 `App` 이 각각 별도 상태를 갖기 때문).
- `useCompletionAlert()` (App 레벨): 알림이 꺼져 있으면 아무것도 구독하지 않는다. 켜져 있으면 `watchTodayProgress(handleProgress)` 를 걸고, **60초마다 `new Date().getDate()` 를 비교해 날짜가 바뀌면 기존 구독을 끊고 새 날짜로 재구독**한다. 언마운트 시 인터벌과 구독 모두 해제.
- `watchTodayProgress(onChange)` 가 거는 실시간 구독(모두 `todayKey()` 기준, 5개):
  - `days/{date}/items`
  - `days/{date}/machines/{'1호기'|'2호기'|'3호기'}/entries` (3개)
  - `days/{date}/logistics`
  각 스냅샷마다 `emit()` 을 호출하고, 반환값은 모든 해제 함수를 한 번에 부르는 클로저다.
- `emit()` 의 계산 규칙(대시보드와 동일해야 한다):
  - 호기별 `{코드(소문자): 수량}` 을 합쳐 `actualByCode` 를 만든다. 수량 = `actualProduction + additionalProduction`(없으면 0).
  - `totalQty` = items 의 `totalQty` 합.
  - `completedItems` = 다음 중 하나를 만족하는 item 수:
    (a) 코드를 `toLowerCase()` 후 `replace(/[-\s]/g, '')` 로 정규화한 키가 `logistics` 맵에 **존재하면**(값과 무관) 완료, 또는
    (b) `actualByCode[code.toLowerCase()] >= totalQty && totalQty > 0`.
  - `pct` = `totalQty` 가 0 이면 0, 아니면 `Math.round( Σ min(생산량, totalQty) / totalQty * 100 )`. **반올림은 마지막에 한 번**.
  - **`logistics` 문서가 하나라도 있으면 `pct` 를 강제로 `100` 으로 덮어서 emit 한다** (`hasLogistics ? 100 : pct`).
  - `logistics` 맵의 키는 **문서 ID 를 `toLowerCase().replace(/[-\s]/g,'')` 로 정규화**한 것이고, 값은 `qty` 필드(없으면 0).
- `handleProgress(p)` 발사 조건: `itemCount > 0` && `totalQty > 0` && `pct >= 100` && `lastNotifiedDate() !== p.date`. 발사 전에 `markNotified(p.date)` 를 먼저 해서 **하루 1회**를 보장한다. 제목 `✅ 생산 완료`, 본문 `` `${p.date} 전 품목 생산이 완료되었습니다 (${p.completedItems}/${p.itemCount}품목 · ${p.totalQty.toLocaleString()}EA)` ``, tag `` `ssbon-done-${p.date}` ``.
- `fireNotification(title, body, tag)`: 권한이 `'granted'` 일 때만 `new Notification(..., { body, tag, requireInteraction: true })`, 클릭 시 `window.focus()` + `close()`. 그리고 권한과 무관하게 `navigator.vibrate?.([300,120,300,120,500])` 와 WebAudio 비프(사인파 880Hz 0.18s → 0.2s 뒤 1175Hz 0.28s, gain 0.25 로 exponential ramp, 1.5초 뒤 `ctx.close()`)를 울린다. 전부 try/catch 로 감싸 자동재생 차단 등을 삼킨다.

### 13. Firebase 초기화 (`src/firebase.ts`)

**환경변수를 쓰지 않는다.** 설정값이 소스에 그대로 하드코딩돼 있고(`import.meta.env` / `VITE_*` 사용처 0건), GitHub Actions 빌드에도 시크릿이 없다. Firebase 웹 API 키는 공개돼도 되는 식별자이며 접근 통제는 Firestore 보안 규칙이 담당한다는 전제다.

```
apiKey: 'AIzaSyB2NvRGbKLOHrhBcUKOoiAzwCNpBxTrmPQ'
authDomain: 'fp-01-b64f7.firebaseapp.com'
projectId: 'fp-01-b64f7'
storageBucket: 'fp-01-b64f7.firebasestorage.app'
messagingSenderId: '571043802622'
appId: '1:571043802622:web:ceaa6fdeca768f96f924af'
```

`initializeApp(firebaseConfig)` 의 결과를 `app`, `getFirestore(app)` 를 **`db`**, `getAuth(app)` 를 `auth` 로 export 한다. 앱 전체가 `import { db } from '../firebase'` 로 이 싱글턴 하나만 쓴다(35곳). **`auth` 는 export 만 되고 실제로 로그인·익명인증에 쓰이는 곳이 없다** — 즉 앱은 Firestore 에 미인증 상태로 접근하며, 보안 규칙이 공개 읽기/쓰기를 허용하고 있어야 동작한다. (`ProductSettings` 의 오류 안내 문구만 `request.auth != null` 규칙 예시를 언급한다.)

### 14. 뼈대가 직접 건드리는 Firestore 경로 요약

| 경로 | 누가 | 동작 |
|---|---|---|
| `settings/analyticsAuth` | `AnalyticsGate` | `getDoc` 1회, `password` 필드 읽기 |
| `visits/{YYYY-MM-DD}_{visitorId}` | `useTrackVisit` | `setDoc`(date, visitorId, lastSeen=serverTimestamp) |
| `visits` where `date < today` | `useTrackVisit` | 하루 1회 `getDocs` → 개별 `deleteDoc` |
| `visits` where `date == today` | `useTodayVisitorCount` | `onSnapshot`, `snap.size` |
| `days/{date}/items` | `watchTodayProgress` | `onSnapshot` |
| `days/{date}/machines/{호기}/entries` | `watchTodayProgress` | `onSnapshot` × 3 |
| `days/{date}/logistics` | `watchTodayProgress` | `onSnapshot` |
| `appMeta/dailyProgress` | `Dashboard` | 오늘일 때만 `setDoc(..., { merge: true })` |

### 15. 뼈대가 쓰는 localStorage 키 전체

| 키 | 값 | 의미 |
|---|---|---|
| `analyticsAuthedAt` | `Date.now()` 문자열 | 분석 로그인 시각, TTL 12시간 |
| `viewDate` | `{"date","chosenOn"}` JSON | 공유 조회 날짜 |
| `visitorId` | `{ts}-{rand10}` | 기기 식별자 |
| `visitsCleanupDate` | `YYYY-MM-DD` | 과거 방문기록 청소 완료일 |
| `completionAlert:on` | `'1'` | 이 기기 알림 켜짐 |
| `completionAlert:notified` | `YYYY-MM-DD` | 마지막 완료 알림 날짜 |

(페이지 고유 키 — `extPackTableFontSize`, 각종 `…cache:` 접두 캐시, `attendanceSnapshotBackfill_v2`, `matAnalysis:expandSub`, 재고 알림 키 등 — 는 각 페이지 사양에서 다룬다.)

---

# 2부 — 데이터 모델 (Firestore 구조와 코드 규칙)

## 데이터 모델 — Firestore 구조와 코드 규칙

이 문서는 **현황(대시보드)** 과 **입력(1·2·3호기, 외포장-1/2/3)** 이 읽고 쓰는 데이터 구조만 다룬다.
화면 레이아웃·인터랙션은 다른 문서가 담당하고, 여기서는 **"어떤 경로에 어떤 필드가 어떤 규칙으로 들어가는가"** 를 정의한다.

---

### 0. 전제

- 백엔드는 **Firebase Firestore 단일 프로젝트** 하나뿐이다. 서버·API 레이어가 없고, 브라우저 SDK(`firebase/firestore`)가 직접 읽고 쓴다.
- `src/firebase.ts` 가 `initializeApp` → `export const db = getFirestore(app)` 를 내보내고, 모든 페이지가 이 `db` 하나를 쓴다. `getAuth(app)` 로 `auth` 도 내보내지만 **현황·입력 화면은 로그인 없이 동작한다.** 인증 분기가 붙는 곳은 `/analytics/*` 라우트뿐이고(`settings/analyticsAuth` 문서의 `password` 필드 + localStorage `analyticsAuthedAt` 12시간 TTL), 현황·입력·외포장에는 어떤 권한 분기도 없다.
- 트랜잭션(`runTransaction`)은 어디에도 쓰지 않는다. 전부 `setDoc` / `addDoc` / `updateDoc` / `deleteDoc` / `writeBatch` 이고, **모든 화면 갱신은 `onSnapshot` 실시간 구독**에 의존한다. 즉 낙관적 로컬 상태를 따로 만들지 않고, 쓰기 → 서버 → 스냅샷 → 리렌더의 한 방향이다. (Firestore SDK가 로컬 라이트를 즉시 스냅샷에 반영하므로 체감 지연은 없다.)

---

### 1. 경로 지도

현황·입력이 만지는 경로는 아래 5개가 전부다.

| 경로 | 문서 ID | 쓰는 화면 | 읽는 화면 |
|---|---|---|---|
| `days/{YYYY-MM-DD}/items/{code}` | **제품코드 그대로** | 현황(붙여넣기·전체삭제), 백업가져오기 | 현황, 1·2·3호기, 외포장, 잔여량, 내포장, 분석 전반 |
| `days/{YYYY-MM-DD}/machines/{machine}/entries/{autoId}` | **자동 ID** | 1·2·3호기 | 현황, 1·2·3호기, 외포장, 잔여량, 분석 전반 |
| `days/{YYYY-MM-DD}/logistics/{ourCode}` | **하이픈 단축코드** | 잔여량 화면의 "수정" 모달 | 현황, 잔여량, 분석 전반 |
| `appMeta/dailyProgress` | 고정 문자열 `dailyProgress` | 현황(오늘 볼 때만) | 외부 Apps Script 시간 트리거 |
| `productSettings/{code}` | **관리자가 입력한 코드 문자열** | 설정 화면 | 분석·내포장·생산성 (현황·입력은 **읽지 않음**) |

`{machine}` 은 `'1호기' | '2호기' | '3호기'` 세 문자열 중 하나다. 한글이 그대로 문서 ID로 들어간다.

**중요**: `days/{YYYY-MM-DD}` 문서 자체는 **한 번도 생성되지 않는다.** 서브컬렉션만 존재하는 "유령 부모 문서"다. 그래서 `days` 컬렉션을 리스트해도 날짜가 나오지 않고, DB 백업 모듈(`src/lib/dbBackup.ts`)도 날짜를 열거하는 대신 `collectionGroup(db, 'items')`, `collectionGroup(db, 'entries')` 처럼 서브컬렉션 그룹으로 긁는다. 날짜를 알아내는 유일한 방법은 "화면이 보고 있는 날짜 문자열을 직접 만들어서 경로에 끼워 넣는 것"이다.

---

### 2. `days/{YYYY-MM-DD}/items/{code}` — 일별 품목 (생산 계획)

그날 만들어야 할 품목과 목표수량. **이 컬렉션이 하루의 기준점**이고, 다른 모든 화면이 여기에 조인한다.

TypeScript 인터페이스(`src/types.ts` 의 `Item`):

| 필드 | 타입 | 단위 | 필수 | 기본/비고 |
|---|---|---|---|---|
| `id` | string | — | 필수(타입상) | **항상 `code` 와 같은 값**을 넣는다. 문서 ID와도 같다. 3중 중복이지만 그대로 유지할 것 |
| `code` | string | — | 필수 | 제품코드. **정규화하지 않은 원문**(아래 8장) |
| `name` | string | — | 필수 | 품목명. 값이 없으면 빈 문자열 `''` (undefined 아님) |
| `orderQty` | number | EA | 필수 | 주문수량 |
| `coupang` | number | EA | 필수 | 쿠팡 |
| `marketKurly` | number | EA | 필수 | 마켓컬리. **주말 모드에서는 무조건 `0`** |
| `sample` | number | optional | — | 샘플. 붙여넣기는 항상 씀(샘플모드 아니면 `0`). 백업가져오기는 아예 안 씀(필드 없음) |
| `totalQty` | number | EA | 필수 | **목표수량**. 진행률·완료판정의 분모 |
| `actualProduction` | number | EA | 필수 | 붙여넣기 시 항상 `0`. **현황 화면은 이 필드를 표시에 쓰지 않는다**(호기 entries 합계를 쓴다). 사실상 레거시 |
| `coolingEndTime` | string | `'HH:MM'` | optional | 붙여넣기는 절대 쓰지 않음(필드 자체가 없음). 백업가져오기만 값이 있을 때 씀 |
| `date` | string | `'YYYY-MM-DD'` | 필수 | 경로의 날짜와 동일값을 문서 안에도 중복 저장 |

**문서 ID = 제품코드**를 쓰는 이유: 같은 날 같은 코드가 두 번 등록되면 자동으로 덮어써져서 중복행이 생기지 않는다. ERP 붙여넣기를 두 번 해도 안전하다. 대신 부작용이 있다 —

- 붙여넣기는 `batch.set(...)` 을 **merge 없이** 호출한다. 따라서 재붙여넣기는 기존 문서를 통째로 교체하고, `actualProduction` 은 `0` 으로, `coolingEndTime` 은 **필드 삭제**로 되돌아간다.
- 코드 문자열이 Firestore 문서 ID 제약(`/` 금지, `.` `..` 금지, 1500바이트 이하)을 그대로 받는다. 붙여넣은 코드는 **아무 검증 없이** 경로에 들어가므로 코드에 `/` 가 섞이면 예외가 난다.

**쓰기 트리거 1 — 현황 화면 "ERP 데이터 붙여넣기"**

탭(`\t`) 구분 텍스트를 파싱한다. 모드가 3가지고 **열 개수와 열 의미가 모드마다 다르다.**

- `isWeekend === false && hasSample === false` → **평일**, 최소 6열
  열 순서 문구: `코드 / 품목명 / 주문수량 / 쿠팡 / 마켓컬리 / 총수량 (6열)`
- `isWeekend === false && hasSample === true` → **평일+샘플**, 최소 7열
  열 순서 문구: `코드 / 품목명 / 주문수량 / 쿠팡 / 마켓컬리 / 샘플 / 총수량 (7열)`
- `isWeekend === true` → **주말**, 최소 5열
  열 순서 문구: `코드 / 품목명 / 주문수량 / 쿠팡 / 총수량 (5열)`

매핑 규칙 (0-based 열 인덱스):

```
code        = cols[0].trim()                      // 대문자화·정규화 없음
name        = cols[1]?.trim() || ''
orderQty    = num(cols[2])
coupang     = num(cols[3])
marketKurly = isWeekend ? 0 : num(cols[4])
sample      = useSample ? num(cols[5]) : 0
totalQty    = isWeekend ? num(cols[4]) : (useSample ? num(cols[6]) : num(cols[5]))
actualProduction = 0
date        = viewDate
```

`useSample = !isWeekend && hasSample` 이다. 주말 모드로 전환하면 샘플 체크박스는 강제로 꺼진다(`setIsWeekend(true); setHasSample(false)`), 그래서 "주말+샘플" 조합은 존재하지 않는다.

숫자 파서 `num(s)` 규칙 (정확히 이대로):
1. `trim()` 후 콤마(`,`)를 **전부** 제거
2. 결과가 `'-'` 이거나 `''` 이면 → `0`
3. `parseFloat` 결과가 `NaN` 이면 → `0`, 아니면 그 값

`parseFloat` 이므로 소수점이 그대로 들어올 수 있다. 정수 강제는 없다. `'-'` 를 0으로 치는 규칙이 핵심이다(ERP가 빈 칸을 `-` 로 내보낸다).

행 필터: `cols.length >= minCols && cols[0]?.trim()` 둘 다 만족해야 한다. 열이 모자란 줄(헤더, 합계행)은 조용히 버려진다.

**쓰기 트리거 2 — 현황 화면 "전체 삭제"**
확인 문구 `오늘 데이터를 모두 삭제할까요?` → 현재 로드된 `items` 를 `batch.delete(doc(db,'days',viewDate,'items', i.code))` 로 전부 지운다. **호기 entries 와 logistics 는 건드리지 않는다.** 즉 품목만 지우면 생산기록은 고아로 남고, 현황 화면에서는 items 기준으로 렌더하므로 보이지 않게 된다.

**쓰기 트리거 3 — 백업 가져오기(`/import`)**
xlsx 시트에서 파싱해 `doc(db,'days',date,'items',it.code)` 로 `set`. 450건씩 끊어서 배치 커밋한다.

---

### 3. `days/{YYYY-MM-DD}/machines/{machine}/entries/{autoId}` — 호기 생산 입력

1·2·3호기 화면에서 "등록"을 누를 때마다 **한 건씩 쌓이는 이벤트 로그**다. 누적 수량이 아니라 이벤트라는 점이 중요하다.

인터페이스(`MachineEntry`):

| 필드 | 타입 | 단위 | 필수 | 비고 |
|---|---|---|---|---|
| `id` | string | — | 필수(타입상) | 제품코드를 그대로 넣는다. **문서 ID가 아니다** |
| `code` | string | — | 필수 | items 의 `code` 를 **글자 그대로 복사**한 값 |
| `actualProduction` | number | EA | optional | 일반 등록일 때만 존재 |
| `additionalProduction` | number | EA | optional | 추가 등록일 때만 존재 |
| `workTime` | string `'HH:MM'` | — | optional | 일반 등록일 때만 존재 |
| `additionalWorkTime` | string `'HH:MM'` | — | optional | 추가 등록일 때만 존재 |
| `machine` | `'1호기'\|'2호기'\|'3호기'` | — | 필수 | 경로와 동일값 중복 저장 |
| `date` | string `'YYYY-MM-DD'` | — | 필수 | 경로와 동일값 중복 저장 |

**문서 ID = `addDoc` 자동 ID** 인 이유: 같은 코드를 같은 호기에서 여러 번 생산하는 것이 정상 업무(1차 생산 → 부족분 추가생산)이므로, 코드를 ID로 쓰면 덮어써져서 이력이 사라진다. 그래서 여기만 자동 ID다.

**"한 문서는 일반이거나 추가이거나 둘 중 하나"** 가 규칙이다. 등록 시 두 필드 쌍 중 한 쪽만 쓴다:

- 일반: `{ id, code, machine, date, actualProduction: qty, workTime: time }`
- 추가: `{ id, code, machine, date, additionalProduction: qty, additionalWorkTime: time }`

쓰지 않는 쪽은 **`0` 이나 `''` 가 아니라 필드 자체가 없다.** 화면은 `editable={!!e.workTime}` / `editable={!!e.additionalWorkTime}` 로 이 존재여부를 보고 "그 행이 소유하지 않은 칸"을 회색 `-` 로 고정한다. 그러니 0으로 채워 넣으면 UI 동작이 달라진다.

`time` 은 `formatTime()` 결과인 **클라이언트 로컬 시각** `HH:MM`(24시간, 0패딩)이다. 서버 타임스탬프를 쓰지 않는다.

**부분 수정**: 표의 숫자를 눌러 인라인 편집하면 `updateDoc` 으로 `{ actualProduction: v }` 또는 `{ additionalProduction: v }` **한 필드만** 갱신한다. 작업시간을 일부러 건드리지 않는 이유는 **정렬이 작업시간 기준이라 수정 때마다 행이 튀는 것을 막기 위해서**다. 주석에도 그렇게 적혀 있다. 저장 조건은 `!isNaN(n) && n >= 0 && n !== value`; 아니면 되돌린다(음수·NaN 거부, 동일값 저장 생략).

**삭제**: `deleteDoc`. 확인 문구는 `` `${code} 기록을 삭제할까요?` ``.

**백업 가져오기의 예외**: `/import` 만은 entries 를 `doc(db,'days',date,'machines',e.machine,'entries', e.code)` 즉 **코드를 문서 ID로** 써서 저장한다. 그래서 백업 복원 시 한 호기·한 날짜·한 코드당 **단 한 건**으로 합쳐지고, 그 한 문서 안에 `actualProduction`·`additionalProduction`·`workTime`·`additionalWorkTime` 이 **동시에** 들어간다. 집계는 항상 두 필드를 더하므로 숫자는 맞지만, 문서 모양은 앱이 만든 것과 다르다. 재현 시 이 비대칭을 그대로 유지해야 과거 데이터가 깨지지 않는다.

**정렬 규칙**(1·2·3호기와 외포장 공통, 클라이언트 정렬):
1. `ta = a.workTime || a.additionalWorkTime || ''` (둘 다 없으면 빈 문자열)
2. `tb.localeCompare(ta)` — **시간 문자열 내림차순**(최신이 위). `HH:MM` 0패딩이라 문자열 비교로 시간 비교가 성립한다.
3. 같은 분이면 `b.docId.localeCompare(a.docId)` — 문서 ID 내림차순. 주석은 "나중에 만든 doc 가 위"라고 하지만 **Firestore 자동 ID는 랜덤 20자라 시간순이 아니다.** 결정적(deterministic)이긴 해도 실제로는 임의 순서다. 그대로 두되 "시간순 보장"으로 착각하지 말 것.

---

### 4. `days/{YYYY-MM-DD}/logistics/{ourCode}` — 물류(잔여량) 보정

ERP 물류 화면에서 복사한 잔여수량. **존재하기만 하면 현황 화면의 계산 모드 전체가 바뀐다**(생산 기준 → 물류 기준).

필드는 딱 3개다. `set` 으로 통째 교체하며 merge 하지 않는다.

| 필드 | 타입 | 필수 | 비고 |
|---|---|---|---|
| `code` | string | 필수 | 변환된 **하이픈 단축코드**(= 문서 ID와 동일) |
| `qty` | number | 필수 | 잔여수량(EA). `parseInt(..., 10)` 결과 |
| `erpCode` | string | 필수 | 변환 전 **ERP 원본 코드**(예: `A-001-01`). 역추적용 |

**문서 ID = `ourCode`** 인 이유: 같은 날 같은 품목의 잔여량은 하나뿐이어야 하고, 재붙여넣기가 덮어써야 하기 때문이다.

**파싱 규칙 (잔여량 화면 "수정" 모달 → 저장)**
1. 헤더 정규화 함수: `s.trim().replace(/\s+/g, '').toLowerCase()` — **공백을 전부 제거**한 뒤 소문자화. 그래서 `'ERP 품목코드'` 가 `'erp품목코드'` 로 매칭된다.
2. 코드 열 후보(정확히 이 배열): `['제품코드', 'erp품목코드', '품목코드', 'erp코드']`
   수량 열 후보: `['등록수량']`
3. 붙여넣은 줄들 중 **두 열을 모두 가진 첫 줄**을 헤더 행으로 삼는다. 없으면 `alert('헤더(제품코드/ERP 품목코드 + 등록수량)를 찾을 수 없습니다')` 후 중단. (헤더 앞의 제목·필터 줄은 자동으로 건너뛴다.)
4. 헤더 다음 줄부터: `erpCode = r[codeCol].trim()`, `qty = parseInt(r[qtyCol] || '0', 10)`.
   **스킵 조건**: `!erpCode || isNaN(qty) || qty < 0`. 즉 **음수 잔여량은 저장되지 않고**, `0` 은 저장된다(0 = "딱 맞음" 표시로 쓰인다). `parseInt` 라 `'1,234'` 는 **1** 이 된다 — 콤마 제거를 하지 않는 것이 현재 동작이다.
5. `ourCode = convertErpCode(erpCode)` (**아래 8장의 하이픈 버전**).
6. **같은 `ourCode` 끼리 qty 를 합산**한다(ERP가 한 품목을 여러 행으로 쪼개 내보내므로). `erpCode` 는 **처음 만난 값**을 유지한다.
7. 배치로 전부 `set` → `alert(`${count}개 품목 물류 데이터 저장 완료`)`.

**놓치기 쉬운 점**: 저장은 **기존 logistics 문서를 지우지 않는다.** 이번 붙여넣기에 없는 코드의 문서는 그대로 남아 계속 "물류 모드"를 유지시킨다. 전부 지우는 건 "물류 초기화" 버튼(`확인 문구: 물류 데이터를 삭제하고 생산 기준으로 돌아갈까요?`)뿐이고, 이것도 **현재 구독으로 로드된 문서 ID들만** 지운다.

---

### 5. `appMeta/dailyProgress` — 진행률 단일 문서

현황 화면이 **오늘을 보고 있을 때만** 쓰는 단일 문서. 외부 Apps Script 시간트리거가 이 한 줄만 읽고 완료 여부를 판단하도록 만든 것이다.

| 필드 | 타입 | 비고 |
|---|---|---|
| `date` | string `'YYYY-MM-DD'` | 보고 있는 날짜(= 오늘) |
| `pct` | number | 진행률 정수 0~100 |
| `completedItems` | number | 완료 품목 수 |
| `itemCount` | number | 총 품목 수 |
| `totalQty` | number | 총 목표수량 |
| `updatedAt` | string | `new Date().toISOString()` |

쓰기 조건이 까다롭다 — 이걸 빠뜨리면 쓰기 비용이 폭발한다:
1. `viewDate !== todayKey()` 이면 **아무것도 쓰지 않는다**(과거 날짜 조회가 오늘 진행률을 덮어쓰면 안 되므로).
2. 서명 문자열 `` `${pct}|${completedItems}|${itemCount}|${totalQty}` `` 를 `useRef` 에 보관하고, **직전과 같으면 쓰기를 생략**한다. 즉 값이 실제로 변할 때만 1쓰기.
3. `setDoc(..., { merge: true })` 이고 `.catch(() => {})` 로 **오류를 통째로 무시**한다(오프라인/권한거부여도 화면은 영향 없음).

---

### 6. `productSettings/{code}` — 제품 DB (마스터)

| 필드 | 타입 | 단위 | 필수 | 비고 |
|---|---|---|---|---|
| `code` | string | — | 사실상 필수 | 문서 ID와 같은 값. 단, 읽을 때는 **`d.id` 로 덮어쓴다**(`{ ...d.data(), code: d.id }`) — 문서 ID가 진실 |
| `type` | `'냄비' \| '바트' \| null` | — | optional | 토글 해제 시 **`null` 을 명시적으로 저장**한다(필드 삭제가 아님) |
| `name` | string | — | optional | 표시명 |
| `packWeight` | number | **g** | optional | 1EA 포장중량(냉장 기준) |
| `vatMaxQty` | number | EA | optional | 한 바트당 최대 수량. **`999` 는 "냄비"를 뜻하는 센티널 값** |

모든 쓰기는 `setDoc(..., { merge: true })` 라 다른 필드를 보존한다.

**일일 데이터와의 관계 — 여기가 핵심이다:**

- `productSettings` 와 `days/{date}/items` 사이에는 **어떤 외래키 제약도, 어떤 자동 동기화도 없다.** items 의 `name`·수량은 전부 ERP 붙여넣기에서 오지, productSettings 에서 오지 않는다.
- **현황·1·2·3호기·외포장 화면은 `productSettings` 를 아예 읽지 않는다.** 이 네 화면은 `days/{date}` 하위만으로 완결된다. 재현 시 이 화면들에 제품 DB 조회를 끼워 넣으면 안 된다(읽기 비용도, 코드 매칭 실패 리스크도 새로 생긴다).
- 제품 DB를 읽는 쪽은 내포장(`Scoop`, `vatMaxQty` 표시), 잔여량분석(`RemainAnalysis`, 완바트 환산), 생산성/10ea미만/원재료분석이다. 이들은 **문서 ID가 제각각이라는 전제로** 조회 맵을 만든다(8·9장).
- 즉 관계는 "items 가 사실, productSettings 는 부가정보"다. items 에 있는 코드가 productSettings 에 없어도 아무 오류도 나지 않고, 그 품목은 부가정보만 비어 보인다.

---

### 7. 날짜 키 규칙 (`src/lib/dateUtil.ts`, `src/lib/viewDate.ts`)

날짜 키는 **항상 로컬 시간대 기준으로 직접 조립한 `YYYY-MM-DD` 문자열**이다. `toISOString().slice(0,10)` 을 절대 쓰지 않는다 — UTC로 밀려 하루가 틀어지기 때문이다.

- `todayKey()` : 로컬 `getFullYear/getMonth+1/getDate` 를 2자리 0패딩해 조립.
- `effectiveTodayKey()` : **현재 시각이 새벽 2시 이전(`getHours() < 2`)이면 하루를 뺀다.** 야간조가 자정을 넘겨 입력해도 전날 데이터에 쌓이게 하는 보호 장치다.
- `shiftDateKey(key, delta)` : `new Date(y, m-1, d + delta)` 로 이동 후 재조립. 월말·윤년을 JS Date 가 처리한다. (현황 화면에는 같은 로직의 로컬 `shiftDate` 사본이 따로 들어 있다.)
- `formatTime(d = new Date())` : 로컬 `HH:MM` 0패딩.

**localStorage `viewDate`** — 세 화면(현황·호기·외포장·잔여량)이 보고 있는 날짜를 공유한다.
- 저장값은 JSON `{ date: 'YYYY-MM-DD', chosenOn: 'YYYY-MM-DD' }`.
- 읽을 때 `chosenOn === todayKey()` 일 때만 `date` 를 복원하고, **날이 바뀌었으면 무조건 오늘**로 돌아간다. 어제 과거 날짜를 보다 껐어도 다음 날엔 오늘부터 시작한다.
- 구버전(평문 문자열) 호환: JSON 파싱 실패 시 `raw === today` 면 그 값을 쓴다.

**날짜 롤오버 타이머** — 1·2·3호기와 외포장에만 있다:
60초마다 `effectiveTodayKey()` 와 현재 `date` 를 비교해 다르면 **강제로 그 날짜로 바꾼다.** 부작용이 있다 — 호기 화면에서 과거 날짜를 골라도 **1분 안에 오늘로 되돌아간다.** 그리고 00:00~01:59 사이에는 `effectiveTodayKey()` 가 어제라서 날짜가 어제로 잡히는데, `isToday` 판정은 `todayKey()` 로 하므로 `⚠ 과거 날짜에 입력 중` 배지가 뜬 채로 정상 동작한다. 현황 화면에는 이 타이머가 **없다**(과거 조회가 가능해야 하므로).

---

### 8. 제품코드 정규화 함수 4종 (`src/lib/codeUtil.ts`)

코드 표기가 세 갈래로 들어온다 — ERP 풀코드(`A-001-01`), 하이픈 단축(`A-01`), 무하이픈 단축(`A01`). 네 함수가 이걸 중재한다.

#### 8-1. `convertErpCode(raw)` — ERP 풀코드 → 무하이픈 단축
정규식 `^([A-Za-z])-(\d+)-\d+$` 로 **전체가 정확히 3토막**일 때만 변환한다. 매치 실패 시 `raw.trim()` 을 그대로 돌려준다(멱등).
변환: 첫 글자 대문자화 + 가운데 숫자를 `parseInt` 후 `padStart(2, '0')` + **하이픈 없이** 연결.

| 입력 | 출력 |
|---|---|
| `A-001-01` | `A01` |
| `F-528-01` | `F528` (3자리는 패딩 안 됨) |
| `I-003-51` | `I03` |
| `A-01` | `A-01` (3토막 아님 → 그대로) |
| `A01` | `A01` |

#### 8-2. ⚠ 같은 이름의 **하이픈 버전 사본이 따로 있다**
`src/pages/Remaining.tsx` 와 `src/components/LogisticsInputModal.tsx` 안에 **로컬로 복제된** `convertErpCode` 가 있고, 이건 `` `${letter}-${num}` `` 즉 **하이픈을 넣어서** 돌려준다.

| 입력 | 로컬 사본 출력 |
|---|---|
| `A-001-01` | `A-01` |
| `F-528-01` | `F-528` |
| `I-003-51` | `I-03` |

**그래서 `logistics` 문서 ID는 `A-01` 처럼 하이픈이 들어간 모양이고, `items` 문서 ID는 보통 `A01` 처럼 하이픈이 없다.** 두 컬렉션을 조인할 때 하이픈 제거 정규화가 반드시 필요한 이유가 이것이다. 리팩터링으로 이 사본을 `codeUtil` 의 것으로 통일하면 **문서 ID 모양이 바뀌어 과거 데이터와 안 붙는다.** 반드시 그대로 둘 것.

#### 8-3. `normalizeCode(code)` — 비교 전용 키
`(code || '').toLowerCase().replace(/[-\s]/g, '')` — **소문자화 + 하이픈·공백 제거뿐**이다. 길이를 줄이거나 0패딩을 하지 **않는다.**

| 입력 | 출력 |
|---|---|
| `A-01` | `a01` |
| `A01` | `a01` |
| `A-001-01` | `a00101` ← 단축되지 않음 |
| `  f 528 ` | `f528` |

즉 `normalizeCode('A-001-01') !== normalizeCode('A-01')` 이다. 이것이 조회 맵을 3중으로 만들어야 하는 이유다(9장).

#### 8-4. `canonicalShort(raw)` — 무엇이든 표준 단축코드로
1. `raw.trim().toUpperCase()` 후 **선두 `PB-` 접두어 하나를 제거**(`replace(/^PB-/, '')`). 대문자화가 먼저이므로 `pb-` 도 제거된다.
2. 정규식 `([A-Z])-?(\d+)` 로 **앵커 없이 첫 매치**를 찾는다 — 문자열 어디서든 "알파벳 + (선택적 하이픈) + 숫자" 를 잡는다.
3. 매치 실패 시 **1단계 결과 문자열을 그대로** 반환.
4. 성공 시 `` `${글자}${parseInt(숫자,10).padStart(2,'0')}` ``.

| 입력 | 출력 | 비고 |
|---|---|---|
| `A01` | `A01` | |
| `A-01` | `A01` | |
| `A-001-01` | `A01` | 첫 매치 `A-001` 만 씀 |
| `PB-A-001` | `A01` | PB- 제거 후 |
| `pb-a-1` | `A01` | |
| `F-528-01` | `F528` | 3자리는 패딩 없음 |
| `I-003-51` | `I03` | |
| `PB01` | **`B01`** | 하이픈이 없어 `PB-` 제거가 안 되고, `P` 뒤에 숫자가 없어 `B01` 이 잡힌다 ⚠ |
| `ABC-12` | **`C12`** | 앵커가 없어 마지막 글자 `C` 가 잡힌다 ⚠ |
| `순수쌀미음` | `순수쌀미음` | 매치 실패 → 원문(대문자화된) 그대로 |
| `''` | `''` | |

#### 8-5. `compareCode(a, b)` — 자연 정렬 (F01, F02, F06, F12, F104 …)
1. 양쪽에 `^([A-Za-z]+)(\d+)` 를 **앵커해서** 적용.
2. **둘 다 매치될 때만**: 글자부를 대문자화해 `localeCompare` → 0이 아니면 그 값. 같으면 `parseInt(숫자a) - parseInt(숫자b)` (숫자 크기 비교).
3. **한쪽이라도 매치 실패면** `(a||'').localeCompare(b||'')` 로 통째 문자열 비교.

| 비교 | 결과 |
|---|---|
| `F06` vs `F12` | F06 먼저 (6 < 12) |
| `F12` vs `F104` | F12 먼저 (사전순이면 F104가 먼저였을 것) |
| `A01` vs `F01` | A01 먼저 |
| `A01` vs `a01` | **0 (동률)** — 대소문자 무시, 숫자 동일 |
| `A-01` vs `A01` | 앵커 실패(하이픈) → **문자열 localeCompare 로 폴백** ⚠ |

**동률(0) 일 때 tie-break 이 없다.** `Array.prototype.sort` 의 안정성(ES2019 이후 보장)에 의존하며, 입력 순서는 Firestore 스냅샷 순서 = **문서 ID 오름차순**이다. 즉 실질 tie-break 은 문서 ID 사전순이다.

---

### 9. 같은 제품이 여러 코드로 들어오는 문제를 어떻게 다루는가

정책은 **"레이어마다 다른 강도의 정규화"** 다. 한 곳에서 통일하지 않는다.

**레이어 1 — 일일 items: 정규화하지 않는다.**
붙여넣은 `cols[0].trim()` 이 그대로 코드이자 문서 ID다. 대문자화도, `canonicalShort` 도 걸지 않는다. 그날 ERP가 뭐라고 부르든 **그 하루 동안은 그것이 그 품목의 정체성**이다. 이렇게 두는 이유: items 를 기준으로 다른 모든 데이터가 파생되므로, 기준 자체를 변형하면 원본 추적이 끊긴다.

**레이어 2 — 호기 entries: 복사해서 문제를 회피한다.**
`entries.code` 는 사용자가 타이핑하는 게 아니라 **검색 목록에서 고른 item 의 `code` 를 글자 그대로 복사**(`setSelectedCode(it.code)` → `code: selectedCode`)한다. 그래서 items ↔ entries 조인은 정규화가 필요 없고, 실제로 **단순 `code.toLowerCase()` 키**로만 붙인다(현황·호기·외포장·잔여량 전부 동일).
→ 재현 시 "코드를 직접 입력하는 UI"를 만들면 이 보증이 깨진다. 반드시 목록 선택 방식이어야 한다.

**레이어 3 — logistics ↔ items: 하이픈 제거 정규화로 붙인다.**
모양이 다르므로(8-2) 양쪽을 `toLowerCase().replace(/[-\s]/g, '')` 한 뒤 비교한다.
- 현황: logistics 맵을 만들 때부터 키를 `d.id.toLowerCase().replace(/[-\s]/g,'')` 로 정규화해 담고, item 쪽도 같은 식으로 정규화해 조회.
- 잔여량: 맵 키는 **원본 doc ID 그대로** 담고(삭제할 때 그 ID가 필요하므로), 조회할 때 `Object.entries(...).find(([k]) => normalize(k) === normItem)` 로 **선형 탐색**한다.
→ 이 차이(정규화된 키 vs 원본 키)를 뒤집으면 "물류 초기화"가 아무 문서도 못 지운다.

**레이어 4 — 분석·부가정보: `canonicalShort` 로 한 점에 모은다.**
월별 생산량, 원재료 사용량, 완바트 환산 등은 하루 경계를 넘어 여러 날·여러 표기를 합산해야 하므로 전부 `canonicalShort(code)` → `A01` 로 눌러서 키를 만든다.

**레이어 5 — productSettings 조회: 3중 키 맵.**
문서 ID가 자유형식이라 어느 한 정규화로는 못 맞춘다. 그래서 소비자 쪽이 **한 문서를 세 키로 등록**한다:
```
map.set(normalizeCode(d.id), s);
map.set(normalizeCode(convertErpCode(d.id)), s);
map.set(normalizeCode(canonicalShort(d.id)), s);
```
조회도 대칭으로 세 번 시도한다(`?? ?? ??`). 일부 화면(내포장·잔여량분석·용기)은 `canonicalShort(d.id)` 단일 키만 쓴다 — 그 화면들은 코드가 이미 표준형이라는 전제다.

**알려진 오염과 청소 장치**
- `PB-` 접두 쓰레기 문서가 제품 DB에 생겼던 이력이 있어서, 포장중량 일괄 모달에 `/^PB-/i` 로 걸러 일괄 삭제하는 버튼이 있다(400개씩 배치).
- 완바트·포장중량 일괄 입력은 새 문서를 만들지 않는다. `canonicalShort(기존 doc id) → 실제 doc id` 조회 맵을 먼저 만들고, **매칭된 기존 문서에만** merge 한다. 매칭 실패는 `⚠ 제품DB에 없어 매칭 실패 N개: ...` 로 보여주고 저장하지 않는다. 코드 표기 흔들림 때문에 유령 문서가 늘어나는 걸 막는 설계다.

---

### 10. 조인 키 요약 (어느 화면이 무엇을 무슨 키로 붙이나)

| 조인 | 키 | 쓰는 곳 |
|---|---|---|
| items ↔ machine entries | `code.toLowerCase()` (하이픈 유지) | 현황, 1·2·3호기, 외포장, 잔여량, 완료알림 |
| items ↔ logistics | `code.toLowerCase().replace(/[-\s]/g,'')` | 현황, 완료알림 |
| items ↔ logistics (잔여량) | `normalize()` 동일식이지만 맵 키는 원본 doc ID | 잔여량 |
| items/entries ↔ productSettings | `canonicalShort` 단일 또는 `normalizeCode` 3중 | 내포장, 잔여량분석, 생산성, 10ea미만, 원재료분석 |
| 일자 간 합산 | `canonicalShort` | 월별현황, 원재료·수율 분석 |

---

### 11. 이 데이터로 만드는 파생값 (현황·입력이 계산하는 것)

여기 계산식은 데이터 모델의 일부다. 반올림 위치와 분기 순서를 그대로 지켜야 한다.

**`actualByCode` (코드별 실제 생산량)** — 세 호기 entries 전체에 대해
`(actualProduction || 0) + (additionalProduction || 0)` 을 `code.toLowerCase()` 키로 **누적 합산**. 일반/추가를 구분하지 않고 더한다.

**`hasLogistics`** = `Object.keys(logisticsByCode).length > 0`. **문서가 한 건이라도 있으면** 현황·잔여량이 통째로 물류 모드로 전환된다.

**현황 통계 카드 5개**
- `totalQty` = items 의 `totalQty` 합
- `actual`(완료된 수량) = 물류 모드면 `totalQty + (모든 logistics.qty 합)` ← items 와 매칭되지 않는 logistics 도 전부 더해진다. 생산 모드면 `items 각각의 actualByCode 합`(items 에 없는 코드의 생산은 무시)
- `itemCount` = `items.length`
- `completedItems` = 각 item 에 대해 **① logistics 에 정규화 코드가 있으면 값과 무관하게 완료**(음수여도 완료), ② 아니면 `actual >= totalQty && totalQty > 0`
- `pct` = `totalQty` 가 0이면 `0`. 아니면 `Math.round( Σ min(produced, totalQty) / totalQty * 100 )`
  - **클램프가 먼저, 합산 다음, 반올림은 맨 마지막 한 번.** 품목별로 반올림하지 않는다. 초과 생산은 `Math.min` 으로 잘려서 100%를 넘기지 않는다.
  - **`pct` 는 logistics 를 전혀 보지 않는다.** 물류 모드여도 진행률은 생산 기준이다. (완료알림 모듈 `watchTodayProgress` 만 예외로 `hasLogistics ? 100 : pct` 로 덮어쓴다.)

**현황 `±` 열과 행 배경**
- `logQty !== undefined` 이면: 표시 실제생산량 = `totalQty + logQty`, `diff = logQty`, 완료로 간주(초록 배경), "진행중" 아님.
- 아니면: 표시 = `actual`, `diff = actual - totalQty`, 완료 = `actual >= totalQty && totalQty > 0`(초록), 진행중 = `0 < actual < totalQty`(빨강).
- `diff >= 10` 이면 `±` 셀에 빨간 배경(과잉 생산 경고).

**냉각 종료 시각** = 해당 코드의 **전 호기 최신 작업시각 + 50분**.
- 최신 시각: 각 entry 에서 `[workTime, additionalWorkTime].filter(Boolean).sort().pop()` (문자열 정렬로 큰 쪽) → 호기별 맵 → 세 호기 중 문자열 최대.
- `+50분` 계산: `total = h*60 + m + 50`, `nh = Math.floor(total/60) % 24`, `nm = total % 60` → **자정을 넘으면 랩어라운드**한다(날짜 정보 없음).
- 작업시각이 하나도 없으면 `item.coolingEndTime` 을 보여주고, 그것도 없으면 `'-'`.

**호기 화면 검색 목록 필터** = `totalQty <= 0` 이면 항상 포함, 아니면 `전 호기 합산 생산 < totalQty` 일 때만 포함. 즉 **다 만든 품목은 검색에서 사라진다.**

**외포장 행 배경**(`totalQty > 0` 일 때만, 위에서부터 먼저 맞는 것):
`combined < totalQty` → `bg-red-200` / `multiEntry` → `bg-green-200` / `combined > totalQty` → `bg-yellow-200` / 그 외(정확히 일치 + 단일 생산) → 배경 없음.
`multiEntry` = (이 호기에서 같은 코드 entry 2건 이상) **또는** (생산량 > 0 인 호기가 2개 이상).

---

### 12. 실시간 구독 규칙

- 모든 구독은 `useEffect` 가 **`onSnapshot` 의 반환값(unsubscribe)을 그대로 리턴**하거나, 여러 개면 `return () => unsubs.forEach((u) => u())` 로 해제한다. 의존성은 `[date]` 또는 `[date, machine]`.
- **날짜가 바뀌면 구독을 새로 걸기 전에 상태를 먼저 비운다** — `setItems([])`, `setMachineQty({'1호기':{}, '2호기':{}, '3호기':{}})`, `setLogisticsByCode({})`. 주석대로 "구데이터 잔상 방지"다. 이걸 빼면 새 날짜의 첫 스냅샷이 오기 전까지 전날 숫자가 그대로 보인다.
- 호기별 3개 구독은 각각 독립 콜백이고, `setMachineQty((prev) => ({ ...prev, [machine]: qmap }))` 처럼 **함수형 업데이트로 자기 호기 슬롯만** 갈아끼운다. 3개가 동시에 도착해도 서로 덮어쓰지 않게 하는 장치다.
- 현황의 "전 호기 최신 작업시각"은 `useEffect` 클로저 밖 지역 객체 `perMachineTime` 에 호기별 맵을 누적해 두고, 어느 호기든 스냅샷이 올 때마다 세 호기를 다시 병합해 `setLastTimeByCode` 한다.
- `onSnapshot` 에 에러 콜백을 다는 곳은 완료알림 모듈뿐(`() => {}` 무시). 나머지는 에러 핸들러가 없다.

---

### 13. 쓰기 비용·배치 한계

- Firestore `writeBatch` 는 500건 제한이다. **현황의 붙여넣기와 전체삭제는 청크를 나누지 않는다** — 한 번에 500행 이상이면 커밋이 실패한다. 실패 시 `setTimeout(..., 50)` 으로 `등록 중 오류: {메시지}` alert 를 띄운다(패널은 이미 닫힌 뒤다).
- 백업 가져오기는 450건, 제품 DB 일괄 삭제류는 400건씩 끊는다. 새로 만드는 대량 쓰기도 같은 관례를 따를 것.
- 현황 화면은 붙여넣기 직후 **검증 전에** `setPasteText('')` + `setShowPaste(false)` 로 패널을 먼저 닫는다. 그래서 모든 사용자 알림이 `setTimeout(..., 50)` 으로 지연 실행된다(닫힌 뒤에 alert 가 뜨도록).

---

### 14. 이 영역이 **쓰지 않는** 것 (혼동 방지)

- `types.ts` 의 **`ExternalPackEntry` 인터페이스는 어디에도 저장되지 않는다.** 외포장 화면은 자기 데이터를 전혀 쓰지 않는 **완전 읽기 전용 뷰**이고, `days/{date}/machines/{machine}/entries` + `days/{date}/items` 만으로 행을 조립한다. 이 타입을 근거로 새 컬렉션을 만들면 안 된다.
- `Item.actualProduction` 은 저장되긴 하지만 현황 표시에 쓰이지 않는다(호기 entries 합계가 진실). 잔여량 화면은 아예 이 필드를 계산값으로 덮어쓴다.
- 내포장(`days/{date}/scoop`, `days/{date}/scoopFlags`), 실온(`days/{date}/ambient`), 재배합(`remix/{date}/items`), 폐기(`waste/{date}/entries`)는 같은 `days/{date}` 아래 있거나 유사하지만 **현황·호기·외포장 어느 화면도 읽지 않는다.**
- 외포장 화면의 표 글자 크기는 Firestore가 아니라 **localStorage `extPackTableFontSize`** 에 저장된다(기기별). 범위 12~72, 기본 18, 증감 2. 저장값이 범위를 벗어나면 기본값으로 떨어진다.

---

# 3부 — 현황↔입력 연결: 생산량이 확정되는 규칙 ★

## 현황 ↔ 입력 연결 — "그날 얼마 만들었나"가 확정되는 규칙

이 문서가 다루는 것: 계획(`items`) · 실적(`entries`) · 잔여량(`logistics`) 세 갈래 데이터가 어떻게 하나의 "생산량"으로 합쳐지는가. 화면으로는 **현황(Dashboard, `/`)**, **호기 입력(Machine, `/machine/:id`)**, **잔여량(Remaining, `/remaining` 과 `/analytics/remaining`)**, **잔여량 입력 모달(LogisticsInputModal)**, 그리고 이 규칙을 월 단위로 재사용하는 **`src/lib/monthlyProduction.ts`** 다.

---

## 1. 데이터 모델 — 삼각관계

### 1.1 Firestore 경로와 필드 (정확히 이대로)

- **계획** — `days/{YYYY-MM-DD}/items/{code}`
  - 문서 ID = 붙여넣은 코드 원문(trim). 필드: `id, code, name, orderQty, coupang, marketKurly, sample?, totalQty, actualProduction, coolingEndTime?, date`
  - `totalQty` 가 "오늘 이 품목을 몇 EA 만들어야 하나"(발주량). 삼각관계의 기준선.
  - `actualProduction` 필드는 붙여넣을 때 항상 `0` 으로 쓰이고 **그 뒤로 절대 갱신되지 않는다**(레거시). 실적은 전부 `entries` 에 있다. 이 필드를 읽고 생산량을 계산하면 전부 0이 된다.
- **실적** — `days/{YYYY-MM-DD}/machines/{호기}/entries/{자동ID}`
  - 호기 이름은 문자열 `1호기` `2호기` `3호기` 셋뿐. 필드: `id, code, actualProduction?, additionalProduction?, workTime?, additionalWorkTime?, machine, date`
  - 한 문서 = 한 번의 등록. 같은 코드가 하루에 여러 문서로, 여러 호기에 걸쳐 쌓인다.
  - 실적 수량의 정의는 **어디서나 `(actualProduction || 0) + (additionalProduction || 0)`**.
- **잔여량** — `days/{YYYY-MM-DD}/logistics/{ourCode}`
  - 문서 ID = ERP 코드를 변환한 값(`A-01`, `F-528` 처럼 하이픈 1개 형태). 필드: `code, qty, erpCode`
  - `qty` 는 생산량이 아니라 **발주량 대비 남은 수량(= 초과분)** 이다. 0이면 딱 맞게 만든 것.
- **알림용 요약** — `appMeta/dailyProgress` (단일 문서): `date, pct, completedItems, itemCount, totalQty, updatedAt`
- **알림 설정** — `appMeta/notifySettings` (단일 문서): `enabled, emails, webAppUrl, updatedAt`

세 컬렉션은 **서로 참조하지 않는다.** 오직 "코드 문자열"로만 이어진다. 그래서 코드 정규화가 이 앱에서 가장 자주 깨지는 지점이다.

### 1.2 코드 정규화 — 서로 다른 3가지가 공존한다 (하나로 통합하면 안 됨)

1. **`code.toLowerCase()` (하이픈 유지)** — 당일 화면(Dashboard / Machine / Remaining / completionAlert)에서 `items` ↔ `entries` 를 맞출 때. 즉 호기 입력 코드는 품목 코드와 **대소문자만 다를 수 있고 하이픈까지 같아야** 매칭된다.
2. **`code.toLowerCase()` 후 하이픈과 공백 전부 제거** — `logistics` 문서 ID ↔ `items.code` 를 맞출 때만. `A-01` ↔ `A01` 이 여기서 붙는다. Remaining.tsx 안에는 같은 로직의 로컬 `normalize()` 가 따로 정의돼 있다.
3. **`canonicalShort(raw)` (`src/lib/codeUtil.ts`)** — 월/기간 집계 전용. 규칙: trim → 대문자 → 선두 `PB-` 제거 → "영문 1글자 + (선택적 하이픈) + 숫자" 패턴 매칭 → 글자 + 숫자를 2자리로 zero-pad. 결과: `PB-A-001` / `A-001-01` / `a01` / `A-01` → 전부 `A01`, `F-528-01` → `F528`(3자리는 그대로), 매칭 실패 시 대문자 원문.

**함정:** `convertErpCode` 라는 같은 이름의 함수가 **두 개**다.
- `src/lib/codeUtil.ts` 의 것은 `A-001-01` → `A01` (하이픈 없음)
- `Remaining.tsx` / `LogisticsInputModal.tsx` 안의 로컬 버전은 `A-001-01` → **`A-01`** (하이픈 있음)

잔여량 문서 ID 를 만드는 건 **로컬 버전**이다. 그래서 logistics 문서 ID 는 `A-01`, `I-03`, `F-528` 꼴이고, 읽는 쪽은 반드시 "하이픈 제거" 정규화(2번)나 `canonicalShort`(3번)를 통과시켜야 한다. 두 변환 모두 `영문-숫자-숫자` 패턴에 안 맞는 입력은 trim 만 하고 그대로 통과시킨다(예: ERP가 `A01` 을 주면 `A01` 로 저장됨 — 그래서 같은 날 두 형태가 섞일 수 있고, 읽기 쪽 정규화가 그걸 흡수한다).

### 1.3 정렬 규칙

- 품목 목록 정렬은 어디서나 `compareCode(a.code, b.code)`: "영문 접두 + 숫자" 로 쪼개 **영문은 사전순, 숫자는 수치순**. 그래서 `F01, F02, F06, F12, F104` 순서가 나온다(사전순이면 F104가 F12보다 앞에 온다 — 틀림). 패턴이 안 맞으면 문자열 `localeCompare` 폴백.
- 호기 입력 내역 정렬은 §3.3 참조 (시간 내림차순 + docId 내림차순 tie-break).

### 1.4 날짜 경계

- `todayKey()` = 로컬 타임존 기준 오늘 `YYYY-MM-DD`.
- `effectiveTodayKey()` = **새벽 2시 이전이면 전날**로 본다(야간조 보호). Machine / ExternalPack 만 이걸 쓴다.
- 날짜 이동/라벨은 절대 `new Date(dateStr)` 로 파싱하지 않는다(UTC 해석 버그). 항상 `dateStr.split('-')` 로 y/m/d 를 뽑아 `new Date(y, m-1, d + delta)` 로 만든 뒤 다시 zero-pad 해서 조립한다.
- **화면 간 날짜 공유**: Dashboard / Machine / Remaining / ExternalPack 이 전부 localStorage 키 `viewDate` 를 공유한다. 저장 형태는 `{ date, chosenOn }` JSON 이고, **`chosenOn` 이 오늘이 아니면 복원하지 않고 오늘로** 돌아간다(어제 보던 날짜가 다음날 아침에 유령처럼 남는 걸 막는다). 구버전 평문 문자열 포맷도 "오늘과 같을 때만" 복원한다.

---

## 2. 계획 입력 — 현황 화면의 ERP 붙여넣기

**"+ 데이터 입력"**(주황 버튼) 을 누르면 붙여넣기 패널이 열린다.

### 2.1 모드와 열 개수

- 토글 2개: `평일 (쿠팡+컬리)` / `주말 (쿠팡만)`. 초기값은 **오늘이 토/일이면 주말**(`new Date().getDay()` 가 0 또는 6).
- 평일일 때만 체크박스 `샘플 포함 (7열)` 이 보인다. 주말 버튼을 누르면 샘플 체크가 강제 해제된다.
- `useSample = 평일 && 샘플체크`
- 필요 최소 열 수 `minCols` = 주말 5, 평일+샘플 7, 평일 6.
- 안내 문구(정확히):
  - 주말: `코드 / 품목명 / 주문수량 / 쿠팡 / 총수량 (5열)`
  - 평일+샘플: `코드 / 품목명 / 주문수량 / 쿠팡 / 마켓컬리 / 샘플 / 총수량 (7열)`
  - 평일: `코드 / 품목명 / 주문수량 / 쿠팡 / 마켓컬리 / 총수량 (6열)`
- textarea placeholder(탭 구분): 주말 `A01→순수쌀미음→17→-→17`, 평일+샘플 `A01→순수쌀미음→17→-→-→2→19`, 평일 `A01→순수쌀미음→17→-→-→17` (→ 는 탭)

### 2.2 파싱 규칙

- 줄바꿈으로 행 분리 → 탭으로 열 분리 → `열 개수 >= minCols` 이고 `첫 열이 공백이 아닌` 행만 남긴다. (헤더 행은 열 수가 모자라거나 첫 열이 비어 자연히 걸러지는 걸 전제로 한다 — 별도 헤더 탐지 없음.)
- 숫자 파싱 `num(s)`: trim → 콤마 전부 제거 → `'-'` 이거나 빈 문자열이면 **0** → `parseFloat` → NaN이면 0. (ERP가 빈칸을 `-` 로 주기 때문에 이 처리가 필수다.)
- 열 → 필드 매핑:
  - `code = cols[0].trim()`, `name = cols[1] 또는 ''`, `orderQty = num(cols[2])`, `coupang = num(cols[3])`
  - `marketKurly` = 주말이면 **0**, 평일이면 `num(cols[4])`
  - `sample` = useSample 이면 `num(cols[5])`, 아니면 0
  - `totalQty` = 주말 `num(cols[4])` / 평일+샘플 `num(cols[6])` / 평일 `num(cols[5])`
  - `actualProduction = 0`, `date = viewDate`, `id = code`
- 저장: `writeBatch` 로 `days/{viewDate}/items/{code}` 에 `set`(전체 덮어쓰기).

### 2.3 동작 순서와 엣지케이스

- "등록"을 누르면 **await 전에 먼저** textarea 를 비우고 패널을 닫는다(현장에서 두 번 눌러 중복 등록하는 걸 막기 위함).
- 유효 행이 0개면 저장하지 않고 `setTimeout(..., 50)` 으로 alert:
  `붙여넣을 데이터가 없습니다 ({주말|평일+샘플|평일} 모드: {minCols}열 필요)` + 빈 줄 + `붙여넣은 첫 줄: {첫 줄 80자}` (비어 있으면 `(비어있음)`). 패널이 닫히는 애니메이션과 alert 가 겹치지 않게 50ms 지연시킨 것.
- 저장 실패 시 역시 50ms 뒤 `등록 중 오류: {메시지}`.
- **재붙여넣기는 merge 가 아니라 덮어쓰기**이고, **이전 붙여넣기에만 있던 코드는 삭제되지 않는다.** 품목이 빠진 새 목록을 붙이면 유령 품목이 남는다. 지우려면 "전체 삭제".
- "전체 삭제": `confirm('오늘 데이터를 모두 삭제할까요?')` → `items` 만 batch delete. **`entries` 와 `logistics` 는 그대로 남는다.**

---

## 3. 실적 입력 — 1·2·3호기 (Machine)

경로 `/machine/:id`, `machine = "{id}호기"`. 화면 제목은 `{machine} 입력`.

### 3.1 날짜

- 초기값 `loadViewDate()`, 바뀌면 저장.
- **60초마다 `effectiveTodayKey()` 로 강제 복귀한다.** 즉 날짜 입력칸으로 과거 날짜를 골라도 1분 안에 오늘(새벽 2시 전이면 어제)로 되돌아간다. `⚠ 과거 날짜에 입력 중` 경고와 `오늘로` 버튼이 함께 뜨지만 롤오버가 이긴다. 재현 시 이 인터벌을 빼먹으면 동작이 달라진다.

### 3.2 검색과 선택

- 세 개의 실시간 구독: (a) 그날 `items`, (b) **이 호기의** `entries`, (c) **세 호기 전부의** `entries`(합산용). 날짜가 바뀌면 (c)는 빈 객체로 리셋하고 3개 구독을 모두 해제한다.
- `combinedByCode[code.toLowerCase()]` = 전 호기 실적 합계.
- 검색 후보 = `items` 중 `totalQty <= 0` 이거나 `전호기합계 < totalQty` 인 것. **이미 발주량을 채운 품목은 목록에서 사라진다**(중복 생산 방지).
- 검색어가 비어 있으면 후보 **앞에서 30개**만 보여주고, 검색어가 있으면 `코드(소문자 포함검사)` 또는 `품목명(원문 포함검사)` 로 필터(개수 제한 없음). 검색어가 비면 그리드 자체가 숨겨진다.
- 카드 그리드 `grid-cols-2 md:grid-cols-3`, 높이 `max-h-60` 스크롤. 카드 내용: 코드(mono, 작게) / 품목명(굵게) / `총 {totalQty}EA`.
- **부분 생산 상태(partial)** = `전호기합계 > 0 && 남은 수량 > 0`. 이때 카드는 연분홍(`bg-rose-50 border-rose-300`) 이고 `추가 {남은수량}개 필요` 배지(진한 장미색 pill)가 붙는다. 선택된 카드는 `bg-slate-900 text-white`, 배지는 연한 장미색으로 바뀐다.
- 카드를 누르면: 코드 선택 + 검색창에 **품목명을 채우고** + **partial 이면 "추가 생산" 체크가 자동으로 켜진다.**

### 3.3 등록

- 체크박스 `추가 생산`, 켜져 있으면 라벨 뒤에 `(부족분 추가 생산으로 기록)` 이 붙고 초록색.
- 수량은 `−` / 숫자입력 / `+` (−는 0 밑으로 안 내려감). 버튼은 추가생산이면 `추가 등록`(초록), 아니면 `등록`(짙은 회색).
- 검증: 코드 없거나 `qty <= 0` 이면 `alert('코드와 수량을 입력하세요')` 후 중단.
- 저장은 **항상 `addDoc`(새 문서)** 이다. 같은 코드로 다섯 번 누르면 문서 5개가 생긴다. 중복 방지 장치는 §3.2 의 "채운 품목 숨김"뿐.
- 쓰는 필드:
  - 일반: `{ id, code, machine, date, actualProduction: qty, workTime: "HH:MM" }`
  - 추가: `{ id, code, machine, date, additionalProduction: qty, additionalWorkTime: "HH:MM" }`
  - **반대쪽 필드는 아예 쓰지 않는다(undefined).** 0 을 넣으면 안 된다 — 표의 수정 가능 여부(§3.4)가 `workTime` / `additionalWorkTime` 의 존재로 결정되기 때문에, 두 시간 필드를 다 채우면 UI 가 달라진다.
  - 시간은 클라이언트 로컬 `HH:MM` (`formatTime()`), 초 없음.
- 성공하면 선택코드 해제, 수량 0, 검색어 비움, 추가생산 체크 해제.

### 3.4 입력 내역 표

- 헤더: `오늘 입력 내역 ({개수})` + 범례 두 개 — `목표 미달`(연분홍 `bg-rose-100` 스와치), `목표+100↑(오입력 의심)`(`bg-red-300` 스와치).
- 열: `코드 / 실제 생산량 / 추가 생산량 / 작업 시간 / 추가 작업 시간 / (삭제)`. 추가 생산 관련 열 헤더는 `bg-green-50`.
- 정렬: `workTime || additionalWorkTime || ''` 문자열 **내림차순**(최신이 위), 같으면 **docId 내림차순** tie-break(같은 분에 들어온 건 나중에 만든 게 위에 오도록 의도).
- 행 배경 (그 행 하나가 아니라 **그 코드의 전 호기 합계** 기준):
  - `목표 > 0 && 전호기합계 >= 목표 + 100` → `bg-red-300` (오입력 의심)
  - `목표 > 0 && 전호기합계 < 목표` → `bg-rose-100` (부족)
  - 그 외 배경 없음. 두 조건이 겹치면 red-300 우선.
- 코드 셀은 `text-2xl font-bold` mono (멀리서도 보이게).
- 값 셀(`QtyCell`): 숫자를 누르면 그 자리에서 입력칸으로 바뀐다. Enter/blur 로 커밋, Escape 로 취소. `NaN 아님 && 0 이상 && 기존값과 다름` 일 때만 `updateDoc` 한다. **수정하는 필드는 `actualProduction` 또는 `additionalProduction` 뿐이고 작업시간은 건드리지 않는다 → 표 순서가 안 바뀐다.** 이건 의도된 동작이다(현장에서 줄이 튀면 오조작이 난다).
- `editable` = 실제 생산량 칸은 `workTime` 이 있을 때, 추가 생산량 칸은 `additionalWorkTime` 이 있을 때. 아니면 회색 `-` 고정(수정 불가). 값이 0/없으면 `-`, 추가생산은 `+12` 처럼 `+` 접두, 값이 있으면 초록.
- 삭제: `confirm('{code} 기록을 삭제할까요?')` → `deleteDoc`.
- 빈 상태: `아직 입력 내역이 없습니다` (colSpan 6, 회색 가운데).

### 3.5 외포장-1/2/3 은 여기에 아무것도 더하지 않는다

`/external/:id` 는 **같은 `machines/{호기}/entries` 컬렉션을 읽기 전용으로 보여주는 화면**이다. 쓰기가 없다. 그러므로 생산량 확정 규칙에는 영향이 없다. (열: `코드 / 품목명 / 주문수량 / 발주량 / 실제 생산량 / 모자란 수량 / 추가 생산량`, 여기서 `모자란 수량` = 전호기합계 − `totalQty`.) 주의할 점은 `machine` 필드가 없는 유령 entries 가 과거에 외포장 초기데이터로 들어간 적이 있어, **월 집계 쪽에서는 `machine` 필드가 있는 문서만 쓴다**는 것뿐이다.

---

## 4. 잔여량 입력 — 무엇을 받아 어디에 저장하나

같은 컬렉션(`days/{date}/logistics`)에 쓰는 입구가 **두 개** 있고 파싱 규칙이 서로 조금 다르다.

### 4.1 Remaining 화면의 "수정" 모달

- 파란 버튼 `수정` → 모달 `물류 데이터 입력`, 부제 `엑셀/재고 화면에서 복사 후 붙여넣기 · 품목코드(제품코드·ERP 품목코드)·등록수량 열 자동 인식`.
- textarea placeholder: `ERP에서 복사한 내용을 여기에 붙여넣으세요 (Ctrl+V)`. 버튼 `취소` / `저장`(내용 없으면 비활성 회색).
- 헤더 탐지: 각 셀을 trim → 공백 전부 제거 → 소문자 로 정규화한 뒤
  - 코드 열 후보: `제품코드`, `erp품목코드`, `품목코드`, `erp코드`
  - 수량 열 후보: `등록수량`
  - **두 조건을 동시에 만족하는 첫 행**이 헤더 행. 그 위 쓰레기 줄은 무시된다.
  - 못 찾으면 `alert('헤더(제품코드/ERP 품목코드 + 등록수량)를 찾을 수 없습니다')`, 열 탐색 실패 시 `alert('품목코드 또는 등록수량 열을 찾을 수 없습니다')`.
- 데이터 행: 헤더 다음 줄부터 끝까지. `코드 비었거나 / qty가 NaN 이거나 / qty < 0` 이면 **건너뛴다**(음수 잔여량은 저장 불가). `qty` 는 `parseInt(값, 10)`.
- **같은 코드가 여러 행에 나뉘어 오면 합산한다**(Map 으로 누적, `erpCode` 는 처음 값 유지).
- 저장: `writeBatch` 로 `days/{date}/logistics/{ourCode}` 에 `{ code: ourCode, qty, erpCode }` `set`. 완료 후 모달 닫고 텍스트 비우고 `alert('{count}개 품목 물류 데이터 저장 완료')`.
- **이전에 있던 코드는 지우지 않는다.** 다시 붙여넣어도 이번 목록에 없는 코드의 문서는 그대로 남는다. 전부 지우려면 `물류 초기화`.

### 4.2 LogisticsInputModal (월별현황 `/analytics/monthly` 에서 여는 모달)

- 제목 `잔여량 입력 (물류)`, 부제 `ERP에서 복사한 표를 그대로 붙여넣기 하세요`. 헤더 배경 `bg-gradient-to-r from-rose-50 to-pink-50`, 크기 `max-w-3xl h-[90vh]`.
- 자체 날짜 입력칸이 있다. `open` 이 true 가 될 때 `defaultDate` 로 리셋(월별현황에서는 "이번 달이면 오늘, 아니면 그 달 1일").
- **열려 있는 동안에만** 그 날짜의 `logistics` 를 구독한다. 상단 우측에 `현재 등록: {N}개 품목 / 총 {합계} EA`(합계는 장미색 굵게).
- 기존 등록 내역 표: 문서 ID 로 `localeCompare` **오름차순**, `{qty} EA`(장미색 굵게). 섹션 헤더 `{date} 기존 등록 내역` 오른쪽에 빨간 `전체 삭제` → `confirm('{date} 의 물류 데이터({N}개)를 삭제할까요?')` → batch delete.
- 파싱은 §4.1 보다 **엄격하다**: 헤더 행은 셀 값이 정확히 `제품코드` 인 행을 찾고(`findIndex` + `some(c === '제품코드')`), 열은 `indexOf('제품코드')` / `indexOf('등록수량')`. 에러 문구: `제품코드 헤더를 찾을 수 없습니다`, `제품코드 또는 등록수량 열을 찾을 수 없습니다`.
- **중복 코드 합산이 없다.** 같은 코드가 두 줄이면 같은 문서에 두 번 `set` 하게 되어 **뒤 행이 앞 행을 덮어쓴다**(합산 아님). 그리고 `count` 는 처리한 행 수라서 알림에 나오는 개수가 실제 문서 수보다 클 수 있다.
- 하단 버튼: `취소` / `저장`(입력 없거나 저장중이면 비활성, 저장중 텍스트 `저장중...`). 저장 완료 알림: `{date}` 줄바꿈 `{count}개 품목 물류 데이터 저장 완료`.
- 도움말(정확히): `· 헤더에 '제품코드'와 '등록수량'이 포함되어야 합니다` / `· 코드는 자동으로 변환됩니다 (예: A-001-01 → A-01, F-528-01 → F-528)`
- 모달을 닫으면 월별현황이 `forceRefresh()` 로 월 데이터를 다시 읽는다(월별현황은 실시간 구독이 아니라 fetch 기반).

---

## 5. 현황(Dashboard) 화면 — 당일 생산량이 확정되는 곳

### 5.1 구독 3종과 해제

날짜(`viewDate`)가 바뀔 때마다:
- `days/{viewDate}/items` 구독. **구독 전에 `items` 를 빈 배열로 리셋한다**(이전 날짜 데이터가 한 프레임 남아 보이는 잔상 방지). 받은 뒤 `compareCode` 정렬.
- 세 호기의 `entries` 를 각각 구독. 먼저 `{ '1호기': {}, '2호기': {}, '3호기': {} }` 로 리셋. 각 스냅샷에서 `code.toLowerCase()` 키로 `(actual + additional)` 를 누적한 맵을 만들고 `setMachineQty(prev => ({...prev, [machine]: map}))` 로 **호기 단위 부분 갱신**.
- `days/{viewDate}/logistics` 구독. 리셋 후, 키는 **문서 ID 를 소문자 + 하이픈/공백 제거**, 값은 `qty || 0`.
- **정리 함수에서 세 호기 구독을 전부 해제해야 한다.** 안 하면 날짜를 넘길 때마다 구독이 쌓여 옛 날짜 스냅샷이 현재 상태를 덮어쓴다(현장에서 "숫자가 깜빡이며 왔다갔다" 하는 증상).

`hasLogistics = logistics 문서가 1개 이상` — 이 불리언 하나가 화면 전체의 계산 모드를 바꾼다.

### 5.2 통계 카드 5개 (정확한 수식)

카드는 `grid-cols-2 md:grid-cols-5`, 각 카드는 위쪽 4px 컬러 보더 + 라벨(작은 회색) + 값(2xl 굵게 컬러) + 단위(작은 회색).

| 라벨 | 값 | 단위 | 색 |
|---|---|---|---|
| `금일 품목수` | `items.length` | `품목` | blue |
| `총 수량` | 모든 `items.totalQty` 합 | `EA` | green |
| `완료된 수량` | 아래 `actual` | `EA` | orange |
| `진행률` | 아래 `pct` | `%` | 100이면 green, 50 이상이면 orange, 아니면 red |
| `완료된 품목` | 아래 `completedItems` | `품목` | purple |

- **`actual` (완료된 수량) — 여기가 핵심 분기**
  - `hasLogistics` 이면: `총수량 + (모든 logistics.qty 합)`. 즉 **호기 입력을 전혀 쓰지 않는다.** 잔여량 문서에만 있고 품목에 없는 코드의 qty 도 그대로 더해진다.
  - 아니면: `items` 를 돌면서 `actualByCode[item.code.toLowerCase()]` 를 더한 값. **`items` 에 없는 코드로 찍힌 entries 는 빠진다**(오타 코드가 조용히 사라지는 경로).
- **`completedItems`**: 품목별로, `logistics[정규화코드]` 가 `undefined` 가 아니면 → 완료(값이 0이든 음수든 완료). 아니면 `전호기합계 >= totalQty && totalQty > 0` 이면 완료.
- **`pct`**: `Math.round( Σ min(전호기합계, totalQty) / 총수량 × 100 )`, 총수량이 0이면 0.
  **`pct` 는 logistics 를 전혀 보지 않는다.** 그래서 잔여량이 들어온 날에도 호기 입력이 부실하면 `완료된 수량` 은 발주량+잔여량으로 꽉 차 보이는데 `진행률` 은 80% 같은 값으로 남는다. 이건 버그가 아니라 현재 동작이며, 알림 쪽(§8)은 여기와 규칙이 다르다.

### 5.3 `appMeta/dailyProgress` 쓰기

- **`viewDate === todayKey()` 일 때만** 쓴다(과거 날짜를 조회해도 오늘 진행률이 오염되지 않게).
- 시그니처 `pct|completedItems|itemCount|totalQty` 를 ref 에 기억해 **값이 바뀔 때만** 1쓰기. 매 스냅샷마다 쓰면 Firestore 쓰기가 폭발한다.
- `setDoc(..., { merge: true })`, 실패는 조용히 무시(`.catch(() => {})`).
- 이 문서는 앱이 읽지 않는다. 오직 Apps Script 시간트리거가 읽는다(§8).

### 5.4 품목별 현황 표

- 카드 헤더 `품목별 현황` + 우측 `{N}개 품목`.
- 열: `코드 / 품목명 / 주문수량 / 쿠팡 / [마켓컬리] / [샘플] / 총수량 / 실제 생산량 / ± / 냉각 종료`
  - `마켓컬리` 열은 `marketKurly > 0` 인 품목이 하나라도 있을 때만, `샘플` 열은 `(sample || 0) > 0` 인 품목이 있을 때만 렌더한다.
  - 헤더 색: 쿠팡 `text-orange-600`, 마켓컬리 `text-blue-600`, 샘플 `text-amber-600`. 표 전체에 `divide-x divide-gray-400` 세로 구분선.
- 행 단위 계산 (품목 하나마다):
  - `logQty` = `hasLogistics` 이면 `logistics[소문자+하이픈제거 코드]`, 아니면 `undefined`
  - **`실제 생산량` 표시값** = `logQty !== undefined` 이면 `totalQty + logQty`, 아니면 전호기합계. 0 이면 `-` 로 표시(`{값 || '-'}`).
  - **`±`(diff)** = `logQty !== undefined` 이면 `logQty` 그 자체, 아니면 `전호기합계 − totalQty`
  - `done` = logQty 가 있으면 **무조건 true**, 아니면 `전호기합계 >= totalQty && totalQty > 0`
  - `inProgress` = logQty 가 있으면 **무조건 false**, 아니면 `0 < 전호기합계 < totalQty`
- 행 배경: `done` → `bg-green-200`, `inProgress` → `bg-red-200`, 그 외 `hover:bg-gray-50`.
- `±` 셀: `diff >= 10` 이면 배경 `bg-red-300`(과잉 생산 경고, **양 모드 공통**). 글자색은 `diff > 0` 초록 / `diff < 0` 빨강 / 0 회색. 표시 내용:
  - 물류 모드: `+{logQty}` / `logQty === 0` 이면 `✓` / 음수면 숫자 그대로
  - 생산 모드: 전호기합계가 0이면 **빈칸**, 아니면 `+{diff}` / 음수면 숫자 / 0이면 `✓`
- **`냉각 종료`**: 그 코드의 "최신 작업시간 + 50분". 최신 시간은 각 entries 의 `[workTime, additionalWorkTime]` 중 빈 값을 걸러 문자열 정렬 후 마지막 것(= 최대), 그걸 코드별로 최대값 갱신, 다시 세 호기 것을 병합해 최대값. 있으면 파란 굵은 글씨, 없으면 `item.coolingEndTime || '-'`.
  - 50분 더하기는 `(h*60 + m + 50)` 후 **`Math.floor(total/60) % 24`** 로 자정을 넘어가면 되감는다(23:40 → 00:30).
  - 입력이 `HH:MM` 이 아니면 빈 문자열을 반환하고, 그러면 `-` 나 `coolingEndTime` 이 아니라 빈 파란 span 이 뜬다(입력이 정상 형식이므로 실무상 안 보임).
- **혼합 상태 주의**: `hasLogistics` 인 날에도 잔여량 문서가 없는 품목 행은 생산 모드 계산으로 떨어진다(빨강/초록이 섞임). 그런데 상단 `완료된 수량` 카드는 그 날 전체를 물류 기준으로 계산한다. 행 합계와 카드가 안 맞을 수 있고, 그게 정상이다.

### 5.5 빈 상태

`items.length === 0 && !showPaste` 일 때: 점선 테두리 박스에 `이 날짜의 생산 데이터가 없습니다` + 남색 `+ 데이터 입력` 버튼.

---

## 6. 잔여량(Remaining) 화면

`/remaining` 과 `/analytics/remaining` 둘 다 같은 컴포넌트. 후자는 `AnalyticsGate` 뒤(패스워드 `settings/analyticsAuth.password`, 통과 시 localStorage `analyticsAuthedAt` 에 타임스탬프, **TTL 12시간**; 패스워드가 빈 문자열이면 무조건 통과).

### 6.1 모드

`hasLogistics` 에 따라 제목이 `잔여량 (물류)` / `잔여량 (생산)` 으로 바뀐다. 이게 화면 전체 모드다.

### 6.2 데이터 준비

- 구독: `items`(정렬), 세 호기 `entries`(합계 맵), `logistics`. logistics 맵의 **키는 정규화하지 않은 원본 문서 ID** 다 — 삭제할 때 그대로 써야 하므로.
- 각 품목에 붙이는 값: `actualProduction` = 전호기합계, `logQty` = logistics 항목 중 `normalize(문서ID) === normalize(품목코드)` 인 것의 qty(없으면 undefined).
- **items 에 없는데 logistics 에만 있는 코드도 행으로 추가한다.** 이때 `name` 은 문자열 `(품목 미등록)`, `totalQty = 0`, `actualProduction = 0`.

### 6.3 섹션 분류

`produced` = `전호기합계 > 0` 이거나 `logQty !== undefined` 인 행. 우측 상단에 `생산 진행 {produced.length}개 품목`.

| 섹션 | 생산 모드 조건 | 물류 모드 조건 |
|---|---|---|
| `부족 (추가생산 필요)` (red) | `실적 < totalQty` | **항상 빈 배열** |
| `잔여량 있음` (green) | `실적 > totalQty` | `logQty > 0` |
| `잔여량 없음` (blue) | `실적 === totalQty` | `logQty === 0` |

- DOM 순서는 부족 → 잔여량 있음 → 잔여량 없음. 비어 있는 섹션은 아예 렌더하지 않는다.
- 섹션 합계: 부족은 `Σ (totalQty − 실적)` 을 `부족 합계` 로, 잔여는 `Σ (물류모드 ? logQty : 실적 − totalQty)` 를 `잔여량 합계` 로 우측에 굵게. `잔여량 없음` 섹션은 합계를 안 보여준다.
- 섹션 헤더 배지 문구: `품목수 {N}개`. 좌측 4px 컬러 보더 + 연한 배경.
- **엣지케이스**: 물류 모드에서 `logQty < 0` 인 행은 세 섹션 어디에도 속하지 않아 **화면에서 사라진다**(단 `produced.length` 에는 포함돼 상단 카운트와 섹션 합이 안 맞는다). 현재 저장 경로가 음수를 막고 있어서 실무에선 안 나오지만, 수동으로 음수를 넣으면 이 상태가 된다.

### 6.4 행 표시

표 열: `코드 / 품목명 / 총수량 / 실제 생산량 / 잔여량`

- 물류 모드 행: `실제 생산량` = `totalQty + logQty`, `잔여량` = `logQty > 0` 이면 `+{logQty}`(초록), 아니면 `✓`(파랑).
- 생산 모드 행: `실제 생산량` = 전호기합계, `잔여량` = `remain > 0` 이면 `+{remain}`(초록) / `0` 이면 `✓`(파랑) / 음수면 숫자 그대로(빨강).

### 6.5 버튼

- `물류 초기화`(빨간 테두리, `hasLogistics` 일 때만): `confirm('물류 데이터를 삭제하고 생산 기준으로 돌아갈까요?')` → 그 날 logistics 문서 전부 batch delete → 화면이 생산 모드로 돌아간다.
- `수정`(파랑): §4.1 모달.
- `엑셀 다운로드`(남색, `produced` 가 비면 비활성): CSV. 헤더 `구분,코드,품목명,총수량,실제 생산량,잔여량`, 구분값은 `잔여` / `부족` / `잔여량 없음`. 파일명 `잔여량_{date}.csv`, UTF-8 BOM 을 앞에 붙인다(엑셀 한글 깨짐 방지), 콤마·따옴표·줄바꿈이 있으면 따옴표로 감싸고 내부 따옴표는 두 번 반복.
  - **주의: CSV 는 모드와 무관하게 항상 `실적 − totalQty` 로 계산한다.** 물류 모드에서도 화면은 물류 기준, CSV 는 호기 입력 기준으로 나온다. 현재 동작이며 재현 시 그대로 두어야 숫자가 같다.
- `⚠ 과거 날짜 보는 중` 경고 + `오늘로` 버튼(오늘이 아닐 때). **Remaining 은 Machine 과 달리 자동 롤오버가 없다** — 과거 날짜에 머무를 수 있다.
- 빈 상태: `아직 생산된 품목이 없습니다`.

---

## 7. 일자 단위 확정 규칙 — `monthlyProduction.ts`

`computeMonthlyProduction(entries, items, ambient, logisticsByDay, logisticsByDayCode?)`. 월별현황/원재료분석/용기분석이 전부 이 함수를 쓴다. **화면(§5)의 당일 규칙을 "하루씩" 일반화한 것**이며, 둘이 어긋나면 월합과 일합이 안 맞는다.

### 7.1 사전 인덱싱

- 모든 코드는 **`canonicalShort`** 로 통일한다. 주석에 있는 실제 사례: 4월처럼 **잔여수정일에는 items 코드(`I07`)로, 비수정일에는 entries 코드(`i07`)로** 들어와도 같은 키로 묶기 위함이다.
- `itemsByDay[date] = [{ code, totalQty }]` — `it.code` 가 비면 스킵. 표시명 `codeName` 은 **`it.name` 이 있고 `it.code` 와 다를 때만** 기록한다(코드가 이름 자리에 들어간 쓰레기 데이터 배제).
- `entriesByDay[date] = [{ code, qty }]` — `qty = actual + additional`, **`qty <= 0` 이면 통째로 스킵**, `e.code` 가 비면 스킵.
- `machineByDayCode[date][code][machine] = 수량` — 잔여수정일에는 수량이 `items` 로 정해지는데 `items` 에는 호기 정보가 없다. 그래서 **그날 그 코드를 어느 호기가 돌렸는지의 비율**을 entries 에서 뽑아 두고, 확정 수량을 그 비율로 호기에 나눠준다.

### 7.2 하루치 확정 — 우선순위 3단계

처리 대상 날짜는 `items 날짜 ∪ entries 날짜 ∪ logisticsByDay 날짜` 의 합집합.

1. **품목별 잔여량이 있는 날** (`logisticsByDayCode[d]` 가 존재)
   `그 코드 생산량 = 그 코드 계획(totalQty 합) + 그 코드 잔여량`
   대상 코드는 `그날 items 코드 ∪ 그날 잔여량 코드` 의 합집합. 한쪽에만 있으면 없는 쪽을 0으로 본다.
   → **entries 는 수량 계산에 전혀 쓰이지 않는다**(호기 배분에만 쓰임). 소수점이 안 생기는 정확한 경로.
2. **일 합계 잔여량만 있는 날** (`logisticsByDay[d] !== undefined`)
   계획 비율로 안분: 각 품목 행마다 `생산량 += totalQty + 일잔여량합계 × (그 품목 totalQty / 그날 totalQty 총합)`.
   그날 계획 총합이 0이면 지분 0(= `totalQty` 만 더해지는데 그것도 0). **추정치이고 소수점이 생긴다.**
3. **잔여량이 없는 날**
   `생산량 = entries 의 (actual + additional) 합`. 계획은 무시.

> 재현 시 결정적인 점: `logisticsByDayCode` 를 만드는 로더(`MaterialAnalysis2.fetchMonthLogistics`, `containerLoad`)는 **스냅샷이 비면 그 날짜 키를 아예 만들지 않고 return 한다.** 그래서 1번 분기는 "실제로 잔여량 문서가 1개 이상 있는 날"에만 걸린다. 빈 객체를 넣어두면(자바스크립트에서 `{}` 는 truthy) 잔여량 0원인 날이 1번 분기로 빠져 **그날 생산량이 계획값으로 덮여 버린다.** 로더도 같이 옮겨야 한다.
> 로더는 코드 키를 `canonicalShort(data.code || d.id)` 로 만들고 같은 키는 **합산**한다.

### 7.3 호기 배분 (`addDay`)

확정 수량 `qty` 를 코드 합계에 더하는 동시에:
- 그날 그 코드의 `machineByDayCode` 를 보고, 호기별 entries 합계 비율대로 `coldByMachine[호기] += qty × (호기분 / 총합)` 한다.
- entries 가 없거나 합이 0이면 **전량을 `coldMachineUnassigned` 로 보낸다.** 필름처럼 호기로 갈리는 자재 계산이 여기에 의존한다.
- 초기값은 `{ '1호기': 0, '2호기': 0, '3호기': 0 }`.

### 7.4 단계(스테이지) 분류와 반올림 위치

- `STAGE_LETTERS = ['A','B','C','D','E','F','F500','G','H','I']`
- `STAGE_COLOR`: A `bg-blue-500`, B `bg-green-500`, C `bg-orange-500`, D `bg-purple-500`, E `bg-pink-500`, F `bg-teal-500`, F500 `bg-cyan-500`, G `bg-amber-500`, H `bg-rose-500`, I `bg-indigo-500`
- `getStage(code)`: "선두 영문 1글자 + 숫자" 를 매칭해서 글자를 대문자로. **`F` 는 숫자가 500 이상이면 `F500`, 아니면 `F`.** 매칭 실패면 첫 글자만 대문자로 보고 STAGE_LETTERS 에 있으면 그것, 없으면 `null`. 빈 코드는 `null`.
- **반올림은 세 군데서 서로 다르게 일어난다 — 위치를 옮기면 총합이 몇 EA 달라진다:**
  - 품목 하나의 표시 수량: `Math.round(qty)`
  - 단계 합계: **반올림된 품목 수량들의 합**
  - `coldTotal`: **반올림 전 원값 전체를 더한 뒤 한 번만 `Math.round`**
  - `coldByCode` 맵: **반올림하지 않은 원값**(원재료 이론사용량 계산이 이 정밀도를 쓴다)
- **`stage` 가 `null` 인 코드는 `stages` 에서 빠지지만 `coldTotal` 과 `coldByCode` 에는 남는다.** 그래서 `coldTotal ≠ Σ stages.total` 이 되는 게 정상이다.
- 단계 안 품목 정렬: `qty` 내림차순 (tie-break 없음 — 같은 값이면 입력 순서). `stages` 배열은 비어 있는 단계도 포함해 STAGE_LETTERS 고정 순서로 나온다. `maxStage = Math.max(1, ...단계합계들)` (0 나눗셈 방지용 하한 1).
- 실온(ambient)은 `productName` **문자열 그대로** 그룹핑(정규화 없음), `count` 는 엔트리 개수, `qty` 내림차순 정렬. `total = coldTotal + ambientTotal`.

### 7.5 같은 규칙을 쓰는 다른 곳 (전부 동기화되어야 함)

- `src/lib/materialUsage.ts` 의 `computeColdProductionByCode` — 완전히 같은 3단계 분기, 같은 `canonicalShort`.
- `src/pages/AnalyticsMonthly.tsx` 의 `computeMonthStats` — 일 단위로 `logistics[d] !== undefined` 이면 `coldByDay[d] = 그날 totalQty 합 + 잔여량 합`, 아니면 `entries 합`. 또한 `isDayComplete` 는 "잔여량이 있으면 무조건 완료, 없으면 `entries합 / 계획합 >= 0.99`" 로 판정해 **진행 중인 날을 일평균 분모에서 뺀다.**
- `src/lib/containerLoad.ts` 도 같은 분기로 월합을 만든다.
- `src/pages/Analytics.tsx`(일별요약)의 당일 값도 같은 규칙: `hasData` 면 `총수량 + 잔여량합계`, 잔여량 표시값은 `잔여량합계`, 아니면 `Σ max(0, 실적 − 계획)`.

---

## 8. 왜 이렇게 설계했는가 — 현장에서 벌어지는 일

- 아침에 ERP 발주서를 붙여넣어 `items` 를 만든다. 이게 "오늘 만들 양"이다.
- 낮 동안 1·2·3호기 작업자가 배합이 끝날 때마다 태블릿으로 코드와 수량을 찍는다(`entries`). **이건 사람이 손으로 찍는 값이라 늘 틀린다**: 안 찍고 넘어가거나, 두 번 찍거나, 자릿수를 틀린다. Machine 화면의 `목표+100↑(오입력 의심)` 빨간 줄과 `이미 채운 품목은 검색에서 숨김` 이 전부 그 방어책이다. 그래도 하루 합계는 몇 백 EA 씩 어긋난다.
- 퇴근 무렵 물류팀이 ERP에서 **"등록수량"**(창고에 실제로 들어온, 발주량을 넘겨 남은 수량)을 뽑아 붙여넣는다. 이건 전표 기준이라 **회사 공식 숫자**다.
- 그래서 규칙이 이렇게 갈린다:
  - **잔여량이 들어온 날** → 그날 생산량은 `계획 + 잔여량` 으로 **덮어쓴다.** 호기 입력은 수량 근거에서 빠지고, "그 코드를 어느 호기가 돌렸나"라는 배분 정보로만 남는다. 그래서 이 날은 `완료된 수량` 이 항상 계획과 정합하고, `±` 칸이 곧 창고 잔여량이 된다.
  - **잔여량이 안 들어온 날**(당일 진행 중, 토요일, 물류가 깜빡한 날) → 호기 입력 합계 말고 근거가 없다. 그대로 쓴다.
- 품목별 잔여량(1번 분기)이 있으면 코드별로 정확히 더할 수 있지만, 옛 데이터처럼 일 합계만 남아 있으면 계획 비율로 안분할 수밖에 없다(2번 분기). 그래서 두 경로가 공존한다.
- `잔여량 (물류)` 모드에서 `부족` 섹션이 사라지는 이유도 같다 — 전표 기준으로는 부족분이 존재할 수 없다(부족했으면 애초에 잔여량이 음수로 잡히지 않고 그날 못 채운 채 끝난다).

---

## 9. 생산 완료 알림

두 갈래가 있고 서로 독립이다.

### 9.1 기기별 브라우저 알림 (`src/lib/completionAlert.ts`)

- 켜고 끄기: 상단 헤더의 **`현황` 버튼을 5초 꾹 누르면** 토글. 설정은 localStorage 키 `completionAlert:on`(값 `'1'`)에 저장되므로 **PC·휴대폰 각각 따로 켜야 한다.** 토글 후 `window` 에 `ssbon:alert-changed` 이벤트를 쏴서 다른 컴포넌트가 동기화한다.
- 켤 때 confirm 문구(정확히): `이 기기에서 생산 완료 알림을 받겠습니까?` + 빈 줄 + `· 진행률이 100% 가 되면 알림이 뜹니다 (하루 1회)` / `· 확인을 누른 이 기기에만 갑니다 (PC·휴대폰 각각 따로 설정)` / `· 브라우저가 켜져 있어야 합니다 (다른 탭에 있어도 됩니다)`. 끌 때는 `이 기기의 생산 완료 알림을 끌까요?`.
- 미지원 브라우저: `이 브라우저는 알림을 지원하지 않습니다.` + `(iPhone 은 Safari 에서 "홈 화면에 추가" 후 사용해 주세요)`. 권한 거부: `알림 권한이 거부되어 있습니다.` + `브라우저 주소창 옆 자물쇠(ⓘ) → 알림 → 허용 으로 바꿔주세요.`
- 켜지면 테스트 알림 `알림이 켜졌습니다` / `오늘 생산이 100% 완료되면 이 기기로 알려드립니다.` / tag `ssbon-alert-test`.
- **감지 로직**: 알림이 켜진 기기에서만 `todayKey()` 날짜의 `items` + 3호기 `entries` + `logistics` 를 구독하고, 스냅샷마다 재계산한다. 계산은 Dashboard 와 같지만 **딱 하나가 다르다: `pct` 를 `hasLogistics ? 100 : 계산값` 으로 강제한다.** 즉 잔여량이 들어오는 순간 알림 조건이 성립한다.
- **발사 조건**: `itemCount > 0 && totalQty > 0 && pct >= 100 && localStorage['completionAlert:notified'] !== 오늘날짜`. 발사 직전에 그 날짜를 기록해 **하루 1회**를 보장한다.
- 알림 내용: 제목 `✅ 생산 완료`, 본문 `{date} 전 품목 생산이 완료되었습니다 ({completedItems}/{itemCount}품목 · {totalQty 천단위콤마}EA)`, tag `ssbon-done-{date}`, `requireInteraction: true`, 클릭하면 창 포커스 후 닫힘.
- 부가 효과: `navigator.vibrate([300, 120, 300, 120, 500])` + WebAudio 로 만든 2음 비프(880Hz 0.18초, 0.2초 뒤 1175Hz 0.28초, sine, 게인 0.0001→0.25→0.0001 지수 램프, 1.5초 뒤 컨텍스트 close). 전부 try/catch 로 감싸 실패해도 무시(자동재생 차단 등).
- 자정 처리: `App` 이 60초마다 날짜(`getDate()`)를 확인해 바뀌면 구독을 해제하고 새 날짜로 다시 건다.
- 한계(주석에 명시): 브라우저가 떠 있어야 한다. 완전히 끄면 못 받는다(웹푸시 아님).

### 9.2 Gmail 알림 (`src/lib/productionNotify.ts` + Apps Script)

- `productionNotify.ts` 는 **타입과 규약만 있는 파일**이다. 로직이 없다. `NotifySettings = { enabled?, emails?(콤마 구분), webAppUrl?, updatedAt? }` 를 `appMeta/notifySettings` 에 둔다는 계약과, Apps Script 웹앱이 CORS 헤더를 안 주므로 **`mode: 'no-cors'` + `Content-Type: text/plain`** 으로 fire-and-forget POST 한다는 규칙(응답을 못 읽으므로 성공 여부는 메일 도착으로만 확인, preflight 회피)만 적혀 있다.
- 설정 UI 는 `/analytics/settings` 안의 패널. 체크박스 `알림 사용 (켜짐)` / `(꺼짐)`, 이메일 입력(콤마 구분, **blur 시 자동 저장**, placeholder `hong@gmail.com, kim@bongroup.co.kr`). 안내 문구(정확히): `현황 진행률이 100% 되면` 아래 등록된 이메일로 Gmail 알림이 자동 발송됩니다. / `· 발송은 Google Apps Script(구글 서버) 가 매일 15:00~18:00 사이 1분마다 확인해 처리합니다 — 현황 화면을 안 켜둬도 됩니다.` / `· 같은 날 1통만 발송됩니다. 여기서 받는 이메일을 추가/삭제하면 즉시 반영됩니다.`
- **냉장 생산 완료 메일의 감지원은 앱이 아니라 Apps Script 다.** 앱은 `appMeta/dailyProgress` 한 줄만 써 두고(§5.3), 구글 서버가 그걸 폴링해 100% 면 메일을 보낸다. 그래서 브라우저를 안 켜 둬도 된다. 앱 쪽에는 냉장용 직접 푸시 코드가 없다.
- 참고로 **내포장(Scoop)만** 직접 푸시를 한다: 진행률 100% 이고 `enabled && emails && webAppUrl` 이면 `webAppUrl` 로 `{ type: 'scoopDone', date, completedItems, itemCount, emails }` 를 POST 하고, 기기별 하루 1회를 localStorage 키 `scoopNotified:{date}` 로 막는다. 요약은 `appMeta/scoopProgress` 에 저장한다.

---

## 10. 잘못 구현하면 어떤 숫자가 틀어지는가

- **잔여량이 있는 날에 entries 를 같이 더하면** 그날 생산량이 거의 두 배가 된다 → 월합, 원재료 이론사용량, 수율, 용기 사용량이 전부 위로 튄다. 잔여량 날은 `entries` 를 **수량에서 배제**해야 한다.
- **반대로 잔여량을 "생산량"으로 오해해 계획을 안 더하면** 그날 생산량이 수십~수백 EA 로 쪼그라든다(잔여량은 초과분일 뿐이다).
- **품목별 잔여량이 있는데 2번(비례안분) 분기를 쓰면** 총합은 같은데 **코드별 수량에 소수점이 생기고 코드마다 값이 달라진다** → 원재료 분석의 제품별 이론사용량이 어긋난다.
- **`canonicalShort` 를 안 쓰면** `I07` 과 `i07`, `A-01` 과 `A01` 이 서로 다른 제품으로 갈려 한 품목이 두 줄로 쪼개지고 단계 합계가 이상해진다.
- **반올림 위치를 바꾸면**(예: `coldTotal` 을 반올림된 품목들의 합으로) 월 총합이 몇 EA 달라져 엑셀과 안 맞는다. `coldByCode` 를 반올림하면 원재료 이론사용량이 미세하게 틀어진다.
- **`pct` 에 logistics 를 반영하면** Dashboard 진행률과 `appMeta/dailyProgress` 가 바뀌어 **Gmail 알림 발송 시점이 앞당겨진다**. 반대로 `completionAlert` 의 `hasLogistics ? 100` 을 없애면 브라우저 알림이 안 온다. 두 곳의 규칙이 의도적으로 다르다.
- **구독 해제를 빠뜨리면**(특히 3호기 루프) 날짜를 넘길 때마다 옛 스냅샷이 새 상태를 덮어 숫자가 깜빡인다.
- **Machine 의 addDoc 을 setDoc(code) 로 바꾸면** 같은 코드의 2차·3차 생산이 덮여 실적이 통째로 사라진다.
- **entries 에 `actualProduction: 0` 과 `additionalProduction: 0` 을 둘 다 쓰면** 표의 수정 가능 칸 판정(`workTime`/`additionalWorkTime` 존재 여부)과 월 집계의 `qty <= 0 스킵` 이 동시에 흔들린다.
- **`items.actualProduction` 을 실적으로 읽으면** 전부 0이 나온다.
- **로더에서 빈 날짜에도 `logisticsByDayCode[d] = {}` 를 채우면** 잔여량 없는 날이 1번 분기로 빠져 그날 생산량이 계획값으로 덮인다(entries 가 통째로 무시된다).

---

# 4부 — 현황 화면 (대시보드)

## 현황 화면 (대시보드, 라우트 `/`)

### 0. 파일·의존 관계

| 항목 | 값 |
|---|---|
| 컴포넌트 | `src/pages/Dashboard.tsx` (default export `Dashboard`) |
| 라우트 | `<Route path="/" element={<Dashboard />} />` (App.tsx) |
| 상단 네비 라벨 | `현황` (Header 의 rightLinks 중 `{ section: 'dashboard', to: '/', label: '현황' }`) |
| 서브탭 | 없음 (`SUB_TABS.dashboard = []` → SubNav 자체가 렌더되지 않음) |
| 본문 컨테이너 | `max-w-screen-xl w-full mx-auto px-4 py-5` (대시보드는 wide 목록에 없음) |
| 최상위 래퍼 | `<div className="space-y-5">` |
| 의존 모듈 | `../firebase` 의 `db`, `../lib/dateUtil` 의 `todayKey`, `../lib/viewDate` 의 `loadViewDate`/`saveViewDate`, `../lib/codeUtil` 의 `compareCode`, `../types` 의 `Item` |

주의: **`ProcessTimeline` 은 대시보드에 없다.** `src/pages/Analytics.tsx`(라우트 `/analytics`, 서브탭 `일별요약`)에서 `<ProcessTimeline date={viewDate} />` 로 한 번만 사용된다. (§8 참조)

---

### 1. 화면 상수와 파일 내부 헬퍼

- `const MACHINES = ['1호기', '2호기', '3호기'] as const;` — Firestore 경로 세그먼트로 그대로 쓰이는 한글 문자열이다. 절대 `'1'`, `'machine1'` 등으로 바꾸면 안 된다.
- `shiftDate(dateStr, delta)` : `'YYYY-MM-DD'` 를 `split('-').map(Number)` 로 분해 → `new Date(y, m-1, d+delta)` (로컬 타임존 생성자) → 다시 `YYYY-MM-DD` 로 재조립. **`new Date('2026-09-13')` 처럼 문자열 파싱을 쓰면 UTC 해석으로 하루가 밀린다.** 반드시 숫자 3인자 생성자를 쓴다.
- `dateLabel(dateStr)` : 같은 방식으로 Date 를 만든 뒤 요일 배열 `['일','월','화','수','목','금','토']` 로 `` `${y}.${MM}.${dd} (${요일})` `` 을 만든다. 예: `2026.09.13 (일)`. 연도는 패딩 없음, 월·일은 2자리 패딩.
- `addMinutes(hhmm, mins)` (컴포넌트 내부 함수) : `'HH:MM'` 을 분으로 바꿔 mins 를 더하고 `Math.floor(total/60) % 24` 로 24시간 랩어라운드, 결과를 2자리 패딩해 `'HH:MM'` 반환. h 또는 m 이 `NaN` 이면 **빈 문자열** 을 반환한다.

---

### 2. 상태(state) 목록과 초기값

| state | 초기값 | 설명 |
|---|---|---|
| `items: Item[]` | `[]` | 당일 품목 목록 |
| `pasteText: string` | `''` | 붙여넣기 textarea 내용 |
| `showPaste: boolean` | `false` | 붙여넣기 패널 열림 |
| `viewDate: string` | `loadViewDate()` (lazy initializer) | 조회 중인 날짜 `YYYY-MM-DD` |
| `isWeekend: boolean` | `new Date().getDay()` 가 `0`(일) 또는 `6`(토) 이면 `true` | **오늘 실제 요일** 기준. `viewDate` 와 무관하다 |
| `hasSample: boolean` | `false` | 샘플 포함(7열) 모드 |
| `machineQty: Record<호기, Record<code, number>>` | `{ '1호기': {}, '2호기': {}, '3호기': {} }` | 호기별 코드별 생산량 |
| `lastTimeByCode: Record<code, 'HH:MM'>` | `{}` | 코드별 최신 작업시간(전 호기 병합) |
| `logisticsByCode: Record<normCode, number>` | `{}` | 잔여량(물류) |

`viewDate` 영속화: `useEffect(() => saveViewDate(viewDate), [viewDate])`.
- `saveViewDate` 는 localStorage 키 `'viewDate'` 에 `{ date, chosenOn: todayKey() }` JSON 을 저장.
- `loadViewDate` 는 저장된 `chosenOn` 이 **오늘과 같을 때만** `date` 를 돌려주고, 아니면 `todayKey()` 를 준다. 즉 "어제 9/10 을 보던 상태로 오늘 다시 켜면 오늘 날짜로 초기화" 된다. 구버전 포맷(평문 문자열)도 `raw === today` 일 때만 인정한다.
- 이 localStorage 키는 `ProductivityInput` 등 다른 페이지와 **공유** 된다. 대시보드에서 날짜를 바꾸면 그 페이지들도 같은 날짜로 열린다.

---

### 3. Firestore 실시간 구독 (총 5개 리스너)

모든 구독은 `viewDate` 를 의존성으로 하며, **이펙트 진입 시 해당 state 를 먼저 비운다**(구데이터 잔상 방지). 반환값으로 unsubscribe 를 돌려줘 날짜 변경/언마운트 시 반드시 해제한다.

#### 3-1. 품목 구독
- 경로: `collection(db, 'days', viewDate, 'items')`
- 이펙트 시작 시 `setItems([])`.
- 스냅샷마다 전체를 배열로 모아 `list.sort((a,b) => compareCode(a.code, b.code))` 후 `setItems(list)`.
- `compareCode` (= `src/lib/codeUtil.ts`) 의 규칙: 양쪽 모두 `/^([A-Za-z]+)(\d+)/` 에 매치되면 **문자 부분을 대문자로 `localeCompare`** 하고, 같으면 **숫자 부분을 정수 비교**(자연 정렬). 매치가 안 되면 문자열 전체 `localeCompare`. 결과: `F01, F02, F06, F12, F104` (사전순이면 F104 가 F12 앞에 오는데 그렇게 되지 않는다).
- **tie-break 없음**: 코드가 완전히 같은 항목이 있을 수 없다(코드가 문서 ID 라서). `Array.prototype.sort` 의 불안정성은 문제되지 않는다.

#### 3-2. 호기 entries 구독 (3개)
- 경로: `collection(db, 'days', viewDate, 'machines', <'1호기'|'2호기'|'3호기'>, 'entries')` 를 `MACHINES.map` 으로 3개 동시 구독.
- 이펙트 시작 시 `setMachineQty({'1호기':{},'2호기':{},'3호기':{}})`, `setLastTimeByCode({})`.
- 이펙트 스코프에 **가변 클로저 변수** `perMachineTime: Record<호기, Record<code, 'HH:MM'>>` 를 두고(초기 3개 빈 객체) 각 스냅샷 콜백이 자기 호기 칸만 덮어쓴다. 이게 있어야 "1호기 스냅샷이 왔을 때 2·3호기의 시간도 같이 병합"이 가능하다.
- 스냅샷 처리(호기 1개 기준):
  - 코드 키: `String(e.code || '').toLowerCase()` — **소문자만 적용하고 하이픈·공백은 제거하지 않는다.**
  - 수량: `qmap[key] += (e.actualProduction || 0) + (e.additionalProduction || 0)` (같은 코드의 여러 entry 를 누적 합산)
  - 시간: `const t = [e.workTime, e.additionalWorkTime].filter(Boolean).sort().pop()` → 두 값 중 **문자열 사전순 최대** 를 고른다(`'HH:MM'` 형식이라 사전순 = 시간순). 그 다음 `if (t && (!tmap[key] || t > tmap[key])) tmap[key] = t`.
  - `perMachineTime[machine] = tmap`
  - `setMachineQty(prev => ({...prev, [machine]: qmap}))` — 함수형 업데이트 필수(3개 콜백이 동시에 들어옴).
  - 병합: `MACHINES` 전체를 돌며 `perMachineTime[m]` 의 각 `[code, t]` 에 대해 `if (!merged[c] || t > merged[c]) merged[c] = t` → `setLastTimeByCode(merged)`.
- 클린업: `return () => unsubs.forEach(u => u())`.

#### 3-3. 잔여량(물류) 구독
- 경로: `collection(db, 'days', viewDate, 'logistics')`
- 이펙트 시작 시 `setLogisticsByCode({})`.
- 키: **문서 ID** 를 `(d.id || '').toLowerCase().replace(/[-\s]/g, '')` 로 정규화. 값: `(d.data().qty as number) || 0`.
- 이 문서들은 `src/components/LogisticsInputModal.tsx`(월별현황 페이지의 "잔여량 입력 (물류)" 모달)가 쓴다. 문서 ID 는 ERP 코드 `A-001-01` → `A-01` 형태(**하이픈 포함**)이고, 대시보드 items 의 코드는 `A01` 형태(하이픈 없음)라서 **양쪽 모두 하이픈을 제거한 정규화 키로만 매칭된다.** 이게 정규화가 두 종류로 나뉘는 이유다.
- `const hasLogistics = Object.keys(logisticsByCode).length > 0;` — "이 날짜에 물류 잔여량이 한 건이라도 입력되었는가".

#### 3-4. 대시보드는 `productivity/{date}` 를 구독하지 않는다
그건 ProcessTimeline(분석 페이지) 의 몫이다.

---

### 4. 파생 계산

#### 4-1. `actualByCode` (`useMemo`, deps `[machineQty]`)
3개 호기의 맵을 코드 키로 단순 합산한 `Record<lowercaseCode, number>`. 키 정규화는 3-2 와 동일(소문자만).

#### 4-2. `stats` (`useMemo`, deps `[items, actualByCode, logisticsByCode, hasLogistics]`)

- **`totalQty`** = `items.reduce((s,i) => s + (i.totalQty || 0), 0)`
- **`actual`** (카드 "완료된 수량") =
  - `hasLogistics === true` → `totalQty + Object.values(logisticsByCode).reduce((s,v)=>s+v, 0)`
    (물류 기준으로 재구성: 목표 총량 + 잔여 조정치의 합. 잔여가 음수면 줄어든다)
  - `hasLogistics === false` → `items.reduce((s,i) => s + (actualByCode[i.code.toLowerCase()] || 0), 0)`
    — **items 를 돌며 합산** 하므로, items 에 없는 코드로 입력된 entry 는 이 숫자에 반영되지 않는다.
- **`itemCount`** = `items.length`
- **`completedItems`** = items 중 아래 조건을 만족하는 개수
  1. `const norm = i.code.toLowerCase().replace(/[-\s]/g, '')` 로 만든 키가 `logisticsByCode` 에 **존재하면**(값이 0 이든 음수든 무관, `!== undefined` 검사) → 완료로 센다.
  2. 아니면 `(actualByCode[i.code.toLowerCase()] || 0) >= i.totalQty && i.totalQty > 0`.
     → **`totalQty` 가 0 인 품목은 생산량이 얼마든 절대 완료로 안 센다.**
- **`pct`** (카드 "진행률") =
  - `totalQty` 가 0(falsy)이면 **`0`**
  - 아니면 `Math.round( (Σ_items min(actualByCode[code.toLowerCase()] || 0, i.totalQty || 0)) / totalQty * 100 )`
  - 핵심: **분자는 품목별로 목표치에서 clamp(초과분은 안 세줌), 분모는 총 목표수량.** 반올림은 마지막 백분율 단계에서 한 번만 `Math.round`.
  - **`pct` 는 logistics 를 전혀 보지 않는다.** 그래서 잔여량이 입력된 날은 "완료된 수량"과 "완료된 품목"은 100% 상태인데 "진행률"은 호기 입력 기준으로 100 미만일 수 있다. (반면 `src/lib/completionAlert.ts` 의 `watchTodayProgress` 는 같은 수식을 쓰되 마지막에 `pct: hasLogistics ? 100 : pct` 로 덮어쓴다 — 알림용과 화면용이 다르다.)

#### 4-3. 표시용 플래그
- `const hasKurly = items.some(i => i.marketKurly > 0);`
- `const hasSampleCol = items.some(i => (i.sample || 0) > 0);`
이 둘이 마켓컬리/샘플 **열 자체의 표시 여부** 를 결정한다(헤더·셀 모두 조건부 렌더).

---

### 5. `appMeta/dailyProgress` 쓰기

목적(코드 주석 그대로): *"오늘 현황의 진행률을 단일 문서에 저장 → Apps Script 시간트리거가 이 한 줄만 읽어 판단"*. 외부 Apps Script 가 컬렉션 전체를 훑지 않고 문서 1건만 읽어 완료 여부를 판단하게 하는 용도.

규칙:
- `useEffect` deps: `[stats.pct, stats.completedItems, stats.itemCount, stats.totalQty, viewDate]`
- **`viewDate !== todayKey()` 이면 즉시 return** — 과거/미래 날짜를 조회할 때는 절대 쓰지 않는다.
- 중복 쓰기 방지: `useRef<string>('')` 인 `lastProgressRef` 에 시그니처 문자열 `` `${stats.pct}|${stats.completedItems}|${stats.itemCount}|${stats.totalQty}` `` 를 저장하고, 같으면 쓰기를 생략한다.
- 쓰기: `setDoc(doc(db, 'appMeta', 'dailyProgress'), { date: viewDate, pct, completedItems, itemCount, totalQty, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {})`
  — **에러는 조용히 삼킨다**(권한/오프라인 시 화면이 깨지면 안 되므로).
- 화면이 열려 있을 때만 갱신되는 best-effort 지표다.

---

### 6. 화면 구성 (위 → 아래)

#### 6-1. 날짜 네비게이션 바
`flex items-center justify-between flex-wrap gap-2`

왼쪽 그룹(`flex items-center gap-2`):
1. `‹` 버튼 — `w-8 h-8 flex items-center justify-center rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 text-lg`, 클릭 시 `setViewDate(shiftDate(viewDate, -1))`
2. 날짜 라벨 — `font-semibold text-gray-800 text-base`, 내용 `dateLabel(viewDate)` (예: `2026.09.13 (일)`)
3. `›` 버튼 — `‹` 와 동일 스타일, `shiftDate(viewDate, +1)`
4. `<input type="date">` — `value={viewDate}`, `onChange` 는 **빈 값이면 무시**(`e.target.value && setViewDate(...)`), 클래스 `ml-1 px-2 py-1 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50 text-gray-700 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-900`
5. `viewDate !== todayKey()` 일 때만 `오늘로` 버튼 — `ml-1 text-xs px-2.5 py-1 rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium`, 클릭 시 `setViewDate(todayKey())`

오른쪽 그룹(`flex gap-2 items-center`):
1. `+ 데이터 입력` 버튼 — `bg-orange-500 hover:bg-orange-600 text-white text-sm px-4 py-2 rounded font-medium transition`, 클릭 시 `setShowPaste(true)`
2. `items.length > 0` 일 때만 `전체 삭제` 링크버튼 — `text-sm text-red-500 hover:underline`, `clearAll()` 호출

#### 6-2. 통계 카드 5장
`grid grid-cols-2 md:grid-cols-5 gap-4` (모바일 2열, md 이상 5열)

각 카드(`StatCard`)는 `bg-white rounded-lg border-t-4 <borderColor> shadow-sm p-4` 안에
- 라벨: `text-xs text-gray-500 mb-2 font-medium`
- 값: `text-2xl font-bold <textColor>`
- 단위: `text-xs text-gray-400 mt-0.5`

색상 매핑(`colorMap`):
| color | border | text |
|---|---|---|
| blue | `border-blue-500` | `text-blue-600` |
| green | `border-green-500` | `text-green-600` |
| orange | `border-orange-400` | `text-orange-500` |
| red | `border-red-400` | `text-red-500` |
| purple | `border-purple-400` | `text-purple-600` |

카드 목록(순서 고정):
| # | 라벨 | 값 | 단위 | 색 |
|---|---|---|---|---|
| 1 | `금일 품목수` | `${stats.itemCount}` | `품목` | blue |
| 2 | `총 수량` | `stats.totalQty.toLocaleString()` | `EA` | green |
| 3 | `완료된 수량` | `stats.actual.toLocaleString()` | `EA` | orange |
| 4 | `진행률` | `${stats.pct}` | `%` | **동적**: `pct === 100 ? 'green' : pct >= 50 ? 'orange' : 'red'` |
| 5 | `완료된 품목` | `${stats.completedItems}` | `품목` | purple |

`toLocaleString()` 은 1·4·5 번에는 안 쓴다(품목수/퍼센트는 천단위 구분 없음).

#### 6-3. 붙여넣기 패널 (`showPaste === true` 일 때만)
`bg-white rounded-lg border border-gray-200 shadow-sm p-5 space-y-3`

- 헤더 행: 제목 `ERP 데이터 붙여넣기` (`font-semibold text-gray-800`) + 우측 `✕` 닫기 버튼 (`text-gray-400 hover:text-gray-600 text-lg`, `setShowPaste(false)`)
- 모드 토글(`flex items-center gap-2 bg-gray-50 rounded-md p-1 w-max`) — 2개 버튼, 활성 시 `bg-blue-900 text-white font-medium`, 비활성 시 `text-gray-500 hover:text-gray-800`:
  - `평일 (쿠팡+컬리)` → `setIsWeekend(false)`
  - `주말 (쿠팡만)` → `setIsWeekend(true); setHasSample(false);` (**주말 선택 시 샘플 체크를 강제 해제**)
- `!isWeekend` 일 때만 샘플 체크박스 라벨 표시:
  - 라벨 컨테이너 `flex items-center gap-2 px-3 py-1.5 rounded-md border cursor-pointer select-none transition`, 체크 시 `bg-amber-50 border-amber-300`, 미체크 시 `border-gray-200 hover:bg-gray-50`
  - 텍스트 `샘플 포함 (7열)`, 체크 시 `text-amber-700`, 아니면 `text-gray-600`
- 열 순서 안내문(`text-xs text-gray-500`), 앞에 `열 순서: ` 붙여서:
  - 주말: `코드 / 품목명 / 주문수량 / 쿠팡 / 총수량 (5열)`
  - 평일+샘플: `코드 / 품목명 / 주문수량 / 쿠팡 / 마켓컬리 / 샘플 / 총수량 (7열)`
  - 평일: `코드 / 품목명 / 주문수량 / 쿠팡 / 마켓컬리 / 총수량 (6열)`
  - **주의: 이 안내문의 분기는 `hasSample` 을 직접 보고(`isWeekend ? ... : hasSample ? ... : ...`), 파싱 로직의 `useSample` 과는 변수만 다를 뿐 결과는 같다.**
- textarea — `w-full h-40 border border-gray-200 rounded-md p-3 font-mono text-xs resize-none focus:outline-none focus:ring-2 focus:ring-blue-900`, placeholder(탭 문자 `\t` 포함):
  - 주말: `A01\t순수쌀미음\t17\t-\t17`
  - 평일+샘플: `A01\t순수쌀미음\t17\t-\t-\t2\t19`
  - 평일: `A01\t순수쌀미음\t17\t-\t-\t17`
- 버튼 행: `등록`(`bg-blue-900 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-800 transition`, `onPaste`) / `취소`(`border border-gray-300 px-5 py-2 rounded text-sm text-gray-600 hover:bg-gray-50 transition`, `setShowPaste(false)`)

#### 6-4. 품목 테이블 (`items.length > 0` 일 때만)
바깥: `bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden`
헤더 줄: `px-5 py-3 border-b border-gray-100 flex items-center justify-between` 안에 `품목별 현황`(`font-semibold text-gray-800`)과 우측 `${items.length}개 품목`(`text-xs text-gray-400`).
표는 `overflow-x-auto` 로 감싼 `table w-full text-sm`.

`thead tr`: `bg-gray-50 text-xs text-gray-500 uppercase tracking-wide divide-x divide-gray-400`
`tbody`: `divide-y divide-gray-400`, 각 `tr` 은 `divide-x divide-gray-400`.

열 구성 (왼→오, 조건부 열은 표시될 때 이 위치):

| # | 헤더 | 정렬 | 헤더 색 | 조건 | 셀 내용 |
|---|---|---|---|---|---|
| 1 | `코드` | left | 기본 | 항상 | `it.code` — `font-mono text-xs text-gray-500` |
| 2 | `품목명` | left | 기본 | 항상 | `it.name` — `font-medium text-gray-800` |
| 3 | `주문수량` | right | 기본 | 항상 | `it.orderQty \|\| '-'` — `text-gray-600` |
| 4 | `쿠팡` | right | `text-orange-600` | 항상 | `it.coupang \|\| '-'` — `text-orange-600 font-medium` |
| 5 | `마켓컬리` | right | `text-blue-600` | `hasKurly` | `it.marketKurly \|\| '-'` — `text-blue-600 font-medium` |
| 6 | `샘플` | right | `text-amber-600` | `hasSampleCol` | `it.sample \|\| '-'` — `text-amber-600 font-medium` |
| 7 | `총수량` | right | 기본 | 항상 | `it.totalQty` (**`\|\| '-'` 없음 — 0 이면 `0` 이 그대로 보인다**) — `font-semibold text-gray-800` |
| 8 | `실제 생산량` | right | 기본 | 항상 | `displayActual \|\| '-'` — `text-gray-700 font-medium` |
| 9 | `±` | right | 기본 | 항상 | §6-5 |
| 10 | `냉각 종료` | center | 기본 | 항상 | §6-6 |

모든 `th` 는 `px-4 py-3 font-medium`, 모든 `td` 는 `px-4 py-3`.

행별 계산 (각 `it` 에 대해):
```
actual        = actualByCode[it.code.toLowerCase()] || 0
normCode      = it.code.toLowerCase().replace(/[-\s]/g, '')
logQty        = hasLogistics ? logisticsByCode[normCode] : undefined
displayActual = logQty !== undefined ? it.totalQty + logQty : actual
diff          = logQty !== undefined ? logQty : (actual - it.totalQty)
done          = logQty !== undefined ? true : (actual >= it.totalQty && it.totalQty > 0)
inProgress    = logQty !== undefined ? false : (actual > 0 && actual < it.totalQty)
```
행 배경(`transition-colors` 와 함께):
- `done` → `bg-green-200`
- 아니고 `inProgress` → `bg-red-200`  ← **"진행중"이 빨강** 이다. 직관과 반대지만 그대로 재현할 것.
- 둘 다 아니면 → `hover:bg-gray-50` (미착수 = 흰 배경)

`key` 는 `it.code`.

#### 6-5. `±` 열 상세
셀 클래스: `px-4 py-3 text-right font-bold` + 조건부 2개를 공백으로 이어 붙임
- `diff >= 10` 이면 `bg-red-300` (10개 이상 초과 생산 = 눈에 띄게 경고. **`diff` 는 부호 있는 값이라 초과(+)일 때만 걸린다**)
- 글자색: `diff > 0 → text-green-600`, `diff < 0 → text-red-500`, `diff === 0 → text-gray-400`

텍스트:
- `logQty !== undefined` (물류 잔여량이 있는 품목):
  - `logQty > 0` → `` `+${logQty}` ``
  - `logQty === 0` → `✓`
  - `logQty < 0` → `logQty` (숫자 그대로, 예 `-5`)
- 그 외(호기 입력 기준):
  - `actual === 0` → **빈 문자열**(아무것도 안 보임)
  - `diff > 0` → `` `+${diff}` ``
  - `diff < 0` → `diff`
  - `diff === 0` → `✓`

#### 6-6. `냉각 종료` 열 상세
`px-4 py-3 text-center text-xs text-gray-500` 안에서 IIFE 로 분기:
- `lastTimeByCode[it.code.toLowerCase()]` 가 있으면 → `<span className="font-semibold text-blue-600">{addMinutes(lt, 50)}</span>`
  즉 **가장 늦은 작업시간 + 50분** 을 냉각 종료 예상 시각으로 보여준다(파란 볼드).
- 없으면 → `it.coolingEndTime || '-'` (회색). `coolingEndTime` 은 대시보드 붙여넣기로는 절대 안 들어가고, 레거시 엑셀 임포트(`/import`, `src/pages/Import.tsx` 의 `냉각 종료 예상 시간` 컬럼)로만 채워진다.

#### 6-7. 빈 상태
조건: `items.length === 0 && !showPaste`
```
<div className="bg-white rounded-lg border border-dashed border-gray-300 p-12 text-center">
  <p className="text-gray-400 text-sm mb-3">이 날짜의 생산 데이터가 없습니다</p>
  <button ...>+ 데이터 입력</button>
</div>
```
버튼 클래스: `bg-blue-900 text-white text-sm px-5 py-2 rounded font-medium hover:bg-blue-800 transition`, `setShowPaste(true)`.

**로딩 상태는 없다.** 날짜를 바꾸면 `setItems([])` → 스냅샷 도착 전까지 위 빈 상태가 잠깐 보였다가 표로 바뀐다. 스피너·스켈레톤을 추가하면 원본과 달라진다.

---

### 7. 동작

#### 7-1. `onPaste()` — 붙여넣기 등록

1. 숫자 파서 `num(s)`: `(s || '').trim().replace(/,/g, '')` → 결과가 `'-'` 이거나 `''` 이면 **0**, 아니면 `parseFloat`, `NaN` 이면 **0**. (`parseFloat` 이므로 `'17.5'` 는 17.5 가 되고, `'17개'` 는 17 이 된다)
2. `const useSample = !isWeekend && hasSample;`
3. `const minCols = isWeekend ? 5 : (useSample ? 7 : 6);`
4. 행 분리: `pasteText.split('\n').map(r => r.split('\t'))` 후 `filter(cols => cols.length >= minCols && cols[0]?.trim())`
   - 구분자는 **탭 고정**(엑셀/ERP 복사 기준). 쉼표 CSV 는 파싱되지 않는다.
   - `>=` 이므로 열이 더 많은 것은 통과한다(뒤쪽 여분 열은 무시).
   - 첫 칸이 빈 줄과 헤더 없는 빈 행은 자연히 걸러진다. **헤더 행 제거 로직은 없다** — 헤더의 첫 칸이 비어있지 않고 열 수가 충분하면 헤더도 품목으로 등록된다(운영상 헤더 없이 복사하는 전제).
5. **즉시 UI 정리**: `const text = pasteText;` 로 원문을 백업한 뒤 `setPasteText(''); setShowPaste(false);` — 검증/저장 전에 패널을 먼저 닫는다.
6. 유효 행이 0 개면 `setTimeout(..., 50)` 으로 `alert` 표시(패널이 닫히는 렌더와 alert 블로킹이 겹치지 않도록 50ms 지연):
   ```
   붙여넣을 데이터가 없습니다 (<모드> 모드: <minCols>열 필요)

   붙여넣은 첫 줄: <text.split('\n')[0]?.slice(0,80) || '(비어있음)'>
   ```
   모드 라벨: `주말` / `평일+샘플` / `평일`.
7. 저장: `writeBatch(db)` 하나에 모든 행을 `batch.set(doc(db, 'days', viewDate, 'items', code), item)` 으로 담고 `await batch.commit()`.
   - 문서 ID = **`cols[0].trim()` 원문 그대로** (대소문자·하이픈 보존). `item.id` 와 `item.code` 도 같은 값.
   - 필드 매핑:
     | 필드 | 값 |
     |---|---|
     | `id`, `code` | `cols[0].trim()` |
     | `name` | `cols[1]?.trim() \|\| ''` |
     | `orderQty` | `num(cols[2])` |
     | `coupang` | `num(cols[3])` |
     | `marketKurly` | `isWeekend ? 0 : num(cols[4])` |
     | `sample` | `useSample ? num(cols[5]) : 0` |
     | `totalQty` | `isWeekend ? num(cols[4]) : useSample ? num(cols[6]) : num(cols[5])` |
     | `actualProduction` | `0` (항상) |
     | `date` | `viewDate` |
   - **주말 모드에서 `cols[4]` 는 총수량** 이고 마켓컬리는 0 으로 강제된다(한 칸이 두 의미를 갖는다).
   - `set` 은 **문서 전체 덮어쓰기** 다 → 같은 코드를 다시 붙여넣으면 `actualProduction` 이 0 으로 리셋되고 `coolingEndTime` 이 있었다면 **사라진다**.
   - 기존에 있던 품목 중 이번 붙여넣기에 없는 코드는 **삭제되지 않는다**(잔존).
8. 예외 시 `setTimeout(() => alert(\`등록 중 오류: ${err instanceof Error ? err.message : err}\`), 50)`.
9. 저장 후 화면 갱신은 별도 코드 없이 **items 구독이 알아서 반영** 한다(낙관적 갱신 없음).

#### 7-2. `clearAll()` — 전체 삭제
- `confirm('오늘 데이터를 모두 삭제할까요?')` 가 false 면 아무것도 안 함. (문구가 "오늘"이지만 실제로는 **`viewDate` 의 데이터** 를 지운다)
- `writeBatch` 로 `items.forEach(i => batch.delete(doc(db, 'days', viewDate, 'items', i.code)))` 후 commit.
- **지우는 것은 `items` 뿐** — 호기 `entries`, `logistics`, `productivity` 는 그대로 남는다.
- 에러 처리 없음(try/catch 없음).

#### 7-3. 품목 수정
개별 품목의 인라인 편집 기능은 **없다.** 수정 = "붙여넣기로 덮어쓰기" 또는 "전체 삭제 후 재등록". 삭제도 개별 행 삭제 버튼이 없다.

#### 7-4. 입력 화면과의 실시간 연동
- 1·2·3호기 입력 페이지(`/machine/:id`)가 `days/{date}/machines/{호기}/entries` 에 `addDoc`/`updateDoc`/`deleteDoc` 하면, 대시보드의 해당 호기 구독이 즉시 발화 → `machineQty` 갱신 → `actualByCode` → `stats` → 카드 5장·행 배경색·`실제 생산량`·`±`·`냉각 종료` 가 한꺼번에 다시 계산된다. 새로고침 불필요.
- `entries` 문서 필드 중 대시보드가 읽는 것은 `code`, `actualProduction`, `additionalProduction`, `workTime`, `additionalWorkTime` 뿐이다(`machine`, `date`, `id` 는 안 씀).
- 잔여량 모달이 `days/{date}/logistics/{코드}` 에 쓰면 `hasLogistics` 가 켜지면서 화면 의미가 통째로 바뀐다: "완료된 수량"이 `총수량 + 잔여합` 으로, 잔여량이 등록된 모든 품목 행이 초록(`done=true`)으로, `실제 생산량` 이 `totalQty + logQty` 로 재구성된다. **단 "진행률" 카드만은 여전히 호기 입력 기준이다.**
- 외포장(`/external/:id`) 데이터는 대시보드가 구독하지 않는다 — 현황 숫자에 영향 없음.

---

### 8. `ProcessTimeline` 컴포넌트 (`src/components/ProcessTimeline.tsx`)

**대시보드가 아니라 분석 → 일별요약(`/analytics`) 에서 `<ProcessTimeline date={viewDate} />` 로 렌더된다.** props 는 `{ date: string }` 하나.

#### 8-1. 데이터
- 구독: `onSnapshot(doc(db, 'productivity', date))`, 이펙트 진입 시 `setData({})`, 문서 없으면 `{}`.
- 읽는 필드(`DayProductivity`): `pot`, `bat`, 그리고 5개 공정 각각 `{key}_people`(number), `{key}_start`(`'HH:MM'`), `{key}_end`(`'HH:MM'`).
- 이 문서는 `조직도 → 생산성 입력`(`/attendance/productivity`, `ProductivityInput.tsx`)에서 `setDoc(..., { merge: true })` 로 필드 단위 저장된다. 빈 값은 `null` 로 저장된다.
- `pot`/`bat` 은 제품 DB(`productSettings`)의 `type` 이 `'냄비'`/`'바트'` 인 품목별 `totalQty` 합계다(냄비=pot, 바트=bat).

#### 8-2. 공정(STAGES) 정의 — 순서·값 그대로
| key | label | emoji | fill | fillLight | textOn | textOff | border |
|---|---|---|---|---|---|---|---|
| `pp` | 전처리 | 🔪 | `#8b5cf6` | `#ede9fe` | `#ffffff` | `#5b21b6` | `#c4b5fd` |
| `bg` | 배합 | 🥣 | `#2563eb` | `#dbeafe` | `#ffffff` | `#1e40af` | `#93c5fd` |
| `ck` | 취반기 | 🍚 | `#059669` | `#d1fae5` | `#ffffff` | `#065f46` | `#6ee7b7` |
| `fl` | 화구 | 🔥 | `#ea580c` | `#ffedd5` | `#ffffff` | `#9a3412` | `#fdba74` |
| `pk` | 내포장 | 📦 | `#7c3aed` | `#ede9fe` | `#ffffff` | `#5b21b6` | `#c4b5fd` |

#### 8-3. 계산
- `parseHM(s)`: `/^(\d{1,2}):(\d{2})$/` 에 매치될 때만 `h*60+mi`, 아니면 `null`. (`'9:30'` 도 OK, `'0930'`·`'09:3'` 은 null)
- `formatDuration(mins)`: `h===0 → '{m}분'`, `m===0 → '{h}시간'`, 그 외 `'{h}시간 {m}분'`.
- `computeProd(key, pot, bat, people, mins)` — **공정별 생산성 = 생산갯수 / (인원 × 시간)**
  - `people <= 0` 또는 `mins <= 0` → `0`
  - `numerator = key === 'ck' ? bat : key === 'fl' ? pot : (pot + bat)` — **취반기는 바트만, 화구는 냄비만, 나머지 3개 공정은 전체**
  - `numerator <= 0` → `0`
  - `hrs = mins / 60`, 반환 `Math.round(numerator / (people * hrs))` — **정수 반올림은 여기 한 번**
- `valid`(막대를 그릴 조건) = `start !== null && end !== null && end >= start`. `end === start` 도 valid(길이 0 막대).
- `hasAny` = 한 행이라도 `start !== null || end !== null || people`(truthy) — **`people` 이 `0` 이면 hasAny 에 기여하지 않는다.**
- 시간축:
  - `minMins` = valid 행들의 start 최소, 없으면 `8 * 60`
  - `maxMins` = valid 행들의 end 최대, 없으면 `18 * 60`
  - `axisStart = Math.floor(minMins/60)*60`, `axisEnd = Math.ceil(maxMins/60)*60`, `axisRange = Math.max(60, axisEnd - axisStart)` (0 나눗셈 방지)
  - 눈금: `axisStart` 부터 `axisEnd` 까지 `+60` 씩, **양끝 포함**
- `totalDuration` = valid 행들의 `(end - start)` **단순 합**. 공정이 겹치는 시간은 중복 계산된다("총 가동"은 인시(人時) 개념이 아니라 공정시간 합).

#### 8-4. SVG 치수 (고정 상수)
`padL=90, padR=24, padT=30, padB=36, innerW=1100, rowH=56, gap=10`
→ `innerH = 5*56 + 4*10 = 320`, `W = 1214`, `H = 386`.
`<svg viewBox="0 0 1214 386" preserveAspectRatio="xMidYMid meet" className="w-full h-auto block">`
`xFor(mins) = padL + ((mins - axisStart) / axisRange) * innerW`

#### 8-5. 그리는 것 (레이어 순서)
1. **세로 눈금**: 각 tick 마다 `<line>` `x1=x2=xFor(t)`, `y1=padT`, `y2=padT+innerH`, `stroke="#e5e7eb"`, `strokeWidth=1`, `strokeDasharray="2 3"`; 위에 `<text y={padT-10} textAnchor="middle" fontSize="11" fill="#6b7280">` 로 `` `${pad2(floor(t/60))}:00` `` (예 `08:00`).
2. **행 배경**: `<rect x=padL y=padT+i*(rowH+gap) width=innerW height=rowH fill="#f8fafc" rx=6 />`
3. **좌측 라벨 블록**(`translate(0, y)`): `<rect width={padL-8}=82 height=56 fill={stage.fillLight} rx=6 />` + 가운데 정렬 텍스트 두 줄
   - 1줄: `y = rowH/2 - 6 = 22`, `fontSize 13`, `fontWeight bold`, `fill=textOff`, 내용 `` `${emoji} ${label}` `` (예 `🔪 전처리`)
   - 2줄(‌`people !== undefined && people !== null` 일 때만): `y = rowH/2 + 8 = 36`, `fontSize 10`, 내용 `` `👥 ${people}명` `` 뒤에 `valid && people` 이면 `` `  ·  ${computeProd(...)}` `` 를 덧붙임(공백 2칸-가운뎃점-공백 2칸).
4. **valid 행**: 세로 선형 그래디언트(`id={\`grad-${stage.key}\`}`, 0% = fill/opacity 1 → 100% = fill/opacity 0.8)로 채운 `<rect x=x1 y=y+8 width=barW height={rowH-16}=40 rx=5 stroke={stage.fill} strokeWidth=1 />`
   - 막대 **위쪽**에 시작시각 `x1+6`, `y+4`, `fontSize 10`, bold, `fill=textOff`; 종료시각 `x2-6`, `textAnchor="end"`.
   - `barW > 60` 일 때만 막대 **안** 중앙에 `formatDuration(dur)` (`fontSize 13`, bold, `fill=textOn`).
5. **invalid 행**: `x=padL+10`, `y=y+rowH/2+4`, `fontSize 11`, `fill="#9ca3af"`, `fontStyle="italic"` 로 아래 문구
   - start·end 둘 다 null → `입력 전`
   - start 만 null → `시작 시간 미입력`
   - 그 외 → `종료 시간 미입력` (end 가 null 인 경우 **및 `end < start` 로 역전된 경우** 도 여기로 온다)
6. **베이스라인**: `<line x1=padL y1={padT+innerH+4} x2={padL+innerW} y2=동일 stroke="#cbd5e1" strokeWidth=1 />`

#### 8-6. 카드 헤더 / 빈 상태 / 하단 카드
- 컨테이너: `bg-white border rounded-lg overflow-hidden`
- 헤더: `px-5 py-3 border-b bg-gradient-to-r from-slate-50 to-blue-50 flex items-center justify-between flex-wrap gap-2`
  - 좌: `⏱ 공정별 타임라인`(`font-semibold text-gray-800`) + `{date}`(`text-xs text-gray-500`)
  - 우(`hasAny` 일 때만): `px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-medium` 안에 `총 가동 <b>{formatDuration(totalDuration)}</b>`
- `!hasAny` → `p-12 text-center text-gray-400 text-sm` 로 문구:
  `이 날짜의 공정 데이터가 없습니다 — 조직도 → 생산성 입력에서 등록하세요`
- 하단 통계 카드: `mt-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2`, 카드마다 `rounded-md border px-3 py-2 text-xs` + 인라인 `style={{ backgroundColor: stage.fillLight, borderColor: stage.border }}`
  - 윗줄: 좌 `{emoji} {label}`(bold, `color: textOff`), 우 `people !== undefined && people !== null` 이면 `{people}명`(`text-[10px]`) — **0명도 표시된다**
  - valid → `font-mono text-[11px]` 로 `HH:MM ~ HH:MM` (공백 포함 `' ~ '`), 그 아래 좌측 `formatDuration(dur)`(`text-[10px]`), 우측 `prod > 0` 일 때만 `생산성 {prod}`(`text-[11px] font-bold`)
  - invalid → `데이터 없음` (`text-[10px] text-gray-400 italic`)
  - 여기서의 `prod` 는 `valid && r.people ? computeProd(...) : 0` — `people` 이 0/undefined 면 0.

---

### 9. Firestore 경로 요약 (이 영역이 건드리는 전부)

| 경로 | 읽기/쓰기 | 주체 |
|---|---|---|
| `days/{YYYY-MM-DD}/items/{code}` | 실시간 읽기 + `set`(붙여넣기) + `delete`(전체 삭제) | Dashboard |
| `days/{YYYY-MM-DD}/machines/{1호기\|2호기\|3호기}/entries/*` | 실시간 읽기 전용 | Dashboard |
| `days/{YYYY-MM-DD}/logistics/{ERP단축코드}` | 실시간 읽기 전용 | Dashboard (쓰기는 LogisticsInputModal) |
| `appMeta/dailyProgress` | `setDoc merge` 쓰기 전용 | Dashboard (오늘일 때만) |
| `productivity/{YYYY-MM-DD}` | 실시간 읽기 전용 | ProcessTimeline |

`localStorage` 키: `viewDate`(공유), `completionAlert:on`, `completionAlert:notified`(알림 기능, App.tsx 소관).

---

# 5부 — 호기 입력 (1·2·3호기)

## 호기 입력 화면 (`/machine/:id` — 1호기·2호기·3호기)

파일: `/home/user/productivity-app/src/pages/Machine.tsx` (이 화면 전체가 이 한 파일 + 같은 파일 하단의 `QtyCell` 내부 컴포넌트로 끝난다. 별도 컴포넌트 import 없음.)

---

### 1. 라우팅과 `:id` → `machine` 값

- 라우트 등록: `App.tsx` 의 `<Route path="/machine/:id" element={<Machine />} />`. 앱 전체는 `BrowserRouter basename="/productivity-app"` 아래 있으므로 실제 URL 은 `/productivity-app/machine/1`.
- 컴포넌트 첫 줄에서 `const { id } = useParams();` 로 받고, **문자열 결합 한 번으로** 호기 이름을 만든다: `` const machine = `${id}호기` as MachineEntry['machine'] ``.
  - `/machine/1` → `'1호기'`, `/machine/2` → `'2호기'`, `/machine/3` → `'3호기'`.
  - **검증이 전혀 없다.** `/machine/9` 로 들어가면 `'9호기'` 가 되어 `days/{date}/machines/9호기/entries` 에 그대로 쓰기가 된다(에러 없음). 다만 합산·색상 계산은 `'1호기' | '2호기' | '3호기'` 세 개만 보므로 9호기 입력은 어디에도 반영되지 않는다. 이 동작을 그대로 재현한다(가드를 추가하지 말 것).
- 상단 서브탭(`App.tsx` 의 `SUB_TABS.input`)은 `1호기`(`/machine/1`), `2호기`, `3호기`, `외포장-1`(`/external/1`), `외포장-2`, `외포장-3`, `내포장`(`/scoop`), `내포장 현황판`(`/scoop/board`) 순서로 고정. 활성 판정은 `location.pathname.startsWith(t.to)`.
- 상단 헤더의 `입력` 버튼은 `/machine/1` 로 간다(= 입력 섹션의 기본 진입점).

---

### 2. Firestore 경로와 문서 형태

| 용도 | 경로 | 문서 ID |
|---|---|---|
| 그날의 품목(발주) 목록 | `days/{date}/items` | 품목 코드 그대로(대시보드 붙여넣기가 `code` 를 ID 로 씀) |
| 호기 입력 한 줄 | `days/{date}/machines/{machine}/entries` | `addDoc` 자동 ID |

- `{date}` 는 항상 `YYYY-MM-DD` 문자열(로컬 시간 기준으로 조립, UTC 변환 금지).
- `{machine}` 은 위에서 만든 `'1호기'` 같은 한글 문자열이 **경로 세그먼트로 그대로** 들어간다.
- `entries` 문서 필드(타입은 `src/types.ts` 의 `MachineEntry`):
  - `id: string` — 선택한 품목 코드(문서 ID 아님, 코드값이 중복 저장된다)
  - `code: string` — 품목 코드(원본 대소문자 그대로)
  - `actualProduction?: number`
  - `additionalProduction?: number`
  - `workTime?: string` — `'HH:MM'`
  - `additionalWorkTime?: string` — `'HH:MM'`
  - `machine: '1호기' | '2호기' | '3호기'`
  - `date: string`
  - **한 문서에는 `actualProduction`+`workTime` 쌍 또는 `additionalProduction`+`additionalWorkTime` 쌍 중 하나만 들어간다.** 나머지 두 필드는 `null` 이 아니라 **아예 존재하지 않는다.** 이 존재/부재가 나중에 표에서 어느 칸이 수정 가능한지를 결정한다.
- `days/{date}/items` 문서(`Item` 타입)에서 이 화면이 쓰는 필드는 `code`, `name`, `totalQty` 뿐이다.
- 참고: `src/pages/Import.tsx`(엑셀 일괄 이관)는 같은 `entries` 컬렉션에 **문서 ID 를 `e.code` 로** 써 넣는다. 즉 실제 DB 에는 자동 ID 가 아닌 문서가 섞여 있을 수 있고, 이 화면은 그걸 그대로 읽고 지우고 수정한다.

---

### 3. 날짜 상태 (`date`)

- `const [date, setDate] = useState(loadViewDate);` — `src/lib/viewDate.ts`.
  - `loadViewDate()`: `localStorage['viewDate']` 에 `{ date, chosenOn }` JSON 이 있고 `chosenOn === todayKey()` 일 때만 저장된 날짜를 돌려주고, 아니면 오늘. (구버전 평문 문자열 형식도 `raw === today` 일 때만 인정.)
  - `useEffect(() => { saveViewDate(date); }, [date]);` — 바뀔 때마다 `{date, chosenOn: todayKey()}` 로 저장.
  - **이 키는 대시보드(`Dashboard.tsx`)와 공유한다.** 대시보드에서 9/10 을 보고 있다가 호기 화면으로 들어오면 9/10 이 그대로 열린다(단, 당일 안에서만 — 날이 바뀌면 무시되고 오늘로 돌아간다).
- `const today = todayKey();` / `const isToday = date === today;` — `todayKey()` 는 순수 달력 오늘.
- **새벽 2시 롤오버**: `setInterval(tick, 60_000)` 로 1분마다 `effectiveTodayKey()` 를 구해 `date !== eff` 면 `setDate(eff)`.
  - `effectiveTodayKey()`(`src/lib/dateUtil.ts`): 현재 시각이 새벽 2시 이전(`getHours() < 2`)이면 **전날**, 아니면 오늘. 야간조가 자정을 넘겨 입력해도 전날 일자에 쌓이게 하려는 규칙이다.
  - 부작용이자 의도된 동작: **이 화면에서 과거 날짜를 고르면 최대 60초 뒤 자동으로 "유효 오늘" 로 되돌아간다.** 날짜 input 은 열려 있지만 오래 머물 수 없다.
  - `useEffect` 의존성은 `[date]` 이므로 날짜가 바뀔 때마다 인터벌이 재설정되고, 언마운트/재설정 시 `clearInterval` 로 반드시 해제한다.

---

### 4. 실시간 구독 (총 5개 리스너)

모두 `onSnapshot` 이며 **반드시 해제**한다(단일 구독은 `return onSnapshot(...)`, 다중은 `return () => unsubs.forEach((u) => u())`).

1) **품목 목록** — `days/{date}/items`, 의존성 `[date]`
   - 전부 `Item` 으로 모아 `compareCode(a.code, b.code)` 로 정렬해 `items` 에 넣는다.
   - `compareCode`(`src/lib/codeUtil.ts`)는 자연 정렬: `^([A-Za-z]+)(\d+)` 로 쪼개 알파벳부 `localeCompare` 먼저, 같으면 숫자부를 `parseInt` 정수 비교(F01, F02, F06, F12, F104 순). 패턴에 안 맞으면 통째로 `localeCompare`.
   - **날짜가 바뀔 때 `setItems([])` 로 비우지 않는다.** (대시보드는 비운다.) 새 날짜 스냅샷이 오기 전 몇 프레임 동안 이전 날짜 품목이 남아 보이는 게 현재 동작이다.

2) **이 호기의 입력 내역** — `days/{date}/machines/{machine}/entries`, 의존성 `[date, machine]`
   - 각 문서를 `{ ...data, docId: d.id }` 로 담아 `entries` 에 넣는다.
   - **정렬(중요)**: 비교 키는 `a.workTime || a.additionalWorkTime || ''`.
     - 1차: `tb.localeCompare(ta)` — 시각 문자열 **내림차순**(최근 시각이 위).
     - 2차 tie-break: `b.docId.localeCompare(a.docId)` — 문서 ID 내림차순. 코드 주석은 "같은 분 → 나중에 만든 doc 가 위" 라고 적혀 있지만 Firestore 자동 ID 는 시간순이 아니므로 실제로는 **안정적이지만 임의적인 순서**다. 그대로 재현할 것.
     - 두 시각이 모두 없는 문서는 키가 `''` 이라 목록 **맨 아래**로 간다.
   - 여기도 날짜 변경 시 초기화하지 않는다.

3~5) **1·2·3호기 전체 합산 구독** — `days/{date}/machines/{m}/entries` 를 `['1호기','2호기','3호기']` 각각에 대해, 의존성 `[date]`
   - 효과 시작 시 `setAllMachineQty({ '1호기': {}, '2호기': {}, '3호기': {} })` 로 **초기화한다**(여기만 초기화한다).
   - 각 호기별로 `{ 코드(소문자): 수량합 }` 맵을 만든다: `key = String(e.code || '').toLowerCase()`, 값은 `(e.actualProduction || 0) + (e.additionalProduction || 0)` 누적.
   - `setAllMachineQty((prev) => ({ ...prev, [m]: map }))` 로 호기별로 교체.
   - **왜 다른 호기까지 구독하나**: 한 품목(코드)을 여러 호기가 나눠 만든다. "이 코드가 목표를 채웠는지"는 내 호기 실적만으로는 알 수 없다. 이 합계는 세 곳에 쓰인다 — ① 이미 다 만든 코드를 검색 목록에서 숨기고, ② 카드에 `추가 N개 필요` 배지를 띄우고, ③ 입력 내역 행의 배경색(미달 분홍 / 과다 빨강)을 정한다.
   - 주의: 내 호기 컬렉션은 2번 리스너와 이 리스너가 **중복 구독**된다(설계 그대로). `entries` 와 `allMachineQty[machine]` 을 더해 쓰는 곳은 없으므로 이중 계산은 일어나지 않는다.

파생값(모두 `useMemo`):
- `combinedByCode` = 세 호기 맵을 코드별로 합산한 `{소문자코드: 총생산량}`.
- `targetByCode` = `items` 로부터 `{ i.code.toLowerCase(): i.totalQty || 0 }`.
- **코드 정규화는 `toLowerCase()` 뿐이다.** 하이픈·공백은 제거하지 않는다(`normalizeCode` 를 쓰지 않는다). 대시보드의 `logistics` 쪽만 `[-\s]` 를 제거한다 — 그 차이를 그대로 둘 것.

---

### 5. 화면 구성

최상위: `<div className="space-y-4">`. 위에서부터 세 덩어리.

#### 5.1 헤더 줄 (`flex items-center gap-3 flex-wrap`)
- `<h2 className="text-xl font-bold">{machine} 입력</h2>` → 예: **"1호기 입력"**.
- 날짜 `<input type="date">` (`border rounded px-2 py-1 text-sm`), 변경 시 `setDate(e.target.value)`.
- `isToday` 가 아닐 때만 추가로 두 개:
  - 버튼 **`오늘로`** — `bg-blue-100 text-blue-700` 작은 알약(`px-3 py-1 text-xs rounded font-medium`), 누르면 `setDate(today)`.
  - 경고 문구 **`⚠ 과거 날짜에 입력 중`** — `text-xs text-orange-600 font-medium`.

#### 5.2 검색·등록 카드 (`bg-white border rounded-lg p-4 space-y-3`)
- 검색 input: `value={search}`, placeholder **`코드 또는 품목명 검색...`**, `w-full border rounded-md px-3 py-3 text-base` (현장 태블릿용으로 크게).
- **`search` 가 빈 문자열이면 결과 목록 자체를 렌더하지 않는다**(`{search && (...)}`). 즉 기본 화면에는 품목 목록이 보이지 않고, 검색해야 나타난다. 이 화면에는 "이 호기가 오늘 만들 품목" 같은 호기별 배정 개념이 아예 없다 — **그날 `items` 전체가 세 호기에 똑같이 보인다.**
- 결과 목록: `grid grid-cols-2 md:grid-cols-3 gap-2 max-h-60 overflow-y-auto` — 즉 모바일 2열, md 이상 3열, 높이 15rem 넘으면 세로 스크롤.
- 후보 계산(`filtered`):
  1. `stillNeeded` = `items` 중 `i.totalQty <= 0` 이면 무조건 포함, 아니면 `combinedByCode[i.code.toLowerCase()] || 0 < i.totalQty` 인 것만. → **이미 목표를 채운 코드는 목록에서 사라진다**(중복·과잉 입력 1차 방지).
  2. `q = search.trim().toLowerCase()`. `q` 가 비면 `stillNeeded.slice(0, 30)`(공백만 입력한 경우에만 도달), 아니면 `i.code.toLowerCase().includes(q) || i.name.includes(q)` — **품목명은 소문자화하지 않은 원본에 소문자 질의를 `includes`** 한다(한글이라 실무상 문제 없음). 개수 제한 없음.
- 각 후보 카드(버튼) 내부:
  - `produced = combinedByCode[코드소문자] || 0`, `remaining = it.totalQty - produced`, `partial = produced > 0 && remaining > 0`, `active = selectedCode === it.code`.
  - 배경/테두리: `active` → `bg-slate-900 text-white border-slate-900`; 아니고 `partial` → `bg-rose-50 border-rose-300 hover:bg-rose-100`; 그 외 → `hover:bg-slate-50`(기본 흰색).
  - 1행 코드 `font-mono text-xs`(`partial` 이고 비활성이면 `text-rose-600`, 그 외 `opacity-70`), 2행 품목명 `font-medium`, 3행 **`총 {it.totalQty}EA`** `text-xs opacity-70`.
  - `partial` 이면 알약 배지 **`추가 {remaining}개 필요`** (`text-[11px] font-bold`, 비활성일 때 `bg-rose-500 text-white`, 활성일 때 `bg-rose-200 text-rose-800`).
  - 클릭 시: `setSelectedCode(it.code)`(원본 대소문자), `setSearch(it.name)`(검색창을 품목명으로 교체 — 목록은 계속 보인다), `setIsAdditional(partial)` — **부분 생산 상태면 "추가 생산" 체크가 자동으로 켜진다.**
- 선택된 코드가 있을 때만(`{selectedCode && ...}`) 입력부가 나타난다:
  - 체크박스(`w-5 h-5`) + 라벨 **`추가 생산 `**, 체크 시 뒤에 **`(부족분 추가 생산으로 기록)`** 이 붙고 글자색이 `text-green-700`(꺼져 있으면 `text-slate-700`).
  - 수량 줄(`flex items-center gap-2`): `−` 버튼(`w-12 h-12 border rounded-md text-xl`, U+2212 문자) → `setQty(Math.max(0, qty - 1))`; 숫자 input(`type="number"`, `value={qty || ''}`, placeholder `0`, `flex-1 px-3 py-3 text-center text-xl font-bold`, `onChange = setQty(Number(e.target.value) || 0)`); `+` 버튼 → `setQty(qty + 1)`; 등록 버튼(`text-white px-6 py-3 rounded-md font-medium`) — 라벨은 `isAdditional` 이면 **`추가 등록`** + `bg-green-700 hover:bg-green-800`, 아니면 **`등록`** + `bg-slate-900 hover:bg-slate-800`.

#### 5.3 입력 내역 테이블 (`bg-white border rounded-lg overflow-hidden`)
- 헤더 바(`p-3 border-b bg-slate-50 font-semibold flex items-center gap-3 flex-wrap`):
  - **`오늘 입력 내역 ({entries.length})`**
  - 범례 두 개(`text-xs font-normal text-gray-500`): 작은 사각형 `bg-rose-100 border border-rose-200` + **`목표 미달`**, 사각형 `bg-red-300` + **`목표+100↑(오입력 의심)`**.
- `<table className="w-full text-sm">`, thead `bg-slate-100 text-xs text-slate-600`, 컬럼 6개:
  1. `코드` (좌측 정렬)
  2. `실제 생산량` (우측)
  3. `추가 생산량` (우측, th 에 `bg-green-50`)
  4. `작업 시간` (가운데)
  5. `추가 작업 시간` (가운데, th 에 `bg-green-50`)
  6. 빈 헤더(삭제 버튼 열)
- 각 행:
  - `코드` 셀은 **`font-mono text-2xl font-bold`** (현장에서 멀리서 보이도록 크게).
  - `실제 생산량` 셀: `<QtyCell value={actualProduction||0} editable={!!e.workTime} onSave={updateActual}/>`.
  - `추가 생산량` 셀: `<QtyCell value={additionalProduction||0} editable={!!e.additionalWorkTime} prefix="+" green />`, 그리고 값이 0보다 크면 td 에 `bg-green-50`.
  - `작업 시간` 셀: `e.workTime || '-'`, `text-lg`.
  - `추가 작업 시간` 셀: `e.additionalWorkTime || '-'`, 값이 있으면 `bg-green-50 text-green-700`.
  - 마지막 셀: **`삭제`** 링크형 버튼(`text-xs text-red-500 hover:underline`).
  - 행 배경(아래 6절 규칙).
- 빈 상태: `entries.length === 0` 이면 `<tr><td colSpan={6} className="p-6 text-center text-slate-400">` **`아직 입력 내역이 없습니다`**.

---

### 6. 행 배경색 규칙 (코드 단위, 호기 무관)

행마다 다음을 계산한다.
- `codeKey = (e.code || '').toLowerCase()`
- `target = targetByCode[codeKey] || 0`
- `producedTotal = combinedByCode[codeKey] || 0` ← **전 호기 합계**
- `over100 = target > 0 && producedTotal >= target + 100` → 배경 `bg-red-300`
- `shortage = target > 0 && producedTotal < target` → 배경 `bg-rose-100`
- 둘 다 아니면 배경 없음. **`over100` 이 우선**(else-if 순서).

따라서 ① 같은 코드의 모든 행은 항상 같은 색이고, ② 1호기 행이 분홍인 것은 "이 줄이 모자라다" 가 아니라 "이 코드가 아직 전체 목표에 못 미친다" 는 뜻이며, ③ 목표를 정확히 채우면 색이 사라지고, +100 이상 넘기면 오입력 의심으로 빨강이 된다. `items` 에 없는 코드(`target === 0`)는 항상 무색이다.

---

### 7. 등록 (`submit`)

1. 가드: `if (!selectedCode || qty <= 0) return alert('코드와 수량을 입력하세요');` — 코드 미선택 또는 수량 0 이하면 alert 하나 띄우고 끝. (`type="number"` 라 소수 입력은 막지 않는다.)
2. `const time = formatTime();` → 현재 로컬 시각을 `HH:MM` 로(`String(getHours()).padStart(2,'0')` + `:` + 분 동일). **초는 없다.**
3. 공통 필드 `base = { id: selectedCode, code: selectedCode, machine, date }`.
4. 분기:
   - `isAdditional === true` → `{ ...base, additionalProduction: qty, additionalWorkTime: time }`
   - 아니면 → `{ ...base, actualProduction: qty, workTime: time }`
5. `await addDoc(collection(db, 'days', date, 'machines', machine, 'entries'), data)` — **문서 ID 는 Firestore 자동 ID**(지정하지 않는다).
6. 성공 후 입력 상태 초기화: `setSelectedCode(null); setQty(0); setSearch(''); setIsAdditional(false);` → 검색창이 비워지므로 결과 목록도 접힌다. 확인 토스트·알림은 없다. 실패 처리(try/catch)도 없다.

의미 구분:
- **실적(`actualProduction`)** = 그 호기가 그 시각에 정상 생산한 수량. `workTime` 은 등록을 누른 시각이며 "그 배치가 끝난 시각" 처럼 쓰인다(대시보드가 여기에 +50분 해서 냉각 종료 시각을 계산한다).
- **추가생산(`additionalProduction`)** = 목표에 모자라 나중에 더 만든 수량. `additionalWorkTime` 이 그 시각. 화면 전반에서 초록색으로 구분한다.
- **작업시간은 사용자가 입력하지 않는다.** 등록 버튼을 누른 순간의 시각이 자동으로 박히고, 이후 수량을 고쳐도 **절대 바뀌지 않는다**(그래서 목록 순서가 흔들리지 않는다). 시각을 고치려면 지우고 다시 등록하는 수밖에 없다.

---

### 8. 수정 (`QtyCell` 인라인 편집)

- 표시 상태: 버튼 하나. `value > 0` 이면 `` `${prefix}${value}` ``(추가 생산은 `+` 접두), 아니면 `-`. `hover:bg-amber-50 hover:ring-1 hover:ring-amber-300`, `title` 은 **`눌러서 수정 (작업시간·순서는 그대로)`**. `green && value > 0` 이면 `text-green-700`.
- `editable === false` 이면 버튼이 아니라 `<span className="px-2 py-1 text-lg text-gray-300">-</span>` 로 **회색 고정**. 실적 행의 "추가 생산량" 칸, 추가생산 행의 "실제 생산량" 칸이 여기에 해당한다(해당 시각 필드가 없으므로). 즉 **한 문서가 두 종류 수량을 동시에 갖게 만들 방법이 UI 에는 없다.**
- 클릭하면 `type="number"` input(`autoFocus`, `w-24 border-2 border-amber-400 ... text-right text-lg font-bold`)으로 바뀐다. 로컬 문자열 state `local` 을 쓰고, 외부 `value` 가 바뀌면 `useEffect` 로 `String(value || '')` 로 다시 맞춘다(빈 값이면 `''`).
- 커밋 규칙(`commit`): 먼저 `setEditing(false)` 후 `n = Number(local)`; **`!isNaN(n) && n >= 0 && n !== value`** 일 때만 `onSave(n)`, 아니면 `local` 을 원래 값으로 되돌린다.
  - 빈칸으로 지우고 커밋하면 `Number('') === 0` 이라 **0 이 저장된다**(삭제가 아니라 0).
  - 음수는 저장되지 않고 조용히 되돌아간다. 같은 값이면 쓰기 자체를 생략한다.
- 키/포커스: `Enter` = 커밋, `Escape` = 취소(`cancel`, 값 복원), `onBlur` = 커밋.
- 저장 함수는 **단일 필드만** 갱신한다.
  - `updateActual(docId, v)` → `updateDoc(doc(db,'days',date,'machines',machine,'entries',docId), { actualProduction: v })`
  - `updateAdditional(docId, v)` → 같은 문서에 `{ additionalProduction: v }`
  - `workTime` / `additionalWorkTime` 은 건드리지 않으므로 정렬 키가 보존되어 **행이 튀어오르지 않는다.** 이게 이 설계의 핵심 의도다.
- **즉시성**: 별도의 낙관적 갱신 코드는 없다. 화면 값은 오로지 `onSnapshot` 이 준 `entries` 로 그린다. 그럼에도 즉시 반영돼 보이는 이유는 Firestore SDK 가 로컬 쓰기를 곧바로 스냅샷으로 되돌려주기 때문(latency compensation). 오프라인이면 화면은 먼저 바뀌고 나중에 서버와 합쳐진다. 재현 시에도 수동 낙관적 갱신을 추가하지 말 것.

---

### 9. 삭제 (`remove`)

- `if (!confirm(`${code} 기록을 삭제할까요?`)) return;` — 예: `A01 기록을 삭제할까요?`.
- `await deleteDoc(doc(db, 'days', date, 'machines', machine, 'entries', docId))`.
- 되돌리기 없음, 확인 토스트 없음. 화면에서 사라지는 것도 구독 반영(=사실상 즉시).

---

### 10. 완료 알림 (`src/lib/completionAlert.ts`)

이 화면 안에는 알림 코드가 **없다**. 알림은 `App.tsx` 가 전역으로 돌리고 있어서, 어느 페이지에 있든(호기 입력 화면 포함) 동작한다. 호기 입력이 알림의 트리거가 되는 구조다.

**켜고 끄기 (`toggleAlertByLongPress`)**
- 상단 헤더의 **`현황`** 네비 버튼을 **5초 꾹** 누르면 실행된다(`useLongPress(…, 5000)`; 누르는 동안 버튼에 `ring-2 ring-amber-300 scale-95`, 롱프레스가 발동하면 뒤따르는 click 은 `consumeClick` 이 막아 페이지 이동이 일어나지 않는다). 켜져 있으면 버튼 라벨 옆에 🔔 가 붙는다.
- 이미 켜져 있으면: `confirm('이 기기의 생산 완료 알림을 끌까요?')` → 확인 시 끔.
- 꺼져 있으면: ① `'Notification' in window` 가 아니면 `alert('이 브라우저는 알림을 지원하지 않습니다.\n(iPhone 은 Safari 에서 "홈 화면에 추가" 후 사용해 주세요)')` 후 종료. ② 안내 `confirm`(“이 기기에서 생산 완료 알림을 받겠습니까?” + 진행률 100% 시 하루 1회 / 확인 누른 기기에만 / 브라우저가 켜져 있어야 함) ③ 권한이 `default` 면 `Notification.requestPermission()`, `granted` 가 아니면 `alert('알림 권한이 거부되어 있습니다.\n브라우저 주소창 옆 자물쇠(ⓘ) → 알림 → 허용 으로 바꿔주세요.')` ④ 성공하면 `localStorage['completionAlert:on'] = '1'` 후 테스트 알림 `('알림이 켜졌습니다', '오늘 생산이 100% 완료되면 이 기기로 알려드립니다.', 'ssbon-alert-test')`.
- 상태 변경 후 `window.dispatchEvent(new Event('ssbon:alert-changed'))` 로 구독 훅이 재평가된다.

**무엇을 검사하나 (`watchTodayProgress` + `handleProgress`)**
- 날짜는 `todayKey()`(**`effectiveTodayKey()` 아님** — 입력 화면의 새벽 2시 규칙과 다르다). 자정을 넘기면 `App.tsx` 가 1분마다 `getDate()` 변화를 감지해 구독을 끊고 새 날짜로 다시 건다.
- 구독 5개: `days/{date}/items`, `days/{date}/machines/{1·2·3호기}/entries`, `days/{date}/logistics`. 아무 콜백에서나 값이 오면 `emit()` 으로 재계산한다.
- 코드별 실적 = 세 호기의 `(actualProduction||0) + (additionalProduction||0)` 합, 키는 `code.toLowerCase()`.
- `totalQty` = `items` 의 `totalQty` 합.
- `completedItems` = 품목 중 ① `logistics[normalize(code)]` 가 존재하면 완료로 인정(여기서 `normalize` 는 `toLowerCase().replace(/[-\s]/g,'')` — **여기만 하이픈/공백을 지운다**), 아니면 ② `실적 >= totalQty && totalQty > 0`.
- `pct` = `Math.round( Σ min(실적, totalQty) / totalQty × 100 )`. **품목별로 목표에서 잘라 더하므로 초과 생산이 다른 품목의 미달을 메꾸지 못한다.** `totalQty` 가 0 이면 0.
- 단, `logistics` 문서가 하나라도 있으면 `pct` 를 **무조건 100 으로 덮어쓴다**(`hasLogistics ? 100 : pct`). 물류가 잔여량을 확정 입력하면 그날 생산은 끝난 것으로 본다는 규칙 — 대시보드와 동일.
- 발사 조건(`handleProgress`): `itemCount > 0` **그리고** `totalQty > 0` **그리고** `pct >= 100` **그리고** `localStorage['completionAlert:notified'] !== 오늘날짜`. 통과하면 먼저 날짜를 기록해 **하루 한 번**만 울리게 하고 알림을 띄운다.
- 알림 내용: 제목 **`✅ 생산 완료`**, 본문 `` `${date} 전 품목 생산이 완료되었습니다 (${completedItems}/${itemCount}품목 · ${totalQty.toLocaleString()}EA)` ``, tag `` `ssbon-done-${date}` ``.
- `fireNotification`: `Notification.permission === 'granted'` 일 때만 `new Notification(title, { body, tag, requireInteraction: true })`(클릭 시 `window.focus()` 후 닫기). 그와 별개로 항상 `navigator.vibrate?.([300,120,300,120,500])` 와 WebAudio 비프(사인파 880Hz 0.18초 → 0.2초 뒤 1175Hz 0.28초, gain 0.0001→0.25→0.0001 지수 램프, 1.5초 뒤 `ctx.close()`)를 시도하고 실패는 전부 무시한다.
- 설정은 **기기별**(localStorage). PC·휴대폰 각각 켜야 하고, 브라우저가 떠 있어야 한다(웹푸시 아님).

즉 3호기에서 마지막 부족분을 등록해 진행률이 100% 가 되는 순간, 알림을 켜 둔 기기들에서 알림이 뜬다.

---

### 11. 대시보드로의 즉시 반영

대시보드(`/`)는 이 화면과 **같은 컬렉션을 독립적으로 구독**하므로 별도 동기화 코드가 없어도 즉시 반영된다.
- `Dashboard.tsx` 는 `days/{viewDate}/machines/{1·2·3호기}/entries` 를 구독해 코드별(소문자) `실제+추가` 합계 `actualByCode` 를 만들고, 동시에 `[workTime, additionalWorkTime].filter(Boolean).sort().pop()` 으로 코드별 **최신 시각** `lastTimeByCode` 를 만든다.
- 호기에서 한 줄 등록하면 대시보드의 품목 행에서 `실제 생산량`, `±` 열, 행 배경(`done` → `bg-green-200`, `inProgress`(0 < 실적 < 목표) → `bg-red-200`), 상단 통계 카드(`완료된 수량`·`진행률`·`완료된 품목`)가 동시에 갱신된다.
- `냉각 종료` 열은 그 코드의 최신 작업시각에 **+50분**(`addMinutes(lt, 50)`, 24시간 순환)한 값을 파란 굵은 글씨로 보여준다. 즉 **호기에서 등록 버튼을 누른 시각이 그대로 냉각 종료 예정 시각의 기준**이 된다. 작업시각이 하나도 없으면 `item.coolingEndTime` 또는 `-`.
- 대시보드는 보고 있는 날짜가 오늘일 때만, 진행률 시그니처(`pct|completedItems|itemCount|totalQty`)가 바뀔 때만 `appMeta/dailyProgress` 에 `setDoc(..., { merge: true })` 로 한 줄 쓴다(Apps Script 시간트리거용). 호기 화면은 이 문서를 쓰지 않는다.
- 두 화면은 `localStorage['viewDate']` 를 공유하므로, 대시보드에서 고른 날짜가 호기 화면에도 이어진다(당일 한정).

---

### 12. 가드 요약 (있는 것 / 없는 것)

**있는 것**
- 등록: 코드 미선택 또는 `qty <= 0` 이면 `alert('코드와 수량을 입력하세요')`.
- 목표를 이미 채운 코드는 검색 목록에서 제외 → 과잉 입력 1차 차단.
- 부분 생산 코드는 선택 즉시 "추가 생산" 이 자동 체크 → 실적/추가 오분류 방지.
- 목표 대비 미달/과다(+100 이상)를 행 배경색으로 경고.
- 수량 수정 시 음수·NaN 거부, 동일값이면 쓰기 생략.
- 삭제는 `confirm` 필수.

**없는 것(추가하면 안 됨)**
- 같은 코드 중복 등록 차단 없음(여러 줄이 정상 사용 패턴이다).
- 목표 초과 수량 입력 차단 없음(색으로만 경고).
- `:id` 검증, 로그인·권한 분기 없음(분석 메뉴에만 `AnalyticsGate` 비밀번호가 있고 입력 화면은 누구나 접근).
- 쓰기 실패 처리(try/catch)·로딩 스피너·성공 토스트 없음.

---

### 부록: `ProcessTimeline.tsx` 는 이 화면에 없다

읽어 봤지만 `/machine/:id` 와 무관하다. `src/pages/Analytics.tsx` 에서 `<ProcessTimeline date={viewDate} />` 로만 쓰이며, `productivity/{date}` 문서 하나를 구독해 전처리(`pp`)·배합(`bg`)·취반기(`ck`)·화구(`fl`)·내포장(`pk`) 5행 간트를 SVG 로 그린다. 핵심 규칙만 남긴다(담당 영역에서 상세화할 것): 생산성 = `Math.round(numerator / (people × (mins/60)))`, 분자는 `ck` 면 `bat`, `fl` 면 `pot`, 나머지는 `pot + bat`, 인원≤0·시간≤0·분자≤0 이면 0. 데이터가 하나도 없으면 **`이 날짜의 공정 데이터가 없습니다 — 조직도 → 생산성 입력에서 등록하세요`**. 호기 입력 화면을 재현할 때 이 컴포넌트를 넣지 말 것.

---

# 6부 — 외포장 입력 (외포장-1/2/3)

## 외포장 입력 화면 (외포장-1 / 외포장-2 / 외포장-3)

파일: `/home/user/productivity-app/src/pages/ExternalPack.tsx` (컴포넌트 `ExternalPack`, default export)
라우트: `/external/:id` (`src/App.tsx`)

---

### 0. 가장 먼저 알아야 할 것 — 이 화면은 "입력" 화면이 아니다

이름과 메뉴 위치(상단 `입력` 섹션, 서브탭 `외포장-1/2/3`)는 입력 화면이지만, **이 화면에는 쓰기 동작이 하나도 없다.**

- `addDoc` / `setDoc` / `updateDoc` / `deleteDoc` 을 **전혀 import 하지 않는다.** import 하는 firestore API 는 `collection`, `onSnapshot` 둘뿐이다.
- 따라서 **등록·수정·삭제 UI가 없다.** 검색창 없음, 코드 선택 버튼 없음, 수량 ±버튼 없음, `추가 생산` 체크박스 없음, 등록 버튼 없음, 인라인 수정 셀(`QtyCell`) 없음, 행 끝 `삭제` 버튼 없음.
- 이 화면이 쓰는 유일한 영구 저장소는 **localStorage 두 개**(조회 날짜, 표 글자 크기)뿐이다. Firestore 에는 한 글자도 쓰지 않는다.

정체는 **해당 호기의 entries 를 품목 마스터와 조인해서 "이 코드 다 쳤나/모자라나"를 큰 글씨로 보여주는 읽기 전용 현황판**이다. 외포장 작업자가 태블릿/모니터로 띄워놓고 보는 용도다.

**`/external/1` 은 `/machine/1` 과 정확히 같은 Firestore 컬렉션을 읽는다.** 외포장 전용 컬렉션은 존재하지 않는다. 즉 외포장-1 은 1호기 입력 내역의 다른 뷰(mirror)다.

### 0-1. `ExternalPackEntry` 타입은 죽은 타입이다 — 반드시 확인할 것

`src/types.ts` 에 다음 인터페이스가 선언되어 있다.

```
ExternalPackEntry {
  code, name, orderQty, shippedQty, actualProduction, shortage,
  additionalProduction, machine: '1호기'|'2호기'|'3호기', date
}
```

그런데 **저장소 전체에서 이 타입을 import 하거나 사용하는 코드는 한 줄도 없다.** `ExternalPack.tsx` 조차 이 타입을 쓰지 않고 `Item` 과 `MachineEntry` 만 import 한다. `external` 이라는 문자열은 저장소에서 ① `App.tsx` 의 라우트·서브탭 3개, ② `types.ts` 의 이 인터페이스 선언, 이 두 곳에만 등장한다. `days/{date}/externalPack/...` 같은 Firestore 컬렉션은 **없다.**

`db_schema_export.md` 11절 `external_pack_entries` 도 "현재는 동일 컬렉션의 별도 doc 형태가 아니라 별도 페이지 데이터셋"이라고 적어 두었다 — 즉 **미래의 RDB 이관을 위해 미리 그려 둔 설계일 뿐, 지금 돌아가는 앱에 대응하는 테이블/컬렉션이 없다.**

**이 화면을 재현할 때 `ExternalPackEntry` 를 만들거나 저장하려 하면 안 된다.** 타입은 그대로 선언해 두되(스키마 문서와 짝이 맞아야 하므로) 사용하지 않는다.

필드별 실제 대응관계 (화면 컬럼 ↔ 타입 필드 ↔ 실제 데이터 출처):

| `ExternalPackEntry` 필드 | 화면 컬럼 | 실제로 어디서 오나 | 성격 |
|---|---|---|---|
| `code` | 코드 | `MachineEntry.code` (entries 문서) | 저장값 |
| `name` | 품목명 | `Item.name` (같은 날 items 에서 코드로 조인) | 조인값, 저장 안 함 |
| `orderQty` | 주문수량 | `Item.orderQty` | 조인값, 저장 안 함 |
| `shippedQty` | 발주량 | **`Item.totalQty`** (이름과 다름! 주의) | 조인값, 저장 안 함 |
| `actualProduction` | 실제 생산량 | `MachineEntry.actualProduction` (그 행 자기 값) | 저장값 |
| `shortage` | 모자란 수량 | **계산값**: `전 호기 합산 생산량 − Item.totalQty` | 화면에서만 계산, 절대 저장 안 함 |
| `additionalProduction` | 추가 생산량 | `MachineEntry.additionalProduction` (그 행 자기 값) | 저장값 |
| `machine` | — | URL 의 `:id` 로부터 `${id}호기` | 화면에 안 보임 |
| `date` | 상단 날짜 입력칸 | 조회 날짜 state | 화면에 안 보임 |

→ **`shortage` 는 입력값이 아니라 100% 계산값이다.** 게다가 이름과 달리 부족분만이 아니라 **초과분(양수)도 함께 표시**한다(아래 4-3 참조).

---

### 1. 라우팅·셸·권한

- `App.tsx` 의 `<Route path="/external/:id" element={<ExternalPack />} />`.
- `getSection()`: `pathname.startsWith('/external')` → 섹션 `'input'`. 그래서 상단 파란 헤더에서 `입력` 탭이 활성(흰 배경+파란 글씨)으로 보이고, 두 번째 줄 서브탭이 1호기/2호기/3호기/외포장-1/외포장-2/외포장-3/내포장/내포장 현황판 8개로 뜬다.
- 서브탭 활성 판정은 `location.pathname.startsWith(t.to)` (`exact` 없음).
- **권한 게이트 없음.** `AnalyticsGate` 는 `/analytics/*` 만 감싼다. 외포장 화면은 누구나 URL 만 알면 본다.
- 본문 컨테이너 폭: `MainContainer` 의 `wide` 목록에 `/external` 이 없으므로 **`max-w-screen-xl`**, `w-full mx-auto px-4 py-5`.
- `:id` 는 검증하지 않는다. `machine` 을 문자열 템플릿 `` `${id}호기` `` 로 만들 뿐 `MachineEntry['machine']` 으로 캐스팅조차 하지 않는다. `/external/7` 로 들어가면 `days/{date}/machines/7호기/entries` 를 구독하고, 비어 있으므로 `7호기에서 입력된 내역이 없습니다` 가 뜬다(에러 아님).

### 2. 날짜 상태 (호기 입력과 100% 동일, 그대로 베낀 부분)

`Machine.tsx` 의 날짜 블록을 문자 그대로 복사한 코드다. 네 조각으로 이루어진다.

1. `const [date, setDate] = useState(loadViewDate);` — 초기값은 `src/lib/viewDate.ts` 의 `loadViewDate()`.
   - localStorage 키 `viewDate` 에 `{ date, chosenOn }` JSON 으로 저장.
   - `chosenOn === todayKey()` 일 때만 저장된 `date` 를 돌려준다. 즉 **어제 고른 조회 날짜는 오늘 접속하면 오늘로 초기화**된다(날짜 선택이 하루 단위로만 유지).
   - 구버전 호환: raw 가 JSON 이 아니면(평문 문자열) `raw === today` 일 때만 그 값을 쓴다.
2. `useEffect(() => { saveViewDate(date); }, [date]);` — 날짜 바뀔 때마다 저장. 저장 시 `chosenOn` 은 `todayKey()`.
3. `const today = todayKey(); const isToday = date === today;` — **`effectiveTodayKey()` 가 아니라 `todayKey()` 로 비교한다.**
4. **새벽 2시 롤오버 타이머**: 60초(`60_000`)마다 `effectiveTodayKey()` 를 구해 `date !== eff` 이면 무조건 `setDate(eff)`. deps `[date]`. cleanup 에서 `clearInterval`.

`dateUtil.ts`:
- `todayKey()` = 로컬 시각 기준 `YYYY-MM-DD` (월·일 `padStart(2,'0')`).
- `effectiveTodayKey()` = 같은 계산인데 **`getHours() < 2` 이면 하루를 뺀다**(야간조 보호). 즉 00:00~01:59 의 "오늘"은 전날.

### 3. Firestore 구독 (읽기 전용, 총 4개 리스너)

경로는 **호기 입력과 완전히 동일**하다. 외포장 전용 경로는 없다.

**구독 ①: 품목 마스터**
`collection(db, 'days', date, 'items')` → `Item[]`.
`useEffect(() => onSnapshot(...))` 형태로 unsubscribe 를 그대로 반환. deps `[date]`.
- **`Machine.tsx` 와 다른 점: 정렬을 하지 않는다.** `Machine.tsx` 는 `list.sort(compareCode(a.code,b.code))` 를 하지만 여기는 안 한다. 어차피 조인용 Map 으로만 쓰므로 결과에 영향 없음. → **`ExternalPack.tsx` 는 `src/lib/codeUtil.ts` 를 import 하지 않는다.**
- 날짜가 바뀔 때 `setItems([])` 로 비우지 않는다(대시보드는 비운다). 날짜 전환 순간 이전 날짜 품목명이 잠깐 남는다.

**구독 ②: 이 호기의 entries (표의 행 소스)**
`collection(db, 'days', date, 'machines', machine, 'entries')` → `(MachineEntry & { docId: string })[]`.
문서 데이터에 `docId: d.id` 를 붙여 보관. deps `[date, machine]`.

정렬 규칙(호기 입력과 문자 그대로 동일):
- `ta = a.workTime || a.additionalWorkTime || ''`, `tb` 도 동일.
- 1차: `tb.localeCompare(ta)` → **시각 문자열 내림차순**(최근 작업이 위). `'HH:MM'` 문자열 비교라 사전순 = 시간순이 성립.
- 2차 tie-break: `b.docId.localeCompare(a.docId)` → **docId 내림차순**. 주석은 "같은 분 → 나중에 만든 doc(=docId 큼)이 위"라고 하지만, Firestore auto-ID 는 랜덤 20자라 실제로 시간순을 보장하지 않는다. **그래도 코드 그대로 재현할 것**(같은 분 입력의 순서는 결정적이되 시간순은 아님).
- `workTime` 도 `additionalWorkTime` 도 없는 문서는 `''` 가 되어 맨 아래로 몰린다.

**구독 ③(×3): 전 호기 합산 수량**
파일 상단 상수 `const MACHINES = ['1호기','2호기','3호기'] as const;`
`MACHINES.map(m => onSnapshot(collection(db, 'days', date, 'machines', m, 'entries'), ...))` 세 개를 동시에 건다. deps `[date]`, cleanup 은 `unsubs.forEach(u => u())`.
- effect 시작 시 `setAllMachineQty({ '1호기': {}, '2호기': {}, '3호기': {} })` 로 **먼저 초기화**한다(날짜 바뀔 때 구데이터 잔상 방지 — items/entries 는 안 하는데 이것만 한다).
- 각 스냅샷마다 코드별 맵을 새로 만든다:
  - 키 정규화: `String(e.code || '').toLowerCase()` — **소문자 변환만.** `normalizeCode()` 처럼 하이픈·공백을 지우지 **않는다**.
  - 값: `(e.actualProduction || 0) + (e.additionalProduction || 0)` 를 같은 키에 누적.
- 상태 갱신은 `setAllMachineQty(prev => ({ ...prev, [m]: map }))` — 호기별 슬롯 통째 교체.
- 결과 shape: `Record<'1호기'|'2호기'|'3호기', Record<codeLower, qty>>`.

**주의:** 현재 호기의 entries 컬렉션은 ②와 ③에서 **두 번 구독**된다(같은 경로에 리스너 2개). 의도된 구조이며 그대로 두면 된다.

**파생값 `combinedByCode`** (`useMemo`, deps `[allMachineQty]`): 세 호기 맵을 코드 키로 합산한 `Record<codeLower, number>`.

### 4. 행 계산 (`rows`, `useMemo`, deps `[items, entries, combinedByCode]`)

**4-1. 조인**
`itemMap = new Map(items.map(i => [i.code.toLowerCase(), i]))`.
행마다 `itemMap.get(e.code.toLowerCase())` 로 품목을 찾는다. **여기도 `toLowerCase()` 만.** 매칭 실패 시 `item` 은 `undefined` → 품목명 `''`, 주문수량 `0`, 발주량 `0`.

**4-2. 중복 생산 판정**
- `entryCountByCode`: **이 호기 entries 안에서** 코드(소문자)별 행 개수.
- `sameMulti` = `(entryCountByCode[code] || 1) > 1` — 같은 호기에서 같은 코드를 2번 이상 입력.
- `crossMachine` = `MACHINES.filter(m => (allMachineQty[m][code] || 0) > 0).length > 1` — **수량이 0보다 큰** 호기가 2개 이상. (수량 0인 entry 만 있는 호기는 안 센다.)
- `multiEntry = sameMulti || crossMachine`.

**4-3. 표시값**
- `orderQty` = `item?.orderQty || 0` → 컬럼 `주문수량`
- `shipped` = `item?.totalQty || 0` → 컬럼 **`발주량`** (대시보드는 같은 `totalQty` 를 `총수량` 이라고 부른다. 화면마다 라벨이 다르니 문구 그대로 지킬 것)
- `actual` = `e.actualProduction || 0` → 컬럼 `실제 생산량` (**그 행 자기 값**, 합산 아님)
- `additional` = `e.additionalProduction || 0` → 컬럼 `추가 생산량` (**그 행 자기 값**)
- `combined` = `combinedByCode[code] || 0` (전 호기 × 실제+추가 합산)
- **`combinedDiff = combined − totalQty`** → 컬럼 `모자란 수량`

`combinedDiff` 는 **행 단위가 아니라 코드 단위** 값이다. 같은 코드 행이 여러 개면 **모두 같은 숫자**가 찍힌다(각 행의 부족분이 아님). 컬럼 이름은 "모자란 수량"이지만 초과일 때도 그 값을 보여준다.

**4-4. 행 배경색 (호기 입력과 규칙이 완전히 다르다)**
`totalQty > 0` 일 때만 색을 칠한다. `totalQty === 0` 이면 항상 무색.
우선순위 순서대로:
1. `combined < totalQty` → **`bg-red-200`** (합산해도 부족)
2. else if `multiEntry` → **`bg-green-200`** (재생산으로 맞춤/초과)
3. else if `combined > totalQty` → **`bg-yellow-200`** (단일 생산인데 초과)
4. 그 외(`combined === totalQty` && 단일 생산) → 색 없음(흰색)

(참고로 `Machine.tsx` 의 행 색은 `목표+100 이상 → bg-red-300`, `부족 → bg-rose-100` 으로 완전히 다른 체계다. 섞지 말 것.)

**4-5. React key**
`key: \`${e.code}-${idx}\`` — **docId 가 아니라 인덱스 기반**이다(`Machine.tsx` 는 `e.docId` 사용). 그대로 재현.

`rows` 의 deps 에 `allMachineQty` 가 빠져 있지만(`crossMachine` 계산에 쓰임) `combinedByCode` 가 `allMachineQty` 에서 파생되므로 함께 갱신되어 문제가 되지 않는다.

### 5. 화면 구성

루트: `<div className="space-y-4">`. 크게 **헤더 줄 1개 + 표 1개**, 끝.

**5-1. 헤더 줄** — `flex items-center gap-3 flex-wrap`, 왼쪽부터:

1. `<h2 className="text-xl font-bold">외포장-{id}</h2>` — **`외포장-1` 처럼 URL 의 id 를 그대로 붙인다.** (`Machine.tsx` 는 `{machine} 입력` = `1호기 입력`)
2. 날짜 입력: `<input type="date">`, `className="border rounded px-2 py-1 text-sm"`, `onChange` 로 `setDate`.
3. `!isToday` 일 때만 **`오늘로`** 버튼: `px-3 py-1 text-xs rounded bg-blue-100 text-blue-700 font-medium hover:bg-blue-200`. 클릭 시 `setDate(today)`.
4. `!isToday` 일 때만 경고: `<span className="text-xs text-orange-600 font-medium">⚠ 과거 날짜 보는 중</span>`
   → **`Machine.tsx` 는 `⚠ 과거 날짜에 입력 중`.** 문구가 다르다(읽기 전용이므로 "보는 중").
5. **실시간 시계** — 호기 입력에는 없는 요소.
   - 별도 `useState(new Date())` + 1초(`1000`)마다 `setNow(new Date())` 인터벌, deps `[]`, cleanup `clearInterval`. **Firestore 비용 없음(클라이언트 시각)**.
   - `<span className="ml-auto text-3xl font-mono font-bold text-gray-800 tabular-nums" aria-label="현재 시각">` 안에 `🕐 {시각}`.
   - 시각 포맷: `now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })` — **초 없음, 24시간제.**
   - `ml-auto` 가 붙어 있어 이 시계부터 오른쪽으로 밀린다.
6. **표 글자 크기 조절기** — 호기 입력에는 없는 요소.
   - 컨테이너 `flex items-center gap-1 border rounded px-1 py-0.5 bg-white`, `title="이 기기에서만 적용됩니다"`.
   - 버튼 `A−` (**U+2212 MINUS SIGN**, 하이픈 아님) / 표시 `{fontSize}px` / 버튼 `A+` / 리셋 `↺` (U+21BA).
   - `A−`: `px-2.5 py-1 text-sm rounded hover:bg-gray-100 font-bold disabled:text-gray-300`, `disabled={fontSize <= FONT_MIN}`, `aria-label="글자 작게"`.
   - `A+`: 같은 클래스, `disabled={fontSize >= FONT_MAX}`, `aria-label="글자 크게"`.
   - 크기 라벨: `text-xs text-gray-500 min-w-[36px] text-center`.
   - `↺`: `px-2 py-1 text-xs rounded hover:bg-gray-100 text-gray-500`, `aria-label="기본 크기"`, `title="기본 크기로"`, 클릭 시 `setFontSize(FONT_DEFAULT)`.

**5-2. 글자 크기 상수·파생값 (정확히)**
- localStorage 키: **`'extPackTableFontSize'`**
- `FONT_MIN = 12`, `FONT_MAX = 72`, `FONT_DEFAULT = 18`, `FONT_STEP = 2`
- 초기값: `const v = Number(localStorage.getItem(FONT_KEY)); return v >= FONT_MIN && v <= FONT_MAX ? v : FONT_DEFAULT;`
  → 값 없음이면 `Number(null) === 0` → 범위 밖 → 18. 쓰레기값이면 `NaN` → 비교 false → 18.
- `useEffect(() => localStorage.setItem(FONT_KEY, String(fontSize)), [fontSize])`
- `codeSize = fontSize + 6` (코드 컬럼만 6px 더 큼)
- `cellPadY = Math.max(8, Math.round(fontSize * 0.5))`
- `cellPadX = Math.max(8, Math.round(fontSize * 0.45))`
- `cellStyle` (인라인 style): `{ fontSize, paddingTop: cellPadY, paddingBottom: cellPadY, paddingLeft: cellPadX, paddingRight: cellPadX, verticalAlign: 'middle', lineHeight: 1.2, whiteSpace: 'nowrap' }`
- `codeStyle`: `cellStyle` 과 동일하되 `fontSize: codeSize`.
- 이 스타일은 **`<td>` 에만** 적용된다. `<th>` 는 `p-2 text-xs` 고정이라 커지지 않는다.

**5-3. 표**
- 스크롤 박스: `<div className="bg-white border rounded-lg overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>`
- `<table className="w-full text-sm">`
- `<thead className="text-xs text-slate-600">`, 각 `<th>` 에 **`sticky top-0 z-10 bg-slate-100`** (세로 스크롤 시 헤더 고정).
- 컬럼 7개, 순서와 문구 그대로:

| # | 헤더 문구 | th 클래스 | 정렬 |
|---|---|---|---|
| 1 | `코드` | `p-2 text-left sticky top-0 z-10 bg-slate-100 whitespace-nowrap` | 왼쪽 |
| 2 | `품목명` | `p-2 text-left sticky top-0 z-10 bg-slate-100` (nowrap 없음) | 왼쪽 |
| 3 | `주문수량` | `p-2 text-right … whitespace-nowrap` | 오른쪽 |
| 4 | `발주량` | 〃 | 오른쪽 |
| 5 | `실제 생산량` | 〃 | 오른쪽 |
| 6 | `모자란 수량` | 〃 | 오른쪽 |
| 7 | `추가 생산량` | 〃 | 오른쪽 |

- `<tr className={\`border-t border-gray-400 ${r.bg}\`}>` — 행 구분선은 **`border-gray-400`** (진한 회색).
- 셀 렌더링:
  1. 코드: `className="font-mono font-bold"` + `style={codeStyle}`, 값은 `r.code` **원문 그대로**(대소문자 변환 안 함).
  2. 품목명: `style={cellStyle}`, `r.name`(없으면 빈칸).
  3. 주문수량: `className="text-right font-bold"`, **`{r.orderQty}`** — 0이면 **`0` 이 그대로 찍힌다.**
  4. 발주량: `className="text-right"`, **`{r.shipped}`** — 0이면 **`0` 이 그대로 찍힌다.**
  5. 실제 생산량: `className="text-right"`, **`{r.actual || ''}`** — 0이면 **빈칸.**
  6. 모자란 수량: `className={\`text-right font-bold ${diffColor}\`}`
     - `diffColor`: `combinedDiff > 0` → `text-green-700`, `< 0` → `text-red-700`, `=== 0` → `''`
     - 표시값: `r.combinedDiff > 0 ? \`+${r.combinedDiff}\` : r.combinedDiff || ''`
       → 양수는 **`+30`** 처럼 플러스 붙여 초록, 음수는 **`-30`** 그대로 빨강, 0은 **빈칸.**
  7. 추가 생산량: `className="text-right"`, `r.additional > 0 ? r.additional : ''` — 0 또는 음수면 빈칸.
- **빈 상태**: `rows.length === 0` 이면
  `<tr><td colSpan={7} className="p-6 text-center text-slate-400">{machine}에서 입력된 내역이 없습니다</td></tr>`
  → 문구에 들어가는 것은 **`machine`(= `1호기`)** 이지 `외포장-1` 이 아니다. 제목은 `외포장-1`, 빈 문구는 `1호기에서 입력된 내역이 없습니다` 로 서로 다르게 나온다. 그대로 재현할 것.
  (호기 입력의 빈 문구는 `아직 입력 내역이 없습니다` 로 또 다르다.)

### 6. 입력 흐름 · 수정 · 삭제

**없다.** 다시 확인:
- 새 기록을 만드는 방법 없음.
- 수량을 고치는 방법 없음(셀은 그냥 텍스트, 클릭 핸들러 없음).
- 기록을 지우는 방법 없음.
- 정렬 바꾸기, 필터, 검색, 페이지네이션 없음.
- 낙관적 갱신(optimistic update) 개념 자체가 없다 — 모든 값은 `onSnapshot` 이 밀어주는 서버 상태 그대로다.

사용자가 이 화면에서 바꿀 수 있는 것은 **① 조회 날짜(다른 탭과 공유되는 localStorage `viewDate`)**, **② 표 글자 크기(이 브라우저 전용 localStorage `extPackTableFontSize`)** 두 가지뿐이다.

**실제 데이터 입력은 같은 호기 번호의 `/machine/:id` 화면에서 이뤄지고**, 경로가 같으므로 그쪽에서 등록/수정/삭제하면 이 화면에 실시간으로 즉시 반영된다.

### 7. 호기 입력(`Machine.tsx`)과의 대조표

**그대로 베낀 부분 (문자 단위로 동일하게 재현할 것)**
- `useParams()` → `` `${id}호기` `` 로 호기명 조립
- 날짜 state 4종 세트(`loadViewDate` 초기값, `saveViewDate` 이펙트, `todayKey` 비교, 60초 `effectiveTodayKey` 롤오버)
- `days/{date}/items` 구독
- `days/{date}/machines/{machine}/entries` 구독 + `docId` 부착 + 시각 내림차순/docId 내림차순 정렬
- 3개 호기 entries 병렬 구독 → `allMachineQty` → `combinedByCode` 합산 (코드 키 `toLowerCase()`, 값 `actual+additional`)
- 헤더 줄의 날짜 input / `오늘로` 버튼 / 과거날짜 경고 배지 배치와 클래스

**달라진 부분**
| 항목 | 호기 입력 (`/machine/:id`) | 외포장 (`/external/:id`) |
|---|---|---|
| 성격 | 입력 + 내역 | **읽기 전용 현황판** |
| Firestore 쓰기 | `addDoc`/`updateDoc`/`deleteDoc` | **없음** |
| 제목 | `1호기 입력` | `외포장-1` |
| 과거 날짜 배지 | `⚠ 과거 날짜에 입력 중` | `⚠ 과거 날짜 보는 중` |
| 검색·코드 선택 카드 | 있음(상위 30개, 미달 코드만, `추가 N개 필요` 배지) | **없음** |
| 추가 생산 체크박스·±버튼·등록 버튼 | 있음 | **없음** |
| 실시간 시계 | 없음 | **있음**(1초, 초 미표시) |
| 글자 크기 조절 | 없음 | **있음**(`extPackTableFontSize`) |
| `codeUtil` import | `compareCode` 사용 | **사용 안 함** |
| items 정렬 | `compareCode` 로 정렬 | 정렬 안 함 |
| 표 컬럼 | 코드/실제 생산량/추가 생산량/작업 시간/추가 작업 시간/(삭제) 6개 | 코드/품목명/주문수량/발주량/실제 생산량/모자란 수량/추가 생산량 **7개** |
| 작업시간 표시 | 있음 | **없음**(정렬에만 쓰임) |
| 행 배경 규칙 | `목표+100↑ → bg-red-300`, `부족 → bg-rose-100` | `부족 → bg-red-200`, `multiEntry → bg-green-200`, `단일초과 → bg-yellow-200` |
| 헤더 고정 | 없음 | `sticky top-0 z-10` + `maxHeight: calc(100vh - 200px)` |
| React key | `e.docId` | `` `${e.code}-${idx}` `` |
| 범례 박스 | 있음(목표 미달 / 목표+100↑) | **없음** |
| 건수 표시 | `오늘 입력 내역 (N)` | **없음** |

### 8. 다른 화면과의 연결

**아웃바운드(외포장 → 다른 곳): 없다.** 이 화면은 아무것도 쓰지 않으므로, 여기서 한 행동이 대시보드·분석·월별집계에 영향을 주는 경로가 존재하지 않는다. 유일한 부수효과는 localStorage `viewDate` 를 갱신해서 **대시보드·호기 입력의 조회 날짜가 따라 바뀌는 것**뿐이다(같은 키를 공유하며, `chosenOn === todayKey()` 조건 하에 당일에만 유지).

**인바운드(다른 곳 → 외포장):**
- `days/{date}/items` — `Dashboard.tsx` 의 붙여넣기 업로드(`writeBatch` → `doc(db,'days',viewDate,'items',code)`) 또는 `Import.tsx` 의 엑셀 업로드로 채워진다. 여기서 `orderQty`(주문수량)·`totalQty`(총수량 = 이 화면의 `발주량`)·`name` 이 온다.
- `days/{date}/machines/{1|2|3}호기/entries` — `Machine.tsx` 등록/수정/삭제, 또는 `Import.tsx` 엑셀 이관으로 채워진다.

**대시보드와의 관계:** 대시보드(`Dashboard.tsx`)도 같은 세 호기 entries 를 구독해 `actualByCode` 를 만들고, 코드 키 정규화도 동일하게 `toLowerCase()` 만 쓴다. 그래서 **대시보드 "실제 생산량" 과 외포장의 `combined` 는 같은 수치**다. 단 대시보드는 `days/{date}/logistics` 가 있으면 그 값으로 표시를 덮어쓰는 규칙(`displayActual = totalQty + logQty`)이 추가로 있는데, **외포장 화면은 `logistics` 를 전혀 구독하지 않는다.** 따라서 잔여량 보정이 들어간 날에는 **대시보드와 외포장 화면의 숫자가 서로 다르게 보인다**(외포장은 항상 entries 원본 합산).

월별 집계(`src/lib/monthlyProduction.ts`), 완료 알림(`completionAlert.ts`), 생산 알림(`productionNotify.ts`), DB 백업(`dbBackup.ts`) 어디에도 외포장 전용 데이터는 등장하지 않는다.

---

# 7부 — 연결 부속 (실온 입력·알림·백업)

## 연결 부속 — 실온(외주) 입력 · 알림 · 백업

이 문서는 "현황(대시보드)"과 "입력(1·2·3호기, 외포장)" 본체가 아니라, 그 주변에 붙어서 **데이터를 채워 넣거나(실온·잔여량 입력), 상태를 밖으로 알리거나(완료 알림·Gmail 알림), 통째로 빼내는(DB 백업)** 부속 기능을 다룬다.

---

### 0. 부속 지도 — 무엇이 어디서 열리는가

| 부속 | 파일 | 진입점 | 저장 위치 |
|---|---|---|---|
| 실온 생산량 입력 모달 | `src/components/AmbientInputModal.tsx` | `/analytics/monthly` (월별 분석) 상단 우측 주황 버튼 **실온 입력** | `days/{YYYY-MM-DD}/ambient/{제품명}` |
| 잔여량(물류) 입력 모달 | `src/components/LogisticsInputModal.tsx` | `/analytics/monthly` 상단 우측 장미색 버튼 **잔여량 수정** | `days/{YYYY-MM-DD}/logistics/{표준코드}` |
| 생산 완료 알림(기기 로컬) | `src/lib/completionAlert.ts` | 헤더 네비의 **현황** 버튼을 5초 롱프레스 | `localStorage` (Firestore 아님) |
| 생산 완료 Gmail 알림 | `src/lib/productionNotify.ts` (타입 전용) + `ProductSettings` 패널 | `/analytics/settings` → 📧 **생산완료 알림 (Gmail)** 섹션 | `appMeta/notifySettings`, 신호는 `appMeta/dailyProgress` · `appMeta/scoopProgress` |
| DB 백업 | `src/lib/dbBackup.ts` + `src/lib/pgSqlGen.mjs` | `/analytics/settings` → 💾 **DB 백업** 섹션 | 저장 없음(읽기 전용), `.sql` 파일 다운로드 |

두 입력 모달은 **모두 `/analytics/*` 라우트 안에만 존재**한다. `/analytics/*` 는 `AnalyticsGate` 로 감싸여 있고, 게이트는 `settings/analyticsAuth` 문서의 `password` 필드와 입력값을 문자열 일치 비교한다. 통과하면 `localStorage['analyticsAuthedAt'] = Date.now()` 를 저장하고 **12시간(43,200,000ms)** 동안 유효하다. `password` 가 빈 문자열이면 게이트는 무조건 통과시킨다. 즉 **실온·잔여량 입력은 분석 비밀번호를 아는 사람만** 할 수 있고, 현장 태블릿(호기 입력 화면)에서는 열 수 없다.

두 모달 모두 `open` 이 `false` 면 `null` 을 반환해 DOM 자체가 없다. 공통 모달 골격은 `fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4` + 내부 카드 `bg-white rounded-xl shadow-2xl w-full h-[90vh] overflow-hidden flex flex-col` (실온 `max-w-4xl`, 잔여량 `max-w-3xl`).

**`defaultDate` 계산(부모 쪽)**: 월별 분석 페이지에서 `const today = todayKey(); const defaultModalDate = today.startsWith(month) ? today : `${month}-01`;` — 보고 있는 달이 이번 달이면 오늘, 과거 달이면 그 달 1일. 두 모달에 같은 값을 넘긴다.

---

### 1. 실온(ambient) 입력 모달 — `AmbientInputModal`

#### 1.1 역할

냉장 이유식은 1·2·3호기 + 외포장에서 실시간으로 입력되지만, **실온 이유식은 외주 생산**이라 공장 안에 입력 단말이 없다. 그래서 월별 분석 화면에서 담당자가 **품목 × 수량(EA)** 만 사후 등록한다. 호기·시간·작업자·설비 개념이 전혀 없다.

#### 1.2 모달 상단 (양쪽 뷰 공통)

- 헤더 배경: `bg-gradient-to-r from-orange-50 to-amber-50`
- 제목 **"실온 생산량 입력"**, 부제 **"제품 카테고리는 자동으로 분류됩니다"**
- 우측 세그먼트 토글 2개: **"📅 일별 입력"** / **"🗓️ 월별 보기"**. 선택된 쪽은 `bg-orange-500 text-white`, 나머지는 흰 배경 회색 글자.
- 맨 우측 원형 `×` 닫기 버튼 (`aria-label="닫기"`)
- 모달이 열릴 때마다(`open` 이 true 로 바뀔 때) `date` 를 `defaultDate` 로 리셋하고 `view` 를 `'day'` 로 되돌린다.

#### 1.3 마스터 데이터 (`src/lib/ambientProducts.ts`)

카테고리는 4종, 순서 고정: `['TOGO', '본죽키즈', '순수본', '영양밥']`.

제품 28종(이름이 그대로 ID이자 표시명):
```
TOGO_한우참깨애호박죽, TOGO_한우야채진밥,
본죽키즈_모둠야채죽, 본죽키즈_영양닭죽, 본죽키즈_튼튼전복죽, 본죽키즈_한우야채죽,
순수본_한우참깨애호박죽, 순수본_닭고기버섯죽, 순수본_한우야채진밥, 순수본_닭고기양송이진밥,
순수본_한우과일죽, 순수본_닭고기애호박미역죽, 순수본_한우불고기진밥, 순수본_닭고기알밤진밥,
순수본_한우뿌리채소죽, 순수본_찹쌀누룽지닭죽, 순수본_한우버섯무죽, 순수본_오트밀버섯전복죽,
순수본_한우사골진밥, 순수본_전복영양진밥, 순수본_흰살생선채소죽, 순수본_퀴노아미역전복죽,
순수본_게살보리진밥, 순수본_가리비치즈진밥, 순수본_한우치즈영양밥, 순수본_닭살들깨버섯영양밥,
순수본_전복버터영양밥, 순수본_미트카레영양밥
```

**카테고리 자동 분류 `categorize(name)` — 판정 순서가 중요**:
1. `TOGO_` 로 시작 → `'TOGO'`
2. `본죽키즈_` 로 시작 → `'본죽키즈'`
3. `영양밥` 으로 **끝남** → `'영양밥'`
4. 그 외 전부 → `'순수본'`

→ `순수본_한우치즈영양밥`, `순수본_닭살들깨버섯영양밥`, `순수본_전복버터영양밥`, `순수본_미트카레영양밥` 4종은 이름이 `순수본_` 으로 시작해도 **카테고리는 `영양밥`** 이다. 3번 규칙이 4번보다 먼저다.

**카테고리 색상 `CATEGORY_STYLES`** (Tailwind 클래스 그대로):

| 카테고리 | chip(점) | soft(배경) | text | border |
|---|---|---|---|---|
| TOGO | `bg-blue-500` | `bg-blue-50` | `text-blue-700` | `border-blue-200` |
| 본죽키즈 | `bg-amber-500` | `bg-amber-50` | `text-amber-700` | `border-amber-200` |
| 순수본 | `bg-emerald-500` | `bg-emerald-50` | `text-emerald-700` | `border-emerald-200` |
| 영양밥 | `bg-sky-500` | `bg-sky-50` | `text-sky-700` | `border-sky-200` |

**`productSlug(name)` 는 항등 함수**다 — 제품명을 그대로 Firestore 문서 ID 로 쓴다(한글·언더스코어 허용). 별도 slug 변환 없음.

**`looseKey(s)`**: 소문자화 + 공백/언더스코어/하이픈 제거 (`/[\s_\-]/g`). 실온 ERP 코드 매칭(`findAmbientErp`)에만 쓰이고, 이 모달의 저장 경로에는 쓰이지 않는다. `AMBIENT_ERP` 는 `SSB55120014` 형태 코드 32건의 마스터로, ERP 등록명(`순수본-한우야채진밥`, `togo-한우참깨애호박죽`, `본죽키즈 영양닭죽` 등 구분자가 제각각)을 `looseKey` 로 정규화해 앱 내부명과 이어준다.

#### 1.4 저장 스키마

경로 `days/{date}/ambient/{제품명}`, 문서 필드 4개 (`AmbientEntry`):
- `productName: string` — 제품명(문서 ID 와 동일)
- `category: string` — `AMBIENT_PRODUCTS` 에서 찾은 카테고리
- `qty: number` — EA
- `date: string` — `YYYY-MM-DD` (문서 경로와 중복이지만 **collectionGroup 쿼리용으로 반드시 저장**)

모든 쓰기는 `setDoc` **전체 덮어쓰기**(merge 아님). 즉 하루·제품당 문서 1개, 입력 회차 개념이 없다.

#### 1.5 일별 입력 뷰 (`view === 'day'`)

**구독**: `onSnapshot(collection(db, 'days', date, 'ambient'))` — `open && view === 'day'` 일 때만 걸고, `[open, view, date]` 가 바뀌면 해제 후 재구독. 목록은 `productName.localeCompare` 오름차순.

**상단 바 (한 줄, `flex-wrap`)**
- 라벨 "날짜" + `<input type="date">` (빈 값으로는 바뀌지 않음 — `e.target.value &&` 가드)
- 검색창 placeholder **"🔍 품목 검색..."**, 포커스 링 `focus:ring-orange-300`, 값이 있으면 우측에 `×` 지우기 버튼
- 우측 요약: `{entries.length}개 품목 / 총 {합계}` + **" EA"**, 합계는 주황 굵게(`text-orange-600`), `toLocaleString()` 로 천단위 콤마

**기 입력 내역 표** — `entries.length > 0` 일 때만 렌더. 헤더 줄 **"기 입력 내역"** (`bg-slate-50`). 각 행: 카테고리 색 점(`w-2 h-2 rounded-full`) → 회색 작은 글씨로 카테고리명 → 굵은 제품명 → 우측 정렬 `{qty} EA` (`text-orange-700` 굵게) → 맨 오른쪽 빨간 **"삭제"** 링크. 삭제는 `confirm("'{제품명}' 기록을 삭제할까요?")` 후 `deleteDoc`. 
카테고리가 비어 있으면 `'순수본'` 으로 보정해 스타일을 고른다.

**제품 선택 그리드** — 소제목 "제품 선택". 카테고리 순서대로 4블록. 각 블록 머리에 색 점 + 카테고리명 + `({표시개수})`, 검색 중이면 `({표시개수} / {전체개수})`. 버튼 그리드는 `grid-cols-2 md:grid-cols-3`.
- 버튼 라벨은 제품명에서 `"{카테고리}_"` 를 먼저 지우고 다시 `"순수본_"` 를 지운 문자열. → `영양밥` 카테고리 제품은 1차 치환(`영양밥_`)이 안 먹고 2차(`순수본_`)가 먹어서 `한우치즈영양밥` 처럼 나온다.
- 선택된 버튼: `bg-orange-500 text-white border-orange-500 shadow`. 비선택: 카테고리 soft/text/border 조합 + `hover:brightness-95`.
- 이미 그 날짜에 입력된 제품이면(선택 상태가 아닐 때) 버튼 아래에 작은 회색 글씨 **"기 입력"**.
- 검색 필터는 `p.name.toLowerCase().includes(search.toLowerCase())` (원본 전체 이름 기준 — `순수본_` 을 포함해 검색된다). 결과가 0인 카테고리 블록은 통째로 숨기고, 모든 카테고리가 0이면 중앙에 회색 **"'{검색어}' 검색 결과가 없습니다"** (`py-8`).

**하단 고정 바 (`bg-slate-50`)**
- 선택 전: 회색 **"위에서 제품을 선택하세요"**
- 선택 후: `선택:` + 굵은 제품명, 우측에 `−` / 숫자입력 / `+` / **추가** 버튼.
  - `−` 는 `Math.max(0, qty - 10)`, `+` 는 `qty + 10` → **10 단위 스테퍼**, 0 아래로 안 내려감.
  - 숫자 입력은 `value={qty || ''}` 라 0이면 빈칸으로 보이고 placeholder **"수량"** 이 뜬다.
  - 저장 버튼 라벨은 평소 **"추가"**, 저장 중 **"저장중..."**. `qty <= 0 || saving` 이면 비활성(`disabled:bg-gray-300`).
- 항상 맨 오른쪽에 **"닫기"** 버튼.

**저장 동작 `save()` — 누적(더하기)이다**
1. `selected` 없거나 `qty <= 0` 이면 무시.
2. `AMBIENT_PRODUCTS` 에서 제품을 찾지 못하면 조용히 중단(단 `saving` 은 `finally` 에서 해제).
3. 같은 날짜에 같은 `productName` 문서가 이미 있으면 `newQty = 기존 qty + 입력 qty`. 없으면 입력값 그대로.
4. `setDoc(days/{date}/ambient/{제품명}, {productName, category, qty: newQty, date})`.
5. 성공 후 `qty = 0`, `selected = null` (선택 해제). 실패해도 `saving` 만 풀린다 — **에러 토스트·alert 없음**.

#### 1.6 월별 보기 뷰 (`view === 'month'`) — `MonthView`

일별 뷰와 달리 **그 달 전체를 한 화면에서 수정/삭제/추가**한다. 초기 `month` 는 `date.slice(0, 7)`.

**구독**: `collectionGroup(db, 'ambient')` 에 `where('date', '>=', `${month}-01`)`, `where('date', '<=', `${month}-31`)`. 스냅샷에서 다시 한 번 `!data.date || data.date < start || data.date > end` 인 문서를 버린다(방어). `[month]` 만 의존 — 모달 open 여부와 무관하게 뷰가 마운트돼 있으면 구독한다.

**상단 바**: 라벨 "기준월" + `<input type="month">` (굵게), 검색창(일별과 같은 문구/색), 우측 요약 `{날짜그룹수}일 / 총 {월합계} EA`.

**빠른 추가 바** (`bg-orange-50 border-orange-200 rounded-lg`)
- 머리 글자 **"+ 추가:"** (주황 굵게)
- 날짜 `<input type="date">` — `min={month}-01`, `max={month}-31`. `month` 가 바뀌면 `useEffect` 로 `{month}-01` 로 리셋된다.
- 제품 **자동완성** 입력: placeholder **"제품명 입력…"**. 입력할 때마다 `addProduct` 를 비우고 후보 목록을 연다. 후보는 `AMBIENT_PRODUCTS` 중 `name.toLowerCase().includes(입력어)` 를 **최대 12개**(`slice(0, 12)`). 입력어가 공백뿐이면 후보 없음.
  - 후보 드롭다운: `absolute z-20 ... w-64 max-h-60 overflow-y-auto bg-white border rounded-lg shadow-lg`, 각 행은 카테고리 색 점 + 회색 카테고리명 + 접두사 제거한 제품명, `hover:bg-orange-50`.
  - 후보 클릭은 `onMouseDown` + `preventDefault()` 로 처리한다 — `onBlur` 가 먼저 터져 목록이 닫히는 것을 막기 위함. `onBlur` 자체도 `setTimeout(..., 150)` 으로 지연해 닫는다.
  - 선택하면 입력칸 텍스트는 접두사를 지운 짧은 이름으로 바뀌고, 입력칸 아래에 작은 초록 글씨 **"✓ 선택됨"** 이 뜬다. 실제 저장에는 `addProduct`(전체 이름)를 쓴다.
- 수량 `<input type="number">` placeholder **"수량(EA)"**, 우측 정렬
- **추가** 버튼 — `!addProduct || addQty <= 0` 이면 비활성
- 안내 문구: **"같은 날·같은 제품이 있으면 이 값으로 덮어씁니다."**

**빠른 추가 `quickAdd()` — 절대값 덮어쓰기**다. 일별 뷰의 누적과 정반대. 성공 후 `addQty=0`, `addProduct=''`, `addQuery=''` 로 비우지만 `addDate` 는 유지한다(같은 날 연속 입력 편의).

**날짜별 섹션**
- 그룹핑: 검색어가 있으면 `productName` 부분일치로 먼저 거른 뒤 `date` 별로 묶는다. 날짜 오름차순(`localeCompare`), 그룹 내부는 `productName.localeCompare`.
- 섹션 헤더(`bg-slate-100`): 왼쪽에 `{M}/{D} ({요일})` — 요일은 `['일','월','화','수','목','금','토']` 를 `new Date(y, m-1, d).getDay()` 로 인덱싱. 오른쪽에 `{n}품목 · {합계} EA` (합계 `text-orange-700` 굵게).
- 각 행: 색 점 + 카테고리명 + 제품명 / **수량 인라인 입력칸**(`w-24`, 우측정렬, `text-orange-700` 굵게) + `EA` / **삭제** 링크.
- 수량 입력칸은 비제어(`defaultValue`)이고 `key={docId}-{qty}` 를 줘서 **원격에서 값이 바뀌면 강제로 remount** 된다. 저장은 `onBlur` 에서만 일어나고, 값이 기존과 같으면 쓰지 않는다.
- `setQtyAbs`: 새 값이 **0 이하면 문서를 삭제**, 아니면 절대값으로 `setDoc`. 실패는 `.catch(() => {})` 로 묵살.
- 행 삭제: `confirm("[{날짜}] '{제품명}' 삭제할까요?")` 후 `deleteDoc`.
- 그 달 데이터가 없으면 중앙 회색 2줄: **"{YYYY-MM} 실온 입력 내역이 없습니다."** / **"위 "+ 추가"로 등록하세요."**

**월별 뷰 하단 바**: 왼쪽 안내 **"수량 칸을 직접 고치면 자동 저장됩니다. 0 으로 만들면 삭제됩니다."**, 오른쪽 **"닫기"**.

#### 1.7 실온이 냉장과 다른 점 (요약)

| | 냉장(1·2·3호기 / 외포장) | 실온(ambient) |
|---|---|---|
| 입력 주체 | 현장 태블릿, 실시간 | 분석 화면, 사후 일괄 |
| 계획(items) | `days/{date}/items` 계획 대비 실적 | **계획 개념 없음** — 실적만 등록 |
| 문서 키 | 제품 코드(`A-01` 등), 정규화 필요 | **제품명 그대로** (정규화 없음) |
| 문서 단위 | 호기별 `entries` 여러 건 누적 | 하루·제품당 **문서 1건** |
| 수량 필드 | `actualProduction` + `additionalProduction` | `qty` 하나 |
| 부가 정보 | 시간·작업자·비고·호기 | 없음 (카테고리만 자동 부여) |
| 삭제 | 엔트리 단위 | 문서 통삭제 |
| 현황(대시보드) 반영 | 반영됨 | **반영 안 됨** — 실온은 월별 분석에서만 합산 |

---

### 2. 잔여량(물류) 입력 모달 — `LogisticsInputModal`

#### 2.1 역할

하루 마감 시 물류팀 ERP 에서 실제 등록된 수량을 받아 `days/{date}/logistics` 에 넣는다. 이 컬렉션에 **문서가 하나라도 있으면 그 날은 "마감된 날"** 로 간주되어, 현황·월별 분석 전반의 계산 기준이 "생산 실적"에서 "물류 확정치"로 갈아탄다(자세한 파급은 4·6절 및 현황 사양 참조).

#### 2.2 UI

- 헤더 `bg-gradient-to-r from-rose-50 to-pink-50`, 제목 **"잔여량 입력 (물류)"**, 부제 **"ERP에서 복사한 표를 그대로 붙여넣기 하세요"**, 우측 `×`.
- 상단 줄: 라벨 "날짜" + `<input type="date">`, 우측에 `현재 등록: {n}개 품목 / 총 {합계} EA` (합계 `text-rose-600` 굵게).
- **기존 등록 내역** — `existingCount > 0` 일 때만. 회색 헤더 좌측에 `{date} 기존 등록 내역`, 우측에 빨간 **"전체 삭제"** 링크. 목록 영역은 `max-h-48 overflow-y-auto`, 각 행은 `font-mono` 코드 + 우측 `{qty} EA`(`text-rose-700` 굵게). 정렬은 **코드 `localeCompare` 오름차순**.
- **ERP 데이터 붙여넣기** — 라벨 그대로, `textarea h-56 font-mono`, placeholder **"ERP의 '제품코드' '등록수량' 열이 있는 표 전체를 복사 후 여기에 붙여넣기..."**.
  안내 2줄: `· 헤더에 '제품코드'와 '등록수량'이 포함되어야 합니다` / `· 코드는 자동으로 변환됩니다 (예: A-001-01 → A-01, F-528-01 → F-528)`
- 하단 바: 왼쪽 **"취소"**(= 닫기와 동일), 오른쪽 **"저장"**(저장 중 **"저장중..."**). `!pasteText.trim() || saving` 이면 비활성.

#### 2.3 구독

`onSnapshot(collection(db, 'days', date, 'logistics'))` — `open` 일 때만, `[open, date]` 의존. 문서 ID → `qty` 맵으로 보관(`(d.data().qty as number) || 0`). **날짜를 바꿀 때 맵을 먼저 비우지 않는다** — 새 스냅샷이 도착하기 전까지 이전 날짜의 내역이 잠깐 그대로 보인다.

#### 2.4 붙여넣기 파싱 (`save()`)

1. `pasteText.trim()` 을 `\n` 으로 줄 분리, 각 줄을 `\t` 로 셀 분리. (엑셀/ERP 표 복사 = 탭 구분 전제. CSV·공백 구분은 지원 안 함)
2. **헤더 줄 탐색**: 어떤 셀이든 `trim()` 결과가 정확히 `'제품코드'` 인 첫 줄. 못 찾으면 `alert('제품코드 헤더를 찾을 수 없습니다')` 후 중단.
3. 그 줄의 각 셀을 `trim()` 한 배열에서 `indexOf('제품코드')`, `indexOf('등록수량')`. 둘 중 하나라도 없으면 `alert('제품코드 또는 등록수량 열을 찾을 수 없습니다')` 후 중단.
4. 헤더 **다음 줄부터 끝까지** 반복:
   - `erpCode = (셀 || '').trim()`, `qty = parseInt(셀 || '0', 10)`
   - `!erpCode || isNaN(qty) || qty < 0` 이면 그 줄은 건너뛴다. → **`qty === 0` 은 유효**하며 0으로 저장된다.
   - `ourCode = convertErpCode(erpCode)`
   - `batch.set(doc(db, 'days', date, 'logistics', ourCode), { code: ourCode, qty, erpCode })`
5. `batch.commit()` → 텍스트 비우고 `alert(`${date}\n${count}개 품목 물류 데이터 저장 완료`)`. **모달은 닫히지 않는다.**

**`convertErpCode(raw)` 정규화 규칙**
- 정규식 `^([A-Za-z])-(\d+)-\d+$` 에 맞을 때만 변환. 안 맞으면 `raw.trim()` 을 그대로 문서 ID 로 쓴다.
- 영문자는 **대문자화**, 가운데 숫자는 `parseInt(_, 10)` 후 `padStart(2, '0')`.
- 예: `A-001-01 → A-01`, `a-9-3 → A-09`, `F-528-01 → F-528` (이미 3자리라 패딩 안 붙음).

저장 문서 필드는 `code`(표준코드) · `qty` · `erpCode`(원본) 3개. `date` 필드는 **없다** (실온과 달리 collectionGroup 쿼리를 쓰지 않기 때문).

#### 2.5 전체 삭제

`existingCount === 0` 이면 아무 것도 안 함. 아니면 `confirm(`${date} 의 물류 데이터(${existingCount}개)를 삭제할까요?`)` 후, 현재 맵의 모든 키에 대해 `batch.delete` → commit. 컬렉션이 비면 그 날짜는 다시 "마감 전"으로 돌아간다.

#### 2.6 닫힐 때

`onClose` 는 부모(월별 분석)에서 `setLogisticsModalOpen(false)` **와 함께 `forceRefresh()`** 를 호출한다. `forceRefresh` 는 `clearCache('m:{month}')`, `clearCache('pm:{직전월}')` 후 `refreshTick` 증가 → 월별 집계 재조회. 실온 모달의 `onClose` 에는 `forceRefresh` 가 **없다**(실온은 `onSnapshot` 기반 구독이라 자동 반영되는 경로가 따로 있음).

#### 2.7 같은 로직의 다른 구현 — `Remaining.tsx`

`/remaining` (잔여량 페이지)에도 같은 목적의 붙여넣기 모달이 있고 `convertErpCode` 도 동일하지만 **파싱이 더 관대하고 더 정확하다**:
- 헤더 후보를 `제품코드` 외에 `ERP 품목코드` 까지 받고, 코드열·수량열이 **둘 다 있는** 줄을 헤더로 본다.
- 같은 표준코드가 여러 행으로 쪼개져 들어오면 **합산**한 뒤 한 번만 쓴다.
- 삭제 문구도 다르다: `'물류 데이터를 삭제하고 생산 기준으로 돌아갈까요?'`

`LogisticsInputModal` 은 합산을 하지 않으므로, 같은 코드가 두 줄이면 **마지막 줄 값이 이긴다**. 두 화면의 결과가 달라질 수 있는 지점이다.

---

### 3. 생산 완료 알림 (기기 로컬) — `completionAlert.ts`

#### 3.1 무엇을 감시하나

**오늘(`todayKey()`) 하루치 생산 진행률**만 감시한다. 과거 날짜는 보지 않는다.

`watchTodayProgress(onChange)` 가 거는 구독은 총 **5개**:
- `days/{today}/items`
- `days/{today}/machines/{m}/entries` — `m ∈ ['1호기', '2호기', '3호기']` (**외포장은 포함되지 않는다**)
- `days/{today}/logistics`

각 스냅샷마다 `emit()` 을 호출해 집계를 다시 계산한다. 모든 `onSnapshot` 에 빈 에러 콜백 `() => {}` 을 달아 권한/네트워크 오류를 묵살한다. 반환값은 5개 구독을 전부 해제하는 함수.

#### 3.2 진행률 계산 — 현황(Dashboard)과 같은 규칙

- `items` 는 `code` 가 빈 문자열이 아닌 것만 취하고 `{code, totalQty}` 로 축약.
- 호기 엔트리는 `code` 를 **소문자화만** 해서(`String(e.code||'').toLowerCase()`) `actualProduction + additionalProduction` 을 누적. 빈 코드는 무시. 세 호기 값을 코드별로 합산해 `actualByCode`.
- `logistics` 는 **문서 ID** 를 `.toLowerCase().replace(/[-\s]/g, '')` (하이픈·공백 제거)로 정규화한 키의 맵.
- `totalQty` = 모든 item 의 `totalQty` 합.
- `completedItems` = 아래 중 하나를 만족하는 item 수
  1. `logistics[코드정규화]` 가 `undefined` 가 아님 → 무조건 완료 (수량 0 이어도 완료)
  2. 아니면 `actualByCode[code.toLowerCase()] >= totalQty && totalQty > 0`
- `pct` = `Math.round( Σ min(produced, totalQty) / totalQty * 100 )`, `totalQty` 가 0 이면 0.
- **최종 `pct` 는 `hasLogistics ? 100 : pct`** — 물류 문서가 하나라도 있으면 진행률을 100으로 강제한다. 즉 잔여량을 입력하는 순간 완료 알림 조건이 성립한다.

> ⚠ 두 종류의 코드 키가 섞여 있다: 완료 판정의 logistics 조회는 **하이픈 제거 키**, 생산량 조회는 **소문자화만 한 키**. Dashboard 와 토씨까지 같은 (의도된) 동작이므로 그대로 재현해야 한다.

#### 3.3 발사 조건 `handleProgress(p)`

순서대로 하나라도 걸리면 발사하지 않는다.
1. `p.itemCount <= 0` 또는 `p.totalQty <= 0` → 오늘 계획이 아직 없음
2. `p.pct < 100`
3. `localStorage['completionAlert:notified'] === p.date` → **하루 1회 제한**

통과하면 먼저 `localStorage['completionAlert:notified'] = p.date` 를 기록하고(중복 방지 선기록) `fireNotification` 호출:
- 제목 **`'✅ 생산 완료'`**
- 본문 **`` `${date} 전 품목 생산이 완료되었습니다 (${completedItems}/${itemCount}품목 · ${totalQty.toLocaleString()}EA)` ``**
- tag **`` `ssbon-done-${date}` ``**

#### 3.4 켜고 끄기 — 헤더 "현황" 5초 롱프레스

`App.tsx` 의 `useLongPress(onLong, ms = 5000)` 훅:
- `onPointerDown` 에 타이머 시작 + `holding = true`, `onPointerUp / onPointerLeave / onPointerCancel` 에 취소.
- 5초를 채우면 `firedRef = true` 로 표시한 뒤 콜백 실행. 이어지는 `click` 은 `consumeClick` 이 `preventDefault + stopPropagation` 으로 **삼켜서 화면 이동을 막는다**.
- 누르는 동안 `onContextMenu` 를 막는다(모바일 길게누르기 메뉴 방지).
- 시각 피드백: PC 네비에서 `ring-2 ring-amber-300 scale-95`, 모바일 네비에서 `ring-2 ring-amber-300`.
- 이 핸들러는 **`section === 'dashboard'` 인 "현황" 링크에만** 붙는다. PC 링크의 `title` 은 `'5초 꾹 누르면 생산 완료 알림을 켜고 끌 수 있습니다'`.
- 알림이 켜져 있으면 "현황" 옆에 🔔 (PC 는 `<span title="생산 완료 알림 켜짐">`, 모바일은 라벨 뒤에 ` 🔔`).

`toggleAlertByLongPress()` 흐름:
- **이미 켜져 있으면**: `confirm('이 기기의 생산 완료 알림을 끌까요?')` → 예면 끄고 `false`, 아니면 `true` 유지.
- **꺼져 있으면**:
  1. `'Notification' in window` 가 아니면 `alert('이 브라우저는 알림을 지원하지 않습니다.\n(iPhone 은 Safari 에서 "홈 화면에 추가" 후 사용해 주세요)')` → `false`
  2. `confirm` 안내(줄바꿈 포함, 원문 그대로):
     ```
     이 기기에서 생산 완료 알림을 받겠습니까?

     · 진행률이 100% 가 되면 알림이 뜹니다 (하루 1회)
     · 확인을 누른 이 기기에만 갑니다 (PC·휴대폰 각각 따로 설정)
     · 브라우저가 켜져 있어야 합니다 (다른 탭에 있어도 됩니다)
     ```
  3. 권한이 `'default'` 면 `Notification.requestPermission()`. 결과가 `'granted'` 가 아니면 `alert('알림 권한이 거부되어 있습니다.\n브라우저 주소창 옆 자물쇠(ⓘ) → 알림 → 허용 으로 바꿔주세요.')` → `false`
  4. `localStorage['completionAlert:on'] = '1'` 후 **테스트 알림 즉시 발사**: 제목 `'알림이 켜졌습니다'`, 본문 `'오늘 생산이 100% 완료되면 이 기기로 알려드립니다.'`, tag `'ssbon-alert-test'` → `true`

토글 후 `Header` 는 `window.dispatchEvent(new Event('ssbon:alert-changed'))` 를 쏘고, `App` 의 `useCompletionAlert` 가 이 이벤트를 듣고 구독을 켜거나 끈다.

#### 3.5 알림 연출 `fireNotification(title, body, tag)`

세 가지를 동시에 한다(각각 try/catch 로 격리):
1. **브라우저 알림** — `supportsNotification() && Notification.permission === 'granted'` 일 때만. `requireInteraction: true` (사용자가 닫을 때까지 유지), 클릭하면 `window.focus()` 후 닫힘. 같은 `tag` 는 OS 가 하나로 합친다.
2. **진동** — `navigator.vibrate?.([300, 120, 300, 120, 500])`
3. **소리** — `beep()`: 오디오 파일 없이 WebAudio 로 생성. `AudioContext` (없으면 `webkitAudioContext`) 에 사인파 2음 — **880Hz 를 0초에 0.18초**, **1175Hz 를 0.2초에 0.28초**. 게인은 `0.0001` 에서 20ms 동안 `0.25` 까지 지수 램프 후 다시 `0.0001` 로 감쇠. 1500ms 뒤 `ctx.close()`.

> 소리와 진동은 **권한과 무관하게** 실행된다. 브라우저 알림 권한이 거부돼 있어도 비프는 울릴 수 있다(단 자동재생 정책상 사용자 상호작용이 한 번도 없던 탭에서는 차단될 수 있고, 그 경우 조용히 실패한다).

#### 3.6 수명주기 (`App.tsx` `useCompletionAlert`)

- `isAlertOn()` 이 `false` 면 **구독 자체를 걸지 않는다** (Firestore 읽기 0).
- 켜져 있으면 `watchTodayProgress(handleProgress)` 구독 + **60초(`60_000ms`)마다 `new Date().getDate()` 비교**. 날짜가 바뀌면 기존 구독을 해제하고 새 `todayKey()` 로 재구독한다 → **자정을 넘겨 켜둔 태블릿도 다음 날 알림을 받는다.**
- 언마운트/끄기 시 `clearInterval` + 구독 해제.
- 설정은 기기별 `localStorage` 다. PC·휴대폰에서 **각각 따로** 켜야 하고, 브라우저를 완전히 종료하면 못 받는다(웹푸시 아님).

---

### 4. 생산 완료 Gmail 알림 — `productionNotify.ts` + `appMeta`

`productionNotify.ts` 는 **런타임 코드가 한 줄도 없는 타입·주석 전용 파일**이다. 내용은 `NotifySettings` 인터페이스 하나:
- `enabled?: boolean`
- `emails?: string` — 콤마 구분 수신자. Apps Script(시간트리거)가 `appMeta/notifySettings` 에서 읽어 발송.
- `webAppUrl?: string` — Apps Script 웹앱 배포 URL. 100% 시 앱이 직접 신호를 쏘는 주소(Firestore 읽기 0).
- `updatedAt?: string`

파일 상단 주석이 설계 근거를 담고 있다: Apps Script 웹앱은 CORS 응답 헤더를 주지 않으므로 `mode:'no-cors'` 로 **fire-and-forget**, `Content-Type: text/plain` 으로 preflight 회피, 성공 여부는 메일 도착으로만 확인.

#### 4.1 설정 UI — `/analytics/settings` → 📧 "생산완료 알림 (Gmail)"

`appMeta/notifySettings` 를 `onSnapshot` 으로 구독. 로딩 중에는 `불러오는 중…`.
- 파란 안내 박스 3줄(원문):
  - `현황 진행률이 100% 되면 아래 등록된 이메일로 Gmail 알림이 자동 발송됩니다.`
  - `· 발송은 Google Apps Script(구글 서버) 가 매일 15:00~18:00 사이 1분마다 확인해 처리합니다 — 현황 화면을 안 켜둬도 됩니다.`
  - `· 같은 날 1통만 발송됩니다. 여기서 받는 이메일을 추가/삭제하면 즉시 반영됩니다.`
- 체크박스 **"알림 사용 (켜짐)"/"알림 사용 (꺼짐)"** — 토글 즉시 저장, 저장 중 회색 `저장 중…`.
- 이메일 입력: 라벨 `받는 이메일 (여러 명은 콤마로 구분)`, placeholder `hong@gmail.com, kim@bongroup.co.kr`, **`onBlur` 에서만 저장**. 아래 힌트 `입력 후 칸 밖을 클릭하면 자동 저장됩니다.`
- 저장은 `setDoc(appMeta/notifySettings, {enabled: !!enabled, emails: emails || '', updatedAt: new Date().toISOString()}, { merge: true })`. **`webAppUrl` 은 이 패널에서 편집하지 않는다** — 콘솔이나 다른 경로로 넣는 값이며, `merge: true` 덕에 지워지지 않는다.

#### 4.2 앱이 남기는 신호 (감시 대상)

**① 현황(Dashboard) — 폴링용 요약 문서**
`viewDate === todayKey()` 일 때만, 그리고 `` `${pct}|${completedItems}|${itemCount}|${totalQty}` `` 서명이 바뀔 때만 `setDoc(appMeta/dailyProgress, {date, pct, completedItems, itemCount, totalQty, updatedAt}, {merge:true})`. 과거 날짜를 조회 중이면 쓰지 않는다. 에러는 `.catch(() => {})`.
→ Apps Script 시간 트리거가 이 **문서 한 건만** 읽어서 100% 를 판단하고 Gmail 을 보낸다(현장 화면을 켜둘 필요 없음, 읽기 비용 최소).

**② 내포장(Scoop) — 요약 문서 + 즉시 푸시**
- 같은 방식으로 서명 `` `${pct}|${completed}|${itemCount}` `` 이 바뀔 때만 `setDoc(appMeta/scoopProgress, {date, pct, completedItems, itemCount, updatedAt}, {merge:true})`.
- 진행률 계산은 `totalQty > 0` 인 item 만 대상으로 `Σ min(done, target) / Σ target` 을 `Math.round(_ * 100)`. `itemCount === 0` 이면 아무 것도 하지 않는다.
- **즉시 푸시**: `pct >= 100 && notifyCfg.enabled && notifyCfg.emails.trim() && notifyCfg.webAppUrl` 이면, `localStorage['scoopNotified:{date}']` 가 없을 때 한 번만 —
  `fetch(webAppUrl, { method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain'}, body: JSON.stringify({ type:'scoopDone', date, completedItems, itemCount, emails }) })`. 실패는 묵살. 중복 방지 플래그는 **기기별 localStorage** 라서 여러 기기가 열려 있으면 기기 수만큼 신호가 갈 수 있다(중복 제거는 Apps Script 쪽 책임).
- `notifySettings` 는 `onSnapshot` 으로 구독해 캐시에 남긴다(오프라인/읽기 절약).

> 정리하면 알림은 **2계층**이다: ㉠ 기기 로컬 즉시 알림(소리·진동·브라우저 알림, `completionAlert.ts`, 설정=localStorage) ㉡ 서버측 Gmail(Apps Script 가 `appMeta/*Progress` 를 폴링하거나 웹앱 URL 로 직접 신호를 받음, 설정=Firestore). 둘은 서로 독립이며 켜고 끄는 곳도 다르다.

---

### 5. DB 백업 — `dbBackup.ts` (+ `pgSqlGen.mjs`)

#### 5.1 무엇을 하나

브라우저에서 Firestore 전체를 **읽기 전용**으로 훑어 **PostgreSQL 덤프(.sql) 파일 하나**를 만들어 다운로드한다. 쓰기/삭제 API 를 전혀 쓰지 않는다. 웹 SDK 는 `listCollections()` 를 못 쓰므로(관리자 전용) **컬렉션 목록은 상수로 손수 관리**한다 — 앱에 새 컬렉션을 추가하면 여기에도 반드시 추가해야 한다.

#### 5.2 대상 컬렉션 (정확히 이 목록)

**최상위 `ROOT_COLLECTIONS` (23개, 배열 순서대로 수집)**
```
productSettings, materials, recipes, subRecipes, ambientRecipes,
materialPrices, materialPricesInventory, materialPricesMonthly, materialOutflow,
materialErpCodes, supplierCodes, members, productivity,
monthlyStats, monthlyMeta, under10Manual, visits,
attendanceSnapshot, attendanceMeta, analyticsGraphs,
appMeta, settings, purchaseInbound
```

**서브컬렉션 `GROUP_COLLECTIONS` (9개, `collectionGroup` 으로 전량 수집)**
```
items, logistics, ambient, scoop, scoopFlags, entries, records, movements, requests
```

→ `days/{날짜}/items`, `days/{날짜}/logistics`, `days/{날짜}/ambient`, `days/{날짜}/machines/{호기}/entries` 등 **현황·입력이 쓰는 데이터가 전부 여기 포함**된다. 단 `days` 문서 자체(중간 부모 문서)는 최상위 목록에 없으므로 수집되지 않는다.

#### 5.3 수집 알고리즘 `runBackup(opts)`

- 옵션: `maxReads`(기본 `40000`, 설정 화면에서는 **`Infinity`** 로 호출), `paceMs`(기본 `60`), `onProgress`, `signal: { aborted: boolean }`
- 페이지 크기 상수 `PAGE = 500`
- 각 컬렉션은 `orderBy(documentId())` + `startAfter(커서)` + `limit(500)` **커서 페이징**으로 전량 수집(누락 방지). 페이지마다 `paceMs` 만큼 `sleep` 으로 속도를 늦춘다(읽기 폭주 방지).
- 루프 탈출 조건:
  - `snap.empty` → 끝
  - `snap.size < PAGE` → 마지막 페이지
  - `signal.aborted` → `incomplete = '{컬렉션} (사용자 중단)'` 후 반환
  - `docCount >= maxReads` → `incomplete = '{컬렉션} (읽기 상한 도달)'` 후 반환
- 컬렉션 단위 실패는 `try/catch` → `console.warn('[백업] {name} 건너뜀:', e)` 하고 **다음 컬렉션으로 진행**(권한 없는 컬렉션이 있어도 전체가 죽지 않는다).
- `incomplete` 가 생기면 **바깥 루프를 즉시 중단**하고, 그룹 컬렉션 단계 자체를 건너뛴다.
- 진행 보고 `BackupProgress { phase, docs, done, total }`, `total = 23 + 9 = 32`.
- 반환 `BackupResult { sql, stats, docCount, validation, incomplete, sizeBytes }`. `sizeBytes` 는 `new Blob([sql]).size`.

헤더 문자열: 정상 `` `generated: ${ISO}` ``, 중단 시 `` `generated: ${ISO}  ⚠ 불완전 (중단: ${incomplete})` ``.

#### 5.4 SQL 출력 형식 (`pgSqlGen.mjs`)

파일 앞머리(고정 3줄 주석 + 설정):
```
-- 순수본 1공장 MES — Firestore 전체 덤프 (PostgreSQL)
-- {header}
-- 컬렉션 1:1 이관 · 원본 경로는 doc_path 보존 · 배열/객체는 JSONB 원본 유지
SET client_encoding = 'UTF8';
BEGIN;
```
끝은 `COMMIT;` + 개행. 테이블은 **이름 오름차순**으로 출력된다.

- **테이블명**: 문서 경로에서 **짝수 인덱스 세그먼트(= 컬렉션 이름)만** 남겨 `__` 로 잇고, 영숫자·`_` 외 문자는 `_` 로 치환. 예) `days/2026-09-13/items` → `days__items`, `days/2026-09-13/machines/1호기/entries` → `days__machines__entries`.
- **설정성 컬렉션 특례**: 최상위 세그먼트가 `appMeta`, `settings`, `_config` 중 하나면 테이블은 전부 **`config_docs`** 하나로 모이고, 컬럼은 `doc_id` / `doc_path` / `data`(JSONB 통짜). → `appMeta/notifySettings`, `appMeta/dailyProgress`, `settings/analyticsAuth` 가 모두 여기로 간다.
- **컬럼**: `doc_id TEXT NOT NULL`, `doc_path TEXT NOT NULL`, 그 뒤로 그 테이블에서 관찰된 필드들(처음 등장한 순서).
- **PK**: 그 테이블 안에서 `doc_id` 가 전부 유일하면 `doc_id` 가 PK, 아니면 `doc_path` 가 PK. (`days__items` 처럼 날짜가 달라도 같은 문서 ID 가 반복되는 서브컬렉션은 자동으로 `doc_path` PK 가 된다.)
- **타입 추론** (`pgType`, 필드별로 관찰된 kind 집합 기준): `json` 이 하나라도 있으면 `JSONB`; 단일 kind 면 `int→BIGINT`, `double→NUMERIC`, `bool→BOOLEAN`, 그 외 `TEXT`; 여러 kind 인데 전부 숫자면 `NUMERIC`; 나머지는 `TEXT`. **관찰된 값이 하나도 없으면(전부 null) `TEXT`.**
- **값 인코딩** (`decode`): Timestamp(`toDate()` 보유)·`Date` → ISO 문자열, GeoPoint → `{lat, lng}` JSON, DocumentReference → `path` 문자열, Buffer/웹SDK Bytes → base64, 배열·객체 → 구조 유지 JSON. 작은따옴표는 `''` 로 이스케이프.
- 각 테이블은 `DROP TABLE IF EXISTS "t" CASCADE;` → `CREATE TABLE` → **500행씩 묶은 다중 VALUES `INSERT`** 순서.
- 데이터 컬럼에 **`date` 가 있으면** `CREATE INDEX "idx_{테이블}_date" ON "{테이블}" ("date");` 를 자동 생성한다. → `days__ambient`, `days__items` 등이 해당.

**구문 검증 `validateSql(sql)`**: 문자열 리터럴(`'...'`)을 먼저 전부 제거한 뒤에 괄호 균형을 센다(품목명에 `한우(볶음)-후` 처럼 괄호가 들어 있기 때문). 반환값 `{ nCreate, nDrop, nInsert, nIndex, parenBalanced, quotesBalanced, wrapped, open, close }`. `wrapped` 는 `BEGIN;` 과 `COMMIT;` 이 각각 한 줄로 존재하는지.

#### 5.5 다운로드

`downloadSql(sql, filename)` — `new Blob([sql], { type: 'application/sql;charset=utf-8' })` → `URL.createObjectURL` → `<a download>` 생성 후 `.click()` → **즉시 `revokeObjectURL`**.
파일명: `` `ssbon_backup_${YYYY-MM-DD}${incomplete ? '_불완전' : ''}.sql` `` (날짜는 `new Date().toISOString().slice(0, 10)` = **UTC 기준**). "다시 다운로드" 버튼은 접미사 없이 `ssbon_backup_{오늘}.sql`.

#### 5.6 설정 화면 UI (`DbBackupPanel`)

- 시작 전 `confirm`:
  ```
  DB 전체를 읽어 백업 파일(.sql)을 만듭니다.

  · 데이터를 읽기만 하며 변경하지 않습니다
  · 상한 없이 전부 읽습니다 (중단 버튼으로 언제든 멈춤 가능)
  · 읽기 한도(무료 하루 5만)는 현장 앱과 공유합니다

  계속할까요?
  ```
- 회색 설명 박스 + **호박색 경고 박스**: 읽기 한도를 현장 앱과 공유하므로 근무 중 실행하면 현장 태블릿 조회가 막힐 수 있고(다음날 자동 복구 · 한국시간 오후 4시경), **퇴근 후 실행 권장**.
- 버튼: **"💾 DB 백업 파일 만들기"** (진행 중 **"백업 중…"**, 비활성), 진행 중에만 **"중단"**(누르면 `abortRef.current.aborted = true`), 결과가 있고 실행 중이 아니면 **"다시 다운로드"**.
- 진행 표시: `bg-slate-700` 막대 (`width = round(done/total*100)%`) + `{phase} 수집 중 · {docs}건 읽음 ({done}/{total} 컬렉션)`.
- 실패 시 빨간 박스 `실패: {메시지}`.
- 완료 시 `incomplete` 면 호박색 **"⚠ 불완전한 백업입니다 (중단: {지점}). 파일명에도 표시했습니다. 이관용으로 쓰려면 다시 받으세요."**, 아니면 초록색 **"✅ 백업 완료 — 다운로드됐습니다."**
- 통계 카드 4개: **문서**(`docCount`), **테이블**(`stats.length`), **파일 크기**(`(sizeBytes/1024/1024).toFixed(2)` + `MB`), **구문 검사**(`parenBalanced && wrapped` 면 초록 `OK`, 아니면 빨강 `NG`).

---

### 6. 이 부속들이 없으면 현황·입력이 어떻게 불완전해지는가

**실온 입력 모달이 없으면**
- `days/*/ambient` 가 영원히 비고, 월별 분석의 **실온 생산량 = 0**. "총 생산량(냉장 + 실온)", "일평균 생산량", 실온/냉장 비교 그래프가 전부 냉장만 반영한 반쪽 숫자가 된다.
- 월별 **가동일 판정**(`isDayComplete`)이 "생산 또는 실온 데이터가 있으면 완료"라는 분기를 쓰므로, 실온만 돌린 날이 **비가동일로 빠져** 일평균이 부풀려진다.
- 실온은 다른 입력 경로가 전혀 없다(호기 화면·붙여넣기 어디에도 없음). 이 모달이 유일한 투입구다.

**잔여량(물류) 모달이 없으면**
- `days/*/logistics` 가 비어 `hasLogistics` 가 항상 `false`. 현황의 "완료 수량 = 총수량 + 잔여량합계" 분기, 품목별 ± 컬럼의 **잔여량 수정값 우선 표시**, 품목 완료 배지(물류 등록만으로 완료 처리)가 전부 죽고 **생산 실적만으로** 판정하게 된다.
- 월별 분석의 "잔여량 비율", 마감일 판정, `totalQty + logQty` 로 덮어쓰는 일별 냉장 생산량 보정이 사라져 실제 출고와 어긋난다.
- 완료 알림의 `pct = hasLogistics ? 100 : pct` 강제도 사라져, 실적이 계획에 조금 못 미치면 **영원히 100% 에 도달하지 않아 알림이 안 울린다.**

**완료 알림이 없으면**
- 현황 화면을 계속 들여다보지 않는 한 100% 도달을 알 수 없다. 마감 확인이 늦어지고 잔여량 입력·퇴근 판단이 밀린다. Gmail 알림은 Apps Script 가 **15:00~18:00 에만 1분 간격**으로 확인하므로 그 밖의 시간대 완료는 즉시 알 방법이 이것뿐이다.

**Gmail 알림 설정이 없으면**
- `appMeta/notifySettings` 가 없으면 Apps Script 가 수신자를 못 찾아 메일이 안 나간다. 현황/내포장이 `appMeta/dailyProgress`·`appMeta/scoopProgress` 를 계속 써도 소비자가 없다. 화면을 켜둘 필요 없이 사무실에서 완료를 아는 유일한 경로가 끊긴다.

**DB 백업이 없으면**
- Firestore 데이터를 사내 서버로 옮기거나 장기 보관할 수단이 없다. 현황·입력이 만들어내는 `days/*/items`, `entries`, `logistics`, `ambient` 가 전부 Firestore 안에만 존재하게 되고, 스키마가 없는 문서 구조를 관계형으로 옮길 변환 규칙(`pgSqlGen`)도 함께 사라진다.

---

# 부록 A — 놓치기 쉬운 규칙 전량

재현하다 틀어지는 자리를 영역별로 모았다. **구현 후 이 목록을 하나씩 대조하라.**

## 1부

- `vite.config.ts` 의 base('/productivity-app/')와 BrowserRouter basename('/productivity-app')은 반드시 짝을 이뤄야 하고, 빌드 스크립트의 `cp dist/index.html dist/404.html` 을 빠뜨리면 GitHub Pages에서 딥링크 새로고침이 전부 404 가 된다.
- 헤더 메뉴의 활성 표시는 URL 매칭이 아니라 getSection() 결과 비교다. 그래서 /machine/3 에서도 '입력'이, /analytics/waste 에서도 '분석'이 하이라이트된다. NavLink 의 isActive 를 쓰면 재현이 틀어진다.
- getSection 은 /report 와 /remaining 을 '정확히 일치'로만 analytics 섹션에 넣는다(startsWith 아님). 반면 /import 는 어느 규칙에도 안 걸려 dashboard 섹션으로 분류돼 헤더의 '현황'이 활성화된다.
- SubNav 활성 판정은 exact 가 없으면 pathname.startsWith(to) 다. /scoop/board 에서는 '내포장'(to='/scoop')과 '내포장 현황판' 두 탭이 동시에 활성으로 보인다 — 현재 동작 그대로 재현할 것.
- SubNav 는 dashboard 섹션에서 SUB_TABS 가 빈 배열이라 컴포넌트 자체를 렌더하지 않는다(null). 빈 흰 줄이 남으면 안 된다.
- MainContainer 는 일부 경로에서 max-w-screen-2xl 로 넓어지지만 SubNav 내부 컨테이너는 항상 max-w-screen-xl 이다. 이 폭 불일치는 의도된 현 상태다.
- SubNav 의 sticky 오프셋은 top-[52px] 하드코딩이다. 모바일 헤더는 네비가 두 번째 줄로 내려가 52px보다 높으므로 겹침이 생긴다 — 값을 '고쳐서' 바꾸지 말 것.
- 분석 잠금은 Firebase Auth 계정이 아니라 Firestore settings/analyticsAuth 문서의 password 필드와 문자열 완전 일치(트림·해시 없음)다.
- settings/analyticsAuth 문서가 없거나 password 가 빈 문자열이면 AnalyticsGate 는 무조건 통과시킨다 — 분석 전체가 개방된다.
- isAuthed() 는 만료를 감지하면 그 자리에서 localStorage 키를 지운다. 그래서 '이전에 키가 있었는지'(wasAuthed)를 isAuthed() 호출 **전에** 따로 읽어둬야 '세션이 만료되었습니다 (12시간)' 안내가 뜬다.
- 헤더의 '🔓 로그아웃' 버튼은 TTL 검사 없이 analyticsAuthedAt 키 존재만 본다. 그리고 클릭 시 상태 갱신이 아니라 window.location.reload() 로 새로고침한다.
- viewDate 는 { date, chosenOn } 형태로 저장한다. chosenOn 이 오늘이 아니면 무시하고 오늘을 반환 — '어제 과거 날짜를 보다 그대로 두면 오늘 다시 오늘 날짜로 리셋'되는 규칙이다. 구버전 평문 문자열도 파싱 실패 경로에서 처리해야 한다.
- loadViewDate 는 useState(loadViewDate) 처럼 **초기화 함수로 전달**해야 한다. useState(loadViewDate()) 로 바꾸면 렌더마다 localStorage 를 읽는다.
- Machine/ExternalPack 은 60초마다 effectiveTodayKey() 와 비교해 강제로 setDate 한다. 결과적으로 이 두 화면에서 손으로 고른 과거 날짜는 1분 안에 오늘로 되돌아가고, 공유 viewDate 까지 함께 바뀐다. 이건 버그가 아니라 자정 롤오버 방지 장치다.
- effectiveTodayKey() 는 현재 시각이 새벽 2시 이전이면 전날을 반환한다(야간조 보호). 입력 계열만 이 함수를 쓰고 대시보드·분석은 todayKey() 를 쓴다 — 섞으면 안 된다.
- 날짜 계산은 전부 로컬 타임존이다. toISOString().slice(0,10) 이나 UTC 계산을 쓰면 한국 시간 09시 이전이 전날로 밀린다. 날짜 이동은 new Date(y, m-1, d+delta) 로만 한다.
- 헤더의 M/D(요일) 라벨은 렌더 시점에 한 번 계산되는 값이라 자정을 넘겨도 갱신되지 않는다. Dashboard 라벨은 YYYY.MM.DD (요일) 로 포맷이 다르다 — 두 포맷을 통일하지 말 것.
- presence 는 실시간 접속자가 아니라 '오늘 이 앱을 연 기기 수'다. 문서 ID 가 `${date}_${visitorId}` 라서 새로고침해도 중복 생성되지 않고(멱등), 접속 종료를 기록하지 않아 하루 안에서는 값이 줄지 않는다.
- visits 청소는 localStorage 의 visitsCleanupDate 로 하루 1회만 돌고, where('date','<',today) 로 과거 문서를 전부 읽어 개별 삭제한다. 모든 실패를 catch 로 삼켜 조용히 넘어간다.
- useTodayVisitorCount 는 Report 페이지에서만 쓰인다. onSnapshot 해제 함수를 useEffect 에서 그대로 반환해야 구독이 새지 않는다.
- 완료 알림의 진행률 계산에서 logistics 문서가 하나라도 있으면 pct 를 무조건 100 으로 덮는다. 또 품목 완료 판정 시 logistics 키는 toLowerCase().replace(/[-\s]/g,'') 로 정규화하지만, 호기 생산량 조회 키는 toLowerCase() 만 한다 — 정규화 수준이 서로 다르다.
- pct 는 Σ min(생산량, totalQty) / totalQty * 100 을 **마지막에 한 번** Math.round 한다. 품목별로 먼저 반올림하면 안 된다.
- 완료 알림은 markNotified 를 fireNotification 보다 **먼저** 호출해 하루 1회를 보장한다. 순서를 바꾸면 중복 발사 가능성이 생긴다.
- 롱프레스 훅은 발동 후 이어지는 click 을 consumeClick 으로 삼켜야 한다. 안 그러면 5초 꾹 누른 뒤 '/' 로 네비게이션까지 일어난다.
- 알림 on/off 상태는 App 과 Header 가 각각 별도 useState 로 갖기 때문에, 토글 후 window.dispatchEvent(new Event('ssbon:alert-changed')) 로 알려야 두 곳이 동기화된다.
- useCompletionAlert 은 알림이 꺼진 기기에서는 Firestore 구독을 아예 걸지 않는다(비용 절감). 켜진 경우에도 60초 폴링으로 날짜가 바뀌면 기존 구독을 끊고 재구독해야 한다.
- Firebase 설정은 환경변수가 아니라 src/firebase.ts 에 하드코딩이다. VITE_* 를 새로 도입하면 GitHub Actions 빌드에 시크릿이 없어 빈 설정으로 배포된다.
- getAuth 로 만든 auth 는 export 만 되고 실제 로그인에 쓰이지 않는다. 앱은 미인증으로 Firestore 에 접근하므로 보안 규칙이 공개 접근을 허용해야 동작한다.
- 라우트에 catch-all(*) 이 없다. 없는 경로로 가면 에러 페이지가 아니라 본문만 빈 화면이 된다.
- StrictMode 때문에 개발 모드에서 모든 effect 가 두 번 실행된다. useTrackVisit 의 setDoc 처럼 멱등한 쓰기여야 하고, 구독은 반드시 해제 함수를 반환해야 한다.
- Dashboard 는 viewDate !== todayKey() 일 때 appMeta/dailyProgress 를 쓰지 않는다. 과거 날짜 조회가 오늘 진행률 문서를 덮지 않게 하는 날짜 경계 규칙이다.
- /report·/remaining·/import 는 AnalyticsGate 밖에 있어 비밀번호 없이 열린다. 반면 /analytics/report·/analytics/remaining 은 같은 컴포넌트인데도 잠긴다 — 현재 동작 그대로 재현할 것.

## 2부

- `convertErpCode` 가 두 벌 있다. `src/lib/codeUtil.ts` 버전은 하이픈을 빼고(`A-001-01` → `A01`), `src/pages/Remaining.tsx` 와 `src/components/LogisticsInputModal.tsx` 안의 로컬 사본은 하이픈을 넣는다(`A-001-01` → `A-01`). logistics 문서 ID 는 하이픈 버전이므로 절대 통합하지 말 것 — 통합하면 과거 물류 데이터와 조인이 끊긴다.
- `days/{YYYY-MM-DD}` 부모 문서는 절대 생성하지 않는다. 서브컬렉션만 있는 유령 부모다. 날짜 목록을 `days` 컬렉션 조회로 얻으려 하면 빈 결과가 나온다 — 날짜는 클라이언트가 문자열로 만들어 경로에 끼워 넣는다.
- `days/{date}/items` 의 문서 ID 는 붙여넣은 코드 원문(`cols[0].trim()`) 그대로다. 대문자화도, canonicalShort 도 걸지 않는다. 여기에 정규화를 추가하면 그날의 코드 원본 추적이 끊긴다.
- 호기 entries 문서 ID 는 `addDoc` 자동 ID 여야 한다(같은 코드 재생산이 정상 업무라 코드를 ID로 쓰면 덮어써진다). 단 `/import` 백업 가져오기만 예외로 `code` 를 문서 ID로 쓴다 — 이 비대칭을 그대로 유지해야 과거 복원 데이터가 살아 있다.
- 호기 entry 는 '일반'이면 `actualProduction`+`workTime` 만, '추가'면 `additionalProduction`+`additionalWorkTime` 만 쓴다. 안 쓰는 쪽은 0이 아니라 필드 자체가 없어야 한다 — UI 가 `!!e.workTime` 존재여부로 수정 가능 칸을 판정한다.
- 생산량 인라인 수정은 `updateDoc` 으로 숫자 한 필드만 바꾼다. 작업시간을 같이 갱신하면 정렬(작업시간 내림차순)이 흔들려 행이 튄다. 저장 조건은 `!isNaN(n) && n >= 0 && n !== value`.
- 진행률은 `Math.round( Σ min(produced, totalQty) / totalQty * 100 )` — 품목별로 반올림하지 말고 클램프 → 합산 → 마지막에 한 번만 반올림. `totalQty === 0` 이면 0.
- `hasLogistics` 는 logistics 문서가 단 한 건만 있어도 true 가 되어 현황·잔여량 전체가 물류 모드로 바뀐다. 그런데 `pct` 만은 logistics 를 무시하고 항상 생산 기준으로 계산한다(완료알림 모듈만 `hasLogistics ? 100 : pct` 로 덮어씀).
- logistics 가 있는 품목은 `qty` 가 음수여도 '완료'로 센다(`logistics[norm] !== undefined` 만 본다). 반대로 저장 단계에서는 `qty < 0` 인 행을 스킵하므로 음수는 사실 들어오지 않는다.
- items↔entries 조인은 `code.toLowerCase()`(하이픈 유지), items↔logistics 조인은 `toLowerCase().replace(/[-\s]/g,'')`(하이픈 제거). 두 키를 섞으면 안 된다.
- 잔여량 화면의 logistics 맵은 키를 정규화하지 않고 원본 doc ID 로 담는다 — '물류 초기화' 가 그 ID 로 삭제하기 때문. 현황 화면은 반대로 정규화된 키로 담는다. 이 차이를 뒤집으면 삭제가 아무것도 못 지운다.
- logistics 저장은 기존 문서를 지우지 않는다. 이번 붙여넣기에 없는 코드는 남아서 계속 물류 모드를 유지시킨다. 전체 삭제는 '물류 초기화' 버튼뿐이고 그것도 현재 구독으로 로드된 문서만 지운다.
- logistics 수량은 `parseInt(r[qtyCol] || '0', 10)` 이라 콤마가 있으면 `'1,234'` → 1 이 된다. 반면 현황 붙여넣기의 `num()` 은 콤마를 제거하고 `parseFloat` 한다. 두 파서가 다르다.
- 현황 붙여넣기 `num()`: 콤마 제거 → `'-'` 또는 빈 문자열이면 0 → `parseFloat`, NaN 이면 0. ERP 가 빈 칸을 `-` 로 내보내므로 `'-' → 0` 규칙이 필수다.
- 주말 모드에서 `marketKurly` 는 무조건 0 이고 `totalQty` 는 `cols[4]`(평일이면 마켓컬리 자리)에서 읽는다. 주말+샘플 조합은 존재하지 않는다(주말 전환 시 샘플 체크박스 강제 해제).
- 붙여넣기는 `set` 을 merge 없이 한다. 재붙여넣기하면 `actualProduction` 이 0으로, `coolingEndTime` 은 필드 삭제로 되돌아간다.
- 현황의 '전체 삭제' 는 items 만 지운다. machine entries 와 logistics 는 그대로 남아 고아가 된다.
- `canonicalShort` 의 정규식 `([A-Z])-?(\d+)` 은 앵커가 없다. `PB01` → `B01`, `ABC-12` → `C12` 처럼 엉뚱하게 잡힌다. 선두 `PB-` 제거는 하이픈이 있을 때만 동작한다.
- `normalizeCode` 는 하이픈·공백 제거 + 소문자화만 한다. 단축하지 않으므로 `normalizeCode('A-001-01') = 'a00101'` 이고 `normalizeCode('A-01') = 'a01'` 과 다르다. productSettings 조회 맵을 `normalizeCode(id)` / `normalizeCode(convertErpCode(id))` / `normalizeCode(canonicalShort(id))` 3중으로 등록하는 이유다.
- `compareCode` 는 `^([A-Za-z]+)(\d+)` 앵커 매치가 실패하면(예: `A-01` 처럼 하이픈이 낀 코드) 통째 `localeCompare` 로 폴백한다. 그리고 동률일 때 tie-break 이 없어서 `Array.sort` 안정성 + Firestore 문서 ID 오름차순 순서에 의존한다.
- 호기 entries 정렬 tie-break `b.docId.localeCompare(a.docId)` 는 '나중에 만든 게 위'라는 주석과 달리 실제로는 임의 순서다 — Firestore 자동 ID 는 랜덤이라 시간순이 아니다. 결정적이기만 하면 되므로 그대로 둘 것.
- 날짜 키는 반드시 로컬 `getFullYear/getMonth/getDate` 로 조립한다. `toISOString().slice(0,10)` 은 UTC 로 밀려 하루가 틀어진다.
- `effectiveTodayKey()` 는 새벽 2시 이전(`getHours() < 2`)이면 전날을 돌려준다(야간조 보호). 1·2·3호기·외포장에만 있는 60초 타이머가 이 값으로 날짜를 강제 교정하므로, 그 화면들에서 과거 날짜를 골라도 1분 안에 되돌아간다. 현황 화면에는 이 타이머가 없다.
- 00:00~01:59 에는 `effectiveTodayKey()`(어제)와 `todayKey()`(오늘)가 달라서 호기 화면에 날짜는 어제로 잡힌 채 `⚠ 과거 날짜에 입력 중` 배지가 뜬다. 버그가 아니라 의도된 동작이다.
- localStorage `viewDate` 는 `{date, chosenOn}` JSON 이고 `chosenOn !== todayKey()` 면 복원하지 않고 오늘로 돌아간다. 구버전 평문 문자열 포맷도 받아준다.
- `appMeta/dailyProgress` 는 `viewDate === todayKey()` 일 때만 쓴다(과거 조회가 오늘 진행률을 덮으면 안 됨). 서명 문자열 `pct|completedItems|itemCount|totalQty` 이 직전과 같으면 쓰기를 생략하고, `setDoc(..., {merge:true})` + `.catch(()=>{})` 로 에러를 삼킨다.
- 날짜가 바뀌면 구독을 새로 걸기 전에 `setItems([])`, `setMachineQty({'1호기':{},'2호기':{},'3호기':{}})`, `setLogisticsByCode({})` 로 상태를 먼저 비워야 한다. 안 그러면 첫 스냅샷 전까지 전날 숫자가 남는다.
- 호기 3개 구독은 `setMachineQty(prev => ({...prev, [machine]: map}))` 처럼 함수형 업데이트로 자기 슬롯만 갱신해야 한다. 통째 치환하면 동시 도착 시 서로 덮어쓴다.
- 현황·1·2·3호기·외포장은 `productSettings` 를 전혀 읽지 않는다. items 가 name·수량을 모두 들고 있어 자족적이다. 여기에 제품 DB 조회를 끼워 넣지 말 것.
- `productSettings.vatMaxQty === 999` 는 수량이 아니라 '냄비' 를 뜻하는 센티널이다. `type` 토글 해제는 필드 삭제가 아니라 `null` 을 저장한다.
- `productSettings` 문서는 읽을 때 `{...d.data(), code: d.id}` 로 `code` 필드를 문서 ID 로 덮어쓴다 — 문서 ID 가 진실이고 필드는 참고값이다.
- 완바트·포장중량 일괄 입력은 새 문서를 만들지 않는다. `canonicalShort(기존 doc id) → 실제 doc id` 맵으로 매칭된 기존 문서에만 merge 하고, 실패분은 `⚠ 제품DB에 없어 매칭 실패 N개: …` 로 알리고 저장하지 않는다.
- `types.ts` 의 `ExternalPackEntry` 는 어디에도 저장되지 않는 죽은 타입이다. 외포장 화면은 완전 읽기 전용이며 machine entries + items 로 행을 조립한다.
- 현황 붙여넣기와 전체삭제는 writeBatch 청크를 나누지 않는다(Firestore 500건 한계). 백업 가져오기는 450건, 제품 DB 일괄 작업은 400건씩 끊는 관례를 따른다.
- 냉각 종료 시각은 코드별 전 호기 최신 작업시각 + 50분이며 `Math.floor(total/60) % 24` 로 자정 랩어라운드한다(날짜 개념 없음). 작업시각이 없으면 `item.coolingEndTime`, 그것도 없으면 `'-'`.

## 3부

- logistics 문서 ID 는 하이픈이 있는 `A-01`/`F-528` 형태다. Remaining.tsx 와 LogisticsInputModal.tsx 안의 로컬 convertErpCode 가 `${letter}-${num}` 을 만든다 — codeUtil.ts 의 동명 함수(하이픈 없는 `A01`)와 혼동하면 전부 매칭 실패한다.
- 정규화가 3종 공존한다: items↔entries 는 `toLowerCase()`(하이픈 유지), items↔logistics 는 `toLowerCase()` + 하이픈·공백 제거, 월 집계는 `canonicalShort`(숫자 2자리 zero-pad, 선두 PB- 제거). 하나로 통합하면 안 된다.
- 실적 수량은 언제나 `(actualProduction || 0) + (additionalProduction || 0)`. `items.actualProduction` 은 붙여넣기 때 0 으로 쓰고 그 뒤 절대 갱신되지 않는 죽은 필드다.
- 일자 단위 분기 우선순위: (1) 품목별 잔여량이 있으면 `계획 totalQty + 그 코드 잔여량`(entries 무시), (2) 일 합계 잔여량만 있으면 `totalQty + 일잔여량 × (totalQty 지분)` 비례안분(소수점 발생), (3) 잔여량 없으면 entries 합. 순서를 바꾸면 안 된다.
- logistics 로더는 스냅샷이 비면 그 날짜 키를 아예 만들지 않는다. 빈 객체 `{}` 를 넣으면 truthy 라서 1번 분기로 빠져 그날 생산량이 계획값으로 덮인다.
- 반올림 위치가 셋 다 다르다: 품목 qty 는 Math.round, 단계 합계는 반올림된 값들의 합, coldTotal 은 원값 전체 합을 한 번만 Math.round, coldByCode 는 반올림하지 않음.
- stage 가 null 인 코드는 stages 에서 빠지지만 coldTotal·coldByCode 에는 남는다. 그래서 coldTotal ≠ Σ stages.total 이 정상이다.
- getStage 의 F 는 숫자 500 이상이면 별도 단계 `F500`, 미만이면 `F`.
- Dashboard 의 `pct` 는 logistics 를 전혀 보지 않는다(항상 entries 기준). 반면 completionAlert 의 pct 는 `hasLogistics ? 100` 으로 강제한다. 두 규칙이 의도적으로 다르다.
- Dashboard 의 `완료된 수량` 은 hasLogistics 면 `총수량 + 전체 logistics 합`(items 에 없는 코드의 잔여량까지 포함), 아니면 items 를 돌며 합산 — 즉 items 에 없는 코드로 찍힌 entries 는 조용히 빠진다.
- completedItems 판정은 `logistics[정규화코드] !== undefined` 이면 값이 0이든 음수든 완료로 친다.
- hasLogistics 인 날에도 잔여량 문서가 없는 개별 행은 생산 모드로 계산된다 — 행 색과 상단 카드가 안 맞을 수 있고 그게 현재 동작이다.
- ± 셀의 `diff >= 10` 빨간 배경(bg-red-300)은 물류 모드와 생산 모드 양쪽에 다 적용된다.
- `appMeta/dailyProgress` 는 viewDate === todayKey() 일 때만 쓰고, `pct|completedItems|itemCount|totalQty` 시그니처가 바뀔 때만 1쓰기 한다(매 스냅샷마다 쓰면 안 됨).
- Machine / ExternalPack 은 60초마다 effectiveTodayKey() 로 날짜를 강제 복귀시킨다 — 과거 날짜를 골라도 1분 안에 되돌아간다. effectiveTodayKey 는 새벽 2시 이전이면 전날이다.
- Machine 등록은 항상 addDoc(새 문서)다. 중복 방지는 '이미 발주량을 채운 품목을 검색 목록에서 숨기는 것' 뿐이다.
- entries 에는 일반/추가 중 한쪽 필드만 쓴다(반대쪽은 undefined). 0 을 쓰면 QtyCell 의 editable 판정(workTime / additionalWorkTime 존재 여부)과 월 집계의 `qty<=0 스킵` 이 흔들린다.
- 인라인 수정은 actualProduction / additionalProduction 만 updateDoc 하고 작업시간은 건드리지 않는다 → 표 순서 유지가 의도된 동작이다.
- 호기 입력 내역 정렬: (workTime || additionalWorkTime || '') 내림차순, 동률이면 docId 내림차순 tie-break.
- Machine 행 배경은 그 행이 아니라 '그 코드의 전 호기 합계' 기준 — 목표+100 이상이면 bg-red-300, 목표 미달이면 bg-rose-100.
- Remaining 의 물류 모드에서는 `부족` 섹션이 항상 빈 배열이고, logQty 가 음수인 행은 어느 섹션에도 안 들어가 화면에서 사라진다(produced 카운트에는 포함).
- Remaining 의 CSV 다운로드는 모드와 무관하게 항상 `실적 − totalQty` 기준으로 뽑는다(화면과 숫자가 다를 수 있음). BOM 을 앞에 붙여야 엑셀 한글이 안 깨진다.
- Remaining 의 logistics 상태 맵 키는 정규화하지 않은 원본 문서 ID 다 — 삭제할 때 그대로 써야 한다.
- 잔여량 저장은 batch.set 이라 이번 붙여넣기에 없는 기존 코드는 남는다. 지우려면 `물류 초기화` 또는 모달의 `전체 삭제`.
- Remaining 모달은 같은 코드 여러 행을 합산하지만, LogisticsInputModal 은 합산 없이 뒤 행이 앞 행을 덮어쓰고 alert 의 count 는 행 수라 실제 문서 수보다 클 수 있다.
- 잔여량 저장 시 qty < 0 이거나 NaN 인 행은 건너뛴다(음수 잔여량은 저장되지 않는다).
- Dashboard 붙여넣기는 batch.set 이라 덮어쓰기이고, 이전 목록에만 있던 품목은 남는다. `전체 삭제` 는 items 만 지우고 entries·logistics 는 남긴다.
- 붙여넣기 숫자 파싱에서 ERP 의 `-` 와 빈칸은 0 으로, 콤마는 제거해야 한다. 주말 모드는 marketKurly 를 강제 0 으로 두고 totalQty 를 cols[4] 에서 읽는다.
- 날짜 계산에 `new Date(dateStr)` 을 쓰면 UTC 파싱으로 하루가 밀린다. 항상 split 해서 `new Date(y, m-1, d + delta)` 로 만든다.
- viewDate localStorage 는 `{date, chosenOn}` 형태이고 chosenOn 이 오늘이 아니면 복원하지 않는다(Dashboard/Machine/Remaining/ExternalPack 이 같은 키를 공유).
- 냉각 종료 = 그 코드의 최신 작업시간 + 50분이며, `Math.floor(total/60) % 24` 로 자정을 넘기면 되감는다.
- 외포장-1/2/3 은 machines/{호기}/entries 를 읽기만 하고 쓰지 않는다 — 생산량 확정에 아무 영향이 없다. 단 `machine` 필드 없는 유령 entries 는 월 집계에서 걸러야 한다.
- 브라우저 알림은 기기별 localStorage(`completionAlert:on`)로 켜고, `completionAlert:notified` 에 날짜를 기록해 하루 1회만 발사한다. 상단 `현황` 버튼 5초 롱프레스가 토글이다.
- 냉장 생산 완료 Gmail 은 앱이 보내지 않는다. 앱은 appMeta/dailyProgress 만 쓰고 Apps Script 가 15:00~18:00 사이 1분마다 폴링해 발송한다. 직접 webAppUrl 푸시를 하는 건 내포장(Scoop)뿐이다.

## 4부

- 날짜 계산은 반드시 `new Date(y, m-1, d+delta)` 숫자 3인자 생성자로 한다. `new Date('2026-09-13')` 은 UTC 파싱이라 KST 에서 하루가 밀린다 (shiftDate/dateLabel 둘 다 해당).
- 코드 정규화가 두 종류다. 호기 entries 매칭은 `code.toLowerCase()` (소문자만, 하이픈 유지), 잔여량(logistics) 매칭은 `code.toLowerCase().replace(/[-\s]/g,'')` (하이픈·공백까지 제거). logistics 문서 ID 는 `A-01` 처럼 하이픈이 있고 items 코드는 `A01` 이라서 이 차이가 필수다. 한쪽 규칙으로 통일하면 매칭이 깨진다.
- 진행률(pct) 은 logistics 를 전혀 반영하지 않는다. 분자 = Σ min(품목별 실제생산량, 품목별 totalQty) (품목마다 목표치로 clamp, 초과분 무시), 분모 = Σ totalQty. `Math.round` 는 백분율 곱한 뒤 딱 한 번. totalQty 합이 0 이면 pct 는 0 (NaN 아님).
- 반면 '완료된 수량' 카드는 logistics 가 한 건이라도 있으면 `총수량 합 + 잔여량 합` 으로 완전히 다른 식이 된다. 없을 때만 호기 실제생산량 합. 그래서 잔여량 입력일에는 '완료된 수량'/'완료된 품목'은 100% 인데 '진행률'만 100 미만인 화면이 정상 동작이다.
- 완료 판정에서 `logisticsByCode[norm] !== undefined` 는 값이 0 이거나 음수여도 완료로 친다. 그리고 logistics 가 없을 때는 `actual >= totalQty && totalQty > 0` — totalQty 가 0 인 품목은 어떤 경우에도 완료로 세지 않는다.
- 행 배경색이 직관과 반대다. 완료 = `bg-green-200`, 진행중(0 < actual < totalQty) = `bg-red-200`, 미착수(actual=0) = 흰색 + `hover:bg-gray-50`. 진행중을 노랑/주황으로 바꾸면 안 된다.
- ± 열의 `bg-red-300` 은 `diff >= 10` 일 때만 — 부호 있는 비교라 +10 이상 초과생산일 때만 칠해지고 -10 은 안 칠해진다.
- ± 열에서 호기 기준 표시는 `actual === 0` 이면 빈 문자열(‘-’ 도 아니고 ‘✓’ 도 아님)을 넣는다. diff===0 이면서 actual>0 일 때만 `✓`.
- '총수량' 열만 `|| '-'` 가 없다 — 0 이면 `0` 이 그대로 보인다. 주문수량·쿠팡·마켓컬리·샘플·실제생산량은 모두 `값 || '-'` 라서 0 이 `-` 로 표시된다.
- 호기별 최신 작업시간은 `[workTime, additionalWorkTime].filter(Boolean).sort().pop()` 로 두 값 중 사전순 최대를 고른 뒤, 3개 호기를 문자열 비교(`>`)로 다시 병합한다. 3개 호기 스냅샷이 따로 도착하므로 이펙트 스코프의 가변 객체 `perMachineTime` 에 호기별 결과를 남겨두고 매 콜백마다 전체를 다시 병합해야 한다.
- '냉각 종료' 열은 최신 작업시간 + 50분(`addMinutes(lt, 50)`, 24시간 랩어라운드)이다. 50 이라는 상수와 `% 24` 를 빼먹지 말 것. 작업시간이 없을 때만 `item.coolingEndTime`(레거시 엑셀 임포트로만 채워짐) 을 쓰고, 그것도 없으면 `-`.
- 붙여넣기에서 '주말' 모드는 5열이고 `cols[4]` 가 총수량이다(마켓컬리는 0 강제). 평일 6열은 `cols[5]`, 평일+샘플 7열은 `cols[6]` 이 총수량, `cols[5]` 가 샘플. 이 인덱스 3종을 헷갈리면 총수량이 통째로 틀어진다.
- `isWeekend` 초기값은 viewDate 가 아니라 브라우저의 실제 오늘 요일(`new Date().getDay()` 가 0 또는 6)로 정해진다. 과거 날짜를 조회 중이어도 초기 모드는 오늘 기준이다.
- '주말' 버튼을 누르면 `setHasSample(false)` 로 샘플 체크가 강제 해제된다. 파싱은 `useSample = !isWeekend && hasSample` 로 한 번 더 방어한다.
- 숫자 파싱 `num()` 은 쉼표를 제거하고, `'-'` 와 빈 문자열을 0 으로, parseFloat 실패도 0 으로 만든다. parseInt 가 아니라 parseFloat 이다.
- 등록 버튼을 누르면 검증·저장 **이전에** `setPasteText('')`, `setShowPaste(false)` 로 패널을 먼저 닫는다. 그리고 alert 은 모두 `setTimeout(..., 50)` 으로 지연 호출한다(렌더와 블로킹 alert 충돌 회피). 원문은 `const text = pasteText` 로 백업해 에러 메시지에 첫 줄 80자를 보여준다.
- 붙여넣기는 `batch.set` 전체 덮어쓰기라 같은 코드를 재등록하면 `actualProduction` 이 0 으로 리셋되고 `coolingEndTime` 필드가 사라진다. 또 이번 붙여넣기에 없는 기존 품목은 삭제되지 않는다(잔존).
- Firestore writeBatch 500건 한도에 대한 분할 처리가 없다. 원본 그대로 재현할 것(품목 수가 수백 건 수준이라 문제가 안 됨).
- '전체 삭제' 확인 문구는 `오늘 데이터를 모두 삭제할까요?` 지만 실제로는 조회 중인 `viewDate` 의 items 만 지운다. entries·logistics·productivity 는 남는다.
- `appMeta/dailyProgress` 쓰기는 `viewDate === todayKey()` 일 때만, 그리고 `useRef` 에 담은 `pct|completedItems|itemCount|totalQty` 시그니처가 바뀔 때만 1회 발생한다. 실패는 `.catch(() => {})` 로 조용히 무시한다. 과거 날짜 조회가 오늘 진행률을 덮어쓰지 않게 하는 게 이 가드의 목적이다.
- 날짜가 바뀔 때 각 구독 이펙트는 진입 즉시 해당 state 를 빈 값으로 리셋한다(`setItems([])`, `setMachineQty({...3개 빈 객체})`, `setLastTimeByCode({})`, `setLogisticsByCode({})`). 이걸 빼면 이전 날짜 데이터가 잠깐 남아 보인다. 3개 호기 구독은 `unsubs.forEach(u => u())` 로 모두 해제해야 한다.
- 로딩 스피너·스켈레톤이 없다. 날짜 전환 직후엔 '이 날짜의 생산 데이터가 없습니다' 빈 상태가 잠깐 보이는 것이 정상 동작이다.
- 품목 목록 정렬은 `compareCode` 의 자연 정렬(알파벳 대문자 localeCompare 후 숫자 정수 비교)이다. 단순 문자열 정렬로 바꾸면 F104 가 F12 앞에 온다.
- `marketKurly`/`샘플` 열은 `items.some(i => i.marketKurly > 0)` / `items.some(i => (i.sample||0) > 0)` 일 때만 헤더와 셀이 **둘 다** 렌더된다. 조건부 열을 헤더만/셀만 넣으면 표가 어긋난다.
- ProcessTimeline 은 대시보드가 아니라 `/analytics`(일별요약)에 있다. 대시보드에 넣지 말 것.
- ProcessTimeline 의 생산성 분자는 공정마다 다르다: 취반기(ck)=bat, 화구(fl)=pot, 나머지(pp/bg/pk)=pot+bat. `Math.round(numerator / (people × (mins/60)))`, people<=0 또는 mins<=0 또는 numerator<=0 이면 0.
- ProcessTimeline 의 `hasAny` 는 `r.start !== null || r.end !== null || r.people` 인데 people 은 truthy 검사라 0명만 입력된 상태는 '데이터 없음'으로 취급된다. 반면 좌측 라벨과 하단 카드의 인원 표시는 `!== undefined && !== null` 검사라 0명도 표시된다.
- ProcessTimeline 축 기본값: valid 행이 하나도 없으면 08:00~18:00(480~1080분)을 쓴다. `axisRange = Math.max(60, axisEnd - axisStart)` 로 0 나눗셈을 막는다. 눈금은 axisStart~axisEnd 를 60분 간격으로 양끝 포함.
- ProcessTimeline 의 `총 가동` 은 valid 공정들의 (end-start) 단순 합이다 — 공정이 시간상 겹쳐도 중복 합산된다(인시가 아님).
- ProcessTimeline 에서 end < start 로 역전 입력된 행은 invalid 로 떨어지고 '종료 시간 미입력' 문구가 나온다(전용 에러 문구가 따로 없다).
- ProcessTimeline 막대 안의 소요시간 텍스트는 `barW > 60`(픽셀) 일 때만 그린다.

## 5부

- `machine` 은 `` `${id}호기` `` 문자열 결합이 전부다 — :id 검증이 없어 /machine/9 는 '9호기' 경로에 실제로 쓰기가 되지만 합산·색상은 1·2·3호기만 보므로 어디에도 안 나타난다. 가드를 추가하지 말 것.
- 1분마다 도는 롤오버 useEffect 가 `date !== effectiveTodayKey()` 면 무조건 되돌린다 → 과거 날짜를 골라도 최대 60초 뒤 자동 복귀한다(버그 아님, 의도된 동작).
- `isToday` 는 `todayKey()` 기준이고 롤오버는 `effectiveTodayKey()`(새벽 2시 전이면 전날) 기준이라, 00:00~01:59 에는 항상 '⚠ 과거 날짜에 입력 중' 이 뜨고 '오늘로' 를 눌러도 60초 안에 전날로 되돌아간다.
- 코드 정규화는 이 화면 전역에서 `toLowerCase()` 뿐 — 하이픈/공백을 지우지 않는다. `normalizeCode`(`[-\s]` 제거)는 completionAlert 의 logistics 조회에서만 쓴다. 섞지 말 것.
- `items`·`entries` 구독은 날짜가 바뀔 때 state 를 비우지 않는다(잔상 허용). 오직 `allMachineQty` 만 `{'1호기':{},'2호기':{},'3호기':{}}` 로 초기화한다.
- entries 정렬 키는 `workTime || additionalWorkTime || ''` 의 문자열 내림차순이고 tie-break 는 `docId` 내림차순 — 자동 ID 는 시간순이 아니므로 '나중 것이 위' 라는 주석과 실제 결과는 다르다. 로직은 그대로 복제할 것.
- 시각이 둘 다 없는 문서는 키가 '' 이라 목록 맨 아래로 내려간다.
- 한 entry 문서에는 실적 쌍(actualProduction+workTime) 또는 추가 쌍(additionalProduction+additionalWorkTime) 중 하나만 존재한다. 없는 필드는 null 이 아니라 부재이며, 그 부재가 `editable={!!e.workTime}` / `{!!e.additionalWorkTime}` 로 수정 가능 여부를 결정한다(불가능한 칸은 회색 '-' 고정).
- 작업시간은 등록 시각으로 자동 기록되고 사용자가 입력·수정할 수 없다. 수량 수정은 단일 필드만 updateDoc 하므로 시각이 안 바뀌어 정렬이 유지된다 — 여기가 설계의 핵심.
- 검색창이 비면 결과 목록 자체가 렌더되지 않는다(`{search && ...}`). `slice(0,30)` 분기는 공백만 입력했을 때(`search` truthy, `q` 빈 문자열)에만 도달한다.
- 품목명 검색은 소문자화한 질의를 원본 `name` 에 `includes` 한다(이름 쪽은 lowercase 하지 않음).
- 이미 목표를 채운 코드는 검색 목록에서 사라져 더 입력할 수 없다. 단 `totalQty <= 0` 인 품목은 항상 목록에 남는다.
- 카드 클릭 시 `setSearch(it.name)` 으로 검색어가 품목명으로 바뀌고, `partial`(0<생산<목표)이면 '추가 생산' 체크가 자동으로 켜진다.
- 행 배경색은 그 행이 아니라 **코드 단위 전 호기 합계** 기준이다 → 같은 코드의 모든 행이 같은 색이고, 다른 호기 입력 때문에 내 행 색이 바뀐다.
- `over100`(합계 ≥ 목표+100 → bg-red-300)이 `shortage`(합계 < 목표 → bg-rose-100)보다 우선한다. target 이 0 이면 무색.
- 내 호기 entries 는 리스너 2개가 중복 구독한다(개별 목록용 + 합산용). 두 값을 합산해 쓰지 말 것 — 이중 계산이 된다.
- 구독 해제 필수: 단일 구독은 `return onSnapshot(...)`, 3호기 합산은 `return () => unsubs.forEach(u => u())`, 롤오버는 `clearInterval`.
- QtyCell 을 빈칸으로 비우고 커밋하면 `Number('') === 0` 이라 0 이 저장된다(문서 삭제가 아님). 음수·NaN 은 저장 없이 원값 복원, 같은 값이면 쓰기 생략.
- 수동 낙관적 갱신 코드는 없다 — 즉시 반영처럼 보이는 것은 Firestore 로컬 에코 덕분이다. 등록·수정·삭제 모두 스냅샷으로만 화면에 돌아온다.
- 등록 후 `search` 를 비워 결과 목록이 접히는 것까지가 정상 동작이며, 성공 토스트·에러 처리·로딩 표시는 일절 없다.
- 중복 등록 차단은 없다. 같은 코드로 여러 줄 쌓는 것이 정상 사용 패턴이다.
- 완료 알림은 `todayKey()`(새벽 2시 규칙 미적용) 기준이며 App 전역에서 돌아간다 — 호기 화면 안에는 알림 코드가 없다.
- `days/{date}/logistics` 문서가 하나라도 있으면 진행률이 무조건 100 으로 덮어써져 완료 알림이 울린다(`hasLogistics ? 100 : pct`).
- 진행률은 품목별 `Math.min(실적, totalQty)` 합을 총수량으로 나눠 `Math.round` 한다 — 초과 생산이 다른 품목 미달을 메꾸지 못한다.
- 알림은 기기별 localStorage(`completionAlert:on`)이고, `completionAlert:notified` 에 날짜를 먼저 기록해 하루 1회만 울린다. 켜는 조작은 헤더 '현황' 버튼 5초 롱프레스.
- `viewDate` localStorage 키는 대시보드와 공유되며 `chosenOn !== todayKey()` 면 무시되고 오늘로 리셋된다.
- 대시보드의 '냉각 종료' 는 그 코드의 최신 작업시각 +50분이다 — 호기에서 등록 버튼을 누른 시각이 그대로 기준이 되므로 잘못된 시각을 고치려면 지우고 다시 등록해야 한다.
- Import.tsx 는 같은 entries 컬렉션에 문서 ID 를 코드값으로 써 넣는다 → docId 가 자동 ID 가 아닌 문서가 섞일 수 있고 tie-break 순서와 삭제 대상에 영향을 준다.
- ProcessTimeline 은 이 화면에 들어가지 않는다(Analytics 전용). 호기 화면에 추가하지 말 것.

## 6부

- 이 화면은 이름과 달리 완전한 읽기 전용이다. addDoc/setDoc/updateDoc/deleteDoc 을 하나도 import 하지 않으며, firestore 에서 가져오는 것은 collection 과 onSnapshot 뿐이다. 검색창·코드 선택·수량 ±·추가생산 체크박스·등록 버튼·인라인 수정·삭제 버튼을 '입력 화면이니까 있겠지' 하고 만들어 넣으면 안 된다.
- ExternalPackEntry 타입은 types.ts 에 선언만 되어 있고 저장소 어디에서도 import/사용되지 않는 죽은 타입이다. 대응하는 Firestore 컬렉션(days/{date}/externalPack 류)도 없다. 타입 선언은 그대로 두되 절대 이 타입으로 문서를 쓰지 말 것.
- shortage(모자란 수량)는 입력값이 아니라 계산값이다. 수식은 (전 호기 합산 실제+추가) − Item.totalQty. 행 자기 수량이 아니라 코드 단위 합산이라, 같은 코드 행이 여러 개면 모든 행에 같은 숫자가 찍힌다.
- 저장 경로는 호기 입력과 완전히 동일하다. /external/1 은 days/{date}/machines/1호기/entries 를 읽는다. 외포장 전용 경로를 새로 만들면 안 된다.
- 발주량 컬럼의 값은 Item.totalQty 다 (ExternalPackEntry 의 shippedQty 이름에 속지 말 것). 대시보드는 같은 필드를 '총수량' 이라고 부른다 — 화면별 라벨 문구를 그대로 지킬 것.
- 코드 정규화는 오직 .toLowerCase() 뿐이다. codeUtil.ts 의 normalizeCode(하이픈·공백 제거)나 canonicalShort 를 쓰면 안 된다. ExternalPack.tsx 는 codeUtil 을 import 조차 하지 않는다.
- 60초 롤오버 타이머가 date !== effectiveTodayKey() 이면 무조건 setDate(eff) 한다. 즉 과거 날짜를 골라도 1분 안에 당일로 되돌아간다. '오늘로' 버튼과 '⚠ 과거 날짜 보는 중' 배지는 그 짧은 순간에만 보인다. 이 동작을 '버그'로 판단해 조건을 추가하지 말고 그대로 재현할 것.
- isToday 는 effectiveTodayKey() 가 아니라 todayKey() 로 비교한다. 그래서 00:00~01:59 에는 롤오버가 date 를 전날로 고정하는데 isToday 는 false 가 되어 과거날짜 경고가 계속 떠 있고, '오늘로' 를 눌러도 1분 안에 전날로 되돌아간다.
- 행 배경색 우선순위를 지킬 것: totalQty>0 일 때만 칠하고, combined<totalQty → bg-red-200, else if multiEntry → bg-green-200, else if combined>totalQty → bg-yellow-200, 나머지는 무색. 호기 입력의 bg-red-300/bg-rose-100 규칙과 섞지 말 것.
- multiEntry = sameMulti || crossMachine. sameMulti 는 '이 호기 안에서 같은 코드 행이 2개 이상', crossMachine 은 '수량이 0보다 큰 호기가 2개 이상'. 수량 0 인 entry 만 있는 호기는 crossMachine 계산에서 세지 않는다.
- 셀 빈값 처리가 컬럼마다 다르다. 주문수량·발주량은 0 이면 '0' 을 그대로 찍고, 실제 생산량(r.actual || '')·추가 생산량(>0 조건)·모자란 수량(0 이면 '')은 빈칸으로 남긴다.
- 모자란 수량은 양수일 때만 '+' 를 붙인다(+30, text-green-700). 음수는 -30 그대로(text-red-700), 0 은 빈칸. 컬럼 이름이 '모자란 수량' 이지만 초과분도 같은 칸에 보여준다.
- entries 정렬 tie-break 는 b.docId.localeCompare(a.docId) 내림차순이다. Firestore auto-ID 는 랜덤이라 실제 생성 순서를 보장하지 않지만 코드 주석대로 그대로 구현할 것. 1차 키는 (workTime || additionalWorkTime || '') 의 내림차순이며, 시각이 아예 없는 문서는 '' 가 되어 맨 아래로 간다.
- 날짜가 바뀔 때 allMachineQty 만 초기화하고 items·entries 는 초기화하지 않는다. 대시보드처럼 setItems([]) 를 추가하면 동작이 달라진다.
- 현재 호기의 entries 컬렉션은 구독 ②와 구독 ③에서 이중으로 구독된다. 최적화한다고 하나로 합치지 말 것.
- 3개 호기 구독의 cleanup 은 반드시 unsubs.forEach(u => u()) 로 전부 해제해야 한다. items/entries 구독은 onSnapshot 반환값을 useEffect 에서 그대로 return 하는 형태다.
- 표 글자 크기 상수는 localStorage 키 'extPackTableFontSize', MIN 12 / MAX 72 / DEFAULT 18 / STEP 2. codeSize = fontSize + 6, cellPadY = max(8, round(fontSize*0.5)), cellPadX = max(8, round(fontSize*0.45)). 이 인라인 스타일은 td 에만 적용되고 th 는 p-2 text-xs 고정이라 커지지 않는다.
- 글자 크기 초기 읽기에서 Number(null) === 0 이라 저장값이 없으면 범위 검사에 걸려 18 이 된다. NaN 도 비교가 false 라 18. 별도 분기 필요 없음.
- 축소 버튼의 글자는 하이픈이 아니라 U+2212 MINUS SIGN 이다('A−'). 리셋 버튼은 U+21BA('↺').
- 시계는 초를 보여주지 않는다: toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) 앞에 '🕐 ' 를 붙인다. 1초 인터벌은 화면 갱신용이며 Firestore 읽기를 유발하지 않는다. cleanup 에서 clearInterval 필수.
- 제목은 '외포장-{id}' 인데 빈 상태 문구는 '{machine}에서 입력된 내역이 없습니다' 로 '1호기에서...' 가 된다. 두 문구의 불일치를 임의로 통일하지 말 것. colSpan 은 7.
- 과거 날짜 경고 문구가 호기 입력과 다르다. 외포장은 '⚠ 과거 날짜 보는 중', 호기는 '⚠ 과거 날짜에 입력 중'.
- 행 구분선은 border-t border-gray-400 이다(기본 border-t 가 아님). 표 헤더는 sticky top-0 z-10 bg-slate-100, 스크롤 박스의 maxHeight 는 'calc(100vh - 200px)'.
- React key 가 `${e.code}-${idx}` 로 인덱스 기반이다(호기 입력은 e.docId). 그대로 둘 것.
- rows useMemo 의 deps 는 [items, entries, combinedByCode] 이고 allMachineQty 는 빠져 있다. combinedByCode 가 allMachineQty 에서 파생되므로 함께 갱신되어 정상 동작한다 — deps 를 '고치면' 동작은 같지만 원본과 달라진다.
- 이 화면은 days/{date}/logistics 를 구독하지 않는다. 잔여량 보정이 입력된 날에는 대시보드가 보여주는 실제 생산량과 외포장 화면의 합산값이 서로 달라지는 것이 정상이다.
- 권한 게이트가 없다. AnalyticsGate 는 /analytics/* 만 감싸므로 /external/:id 는 아무 인증 없이 열린다.
- :id 를 검증하지 않고 `${id}호기` 로 문자열 조립만 한다. /external/9 같은 URL 도 에러 없이 빈 표를 보여준다.
- 본문 컨테이너 폭은 max-w-screen-xl 이다(App.tsx 의 wide 목록에 /external 이 없음).

## 7부

- 실온 카테고리 자동분류는 판정 순서가 전부다: TOGO_ → 본죽키즈_ → '영양밥'으로 끝남 → 나머지 순수본. 그래서 '순수본_한우치즈영양밥' 같은 4종은 카테고리가 '영양밥'이지 '순수본'이 아니다.
- 실온 제품 버튼/자동완성의 표시 라벨은 `name.replace(`${cat}_`, '').replace('순수본_', '')` 2단 치환이다. 영양밥 카테고리 제품은 1차가 안 먹고 2차 '순수본_'이 먹어서 '한우치즈영양밥'으로 나온다. 순서를 바꾸면 결과가 달라진다.
- 실온 '일별 입력'의 추가 버튼은 기존 수량에 더하는 누적(existing.qty + qty)이고, '월별 보기'의 빠른 추가는 절대값 덮어쓰기다. 정반대 동작이며 월별 바에는 '같은 날·같은 제품이 있으면 이 값으로 덮어씁니다.' 라는 안내가 따로 붙는다.
- 실온 문서 ID 는 productSlug() = 항등 함수라 제품명(한글+언더스코어)이 그대로 문서 ID 다. 슬러그화·소문자화·하이픈 변환을 하면 안 된다.
- 실온 문서는 경로에 날짜가 있는데도 date 필드를 반드시 함께 저장해야 한다. 월별 보기가 collectionGroup('ambient') + where('date','>=',`${month}-01`) / <= `${month}-31` 로 조회하기 때문이다 (이 쿼리에는 ambient 컬렉션그룹의 date 단일필드 색인이 필요하다).
- 실온 월별 수량칸은 비제어 입력(defaultValue)이고 key={docId}-{qty} 로 원격 변경 시 강제 remount 된다. onBlur 에서만 저장하고 값이 같으면 쓰지 않는다. 0 이하를 넣으면 setDoc 이 아니라 deleteDoc 이다.
- 실온 월별 자동완성 후보 클릭은 onMouseDown + preventDefault() 로 처리하고 onBlur 닫기를 setTimeout 150ms 로 늦춘다. onClick 으로 바꾸면 blur 가 먼저 터져 선택이 안 된다.
- convertErpCode 는 `^([A-Za-z])-(\d+)-\d+$` 에 맞을 때만 변환하고 안 맞으면 raw.trim() 을 그대로 문서 ID 로 쓴다. 변환식은 대문자화 + parseInt 후 padStart(2,'0') 이라 A-001-01→A-01 이지만 F-528-01→F-528 (3자리는 패딩 안 붙음).
- 잔여량 붙여넣기는 탭(\t) 구분 전용이다. 헤더는 '제품코드' 셀이 정확히 일치하는 첫 줄을 찾고 '등록수량' 열도 있어야 한다. LogisticsInputModal 은 같은 코드가 여러 줄이어도 합산하지 않아 마지막 줄이 이긴다 (Remaining.tsx 의 같은 기능은 합산한다 — 두 화면 결과가 달라질 수 있다).
- 잔여량 파싱에서 qty===0 은 유효값이라 저장된다. 걸러지는 건 빈 코드·NaN·음수뿐이다. 그리고 logistics 문서가 하나라도 존재하면 그 날은 '마감'으로 간주되어 진행률이 100 으로 강제되므로, 수량 0 짜리 문서 하나도 판정을 뒤집는다.
- 잔여량 모달은 날짜를 바꿀 때 existing 맵을 비우지 않아, 새 스냅샷 도착 전까지 이전 날짜 내역이 잠깐 그대로 보인다 (Dashboard 는 반대로 setLogisticsByCode({}) 를 먼저 한다).
- 잔여량 모달의 onClose 에는 부모가 forceRefresh() 를 물려 캐시(`m:{month}`, `pm:{직전월}`)를 지운다. 실온 모달의 onClose 에는 없다. 이 비대칭을 그대로 재현해야 월별 숫자가 갱신된다.
- 완료 알림의 코드 키가 두 종류다: logistics 조회는 소문자화+`/[-\s]/g` 제거 키, 생산량 조회는 code.toLowerCase() 만. Dashboard 와 동일한 (의도된) 불일치이므로 통일하면 안 된다.
- 완료 알림이 감시하는 호기는 ['1호기','2호기','3호기'] 뿐이다. 외포장(external) entries 는 진행률 계산에 들어가지 않는다.
- 완료 알림은 localStorage['completionAlert:on']==='1' 일 때만 구독을 건다 (꺼져 있으면 Firestore 읽기 0). 하루 1회 제한은 localStorage['completionAlert:notified'] 에 날짜를 '발사 직전에 먼저 기록'하는 방식이다.
- 완료 알림 구독은 60초마다 new Date().getDate() 를 비교해 날짜가 바뀌면 해제 후 새 todayKey() 로 재구독한다. 자정을 넘겨 켜둔 기기에서 다음 날 알림이 오려면 이 인터벌이 필요하다.
- 롱프레스는 5000ms 고정이고, 발동하면 consumeClick 이 이어지는 click 을 preventDefault+stopPropagation 으로 삼켜 '현황' 페이지 이동을 막는다. 누르는 동안 onContextMenu 도 막는다.
- fireNotification 의 소리(WebAudio 880Hz 0.18s + 1175Hz 0.2s부터 0.28s)와 진동([300,120,300,120,500])은 Notification 권한과 무관하게 실행된다. 브라우저 알림만 permission==='granted' 조건이 붙고 requireInteraction:true 다.
- productionNotify.ts 에는 실행 코드가 없다 — NotifySettings 타입과 설계 주석뿐이다. 실제 발송 신호는 Dashboard 가 appMeta/dailyProgress 에, Scoop 이 appMeta/scoopProgress 와 webAppUrl POST(mode:'no-cors', Content-Type:'text/plain', body {type:'scoopDone',...})로 낸다.
- appMeta/dailyProgress·scoopProgress 쓰기는 viewDate/date 가 todayKey() 일 때만, 그리고 pct|completed|itemCount(|totalQty) 서명이 바뀔 때만 일어난다(merge:true, catch 묵살). 이 가드를 빼면 쓰기 폭주한다.
- Scoop 의 100% 직접 푸시 중복방지 키는 localStorage['scoopNotified:'+date] 라 기기별이다. 여러 기기가 열려 있으면 기기 수만큼 신호가 나가며, 중복 제거는 Apps Script 쪽 책임이다.
- NotifySettingsPanel 은 webAppUrl 을 편집하지 않는다. setDoc 에 merge:true 를 써야 기존 webAppUrl 이 날아가지 않는다.
- DB 백업의 컬렉션 목록은 하드코딩 상수다 (웹 SDK 는 listCollections() 불가). ROOT 23개 + GROUP 9개 = 32 단위이며, 앱에 새 컬렉션을 추가하면 ROOT_COLLECTIONS/GROUP_COLLECTIONS 에도 반드시 추가해야 백업에 들어간다.
- 백업 페이징은 orderBy(documentId()) + startAfter + limit(500) 이고, 탈출은 snap.empty 또는 snap.size < PAGE. 중단/상한 도달 시 incomplete 문자열('{컬렉션} (사용자 중단)' / '{컬렉션} (읽기 상한 도달)')을 세팅하고 바깥 루프까지 즉시 끊어 그룹 단계를 건너뛴다.
- runBackup 의 maxReads 기본값은 40000 이지만 설정 화면은 Infinity 로 호출한다. 기본값을 그대로 쓰면 큰 DB 에서 조용히 불완전 백업이 된다.
- SQL 테이블명은 경로의 짝수 인덱스 세그먼트만 남겨 '__' 로 잇는다 (days/{d}/machines/{호기}/entries → days__machines__entries). 단 최상위가 appMeta/settings/_config 인 문서는 전부 config_docs 한 테이블에 doc_id/doc_path/data(JSONB) 형태로 들어간다.
- PK 는 그 테이블 안에서 doc_id 가 전부 유일하면 doc_id, 아니면 doc_path 다. 데이터에 따라 달라지므로 고정할 수 없다. 데이터 컬럼에 'date' 가 있으면 idx_{테이블}_date 인덱스를 자동 생성한다.
- validateSql 은 반드시 문자열 리터럴(/'(?:[^']|'')*'/g)을 먼저 제거한 뒤 괄호를 센다. 품목명에 '한우(볶음)-후' 같은 괄호가 들어 있어 그냥 세면 항상 불균형으로 나온다. UI 의 OK/NG 판정은 parenBalanced && wrapped 두 개만 본다.
- 백업 파일명 날짜는 new Date().toISOString().slice(0,10) = UTC 기준이라 한국시간 오전 9시 이전에 받으면 전날 날짜가 붙는다. 불완전 백업이면 파일명에 '_불완전' 접미사가 붙는다.
- downloadSql 은 a.click() 직후 URL.revokeObjectURL 을 호출한다. 순서를 바꾸거나 지연시키지 말 것 (동작은 하지만 원본 그대로 재현).
- 두 입력 모달은 /analytics/* 안에만 있고 AnalyticsGate(settings/analyticsAuth 의 password 문자열 일치, localStorage['analyticsAuthedAt'] 12시간 TTL, 비밀번호가 빈 문자열이면 무조건 통과) 뒤에 있다. 현장 태블릿에서는 열 수 없다는 권한 분기를 빠뜨리지 말 것.
- 모달 defaultDate 는 부모에서 `today.startsWith(month) ? today : `${month}-01`` 로 계산한다. 과거 달을 보고 있으면 그 달 1일이 기본값이 된다. 모달 안에서 날짜를 바꿔도 부모 상태에는 전파되지 않는다.

---

# 부록 B — 1부 교차검증에서 나온 정정

1부(앱 뼈대)만 코드와 대조 검증을 마쳤다. 판정: **minor-gaps**. 아래는 초안 대비 정정·보강 사항이며, **본문과 충돌하면 이쪽이 맞다.**

- 【사실 오류 - index.html robots】 초안은 robots 메타를 `noindex, nofollow` 라고 썼으나 실제는 `<meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />` 이다(googlebot 만 `noindex, nofollow`). 또한 초안이 아예 빠뜨린 것: 저장소에 `public/robots.txt` 가 있고 내용은 `User-agent: *` + `Disallow: /` 2줄이다(빌드 시 dist 루트로 복사됨).
- 【사실 오류 - viewDate 사용처】 초안은 사용처를 Dashboard·Machine·ExternalPack·Report·Analytics·Attendance·ProductivityInput 7곳으로 적었으나 실제는 10곳이다. 빠진 곳: `src/pages/Inventory.tsx`(53~54행), `src/pages/Remaining.tsx`(29·33행), `src/pages/RemainAnalysis.tsx`(88·111행). 특히 RemainAnalysis 는 `const [endDate, setEndDate] = useState(loadViewDate); useEffect(() => { saveViewDate(endDate); }, [endDate]);` 로 **기간 조회의 '종료일'** 을 공유 viewDate 에 써버린다 → 잔여량분석에서 종료일을 바꾸면 다른 모든 페이지의 조회 날짜가 따라 바뀐다. 재현 시 이 부분을 빼면 동작이 달라진다. '오늘로' 버튼을 가진 페이지도 초안 목록(Analytics·Report·Attendance·ProductivityInput·Inventory)에 더해 `Remaining`, `RemainAnalysis`, `ScoopAnalysis` 가 있다.
- 【사실 오류 + 빠진 엣지케이스 - 입력 페이지 자동 롤오버】 초안은 '손으로 고른 과거 날짜는 최대 60초 안에 **오늘로** 되돌아간다'고 썼는데, 코드는 `todayKey()` 가 아니라 `effectiveTodayKey()` 로 되돌린다(Machine.tsx 19~26행, ExternalPack.tsx 20~27행: `const tick = () => { const eff = effectiveTodayKey(); if (date !== eff) setDate(eff); }; const id = setInterval(tick, 60_000); return () => clearInterval(id);`). 따라서 00:00~01:59 사이에는 화면 날짜가 자동으로 **어제**로 바뀐다. 반면 같은 파일의 `const today = todayKey(); const isToday = date === today;` 는 `todayKey()` 기준이라, 이 시간대에는 롤오버 직후 `⚠ 과거 날짜에 입력 중`(ExternalPack 은 `⚠ 과거 날짜 보는 중`) 경고와 `오늘로` 버튼이 **정상 상태인데도** 표시되고, `오늘로`(`setDate(today)`)를 눌러도 60초 안에 다시 어제로 돌아간다. 또 `tick` 은 마운트 즉시 실행되지 않고 첫 60초 뒤부터 돌기 때문에, 마운트 직후에는 loadViewDate 가 준 날짜가 그대로 유지된다.
- 【빠진 분기 - isToday 판정】 `isToday = date === todayKey()` 라 **미래 날짜**를 골라도 false 가 되어 `오늘로` 버튼과 `⚠ 과거 날짜에 입력 중` / `⚠ 과거 날짜 보는 중` 문구가 그대로 뜬다(문구는 '과거'라고만 쓰여 있음). 초안은 '오늘이 아닌 날' 을 과거로만 서술했다.
- 【빠진 규칙 - watchTodayProgress 의 데이터 정제】 초안이 누락한 필터: (1) items 스냅샷은 `snap.docs.map(d => ({ code: String(v.code || ''), totalQty: v.totalQty || 0 })).filter(x => x.code)` 로 **code 가 빈 문자열인 문서를 제외**한 뒤 itemCount/totalQty 를 센다. (2) machines/{호기}/entries 스냅샷은 `const k = String(e.code || '').toLowerCase(); if (!k) return;` 로 코드 없는 엔트리를 건너뛴다. (3) 합산식은 `q[k] = (q[k] || 0) + (e.actualProduction || 0) + (e.additionalProduction || 0)`. 이 정제를 빼면 itemCount/pct 가 달라진다.
- 【빠진 규칙 - 알림 pct 강제 100 은 알림 전용】 초안은 `emit()` 을 '대시보드와 동일 규칙'이라고 코드 주석 그대로 옮겼는데, `hasLogistics ? 100 : pct` 강제 100 은 **completionAlert 에만 있다**. Dashboard.tsx 의 `stats.pct`(141~148행)에는 hasLogistics 오버라이드가 없어 실제 계산값을 그대로 쓰고, KPI 색도 `stats.pct === 100 ? 'green' : stats.pct >= 50 ? 'orange' : 'red'` 로 그 값을 쓴다. 대신 Dashboard 는 `actual`(완료 수량)만 `hasLogistics ? totalQty + Σ(logistics 값) : Σ actualByCode[code.toLowerCase()]` 로 분기한다. 이 문서만 읽고 재현하면 대시보드 진행률까지 100으로 강제하게 되어 지금과 달라진다.
- 【빠진 규칙 - appMeta/dailyProgress 쓰기 상세】 초안 §14 표는 '오늘일 때만 setDoc merge' 로만 뭉뚱그렸다. 실제(Dashboard.tsx 154~167행): `if (viewDate !== todayKey()) return;` 후 `const sig = `${stats.pct}|${stats.completedItems}|${stats.itemCount}|${stats.totalQty}`` 시그니처를 `lastProgressRef` 에 담아 **값이 그대로면 쓰기를 생략**(중복 쓰기 방지)하고, 저장 필드는 `{ date: viewDate, pct, completedItems, itemCount, totalQty, updatedAt: new Date().toISOString() }` 에 `{ merge: true }`, 실패는 `.catch(() => {})` 로 무시. useEffect 의존성은 `[stats.pct, stats.completedItems, stats.itemCount, stats.totalQty, viewDate]`.
- 【빠진 문구·분기 - toggleAlertByLongPress】 (1) confirm 본문의 **첫 줄이 빠졌다**: 실제 문자열은 `'이 기기에서 생산 완료 알림을 받겠습니까?\n\n'` + 초안이 옮긴 3줄 불릿이다. (2) 이 confirm 을 취소하면 `return false`(켜지 않음). (3) 권한 요청은 무조건 하지 않는다 — `let perm = Notification.permission; if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; } }` 이고, 이미 `'denied'` 면 요청 없이 바로 거부 안내 alert 로 간다. (4) 이미 켜져 있을 때 끄기 confirm 을 취소하면 `return true`(켜진 상태 유지). (5) `supportsNotification()` 도 export 되어 있다.
- 【빠진 동작 - 분석 로그아웃 버튼의 갱신 시점】 `analyticsAuthed` 는 상태가 아니라 렌더 중 `localStorage.getItem('analyticsAuthedAt')` 를 직접 읽는다(App.tsx 204행). Header 는 AnalyticsGate 의 로그인 성공으로 리렌더되지 않으므로, 비밀번호를 막 입력해 통과한 직후에는 `🔓 로그아웃` 버튼이 나타나지 않고 **다음 라우트 이동(리렌더) 뒤에야** 보인다. 초안은 이 지연을 적지 않았다.
- 【빠진 엣지케이스 - AnalyticsGate 읽기 실패】 `getDoc(doc(db,'settings','analyticsAuth'))` 이 throw 하면(오프라인·보안규칙 차단) `setPassword`/`setAuthed` 가 모두 호출되지 않아 password 는 초기값 `''` 인 채 잠금 화면이 뜬다. 이 상태에서 `확인` 버튼은 `disabled={!input}` 라 못 누르지만 입력창의 `onKeyDown` 은 `e.key === 'Enter' && submit()` 이라 **빈 칸에서 Enter 를 치면 `input === password`('' === '') 가 성립해 통과**한다. 또 성공 시 `setError(false); setExpired(false); setInput('')` 로 입력값까지 비운다(초안 누락).
- 【뭉뚱그린 부분 - SubNav 의 scrollbar-none】 `<nav className="flex overflow-x-auto scrollbar-none">` 의 `scrollbar-none` 은 tailwind.config.js 에 플러그인이 없고 index.css 에도 정의가 없어 **어디에도 정의되지 않은 죽은 클래스**다(실제로 스크롤바가 숨겨지지 않음). 재현 시 스크롤바 숨김 플러그인을 넣으면 지금과 외형이 달라진다.
- 【빠진 마크업 - 헤더 좌측 그룹 래퍼】 로고+타이틀은 `<div className="flex items-center gap-2 sm:gap-3 min-w-max">` 로 한 번 더 감싸져 있고(초안 누락), PC 네비의 각 항목은 `<span key={l.to} className="flex items-center gap-1">` 로 감싼 뒤 그 안에 구분선과 NavLink 를 넣는다. 또 `title="5초 꾹 누르면 생산 완료 알림을 켜고 끌 수 있습니다"` 는 **PC NavLink 에만** 붙고 모바일 NavLink 에는 없다.
- 【뭉뚱그린 부분 - Dashboard 날짜 네비 클래스】 `오늘로` 버튼 클래스는 초안이 적은 것 앞에 `ml-1` 이 더 붙어 `ml-1 text-xs px-2.5 py-1 rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium` 이고, `<input type="date">` 는 `ml-1 px-2 py-1 text-sm border border-gray-300 rounded bg-white hover:bg-gray-50 text-gray-700 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-900` 이며 `onChange` 에 `e.target.value &&` 가드가 있어 **빈 값이 들어오면 날짜를 바꾸지 않는다**(모바일에서 날짜 지움 방지). ‹ › 버튼은 `w-8 h-8 flex items-center justify-center rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 text-lg`.
- 【빠진 세부 - useLongPress】 `consumeClick` 은 click 을 삼킨 뒤 `firedRef.current = false` 로 되돌린다(다음 클릭은 정상 통과). 타이머 발동 시 순서는 `firedRef.current = true; clear(); onLong();` 이라 콜백 전에 holding 이 꺼진다. 그리고 Machine/ExternalPack 과 달리 `onContextMenu` 는 `holding` 이 true 일 때만 preventDefault 한다(초안은 맞게 적었으나 순서·리셋은 누락).
- 【빠진 정보 - 빌드/설정 파일】 재현에 필요한데 초안에 없는 것: `postcss.config.js`(`plugins: { tailwindcss: {}, autoprefixer: {} }`), 단일 `tsconfig.json`(`strict`, `noUnusedLocals`, `noUnusedParameters`, `jsx: react-jsx`, `moduleResolution: bundler`, `include: ["src"]` — 프로젝트 참조가 없어 `tsc -b` 가 이 하나만 빌드), `src/vite-env.d.ts`(`/// <reference types="vite/client" />` — Logo 의 `image.png` import 타입이 여기서 온다), `image.png` 가 `src/` 도 `public/` 도 아닌 **저장소 루트**에 있다는 점, package.json 의 `deploy` 스크립트(`npm run build && gh-pages -d dist`, 단 gh-pages 는 devDependencies 에 없음), deploy.yml 의 `actions/setup-node@v4` 에 `cache: npm` 설정.

> 2~7부는 검증 단계가 세션 한도로 못 돌았다. `docs/RESUME-NOTE.md` 참고.
