# -*- coding: utf-8 -*-
"""Stage 2：按 business-report 设计令牌把 final_draft.md 排版为单个完整 HTML。"""
import re
import json
import pathlib
import html as html_lib

BASE = pathlib.Path(r"D:\AI语音养老服务助手\output\9c36f590-273e-4e04-bef8-d8774210a652\stage2")
MD = BASE.parent / "stage1" / "final_draft.md"
TOKENS = pathlib.Path(r"C:\Users\CJX\.workbuddy\plugins\cache\workbuddy-builtin\workbuddy-docx\5.9.3-wb.42398134.gd4692421.h480e8d1fee0f\skills\design-token\tokens\compiled\business-report.json")
OUT = BASE / "formatted-AI语音养老服务助手-功能设计方案.html"

compiled = json.loads(TOKENS.read_text(encoding="utf-8"))
(BASE / "design_tokens.json").write_text(json.dumps(compiled, ensure_ascii=False, indent=2), encoding="utf-8")


def esc(t):
    return html_lib.escape(t, quote=False)


def inline(t):
    t = esc(t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"`(.+?)`", r"<code>\1</code>", t)
    return t


P_STYLE = ("font-family: var(--ff-body); font-size: var(--fs-body); "
           "text-indent: var(--indent-body); line-height: var(--lh-body); "
           "text-align: justify; margin-bottom: var(--spacing-p);")
CHAP_STYLE = ("font-family: var(--ff-heading); font-size: var(--fs-h1); "
              "font-weight: var(--fw-bold); color: var(--color-bg); "
              "background-color: var(--color-primary); text-indent: 0; "
              "text-align: left; padding: var(--spacing-headcell); "
              "margin-top: var(--spacing-section); margin-bottom: var(--spacing-p);")
SUB_STYLE = ("font-family: var(--ff-heading); font-size: var(--fs-h2); "
             "font-weight: var(--fw-bold); color: var(--color-heading); "
             "text-indent: 0; text-align: left; "
             "border-bottom: 1px solid var(--color-border); "
             "padding-bottom: var(--spacing-xs); margin-top: var(--spacing-section); "
             "margin-bottom: var(--spacing-p);")
TH_STYLE = ("font-family: var(--ff-heading); font-size: var(--fs-small); "
            "font-weight: var(--fw-bold); color: var(--color-bg); "
            "background-color: var(--color-primary); text-indent: 0; "
            "text-align: left; padding: var(--spacing-cell);")
TD_STYLE = ("font-family: var(--ff-body); font-size: var(--fs-small); "
            "text-indent: 0; text-align: left; line-height: var(--lh-compact); "
            "padding: var(--spacing-cell); border-bottom: 1px solid var(--color-border);")
QUOTE_STYLE = ("font-family: var(--ff-body); font-size: var(--fs-body); "
               "text-indent: 0; text-align: left; line-height: var(--lh-body); "
               "background-color: var(--color-surface); padding: var(--spacing-quote); "
               "margin-bottom: var(--spacing-xs);")
LI_STYLE = ("font-family: var(--ff-body); font-size: var(--fs-body); "
            "text-indent: 0; text-align: left; line-height: var(--lh-body); "
            "margin-bottom: var(--spacing-xs);")
PRE_STYLE = ("font-family: var(--ff-code); font-size: var(--fs-small); "
             "text-indent: 0; text-align: left; "
             "background-color: var(--color-surface); padding: var(--spacing-md);")


def is_sep(line):
    return bool(re.match(r"^\|[\s\-:|]+\|$", line.strip()))


def split_cells(line):
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def render_table(rows):
    head = rows[0]
    body = rows[1:]
    out = ['<table class="data-table" style="width: 100%; border-collapse: collapse; '
           'margin-bottom: var(--spacing-p);">']
    out.append("<thead><tr>")
    for c in head:
        out.append('<th style="%s">%s</th>' % (TH_STYLE, inline(c)))
    out.append("</tr></thead><tbody>")
    for r in body:
        out.append("<tr>")
        for c in r:
            out.append('<td style="%s">%s</td>' % (TD_STYLE, inline(c)))
        out.append("</tr>")
    out.append("</tbody></table>")
    return "\n".join(out)


