"""日志配置模块：同时输出到文件和控制台。

使用方式：
    from logger_setup import get_logger
    logger = get_logger(__name__)
    logger.info("xxx")
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone, timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path


# 日志目录：优先使用环境变量 DATA_DIR/logs（Docker 挂载），否则使用应用目录/logs
_DATA_DIR = os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent))
_LOG_DIR = Path(_DATA_DIR) / "logs"
_LOG_DIR.mkdir(parents=True, exist_ok=True)
_LOG_FILE = _LOG_DIR / "app.log"

_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# 固定使用 UTC+8 时区（北京时间），避免容器内时区为 UTC 导致日志时间偏差
_CST = timezone(timedelta(hours=8))


def _cst_time(*args):
    """将日志时间戳转换为北京时间 (UTC+8)。"""
    return datetime.now(_CST).timetuple()


_configured = False


def setup_logger(level: int = logging.INFO) -> None:
    """配置根日志记录器，重复调用只生效一次。"""
    global _configured
    if _configured:
        return

    root = logging.getLogger()
    root.setLevel(level)

    # 避免重复添加 handler
    root.handlers.clear()

    formatter = logging.Formatter(_LOG_FORMAT, _DATE_FORMAT)
    formatter.converter = _cst_time

    # 控制台输出
    sh = logging.StreamHandler()
    sh.setFormatter(formatter)
    sh.setLevel(level)
    root.addHandler(sh)

    # 文件输出（滚动：单文件最大 5MB，保留 10 份）
    fh = RotatingFileHandler(
        str(_LOG_FILE),
        maxBytes=5 * 1024 * 1024,
        backupCount=10,
        encoding="utf-8",
    )
    fh.setFormatter(formatter)
    fh.setLevel(level)
    root.addHandler(fh)

    _configured = True


def get_logger(name: str = "app") -> logging.Logger:
    """获取命名日志记录器。"""
    setup_logger()
    return logging.getLogger(name)


def get_log_file() -> Path:
    """返回日志文件路径。"""
    return _LOG_FILE


def tail_log(lines: int = 200, keywords: list[str] | None = None) -> list[str]:
    """读取日志文件末尾 N 行（用于前端展示）。

    Args:
        lines: 读取行数（从末尾起）
        keywords: 若提供则只返回包含任一关键字的行（不区分大小写）
    """
    if not _LOG_FILE.exists():
        return []
    try:
        with open(_LOG_FILE, "r", encoding="utf-8") as f:
            all_lines = f.readlines()
    except OSError:
        return []

    lines_list = [line.rstrip("\n") for line in all_lines[-lines:]]

    if keywords:
        kw_lower = [k.lower() for k in keywords]
        lines_list = [
            ln for ln in lines_list
            if any(k in ln.lower() for k in kw_lower)
        ]

    return lines_list


def clear_log() -> None:
    """清空当前日志文件。"""
    try:
        with open(_LOG_FILE, "w", encoding="utf-8") as f:
            f.truncate(0)
    except OSError:
        pass
