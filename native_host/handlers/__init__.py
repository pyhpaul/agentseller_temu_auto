"""feature 专属 native handler 包。

通用文件能力在顶层 file_ops.py；这里只放某个 feature 独有、依赖重的 handler，
例如 auto_gen_label 的 bartender（pythonnet + BarTender .NET SDK，Windows-only）。
"""