CHAPTER_LEADS = [
    "本章说明产品出台的背景与政策依据、要解决的真实痛点，并界定产品定位、设计原则与责任边界，作为后续所有功能设计的判断基准。",
    "本章从使用者与协同方两类视角出发，刻画七类角色的核心诉求、典型一天的场景串联，以及关键触点一旦失效所付出的代价。",
    "本章给出五层架构、十大功能模块的全景与优先级，以及老人端、家属端、社区端与坐席端各自必须具备的能力。",
    "本章是方案主体，逐模块给出设计目标、可拆分的功能条目、优先级、验收要点与典型语音交互示例，可直接用于需求拆分。",
    "本章用三段真实对话展示服药提醒、疑似跌倒联动与防诈骗场景中的话术分寸、确认机制与闭环动作。",
    "本章给出技术分层、关键能力指标、可靠性设计与数据接口原则，供研发、测试与合规评审直接引用。",
    "本章定义优先级口径、三期实施节奏与里程碑，并给出 MVP 的收敛建议以及可逐条验收的清单。",
    "本章按安全、使用、健康、亲情、信任与运营六个维度列出可量化指标，并说明为何把设备弃用率列为第一指标。",
    "本章逐项列出误报、漏报、隐私争议、模型幻觉、服务落地与责任界定等风险，并给出对应的设计或运营对策。",
    "附录汇总 P0 功能速查清单、术语解释与参考政策资料，便于评审、需求拆分与后续版本维护。",
]

lines = MD.read_text(encoding="utf-8").split("\n")
doc_title = "AI 语音养老服务助手功能设计方案"
chapters = []
body_parts = []
i = 0
n = len(lines)

while i < n:
    raw = lines[i].rstrip()
    line = raw.strip()
    if not line:
        i += 1
        continue

    if line.startswith("# "):
        doc_title = line[2:].strip()
        i += 1
        continue

    if line.startswith("## "):
        title = line[3:].strip()
        cid = "section-%d" % (len(chapters) + 1)
        chapters.append({"title": title, "id": cid, "subs": []})
        body_parts.append('<h2 class="section-header" id="%s" style="%s">%s</h2>' % (cid, CHAP_STYLE, inline(title)))
        lead = CHAPTER_LEADS[len(chapters) - 1]
        body_parts.append('<p class="chapter-lead" style="%s">%s</p>' % (P_STYLE, inline(lead)))
        i += 1
        continue

    if line.startswith("### "):
        title = line[4:].strip()
        ch = chapters[-1]
        sid = "%s-%d" % (ch["id"], len(ch["subs"]) + 1)
        ch["subs"].append({"title": title, "id": sid})
        body_parts.append('<h3 class="subsection-header" id="%s" style="%s">%s</h3>' % (sid, SUB_STYLE, inline(title)))
        i += 1
        continue

    if line.startswith("|") and i + 1 < n and is_sep(lines[i + 1]):
        rows = [split_cells(line)]
        i += 2
        while i < n and lines[i].strip().startswith("|"):
            rows.append(split_cells(lines[i]))
            i += 1
        body_parts.append(render_table(rows))
        continue

    if line.startswith(">"):
        quotes = []
        while i < n and lines[i].strip().startswith(">"):
            q = lines[i].strip().lstrip(">").strip()
            quotes.append(q)
            i += 1
        buf = ['<div class="quote-block" style="margin-bottom: var(--spacing-p);">']
        for q in quotes:
            buf.append('<p class="quote-line" style="%s">%s</p>' % (QUOTE_STYLE, inline(q) if q else "&nbsp;"))
        buf.append("</div>")
        body_parts.append("\n".join(buf))
        continue

    if line.startswith("```"):
        i += 1
        code = []
        while i < n and not lines[i].strip().startswith("```"):
            code.append(esc(lines[i]))
            i += 1
        i += 1
        body_parts.append('<pre style="%s"><code>%s</code></pre>' % (PRE_STYLE, "\n".join(code)))
        continue

    if re.match(r"^\d+\.\s", line) or line.startswith("- "):
        ordered = bool(re.match(r"^\d+\.\s", line))
        tag = "ol" if ordered else "ul"
        items = []
        while i < n:
            l = lines[i].strip()
            if ordered and re.match(r"^\d+\.\s", l):
                items.append(re.sub(r"^\d+\.\s+", "", l))
            elif not ordered and l.startswith("- "):
                items.append(l[2:])
            else:
                break
            i += 1
        buf = ['<%s style="margin-bottom: var(--spacing-p); padding-left: var(--spacing-list);">' % tag]
        for it in items:
            buf.append('<li style="%s">%s</li>' % (LI_STYLE, inline(it)))
        buf.append("</%s>" % tag)
        body_parts.append("\n".join(buf))
        continue

    para = [line]
    i += 1
    while i < n:
        nxt = lines[i].strip()
        if (not nxt or nxt.startswith(("#", "|", ">", "```", "- "))
                or re.match(r"^\d+\.\s", nxt)):
            break
        para.append(nxt)
        i += 1
    body_parts.append('<p style="%s">%s</p>' % (P_STYLE, inline(" ".join(para))))

