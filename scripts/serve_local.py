"""로컬 PWA 미리보기 서버 — 바탕화면 아이콘에서 원클릭 실행.

aep-review 는 이제 정적 PWA(`ui/`)라 별도 백엔드(FastAPI)가 없다. 데이터(자막·번역·
vocab)와 오디오는 런타임에 Supabase / Cloudflare R2 에서 직접 가져오므로, 이 스크립트는
그저 `ui/` 폴더를 HTTP 로 서빙하기만 하면 된다(인터넷만 있으면 데이터는 클라우드에서 옴).

왜 단순 더블클릭(file://)이 아니라 서버가 필요한가:
  PWA 가 ES 모듈 import + importmap + 서비스워커를 쓰는데, 브라우저는 이 셋을 http(s)
  오리진에서만 허용한다. 또 앱이 `/app.js` `/manifest.json` 같은 절대경로를 참조하므로
  서빙 루트를 반드시 `ui/` 로 둬야 경로가 맞는다.

개발용이라 캐시를 끈다(no-store) → 서비스워커/브라우저가 옛 셸을 붙들어 수정이 안 보이는
일을 방지. 라이브(Vercel) 배포는 평소 캐싱 그대로다.
"""
from __future__ import annotations

import functools
import http.server
import socket
import sys
import webbrowser
from pathlib import Path

PORT = 8767  # setup_oracle_linux9.sh 의 포트맵상 aep-review 전용 포트
UI_DIR = Path(__file__).resolve().parent.parent / "ui"


class Handler(http.server.SimpleHTTPRequestHandler):
    # ES 모듈/매니페스트가 올바른 MIME 으로 나가도록 명시(구버전 파이썬 대비).
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
    }

    def end_headers(self):
        # 개발 중 옛 셸 캐시로 헷갈리지 않게 — 매 응답 no-store.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):  # 콘솔을 요청 로그로 도배하지 않음
        pass


def lan_ip() -> str:
    """같은 와이파이의 폰이 접속할 PC 의 LAN IP. (실제 라우팅 인터페이스 기준)"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # 패킷을 보내지 않음 — 라우팅만 확인
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main() -> None:
    if not UI_DIR.exists():
        print(f"[오류] ui/ 폴더를 찾을 수 없습니다: {UI_DIR}")
        input("Enter 를 눌러 닫기...")
        sys.exit(1)

    handler = functools.partial(Handler, directory=str(UI_DIR))
    ip = lan_ip()
    url = f"http://localhost:{PORT}/"

    print("=" * 50)
    print("  aep-review · 로컬 PWA 서버")
    print("=" * 50)
    print(f"  PC  →  {url}")
    print(f"  폰  →  http://{ip}:{PORT}/   (같은 와이파이)")
    print()
    print("  폰이 안 뜨면: Windows 방화벽에서 이 포트 인바운드 허용")
    print("  종료: 이 창을 닫거나 Ctrl+C")
    print("=" * 50)

    try:
        webbrowser.open(url)
    except OSError:
        pass

    try:
        with http.server.ThreadingHTTPServer(("0.0.0.0", PORT), handler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
    except OSError as e:
        print(f"\n[오류] 서버를 시작할 수 없습니다 (포트 {PORT} 사용 중일 수 있음): {e}")
        input("Enter 를 눌러 닫기...")
        sys.exit(1)


if __name__ == "__main__":
    main()
