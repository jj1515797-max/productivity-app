# GitHub Pages 자동 배포 설정 (한 번만 하면 됨)

PAT 권한 문제로 workflow 파일은 GitHub 웹에서 직접 만들어야 해.

## 1단계: 워크플로우 파일 만들기

1. GitHub 저장소 (`jj1515797-max/productivity-app`) 페이지로 가
2. 상단 **Add file → Create new file** 클릭
3. 파일명: `.github/workflows/deploy.yml`
4. 아래 내용 그대로 붙여넣기:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main, claude/automate-data-collection-8CHvP]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

5. 하단 **Commit new file** 클릭

## 2단계: GitHub Pages 활성화

1. 저장소 **Settings** 탭
2. 좌측 **Pages** 메뉴
3. **Source**: `GitHub Actions` 선택
4. 저장

## 3단계: 배포 확인

1. **Actions** 탭에서 워크플로우 실행 확인 (~2분 소요)
2. 완료되면 `https://jj1515797-max.github.io/productivity-app/` 접속

이후엔 코드 푸시할 때마다 자동 배포돼.