# 目录
toc = ['<ol class="toc-list">']
for ch in chapters:
    toc.append('<li><a href="#%s">%s</a>' % (ch["id"], esc(ch["title"])))
    if ch["subs"]:
        toc.append("<ol>")
        for s in ch["subs"]:
            toc.append('<li><a href="#%s">%s</a></li>' % (s["id"], esc(s["title"])))
        toc.append("</ol>")
    toc.append("</li>")
toc.append("</ol>")
toc_html = "\n".join(toc)

token_vars = "\n".join("    %s: %s;" % (k, v) for k, v in compiled["css_variables"].items())

SUMMARY_P = ("font-family: var(--ff-body); font-size: var(--fs-body); "
             "text-indent: var(--indent-body); text-align: justify; "
             "line-height: var(--lh-body); margin-bottom: var(--spacing-p);")

summary = """
<table class="executive-summary abstract-card" style="width: 100%%; border-collapse: collapse; margin-bottom: var(--spacing-section);">
  <thead><tr><th class="summary" style="font-family: var(--ff-heading); font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--color-bg); background-color: var(--color-primary); text-indent: 0; text-align: left; padding: var(--spacing-headcell);">执行摘要</th></tr></thead>
  <tbody><tr><td style="font-family: var(--ff-body); font-size: var(--fs-body); text-indent: 0; text-align: left; background-color: var(--color-surface); padding: var(--spacing-md); line-height: var(--lh-body);">
    <p class="summary" style="%s">本方案面向居家养老场景，设计一套以语音为唯一主入口的 AI 服务助手。产品以安全应急闭环为底座，覆盖适老语音交互、安全守护、健康与用药、生活服务、情感陪伴、亲情联络、多端协同、适老化无障碍、隐私合规与运营兜底十大模块，共给出可拆分的功能条目、优先级与验收标准。</p>
    <p class="summary" style="%s">核心判断是：付费方与使用方并非同一人，老人愿意用是全部价值的前提。因此一期 MVP 只做三件事——<strong>叫得应、叫得来人、按时吃药</strong>，并把<span class="data-emphasis">设备弃用率</span>列为第一考核指标。高风险场景一律保留人工兜底，AI 不越界做诊断、急救判定与资金决策。</p>
    <p class="summary" style="%s">实施按三期推进：0～3 个月完成 20～30 户试点，4～8 个月扩至 300～500 户，9～15 个月形成可跨区域复制的产品与服务标准。</p>
  </td></tr></tbody>
</table>
""" % (SUMMARY_P, SUMMARY_P, SUMMARY_P)

css = """
  @page { @bottom-center { content: "第 " counter(page) " 页"; } }
  @page cover { @bottom-center { content: none; } }
  section[role="cover"] { page: cover; }

  :root {
%s
    --ff-body: "SimSun", "宋体", serif;
    --ff-heading: "SimHei", "Microsoft YaHei", "黑体", sans-serif;
    --ff-code: "Consolas", monospace;
    --fs-cover: 32pt;
    --fs-h1: 16pt;
    --fs-h2: 13pt;
    --fs-body: 12pt;
    --fs-small: 9pt;
    --fw-bold: 700;
    --color-bg: #FFFFFF;
    --color-border: #D6DEE8;
    --color-divider: #E0E0E0;
    --color-emphasis: #C62828;
    --indent-body: 2em;
    --lh-body: 1.6;
    --lh-compact: 1.35;
    --spacing-xs: 0.25em;
    --spacing-p: 0.6em;
    --spacing-md: 0.8em;
    --spacing-lg: 1.2em;
    --spacing-xl: 2.5em;
    --spacing-section: 1.6em;
    --spacing-cell: 0.35em 0.5em;
    --spacing-headcell: 0.4em 0.7em;
    --spacing-quote: 0.25em 0.7em;
    --spacing-list: 2em;
    --page-content-width: 15.6cm;
  }

  body { font-family: var(--ff-body); font-size: var(--fs-body); color: var(--color-text);
         line-height: var(--lh-body); max-width: var(--page-content-width);
         margin-left: auto; margin-right: auto; background-color: var(--color-bg); }
  .cover-category { font-family: var(--ff-heading); font-size: var(--typography-fontSize-coverCategory);
                    font-weight: var(--fw-bold); color: var(--color-primary);
                    text-align: center; text-indent: 0; margin-bottom: var(--spacing-lg); }
  .cover-title { font-family: var(--ff-heading); font-size: var(--fs-cover);
                 font-weight: var(--fw-bold); color: var(--color-heading);
                 text-align: center; text-indent: 0; line-height: 1.35; margin-bottom: var(--spacing-md); }
  .cover-subtitle { font-family: var(--ff-body); font-size: var(--fs-h2);
                    color: var(--color-textSecondary); text-align: center;
                    text-indent: 0; margin-bottom: var(--spacing-xl); }
  .cover-meta { font-family: var(--ff-body); font-size: var(--fs-body);
                color: var(--color-textSecondary); text-align: center;
                text-indent: 0; margin-bottom: var(--spacing-xs); }
  .toc-title { font-family: var(--ff-heading); font-size: var(--fs-h1);
               font-weight: var(--fw-bold); color: var(--color-heading);
               text-align: center; text-indent: 0; margin-bottom: var(--spacing-lg); }
  .toc-list, .toc-list ol, .toc-list ul { list-style: none; list-style-type: none; }
  .toc-list li { font-family: var(--ff-body); font-size: var(--fs-body);
                 text-indent: 0; margin-bottom: var(--spacing-xs); }
  .toc-list ol li { font-size: var(--fs-small); color: var(--color-textSecondary); }
  .toc-list a { color: var(--color-primary); text-decoration: none; }
  .data-table th, .data-table td { border-bottom: 1px solid var(--color-border); }
  .data-emphasis { color: var(--color-emphasis); font-weight: var(--fw-bold); }
  code { font-family: var(--ff-code); font-size: var(--fs-small); }
  strong { font-weight: var(--fw-bold); }
""" % token_vars

