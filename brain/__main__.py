# brain/__main__.py — `python -m brain` 启动 WS server。
import asyncio
from brain.server import serve

if __name__ == "__main__":
    print("brain WS server starting on ws://localhost:8787 ...")
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        print("\nbrain WS server stopped.")
