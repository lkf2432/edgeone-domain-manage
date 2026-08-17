"""自动更新源站组 IP 的调度器模块。

功能：
- 定时检测本机/公网 IP，变化时自动更新 EdgeOne 源站组
- 支持网卡获取 / 公网接口获取两种方式
- 支持 IPv4 / IPv6
- 支持 webhook 消息推送（钉钉/企微）
- 配置持久化到 ddns_config.json
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

import settings
from edgeone_client import EdgeOneClient, EdgeOneError
from ip_detector import detect_ip, list_network_interfaces
from logger_setup import get_logger
from notifier import send_message

_log = get_logger("ddns")

# 北京时间 UTC+8
_CST = timezone(timedelta(hours=8))

CONFIG_FILE = os.path.join(os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__))), "ddns_config.json")

# 调度器单例
_scheduler_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()
_lock = threading.Lock()


def _default_config() -> Dict[str, Any]:
    return {
        "enabled": False,
        "zoneId": "",
        "groupId": "",
        "groupName": "",
        "interval": 300,           # 更新间隔（秒），默认 5 分钟
        "ipType": "ipv4",          # ipv4 / ipv6
        "method": "network_interface",  # network_interface / external_api
        "interfaceName": "",       # 网卡名称，为空自动选择
        "webhookUrl": "",          # webhook 地址
        "webhookEnabled": False,   # 是否启用推送
        "webhookTemplate": "",     # 自定义消息模板，为空则使用默认模板
        "lastIp": "",              # 上次更新的 IP
        "lastUpdate": "",          # 上次更新时间
        "lastStatus": "",          # 上次状态：success / fail / pending
        "lastMessage": "",         # 上次消息
    }


# 默认 webhook 消息模板（Markdown 格式）
_DEFAULT_TEMPLATE = """### {title}

