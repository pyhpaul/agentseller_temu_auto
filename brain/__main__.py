# brain/__main__.py — `python -m brain` 启动 WS server。
# 配 BRAIN_LLM_BASE_URL 用真实 OpenAI 兼容模型；否则 MockModel（规则式，离线可跑）。
# dev 持久化：启动时自动加载项目根 .env.local（gitignored）到环境，免每次手动 export key。
import asyncio
import os
from brain import server
from brain.model import OpenAICompatModel
from brain.server import serve


def _load_dotenv():
    """加载项目根 .env.local（gitignored）到 os.environ；已存在的变量不覆盖（显式 export 优先）。
    dev-only 配置持久化，免每次重复提供 API key。无文件静默跳过。"""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, ".env.local")
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


if __name__ == "__main__":
    _load_dotenv()
    base = os.environ.get("BRAIN_LLM_BASE_URL")
    if base:
        server._model = OpenAICompatModel(
            base,
            os.environ.get("BRAIN_LLM_API_KEY", ""),
            os.environ.get("BRAIN_LLM_MODEL", "gpt-4o-mini"),
        )
        print("brain: using OpenAICompatModel", os.environ.get("BRAIN_LLM_MODEL", "gpt-4o-mini"))
    else:
        print("brain: using MockModel (set BRAIN_LLM_BASE_URL for a real model)")
    print("brain WS server starting on ws://localhost:8787 ...")
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        print("\nbrain WS server stopped.")
