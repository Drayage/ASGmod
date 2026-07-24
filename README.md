# ASGmod

브라우저에서 바로 즐기는 간단한 추상 전략 게임(Abstract Strategy Game) 모음.
정적 사이트로 빌드해 GitHub Pages에 배포하며, PWA로 오프라인 설치도 지원한다.

## 구조

```
index.html            앱 진입점 (SPA)
src/
  main.ts             부트스트랩
  router.ts           해시 라우터 (#/ 허브, #/game/<id> 게임 화면)
  style.css            전역 스타일 (라이트/다크 자동 대응)
  pwa.ts               서비스 워커 등록
  shared/
    types.ts          모든 게임이 구현하는 GameModule 인터페이스
    board.ts          격자형 보드 렌더링 공용 헬퍼
  games/
    registry.ts        게임 목록 (여기에 새 게임을 등록)
    README.md          새 게임 추가 방법
    <game-id>/         게임별 폴더 (game.ts, style.css 등)
public/
  favicon.svg
  icons/               PWA 아이콘 (postinstall 스크립트가 생성, git에는 미포함)
scripts/
  generate-icons.mjs   플레이스홀더 PWA 아이콘 생성 스크립트
.github/workflows/
  deploy.yml           main 브랜치 push 시 GitHub Pages 자동 배포
```

각 게임은 자기 폴더 안에 갇혀 있고, 서로 import하지 않는다. 공용 로직은
`src/shared/`에 둔다. 새 게임 추가 절차는 `src/games/README.md` 참고.

## 개발

```bash
npm install   # postinstall이 PWA 아이콘도 생성한다
npm run dev
```

## 빌드 / 미리보기

```bash
npm run build
npm run preview
```

## 배포 (GitHub Pages)

1. 저장소 Settings → Pages → Source를 **GitHub Actions**로 설정한다.
2. `main` 브랜치에 push하면 `.github/workflows/deploy.yml`이 빌드 후 자동 배포한다.
3. 배포 주소는 `https://<user>.github.io/asgmod/` 형태이며, 이는
   `vite.config.ts`의 `BASE_PATH`와 반드시 일치해야 한다. 저장소 이름이
   바뀌거나 커스텀 도메인을 쓰면 `BASE_PATH`도 함께 바꿔줘야 한다
   (커스텀 도메인이면 `"/"`).

## PWA

`vite-plugin-pwa`가 빌드 시 서비스 워커와 매니페스트를 생성한다
(`registerType: "autoUpdate"`로 새 배포가 있으면 자동 갱신). 아이콘은
`scripts/generate-icons.mjs`가 만드는 플레이스홀더이므로, 실제 아이콘이
생기면 `public/icons/`에 같은 파일명으로 교체하고 `.gitignore`에서
`public/icons/*.png` 줄을 지우면 된다.
