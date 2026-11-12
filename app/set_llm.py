"""命令行接入大模型：填 Key → 立即真实调用验证 → 写库生效。

用法：
    python set_llm.py                    # 交互式，按提示粘贴 Key
    python set_llm.py --status           # 查看当前配置
    python set_llm.py --clear            # 清除配置
    python set_llm.py --provider zhipu --key sk-xxx
"""
import argparse
import sys
import time

import ai
import db
import service

PROVIDERS = {
    "deepseek": ("https://api.deepseek.com/v1", "deepseek-chat", "DeepSeek"),
    "zhipu": ("https://open.bigmodel.cn/api/paas/v4", "glm-4-flash", "智谱 GLM-4-Flash（有免费额度）"),
    "qwen": ("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", "通义千问"),
    "moonshot": ("https://api.moonshot.cn/v1", "moonshot-v1-8k", "月之暗面 Kimi"),
    "openai": ("https://api.openai.com/v1", "gpt-4o-mini", "OpenAI"),
    "ollama": ("http://127.0.0.1:11434/v1", "qwen2.5:7b", "本机 Ollama"),
}


def show_status():
    s = ai.status()
    print("当前配置")
    print("  状态    :", "已接入" if s["configured"] else "未接入（对话走内置指令）")
    print("  接口地址:", s["base_url"] or "(空)")
    print("  模型    :", s["model"] or "(空)")
    print("  Key     :", s["key_hint"] or "(空)")
    if s.get("last_error") and s["last_error"].get("message"):
        print("  上次失败:", s["last_error"]["message"])
    return 0


def guess_provider(base):
    for name, (b, _m, _l) in PROVIDERS.items():
        if b and base.startswith(b.rstrip("/")):
            return name
    return "custom"


def resolve(args):
    provider = args.provider
    base, model, label = ("", "", "")
    if provider and provider in PROVIDERS:
        base, model, label = PROVIDERS[provider]
    if args.base:
        base = args.base
        if not provider:
            provider = guess_provider(base)
    if args.model:
        model = args.model
    if args.key is None:
        print("── 接入大模型 ──")
        print("可用的服务商：")
        for i, (k, (_b, _m, lab)) in enumerate(PROVIDERS.items(), 1):
            print("  %d) %-8s %s" % (i, k, lab))
        print()
        if not provider:
            choice = input("选服务商（直接回车用 deepseek）：").strip()
            provider = list(PROVIDERS)[int(choice) - 1] if choice.isdigit() else (choice or "deepseek")
            if provider in PROVIDERS:
                base, model, label = PROVIDERS[provider]
        print("接口地址：%s" % (base or "(需另填)"))
        print("模型名称：%s" % (model or "(需另填)"))
        print()
        print("请粘贴 API Key（输入后回车，不会显示在屏幕上）：")
        import getpass
        key = getpass.getpass("> ").strip()
        if not key:
            print("没有输入 Key，已取消。")
            return None
        return key, base, model
    return args.key.strip(), base, model


def run_test():
    row = db.q1("SELECT id FROM elders ORDER BY id LIMIT 1")
    if not row:
        print("提示：还没有老人档案，跳过对话测试（配置已保存）。")
        return 0
    eid = row["id"]
    print("正在用真实对话测试（最多等 30 秒）…")
    t0 = time.time()
    obj, mode = ai.ask_llm(eid, "你好，随便跟我说一句话。")
    ms = int((time.time() - t0) * 1000)
    if mode == "llm" and obj:
        print()
        print("  接入成功  ✓   用时 %d ms" % ms)
        print("  模型回话：%s" % (obj.get("reply") or "").strip())
        act = (obj.get("action") or {}).get("name")
        if act and act != "none":
            print("  识别动作：%s" % act)
        print()
        print("老人端再说话，右上角标签会显示「大模型对话中」。")
        return 0
    print()
    print("  接入失败  ✗")
    err = (ai.LAST_ERROR.get("message") or "").strip()
    print("  原因：%s" % (err or ("调用返回 %s" % mode)))
    if mode == "not-configured":
        print("  Key、地址或模型名有空项。")
    elif mode == "http-404":
        print("  检查接口地址是否以 /v1 结尾、模型名是否拼对。")
    print()
    print("  配置已保存，修好后可以重新运行本脚本测试。")
    return 1


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--key", help="API Key")
    ap.add_argument("--base", help="接口地址")
    ap.add_argument("--model", help="模型名")
    ap.add_argument("--provider", choices=list(PROVIDERS), help="服务商")
    ap.add_argument("--status", action="store_true", help="查看当前配置")
    ap.add_argument("--clear", action="store_true", help="清除配置")
    ap.add_argument("--no-test", action="store_true", help="只保存，不测试")
    args = ap.parse_args()

    if args.status:
        return show_status()
    if args.clear:
        ai.clear_llm()
        print("已清除。对话已退回内置指令引擎。")
        return 0

    got = resolve(args)
    if not got:
        return 2
    key, base, model = got
    if not key:
        print("Key 为空，已取消。")
        return 2

    ai.set_llm(key, base, model)
    st = ai.status()
    print()
    print("已保存：%s · %s · %s" % (st["model"], st["base_url"], st["key_hint"]))
    if not st["configured"]:
        print("地址或模型名为空，请用 --base 和 --model 补全。")
        return 1
    if args.no_test:
        return 0
    return run_test()


if __name__ == "__main__":
    sys.exit(main())
