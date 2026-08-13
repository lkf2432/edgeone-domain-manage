"""运行时配置管理。

配置来源优先级（高 → 低）：
    1. settings.json（用户通过配置页保存的运行时配置）
    2. .env / 环境变量（首次启动的初始值）

保存配置时写入 settings.json，并清空已缓存的客户端实例以触发重建。
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict

from dotenv import load_dotenv
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()

# 数据目录：优先使用环境变量 DATA_DIR（Docker 挂载），否则使用应用目录
_DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
SETTINGS_FILE = os.path.join(_DATA_DIR, "settings.json")

# Flask session 密钥（用于签名 cookie）
SECRET_KEY = os.environ.get("SECRET_KEY", "edgeone-management-secret-key-2024")

# EdgeOne 常用接入区域（全球服务，区域参数影响有限）
EDGEONE_REGIONS = [
    ("ap-guangzhou", "广州（推荐）"),
    ("ap-shanghai", "上海"),
    ("ap-beijing", "北京"),
    ("ap-hongkong", "香港"),
    ("ap-singapore", "新加坡"),
    ("ap-tokyo", "东京"),
    ("ap-seoul", "首尔"),
    ("ap-siliconvalley", "硅谷"),
    ("ap-germany", "德国"),
    ("ap-mumbai", "孟买"),
]

# .env 提供的初始值
_ENV_SECRET_ID = os.environ.get("TENCENTCLOUD_SECRET_ID", "")
_ENV_SECRET_KEY = os.environ.get("TENCENTCLOUD_SECRET_KEY", "")
_ENV_REGION = os.environ.get("EDGEONE_REGION", "ap-guangzhou")
APP_PORT = int(os.environ.get("APP_PORT", "8196"))

# 管理员默认密码
_DEFAULT_ADMIN_PASSWORD = "admin"


def _read_file() -> Dict[str, Any]:
    """读取 settings.json，不存在或格式错误时返回空字典。"""
    if not os.path.exists(SETTINGS_FILE):
        return {}
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_file(data: Dict[str, Any]) -> None:
    """写入 settings.json（UTF-8，缩进 2）。"""
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load() -> Dict[str, str]:
    """加载完整配置（settings.json 优先，缺失字段回退 .env）。"""
    f = _read_file()
    return {
        "secretId": f.get("secretId") or _ENV_SECRET_ID,
        "secretKey": f.get("secretKey") or _ENV_SECRET_KEY,
        "region": f.get("region") or _ENV_REGION,
    }


def save(secret_id: str, secret_key: str, region: str) -> Dict[str, str]:
    """保存配置到 settings.json 并返回最新配置。"""
    data = {
        "secretId": (secret_id or "").strip(),
        "secretKey": (secret_key or "").strip(),
        "region": (region or "ap-guangzhou").strip(),
    }
    _write_file(data)
    return data


def mask(secret: str) -> str:
    """密钥脱敏：保留首 4 与末 4 位，中间用 **** 代替。"""
    if not secret:
        return ""
    if len(secret) <= 8:
        return "****"
    return f"{secret[:4]}****{secret[-4:]}"


# 明显的占位符值，视为未配置
_PLACEHOLDER_VALUES = {"", "your_secret_id_here", "your_secret_key_here"}


def is_real_value(value: str) -> bool:
    """判断单个字段值是否为真实密钥（非空且非占位符）。"""
    v = (value or "").strip()
    return bool(v) and v not in _PLACEHOLDER_VALUES


def is_configured(cfg: Dict[str, str] | None = None) -> bool:
    cfg = cfg or load()
    return is_real_value(cfg.get("secretId")) and is_real_value(cfg.get("secretKey"))


# ------------------------------------------------------------------
# 管理员密码管理
# ------------------------------------------------------------------
def get_admin_password_hash() -> str:
    """获取管理员密码哈希值。若未设置则返回默认密码的哈希。"""
    f = _read_file()
    pw_hash = f.get("adminPasswordHash", "")
    if not pw_hash:
        # 首次启动：使用默认密码 admin 生成哈希并持久化
        pw_hash = generate_password_hash(_DEFAULT_ADMIN_PASSWORD)
        f["adminPasswordHash"] = pw_hash
        _write_file(f)
    return pw_hash


def verify_admin_password(password: str) -> bool:
    """验证管理员密码是否正确。"""
    return check_password_hash(get_admin_password_hash(), password)


def change_admin_password(old_password: str, new_password: str) -> bool:
    """修改管理员密码。验证旧密码正确后写入新密码哈希。"""
    if not verify_admin_password(old_password):
        return False
    f = _read_file()
    f["adminPasswordHash"] = generate_password_hash(new_password)
    _write_file(f)
    return True
