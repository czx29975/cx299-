# -*- coding: utf-8 -*-
"""把本机的安语服务临时开放到外网，给不在同一网络里的家人/同事用。

原理：cloudflared 反向隧道。本机主动连出去，不需要公网 IP、不需要改路由器、
也不需要动防火墙（因为方向是出站）。

用法：
    python tunnel.py              # 开隧道并打印网址
    python tunnel.py --open       # 顺手用浏览器打开

注意：这是 Cloudflare 的「快速隧道」，网址每次启动都不一样，窗口关掉就失效。
      需要固定网址得用自己的域名 + Cloudflare 账号，见 README。
"""
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(ROOT)
LOCAL = "http://127.0.0.1:8080"
URL_RE = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com")
OUT_FILE = os.path.join(PROJ, "外网地址.txt")


def find_cloudflared():
    """按 项目内 tools → PATH → 用户目录 的顺序找执行文件。"""
    cands = [
        os.path.join(PROJ, "tools", "cloudflared.exe"),
        os.path.join(PROJ, "tools", "cloudflared"),
        os.path.join(os.path.expanduser("~"), "cloudflared.exe"),
    ]
    for p in cands:
        if os.path.isfile(p):
            return p
    from shutil import which
    return which("cloudflared")


def server_ok():
    try:
        with urllib.request.urlopen(LOCAL + "/api/health", timeout=4) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    open_browser = "--open" in sys.argv

    exe = find_cloudflared()
    if not exe:
        print("")
        print("  找不到 cloudflared。请把 cloudflared.exe 放到：")
        print("    %s" % os.path.join(PROJ, "tools", "cloudflared.exe"))
        print("  下载地址：https://github.com/cloudflare/cloudflared/releases/latest")
        print("  （选 cloudflared-windows-amd64.exe，改名成 cloudflared.exe）")
        print("")
        return 2

    if not server_ok():
        print("")
        print("  安语服务没在跑。请先双击「启动安语.cmd」，等窗口出现网址后再运行本脚本。")
        print("")
        return 3

    print("")
    print("  正在建立外网通道，通常 5~15 秒…（窗口别关，关了网址就失效）")
    print("")

    proc = subprocess.Popen(
        [exe, "tunnel", "--url", LOCAL, "--no-autoupdate"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )

    got = {"url": None}

    def pump():
        for line in proc.stdout:
            m = URL_RE.search(line)
            if m and not got["url"]:
                got["url"] = m.group(0)
                url = got["url"]
                bar = "=" * 64
                print("  " + bar)
                print("   外网网址（发给别人就能打开）：")
                print("")
                print("     " + url)
                print("")
                print("   手机也能开；这是 Cloudflare 的正规 HTTPS 证书，不会提示不安全。")
                print("  " + bar)
                print("")
                try:
                    with open(OUT_FILE, "w", encoding="utf-8") as f:
                        f.write(url + "\n")
                    print("   已保存到：%s" % OUT_FILE)
                except Exception:
                    pass
                if open_browser:
                    try:
                        os.startfile(url)
                    except Exception:
                        pass
                print("")
                print("   关掉本窗口 = 网址失效。下次开是新的网址。")
                print("")
            elif line.strip():
                low = line.lower()
                if "error" in low or "failed" in low:
                    print("   [通道日志] " + line.strip()[:120])

    t = threading.Thread(target=pump, daemon=True)
    t.start()

    try:
        while proc.poll() is None:
            time.sleep(0.5)
        print("")
        print("  通道已断开（退出码 %s）。重新运行本脚本会得到新网址。" % proc.returncode)
        print("")
    except KeyboardInterrupt:
        print("")
        print("  正在关闭通道…")
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