**源站组**: {group_name}
**旧 IP**: {old_ip}
**新 IP**: {new_ip}
**状态**: {status}
**时间**: {time}"""


def _render_template(template: str, variables: Dict[str, str]) -> str:
    """渲染消息模板，安全替换变量。

    支持的变量：{title} {group_name} {old_ip} {new_ip} {status} {time} {message}
    """
    if not template or not template.strip():
        template = _DEFAULT_TEMPLATE
    try:
        return template.format(**{k: (v or "") for k, v in variables.items()})
    except (KeyError, IndexError, ValueError):
        # 模板语法错误时回退到默认
        return _DEFAULT_TEMPLATE.format(**{k: (v or "") for k, v in variables.items()})


def load_config() -> Dict[str, Any]:
    """读取 DDNS 配置。"""
    if not os.path.exists(CONFIG_FILE):
        return _default_config()
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            cfg = _default_config()
            cfg.update(data)
            return cfg
    except (OSError, json.JSONDecodeError):
        return _default_config()


def save_config(data: Dict[str, Any]) -> Dict[str, Any]:
    """保存 DDNS 配置。"""
    cfg = load_config()
    cfg.update(data)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return cfg


def get_status() -> Dict[str, Any]:
    """获取当前状态（配置 + 运行状态）。"""
    cfg = load_config()
    cfg["running"] = _scheduler_thread is not None and _scheduler_thread.is_alive()
    cfg["interfaces"] = list_network_interfaces()
    return cfg


def start_scheduler() -> bool:
    """启动调度器线程。"""
    global _scheduler_thread, _stop_event
    with _lock:
        if _scheduler_thread is not None and _scheduler_thread.is_alive():
            return True
        _stop_event = threading.Event()
        _scheduler_thread = threading.Thread(target=_run_loop, daemon=True, name="ddns-scheduler")
        _scheduler_thread.start()
        _log.info("[DDNS] 调度器已启动")
        return True


def stop_scheduler() -> bool:
    """停止调度器线程。"""
    global _scheduler_thread
    with _lock:
        if _scheduler_thread is None or not _scheduler_thread.is_alive():
            return True
        _stop_event.set()
        _scheduler_thread.join(timeout=10)
        _scheduler_thread = None
        _log.info("[DDNS] 调度器已停止")
        return True


def restart_scheduler() -> bool:
    """重启调度器。"""
    stop_scheduler()
    return start_scheduler()


def apply_config_and_restart(new_config: Dict[str, Any]) -> Dict[str, Any]:
    """保存配置并根据 enabled 状态启动/停止调度器。"""
    cfg = save_config(new_config)
    if cfg.get("enabled"):
        restart_scheduler()
    else:
        stop_scheduler()
    return get_status()


def auto_start() -> None:
    """应用启动时自动恢复调度器状态。

    读取已保存的配置，若 enabled=true 则自动启动后台调度线程。
    解决进程重启（升级/刷新）后调度器丢失的问题。
    """
    cfg = load_config()
    if cfg.get("enabled"):
        _log.info("[DDNS] 检测到配置已启用，自动启动调度器...")
        start_scheduler()
    else:
        _log.info("[DDNS] 配置未启用，调度器保持停止")


def run_once() -> Dict[str, Any]:
    """手动执行一次 IP 检测和更新。"""
    return _do_update(load_config())


def _run_loop():
    """调度器主循环。"""
    while not _stop_event.is_set():
        try:
            cfg = load_config()
            if not cfg.get("enabled"):
                _log.info("[DDNS] 配置已禁用，退出调度循环")
                break
            _do_update(cfg)
        except Exception as e:
            _log.error("[DDNS] 调度循环异常: %s", e)

        interval = cfg.get("interval", 300) if 'cfg' in dir() else 300
        # 分段等待，便于快速响应停止
        for _ in range(interval):
            if _stop_event.is_set():
                return
            time.sleep(1)


def _do_update(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """执行一次 IP 检测 + 源站组更新。"""
    zone_id = cfg.get("zoneId", "")
    group_id = cfg.get("groupId", "")
    group_name = cfg.get("groupName", "")
    ip_type = cfg.get("ipType", "ipv4")
    method = cfg.get("method", "network_interface")
    interface_name = cfg.get("interfaceName", "")
    webhook_url = cfg.get("webhookUrl", "")
    webhook_enabled = cfg.get("webhookEnabled", False)
    webhook_template = cfg.get("webhookTemplate", "")

    now = datetime.now(_CST).strftime("%Y-%m-%d %H:%M:%S")

    _log.info("[DDNS] 开始执行更新 | zoneId=%s | groupId=%s | groupName=%s | ipType=%s | method=%s | interface=%s",
              zone_id or "(空)", group_id or "(空)", group_name or "(空)",
              ip_type, method, interface_name or "(自动)")

    if not zone_id:
        msg = "站点(zoneId)为空，无法更新源站组"
        _log.error("[DDNS] %s", msg)
        _update_status(cfg, "", now, "fail", msg)
        return {"ok": False, "message": msg}

    if not group_id:
        msg = "源站组(groupId)为空，无法更新"
        _log.error("[DDNS] %s", msg)
        _update_status(cfg, "", now, "fail", msg)
        return {"ok": False, "message": msg}

    # 1. 检测 IP
    new_ip = detect_ip(method, interface_name, ip_type)
    if not new_ip:
        msg = f"IP 检测失败（方式: {method}, 类型: {ip_type}）"
        _log.error("[DDNS] %s", msg)
        _update_status(cfg, "", now, "fail", msg)
        if webhook_enabled and webhook_url:
            content = _render_template(webhook_template, {
                "title": "EdgeOne DDNS 更新失败", "group_name": group_name or group_id,
                "old_ip": cfg.get("lastIp", ""), "new_ip": "(无)",
                "status": "失败", "time": now, "message": msg,
            })
            send_message(webhook_url, "EdgeOne DDNS 更新失败", content)
        return {"ok": False, "message": msg}

    # 2. IP 是否变化
    old_ip = cfg.get("lastIp", "")
    if new_ip == old_ip and old_ip:
        msg = f"IP 未变化（{new_ip}），跳过更新"
        _log.info("[DDNS] %s", msg)
        _update_status(cfg, new_ip, now, "success", msg)
        return {"ok": True, "message": msg, "ip": new_ip, "changed": False}

    # 3. 更新 EdgeOne 源站组
    try:
        edge_cfg = settings.load()
        _log.info("[DDNS] 使用 EdgeOne 凭证 | secretId=%s... | region=%s",
                  edge_cfg["secretId"][:8] if edge_cfg["secretId"] else "(空)", edge_cfg["region"])
        client = EdgeOneClient(edge_cfg["secretId"], edge_cfg["secretKey"], edge_cfg["region"])
        origin_records = [{"Record": new_ip, "Type": "IP_DOMAIN"}]
        _log.info("[DDNS] 调用 modify_origin_group | zoneId=%s | groupId=%s | newIP=%s | oldIP=%s",
                  zone_id, group_id, new_ip, old_ip or "(无)")
        client.modify_origin_group(zone_id, group_id, origin_records)

        msg = f"源站组 [{group_name or group_id}] 已更新\n旧 IP: {old_ip or '(无)'}\n新 IP: {new_ip}"
        _log.info("[DDNS] %s", msg)
        _update_status(cfg, new_ip, now, "success", msg)

        if webhook_enabled and webhook_url:
            content = _render_template(webhook_template, {
                "title": "EdgeOne DDNS 更新成功", "group_name": group_name or group_id,
                "old_ip": old_ip or "(无)", "new_ip": new_ip,
                "status": "成功", "time": now, "message": msg,
            })
            send_message(webhook_url, "EdgeOne DDNS 更新成功", content)

        return {"ok": True, "message": msg, "ip": new_ip, "changed": True}
    except (EdgeOneError, Exception) as e:
        msg = f"更新源站组失败: {e}"
        _log.error("[DDNS] %s", msg)
        _update_status(cfg, new_ip, now, "fail", msg)
        if webhook_enabled and webhook_url:
            content = _render_template(webhook_template, {
                "title": "EdgeOne DDNS 更新失败", "group_name": group_name or group_id,
                "old_ip": old_ip or "(无)", "new_ip": new_ip,
                "status": "失败", "time": now, "message": msg,
            })
            send_message(webhook_url, "EdgeOne DDNS 更新失败", content)
        return {"ok": False, "message": msg, "ip": new_ip}


def _update_status(cfg: Dict[str, Any], ip: str, now: str, status: str, msg: str):
    """更新配置中的状态字段并持久化。"""
    cfg["lastIp"] = ip or cfg.get("lastIp", "")
    cfg["lastUpdate"] = now
    cfg["lastStatus"] = status
    cfg["lastMessage"] = msg
    save_config(cfg)
