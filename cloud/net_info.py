"""打印这台机器可以被谁访问到——给「允许局域网访问.cmd」和排障用。

    python net_info.py
"""
import json
import os
import socket
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

# Set the complete online URL through the environment; keep access codes out of source.
ONLINE_URL = os.environ.get("ANYU_ONLINE_URL", "https://anyu-elder-care.app.workbuddy.host/")


def cfg():
    try:
        with open(os.path.join(ROOT, "config.json"), "r", encoding="utf-8") as f:
            c = json.load(f)
        return int(c["server"]["http_port"]), int(c["server"]["https_port"])
    except Exception:
        return 8080, 8443


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith(("127.", "169.254.")):
                ips.add(ip)
    except Exception:
        pass
    return sorted(ips)


def main():
    http_port, https_port = cfg()
    ips = lan_ips()
    host = socket.gethostname().lower()
    print("")
    print("  线上地址（任何网络、任何设备都能开，不依赖这台电脑开机）：")
    print("    %s" % ONLINE_URL)
    print("")
    print("  这台电脑（只能自己用）：")
    print("    http://127.0.0.1:%d/" % http_port)
    if ips:
        print("")
        print("  同一个 WiFi / 局域网里的其他电脑、手机：")
        for ip in ips:
            print("    电脑  http://%s:%d/" % (ip, http_port))
            print("    手机  https://%s:%d/   （自签名证书，点“继续访问”）" % (ip, https_port))
        print("    备用  https://%s:%d/   （路由器给 IP 变了就用主机名）" % (host, https_port))
    else:
        print("  没拿到局域网 IP，可能没连网络。")
    print("")
    print("  用不了的话按顺序查：")
    print("    1) 服务起来了吗（双击 启动安语.cmd，窗口别关）")
    print("    2) 防火墙放行了吗（管理员运行 允许局域网访问.cmd）")
    print("    3) 两台机器是不是同一个 WiFi，有没有开“访客网络/AP 隔离”")
    print("    4) 手机端必须用 https 才能用麦克风")
    print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
