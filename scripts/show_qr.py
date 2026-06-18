"""show_qr.py — aep-review PWA URL 을 QR 로 표시.

사용:
    py scripts/show_qr.py                 # LAN IP 자동 감지
    py scripts/show_qr.py --ip 192.168.0.5
    py scripts/show_qr.py --port 8767
    py scripts/show_qr.py --open          # QR PNG 브라우저로 열기
"""
from __future__ import annotations

import argparse
import socket
import sys
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

DEFAULT_PORT = 8767


def detect_lan_ip() -> str:
    candidates: list[str] = []
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None, family=socket.AF_INET):
            ip = info[4][0]
            if ip and ip not in candidates:
                candidates.append(ip)
    except Exception:
        pass

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip not in candidates:
            candidates.append(ip)
    except Exception:
        pass

    def score(ip: str) -> int:
        if ip.startswith("192.168."):
            return 0
        if ip.startswith("172."):
            try:
                second = int(ip.split(".")[1])
                if 16 <= second <= 31:
                    return 1
            except Exception:
                pass
        if ip.startswith("10."):
            try:
                second = int(ip.split(".")[1])
                if second <= 4:
                    return 2
                return 4
            except Exception:
                return 4
        if ip.startswith("127."):
            return 9
        return 5

    if not candidates:
        return "127.0.0.1"
    candidates.sort(key=score)
    return candidates[0]


def render_ascii_qr(url: str) -> bool:
    try:
        import qrcode  # type: ignore
    except ModuleNotFoundError:
        return False

    qr = qrcode.QRCode(border=1, box_size=10)
    qr.add_data(url)
    qr.make(fit=True)

    print()
    qr.print_ascii(invert=True)
    print()

    try:
        png_path = Path(__file__).parent / "aep_qr.png"
        img = qr.make_image(fill_color="black", back_color="white")
        img.save(png_path)
        print(f"[+] PNG 저장: {png_path}")
    except Exception as e:
        print(f"[!] PNG 저장 실패: {e}")
    return True


def render_web_qr(url: str, open_browser: bool) -> None:
    qr_url = (
        "https://api.qrserver.com/v1/create-qr-code/"
        f"?size=400x400&data={urllib.parse.quote(url, safe='')}"
    )
    print()
    print("[i] qrcode 라이브러리 없음 — 외부 QR 서비스로 대체:")
    print(f"    → {qr_url}")
    print()
    print("    한 번만 설치 권장: py -m pip install qrcode[pil]")
    print()

    try:
        png_path = Path(__file__).parent / "aep_qr.png"
        urllib.request.urlretrieve(qr_url, png_path)
        print(f"[+] PNG 다운로드: {png_path}")
        if open_browser:
            webbrowser.open(str(png_path))
    except Exception as e:
        print(f"[!] PNG 다운로드 실패 (인터넷?): {e}")
        if open_browser:
            webbrowser.open(qr_url)


def main() -> int:
    p = argparse.ArgumentParser(description="aep-review PWA URL → QR")
    p.add_argument("--ip", default=None)
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--open", action="store_true")
    args = p.parse_args()

    ip = args.ip or detect_lan_ip()
    url = f"http://{ip}:{args.port}"

    print("=" * 60)
    print(f"  AEP Review PWA URL : {url}")
    print(f"  감지된 LAN IP       : {ip}")
    print("=" * 60)

    if not render_ascii_qr(url):
        render_web_qr(url, args.open)

    print()
    print("폰에서:")
    print("  1) 카메라로 QR 스캔 → 알림 탭 → 브라우저로 열기")
    print("  2) iOS Safari : 공유 → '홈 화면에 추가'")
    print("     Android Chrome : 우상단 ⋮ → '홈 화면에 추가' / '앱 설치'")
    print("  3) 끝. 홈 아이콘 한 번에 PWA 풀스크린.")
    print()
    print("[!] 폰이 같은 Wi-Fi 에 있어야 합니다.")
    print(f"[!] 첫 시도 실패 시 방화벽 인바운드 {args.port} 허용 필요:")
    print(f'    pwsh -c "New-NetFirewallRule -DisplayName ''aep-review PWA'' '
          f'-Direction Inbound -Protocol TCP -LocalPort {args.port} -Action Allow -Profile Private,Public"')
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
