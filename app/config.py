"""配置加载：config.json + 环境变量覆盖 + 数据库内设置（大模型 Key）。"""
import json
import os
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(ROOT, "config.json")

_lock = threading.Lock()
_cache = None


def _defaults():
    return {
        "app": {"name": "安语", "subtitle": "居家养老语音助手"},
        "server": {"host": "0.0.0.0", "http_port": 8080, "https_port": 8443,
                   "db_path": "data/anyu.db"},
        "llm": {"base_url": "https://api.deepseek.com/v1", "api_key": "",
                "model": "deepseek-chat", "temperature": 0.3, "timeout": 25},
    }


def _merge(base, extra):
    out = dict(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load():
    global _cache
    with _lock:
        cfg = _defaults()
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                    cfg = _merge(cfg, json.load(f))
            except Exception as e:
                print("[config] 读取 config.json 失败，使用默认值：%s" % e)
        # 环境变量优先于文件
        if os.environ.get("ANYU_LLM_KEY"):
            cfg["llm"]["api_key"] = os.environ["ANYU_LLM_KEY"]
        if os.environ.get("ANYU_LLM_BASE"):
            cfg["llm"]["base_url"] = os.environ["ANYU_LLM_BASE"]
        if os.environ.get("ANYU_LLM_MODEL"):
            cfg["llm"]["model"] = os.environ["ANYU_LLM_MODEL"]
        if os.environ.get("ANYU_PORT"):
            cfg["server"]["http_port"] = int(os.environ["ANYU_PORT"])
        # 相对路径统一按 app/ 目录解析
        p = cfg["server"]["db_path"]
        if not os.path.isabs(p):
            cfg["server"]["db_path"] = os.path.normpath(os.path.join(ROOT, p))
        else:
            cfg["server"]["db_path"] = os.path.normpath(p)
        _cache = cfg
        return cfg


def get():
    return _cache or load()


def db_path():
    return get()["server"]["db_path"]
