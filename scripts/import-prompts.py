"""批量导入 prompt合集.md 到 Supabase"""
import json
import re
import os
import urllib.request

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

CATEGORY_MAP = {
    "prompt生成工程师": "元提示词",
    "语言和沟通专家prompt": "生文",
    "采访问答了解意图": "元提示词",
    "儿童绘图prompt": "生图",
    "儿童科普图片生成": "生图",
    "3-8岁儿童科普绘本插图生成规范（结构化版）": "生图",
    "论文助手prompt": "生文",
    "理性分析者prompt": "分析",
    "分析专家prompt——小盖": "分析",
    "Vibe Coding prompt": "开发",
    "开始前的prompt": "元提示词",
    "编辑网页prompt": "开发",
    "压力测试prompt": "分析",
    "压力测试prompt中文版": "分析",
}

TAG_MAP = {
    "prompt生成工程师": ["提示工程", "多角色"],
    "语言和沟通专家prompt": ["沟通", "社交"],
    "采访问答了解意图": ["采访", "需求分析"],
    "儿童绘图prompt": ["儿童", "绘本", "插画"],
    "儿童科普图片生成": ["儿童", "科普", "绘本"],
    "3-8岁儿童科普绘本插图生成规范（结构化版）": ["儿童", "科普", "绘本", "规范"],
    "论文助手prompt": ["论文", "学术", "文献"],
    "理性分析者prompt": ["分析", "决策", "客观"],
    "分析专家prompt——小盖": ["分析", "决策", "创业"],
    "Vibe Coding prompt": ["编程", "产品", "全栈"],
    "开始前的prompt": ["思考", "假设检验"],
    "编辑网页prompt": ["HTML", "编辑器", "网页"],
    "压力测试prompt": ["决策", "压力测试", "英文"],
    "压力测试prompt中文版": ["决策", "压力测试"],
}


def parse_prompts(filepath: str) -> list[dict]:
    with open(filepath, "r", encoding="utf-8") as f:
        text = f.read()

    # Remove YAML frontmatter
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            text = text[end + 3:].strip()

    # Split by # ==title== pattern
    parts = re.split(r"(?=^# ==)", text, flags=re.MULTILINE)
    prompts = []

    for part in parts:
        part = part.strip()
        if not part:
            continue

        # Extract title
        title_match = re.match(r"^# ==(.+?)==\s*$", part, re.MULTILINE)
        if not title_match:
            continue

        title = title_match.group(1).strip()
        content = part[title_match.end():].strip()

        # Remove trailing --- separator
        content = re.sub(r"\n---\s*$", "", content).strip()

        category = CATEGORY_MAP.get(title, "生文")
        tags = [t for t in TAG_MAP.get(title, []) if t != category]

        prompts.append({
            "title": title,
            "content": content,
            "category": category,
            "tags": tags,
            "variables": [],
            "created_by": "camille",
        })

    return prompts


def insert_to_supabase(prompts: list[dict]):
    url = f"{SUPABASE_URL}/rest/v1/prompts"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }

    for p in prompts:
        data = json.dumps(p).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req) as resp:
                result = json.loads(resp.read())
                print(f"  ✓ {p['title']} ({p['category']})")
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            print(f"  ✗ {p['title']}: {e.code} {body}")


if __name__ == "__main__":
    filepath = "/home/ddzhang16/prompt合集.md"
    prompts = parse_prompts(filepath)
    print(f"解析到 {len(prompts)} 条提示词:\n")
    for p in prompts:
        print(f"  [{p['category']}] {p['title']} (标签: {', '.join(p['tags'])})")

    print(f"\n开始导入到 Supabase...\n")
    insert_to_supabase(prompts)
    print(f"\n导入完成!")
