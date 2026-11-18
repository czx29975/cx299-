"""重新生成 HTTPS 自签名证书（局域网 IP 变了就运行一次）。

需要本机有 openssl（Git for Windows 自带，或在 Git Bash 里执行）。
    python make_cert.py
生成的文件：app/certs/anyu.crt、app/certs/anyu.key

为什么要把 IP 写进证书：手机只认 HTTPS 的麦克风，而地址栏里的 IP 必须出现在证书的
SAN 里，否则浏览器会报"证书名称不匹配"。家里路由器重启后 IP 可能变，重跑一次即可。
"""
import os
import socket
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CERTS = os.path.join(ROOT, "certs")


def lan_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith(("127.", "169.254.")):
                ips.append(ip)
    except Exception:
        pass
    return sorted(set(ips)) or ["127.0.0.1"]


def main():
    ips = lan_ips()
    host = socket.gethostname().lower()
    os.makedirs(CERTS, exist_ok=True)
    crt = os.path.join(CERTS, "anyu.crt")
    key = os.path.join(CERTS, "anyu.key")
    san = ["DNS:localhost", "DNS:anyu.local", "DNS:%s" % host, "IP:127.0.0.1"]
    san += ["IP:%s" % ip for ip in ips]
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", crt, "-days", "825",
        "-subj", "/C=CN/O=Anyu/CN=anyu.local",
        "-addext", "subjectAltName=" + ",".join(san),
    ]
    print("正在生成证书，覆盖地址：%s" % "、".join(ips))
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except FileNotFoundError:
        print("没有找到 openssl。请安装 Git for Windows，或在 Git Bash 里执行本脚本。")
        return 1
    except subprocess.CalledProcessError as e:
        print("生成失败：%s" % (e.stderr or e).decode("utf-8", "replace")[:300])
        return 1
    print("完成：\n  %s\n  %s" % (crt, key))
    print("\n重启服务后生效。手机/别的电脑访问：")
    for ip in ips:
        print("  手机 https://%s:8443/" % ip)
        print("  电脑 http://%s:8080/" % ip)
    return 0


if __name__ == "__main__":
    sys.exit(main())
