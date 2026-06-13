# brain/__main__.py — `python -m brain` 启动 WS server。
# 配 BRAIN_LLM_BASE_URL 用真实 OpenAI 兼容模型；否则 MockModel（规则式，离线可跑）。
import asyncio
import os
from brain import server
from brain.model import OpenAICompatModel
from brain.server import serve

if __name__ == "__main__":
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