COVER_CAT = ("font-family: var(--ff-heading); font-size: var(--typography-fontSize-coverCategory); "
             "font-weight: var(--fw-bold); color: var(--color-primary); text-align: center; text-indent: 0;")
COVER_TITLE = ("font-family: var(--ff-heading); font-size: var(--fs-cover); font-weight: var(--fw-bold); "
               "color: var(--color-heading); text-align: center; text-indent: 0;")
COVER_SUB = ("font-family: var(--ff-body); font-size: var(--fs-h2); color: var(--color-textSecondary); "
             "text-align: center; text-indent: 0;")
COVER_META = ("font-family: var(--ff-body); font-size: var(--fs-body); color: var(--color-textSecondary); "
              "text-align: center; text-indent: 0;")
TOC_TITLE = ("font-family: var(--ff-heading); font-size: var(--fs-h1); font-weight: var(--fw-bold); "
             "color: var(--color-heading); text-align: center; text-indent: 0;")

html_doc = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="docx-page-size" content="A4">
  <title>%(title)s</title>
  <style>%(css)s</style>
</head>
<body>
  <section role="cover">
    <div class="cover-category" style="%(ccat)s">产品功能设计方案 · V1.0</div>
    <div class="cover-title" style="%(ctitle)s">%(title)s</div>
    <div class="cover-subtitle" style="%(csub)s">以语音为主入口的居家养老安全、健康与陪伴服务设计</div>
    <div class="cover-meta" style="%(cmeta)s">编制日期：2026 年 11 月 10 日</div>
    <div class="cover-meta" style="%(cmeta)s">适用读者：产品、研发、运营、养老服务机构与合作方</div>
  </section>

  <section role="cover">
    <nav class="doc-toc" aria-label="文档目录">
      <div class="toc-title" style="%(toctitle)s">目录</div>
      %(toc)s
    </nav>
  </section>

  <section role="body" data-page-restart="1">
    %(summary)s
    %(body)s
  </section>
</body>
</html>
""" % {
    "title": esc(doc_title),
    "css": css,
    "toc": toc_html,
    "summary": summary,
    "body": "\n".join(body_parts),
    "ccat": COVER_CAT,
    "ctitle": COVER_TITLE,
    "csub": COVER_SUB,
    "cmeta": COVER_META,
    "toctitle": TOC_TITLE,
}

OUT.write_text(html_doc, encoding="utf-8")
print("html=", str(OUT))
print("bytes=", OUT.stat().st_size)
print("chapters=", len(chapters), "subs=", sum(len(c["subs"]) for c in chapters))
print("tables=", len(re.findall(r'<table ', html_doc)))
print("h1=", len(re.findall(r'<h1 ', html_doc)), "h2=", len(re.findall(r'<h2 ', html_doc)), "h3=", len(re.findall(r'<h3 ', html_doc)))
