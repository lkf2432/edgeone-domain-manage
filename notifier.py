"""Webhook 消息推送模块，支持钉钉机器人和企业微信机器人。"""

from __future__ import annotations

import json
import urllib.request
from typing import Optional

from logger_setup import get_logger

_log = get_logger("notifier")


def _detect_bot_type(webhook_url: str) -> str:
    """根据 webhook URL 自动识别机器人类型。"""
    url = webhook_url.lower()
    if "oapi.dingtalk.com" in url:
        return "dingtalk"
    if "qyapi.weixin.qq.com" in url:
        return "wecom"
    return "dingtalk"  # 默认


def send_message(webhook_url: str, title: str, content: str, bot_type: Optional[str] = None) -> bool:
    """发送 Webhook 消息。

    Args:
        webhook_url: 机器人 webhook 地址
        title: 消息标题
        content: 消息正文（纯文本）
        bot_type: "dingtalk" / "wecom"，为空自动识别
    Returns:
        是否发送成功
    """
    if not webhook_url:
        _log.warning("[Webhook] webhook 地址为空，跳过推送")
        return False

    bot_type = bot_type or _detect_bot_type(webhook_url)

    try:
        if bot_type == "dingtalk":
            return _send_dingtalk(webhook_url, title, content)
        elif bot_type == "wecom":
            return _send_wecom(webhook_url, title, content)
        else:
            _log.error("[Webhook] 不支持的机器人类型: %s", bot_type)
            return False
    except Exception as e:
        _log.error("[Webhook] 推送消息失败: %s", e)
        return False


def _send_dingtalk(webhook_url: str, title: str, content: str) -> bool:
    """发送钉钉机器人消息（markdown 格式）。"""
    payload = {
        "msgtype": "markdown",
        "markdown": {
            "title": title,
            "text": f"### {title}\n\n{content}",
        },
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        if result.get("errcode") == 0:
            _log.info("[Webhook] 钉钉消息推送成功: %s", title)
            return True
        else:
            _log.error("[Webhook] 钉钉消息推送失败: %s", result.get("errmsg", "未知错误"))
            return False


def _strip_markdown(text: str) -> str:
    """将 Markdown 文本转为纯文本（企业微信 text 消息用）。

    企业微信 markdown 消息只能在企业微信客户端查看，微信侧会提示
    "请前往企业微信查看"。改用 text 消息可让微信直接显示。
    """
    import re
    # 去掉标题井号
    text = re.sub(r'^#{1,6}\s*', '', text, flags=re.MULTILINE)
    # 去掉加粗/斜体
    text = re.sub(r'\*{1,2}(.+?)\*{1,2}', r'\1', text)
    text = re.sub(r'_{1,2}(.+?)_{1,2}', r'\1', text)
    # 去掉行内代码
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # 去掉链接 [text](url) -> text
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    # 去掉多余的空行
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def _send_wecom(webhook_url: str, title: str, content: str) -> bool:
    """发送企业微信机器人消息。

    使用 text 格式（而非 markdown），以便消息在微信侧也能直接查看。
    企业微信 markdown 消息仅在企业微信客户端可见。
    """
    # 把 markdown 内容转为纯文本，再加上标题
    plain = _strip_markdown(content)
    text = f"【{title}】\n\n{plain}" if plain else title

    payload = {
        "msgtype": "text",
        "text": {
            "content": text,
        },
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        if result.get("errcode") == 0:
            _log.info("[Webhook] 企微消息推送成功: %s", title)
            return True
        else:
            _log.error("[Webhook] 企微消息推送失败: %s", result.get("errmsg", "未知错误"))
            return False
