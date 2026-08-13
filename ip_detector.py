"""本机 IP 地址检测模块。

支持两种获取方式：
1. network_interface：通过网络接口获取本机 IP（socket / psutil）
2. external_api：通过公网接口获取出口 IP（如 ifconfig.me、ip.sb）

支持 IPv4 / IPv6 选择。
"""

from __future__ import annotations

import socket
import urllib.request
import json
from typing import List, Optional

from logger_setup import get_logger

_log = get_logger("ip_detector")

# 公网 IP 检测服务（依次尝试）
_IPV4_APIS = [
    ("https://4.ipw.cn", "text"),
    ("https://api.ip.sb/ip", "json"),
    ("https://ifconfig.me/ip", "text"),
    ("https://api.ipify.org?format=json", "json"),
]
_IPV6_APIS = [
    ("https://6.ipw.cn", "text"),
    ("https://api-ipv6.ip.sb/ip", "json"),
    ("https://api6.ipify.org?format=json", "json"),
]


def list_network_interfaces() -> List[dict]:
    """列出所有网卡及其 IPv4/IPv6 地址。"""
    result = []
    try:
        import psutil
        addrs = psutil.net_if_addrs()
        stats = psutil.net_if_stats()
        for name, addr_list in addrs.items():
            # 跳过未启用的网卡
            if name in stats and not stats[name].isup:
                continue
            ipv4s = []
            ipv6s = []
            for addr in addr_list:
                if addr.family == socket.AF_INET:
                    ipv4s.append(addr.address)
                elif addr.family == socket.AF_INET6:
                    # 过滤回环和链路本地地址
                    ip = addr.address.split("%")[0]
                    if not ip.startswith("fe80") and ip != "::1":
                        ipv6s.append(ip)
            if ipv4s or ipv6s:
                result.append({
                    "name": name,
                    "ipv4": ipv4s,
                    "ipv6": ipv6s,
                })
    except ImportError:
        # 没有 psutil，用 socket 方式降级
        hostname = socket.gethostname()
        try:
            all_ips = socket.getaddrinfo(hostname, None)
            ipv4s = list({ip[4][0] for ip in all_ips if ip[0] == socket.AF_INET and not ip[4][0].startswith("127.")})
            ipv6s = list({ip[4][0] for ip in all_ips if ip[0] == socket.AF_INET6 and not ip[4][0].startswith("fe80") and ip[4][0] != "::1"})
            if ipv4s or ipv6s:
                result.append({"name": hostname, "ipv4": ipv4s, "ipv6": ipv6s})
        except Exception:
            pass
    return result


def get_ip_from_interface(interface_name: str, ip_type: str = "ipv4") -> Optional[str]:
    """从指定网卡获取 IP 地址。

    Args:
        interface_name: 网卡名称（如 eth0），为空则自动选择第一个有 IP 的网卡
        ip_type: "ipv4" 或 "ipv6"
    """
    interfaces = list_network_interfaces()
    if not interfaces:
        _log.warning("[IP] 未找到任何网络接口")
        return None

    for iface in interfaces:
        if interface_name and iface["name"] != interface_name:
            continue
        ips = iface.get(ip_type, [])
        if ips:
            ip = ips[0]
            _log.info("[IP] 从网卡 %s 获取到 %s 地址: %s", iface["name"], ip_type, ip)
            return ip

    _log.warning("[IP] 网卡 %s 上未找到 %s 地址", interface_name or "(任意)", ip_type)
    return None


def get_ip_from_external(ip_type: str = "ipv4") -> Optional[str]:
    """通过公网接口获取出口 IP 地址。

    Args:
        ip_type: "ipv4" 或 "ipv6"
    """
    apis = _IPV4_APIS if ip_type == "ipv4" else _IPV6_APIS
    for url, fmt in apis:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/7.68.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read().decode("utf-8").strip()
                if fmt == "json":
                    data = json.loads(body)
                    ip = data.get("ip") or data.get("query") or data.get("origin") or ""
                else:
                    ip = body
                if ip and _is_valid_ip(ip, ip_type):
                    _log.info("[IP] 通过公网接口 %s 获取到 %s 地址: %s", url, ip_type, ip)
                    return ip
        except Exception as e:
            _log.debug("[IP] 公网接口 %s 请求失败: %s", url, e)
            continue

    _log.warning("[IP] 所有公网接口均无法获取 %s 地址", ip_type)
    return None


def detect_ip(method: str = "network_interface", interface_name: str = "", ip_type: str = "ipv4") -> Optional[str]:
    """统一入口：根据方式获取 IP。

    Args:
        method: "network_interface" 或 "external_api"
        interface_name: 网卡名称（仅 network_interface 方式）
        ip_type: "ipv4" 或 "ipv6"
    """
    if method == "external_api":
        return get_ip_from_external(ip_type)
    else:
        return get_ip_from_interface(interface_name, ip_type)


def _is_valid_ip(ip: str, ip_type: str) -> bool:
    """简单校验 IP 格式。"""
    try:
        if ip_type == "ipv4":
            socket.inet_pton(socket.AF_INET, ip)
            return not ip.startswith("127.") and not ip.startswith("169.254")
        else:
            socket.inet_pton(socket.AF_INET6, ip)
            return not ip.startswith("fe80") and ip != "::1"
    except (OSError, ValueError):
        return False
