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

1부 뼈대 → 2부 데이터 모델 → **6부 연결 규칙** → 3부 현황 → 4·5부 입력.

6부를 먼저 읽어라. '그날 얼마 만들었나' 를 확정하는 규칙인데, 이게 틀리면
화면은 멀쩡해 보여도 모든 분석 숫자가 조용히 틀어진다. 나머지는 그 규칙을 화면에 입힌 것뿐이다.

