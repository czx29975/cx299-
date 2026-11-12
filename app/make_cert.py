"""重新生成 HTTPS 自签名证书（局域网 IP 变了就运行一次）。

需要本机有 openssl（Git for Windows 自带，或在 Git Bash 里执行）。
    python make_cert.py
生成的文件：app/certs/anyu.crt、app/certs/anyu.key
"""
import os
import socket
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CERTS = os.path.join(ROOT, "certs")


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    ip = lan_ip()
    os.makedirs(CERTS, exist_ok=True)
    crt = os.path.join(CERTS, "anyu.crt")
    key = os.path.join(CERTS, "anyu.key")
    san = "DNS:localhost,DNS:anyu.local,IP:127.0.0.1,IP:%s" % ip
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", crt, "-days", "825",
        "-subj", "/C=CN/O=Anyu/CN=anyu.local",
        "-addext", "subjectAltName=" + san,
    ]
    print("正在为 %s 生成证书……" % ip)
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        print("没有找到 openssl。请安装 Git for Windows，或在 Git Bash 里执行本脚本。")
        return 1
    except subprocess.CalledProcessError as e:
        print("生成失败：%s" % e)
        return 1
    print("完成：\n  %s\n  %s" % (crt, key))
    print("重启服务后生效：手机访问 https://%s:8443/" % ip)
    return 0


if __name__ == "__main__":
    sys.exit(main())
