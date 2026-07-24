# 게임 추가 방법

1. `src/games/<id>/` 폴더를 만든다. (`<id>`는 URL에 쓰이는 소문자-하이픈 slug)
2. 그 폴더 안에 최소 `game.ts` 하나를 만들고 `mount`를 named export 한다
   (dynamic import한 모듈 네임스페이스가 곧 `GameModule` 형태여야 하므로
   `export default` 대신 반드시 named export를 쓴다):

   ```ts
   import type { GameCleanup } from "../../shared/types";

   export function mount(container: HTMLElement): GameCleanup | void {
     container.innerHTML = "<p>여기에 게임을 그린다</p>";
     // 필요하면 정리(cleanup) 함수를 반환한다
     return () => {
       /* 이벤트 리스너 해제 등 */
     };
   }
   ```

3. 게임 전용 스타일이 필요하면 같은 폴더에 `style.css`를 두고 `game.ts` 맨 위에서
   `import "./style.css";` 한다. (Vite가 알아서 번들에 포함시켜준다)
4. `src/games/registry.ts`에 메타데이터를 추가한다:

   ```ts
   {
     id: "example",
     title: "예시 게임",
     description: "한 줄 설명",
     minPlayers: 2,
     maxPlayers: 2,
     load: () => import("./example/game"),
   }
   ```

5. `npm run dev`로 확인 후 커밋한다.

## 규칙

- 게임 폴더끼리 서로 import하지 않는다. 공통 로직은 `src/shared/`에 둔다.
- 보드 상태는 게임 모듈 내부(클로저)에 두고, 전역 상태를 만들지 않는다.
- `mount()`가 두 번째 호출돼도 안전하게 동작해야 한다 (라우터가 매번 새로
  container를 비우고 다시 부르므로).
