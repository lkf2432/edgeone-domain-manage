"""EdgeOne 域名管理 Web 应用。

运行：
    python app.py
然后访问 http://127.0.0.1:5000
"""

from __future__ import annotations

import time
from functools import wraps

from flask import Flask, jsonify, render_template, request, session

import settings
from edgeone_client import EdgeOneClient, EdgeOneError
from logger_setup import get_logger, tail_log, clear_log, setup_logger

setup_logger()
_log = get_logger("api")

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["JSON_AS_ASCII"] = False
app.secret_key = settings.SECRET_KEY

_client: EdgeOneClient | None = None


# ----------------------------------------------------------------------
# 认证
# ----------------------------------------------------------------------
def login_required(f):
    """要求已登录才能访问的装饰器。"""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"error": "未登录", "needLogin": True}), 401
        return f(*args, **kwargs)
    return decorated


@app.before_request
def _auth_check():
    """全局认证拦截：未登录时只允许访问登录页和认证接口。"""
    # 静态资源放行
    if request.endpoint == "static":
        return None

    # 认证相关接口放行
    if request.path.startswith("/api/auth/"):
        return None

    # 页面路由：未登录时重定向到登录页
    if request.path == "/" or request.path.startswith("/login"):
        if request.path == "/login":
            return None  # 登录页本身放行
        if not session.get("logged_in"):
            return render_template("login.html")
        return None

    # 其他 API 路由：未登录返回 401
    if request.path.startswith("/api/"):
        if not session.get("logged_in"):
            return jsonify({"error": "未登录", "needLogin": True}), 401

    return None


@app.before_request
def _log_request_start():
    request._start_time = time.time()  # type: ignore[attr-defined]


@app.after_request
def _log_request_end(response):
    try:
        dt = (time.time() - getattr(request, "_start_time", time.time())) * 1000
        status = response.status_code
        if request.endpoint == "static":
            return response
        _log.info(
            "[HTTP] %s %s -> %d (%.1fms)",
            request.method, request.full_path.rstrip("?"), status, dt,
        )
    except Exception:
        pass
    return response


def get_client() -> EdgeOneClient:
    """懒加载 EdgeOne 客户端，密钥缺失时给出清晰错误。

    保存配置后会清空 _client，下次调用会以最新配置重建。
    """
    global _client
    if _client is None:
        cfg = settings.load()
        if not settings.is_configured(cfg):
            raise EdgeOneError("未配置腾讯云密钥，请点击右上角“设置”按钮填写密钥。")
        _client = EdgeOneClient(cfg["secretId"], cfg["secretKey"], cfg["region"])
    return _client


# ----------------------------------------------------------------------
# 认证接口
# ----------------------------------------------------------------------
@app.route("/api/auth/login", methods=["POST"])
def api_login():
    """管理员登录。"""
    data = request.get_json(silent=True) or {}
    password = data.get("password", "")
    if not password:
        return jsonify({"error": "请输入密码"}), 400
    if settings.verify_admin_password(password):
        session["logged_in"] = True
        _log.info("[AUTH] 管理员登录成功")
        return jsonify({"ok": True, "message": "登录成功"})
    _log.warning("[AUTH] 登录失败：密码错误")
    return jsonify({"error": "密码错误"}), 401


@app.route("/api/auth/logout", methods=["POST"])
def api_logout():
    """退出登录。"""
    session.pop("logged_in", None)
    _log.info("[AUTH] 管理员已退出登录")
    return jsonify({"ok": True, "message": "已退出登录"})


@app.route("/api/auth/status")
def api_auth_status():
    """检查登录状态。"""
    return jsonify({"logged_in": bool(session.get("logged_in"))})


@app.route("/api/auth/change-password", methods=["POST"])
def api_change_password():
    """修改管理员密码。"""
    data = request.get_json(silent=True) or {}
    old_password = data.get("oldPassword", "")
    new_password = data.get("newPassword", "")
    if not old_password or not new_password:
        return jsonify({"error": "请输入旧密码和新密码"}), 400
    if len(new_password) < 3:
        return jsonify({"error": "新密码至少 3 个字符"}), 400
    if settings.change_admin_password(old_password, new_password):
        _log.info("[AUTH] 管理员密码已修改")
        return jsonify({"ok": True, "message": "密码修改成功"})
    return jsonify({"error": "旧密码错误"}), 401


# ----------------------------------------------------------------------
# 错误处理
# ----------------------------------------------------------------------
@app.errorhandler(EdgeOneError)
def handle_edgeone_error(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(Exception)
def handle_unexpected_error(e):
    return jsonify({"error": f"服务器内部错误: {e}"}), 500


# ----------------------------------------------------------------------
# 页面
# ----------------------------------------------------------------------
@app.route("/login")
def login_page():
    """登录页面。"""
    if session.get("logged_in"):
        return render_template("index.html", configured=settings.is_configured())
    return render_template("login.html")


@app.route("/")
def index():
    return render_template("index.html", configured=settings.is_configured())


# ----------------------------------------------------------------------
# 配置 (Settings)
# ----------------------------------------------------------------------
@app.route("/api/settings")
def api_get_settings():
    cfg = settings.load()
    return jsonify({
        "secretId": cfg["secretId"],
        # 密钥不回显明文，前端只展示掩码，留空表示未配置
        "secretKeyMasked": settings.mask(cfg["secretKey"]),
        # 占位符（如 .env 里的 your_secret_key_here）不算已配置
        "secretKeyConfigured": settings.is_real_value(cfg["secretKey"]),
        "region": cfg["region"],
        "regions": [{"value": v, "label": l} for v, l in settings.EDGEONE_REGIONS],
        "configured": settings.is_configured(cfg),
    })


@app.route("/api/settings", methods=["POST"])
def api_save_settings():
    """保存配置。

    若 secretKey 为空字符串或仍为掩码（包含 ****），表示用户未修改密钥，
    保留原值；其它字段直接覆盖。
    """
    data = request.get_json(force=True) or {}
    current = settings.load()

    secret_id = (data.get("secretId") or "").strip()
    secret_key = (data.get("secretKey") or "").strip()
    region = (data.get("region") or "ap-guangzhou").strip()

    # 未传新密钥或传回的是掩码 → 保留原密钥
    if not secret_key or "****" in secret_key:
        secret_key = current["secretKey"]

    # 保留后若仍非真实密钥（占位符或空），要求用户填写
    if not settings.is_real_value(secret_id):
        return jsonify({"error": "请填写真实的 SecretId"}), 400
    if not settings.is_real_value(secret_key):
        return jsonify({"error": "请填写真实的 SecretKey"}), 400

    # region 必须在可选列表内
    valid_regions = {v for v, _ in settings.EDGEONE_REGIONS}
    if region not in valid_regions:
        region = "ap-guangzhou"

    new_cfg = settings.save(secret_id, secret_key, region)

    # 清空客户端缓存，下次请求按新配置重建
    global _client
    _client = None

    return jsonify({
        "secretId": new_cfg["secretId"],
        "secretKeyMasked": settings.mask(new_cfg["secretKey"]),
        "secretKeyConfigured": bool(new_cfg["secretKey"]),
        "region": new_cfg["region"],
        "configured": settings.is_configured(new_cfg),
    })


@app.route("/api/settings/test", methods=["POST"])
def api_test_settings():
    """用当前保存的配置尝试调用 DescribeZones 验证连通性。"""
    try:
        result = get_client().list_zones()
        return jsonify({"ok": True, "zones": result["total"], "message": f"连接成功，共 {result['total']} 个站点"})
    except EdgeOneError as e:
        return jsonify({"ok": False, "message": str(e)}), 200


# ----------------------------------------------------------------------
# 站点
# ----------------------------------------------------------------------
@app.route("/api/zones")
def api_zones():
    return jsonify(get_client().list_zones())


# ----------------------------------------------------------------------
# 源站组
# ----------------------------------------------------------------------
@app.route("/api/zones/<zone_id>/origin-groups")
def api_list_origin_groups(zone_id):
    return jsonify(get_client().list_origin_groups(zone_id))


# ----------------------------------------------------------------------
# 加速域名
# ----------------------------------------------------------------------
@app.route("/api/zones/<zone_id>/domains")
def api_list_domains(zone_id):
    return jsonify(get_client().list_domains(zone_id))


@app.route("/api/zones/<zone_id>/domains/<path:domain_name>")
def api_get_domain(zone_id, domain_name):
    return jsonify(get_client().get_domain(zone_id, domain_name))


@app.route("/api/zones/<zone_id>/domains", methods=["POST"])
def api_create_domain(zone_id):
    data = request.get_json(force=True) or {}
    return jsonify(get_client().create_domain(zone_id, data))


@app.route("/api/zones/<zone_id>/domains", methods=["PUT"])
def api_modify_domain(zone_id):
    data = request.get_json(force=True) or {}
    return jsonify(get_client().modify_domain(zone_id, data))


@app.route("/api/zones/<zone_id>/domains/status", methods=["PUT"])
def api_modify_status(zone_id):
    data = request.get_json(force=True) or {}
    return jsonify(
        get_client().modify_domain_status(zone_id, data["domainName"], data["status"])
    )


@app.route("/api/zones/<zone_id>/domains/https", methods=["PUT"])
def api_modify_https(zone_id):
    data = request.get_json(force=True) or {}
    return jsonify(get_client().modify_domain_https(zone_id, data))


@app.route("/api/zones/<zone_id>/domains/<path:domain_name>/add-cname", methods=["POST"])
def api_add_domain_cname(zone_id, domain_name):
    """为加速域名自动添加 CNAME 记录（NS / DNSPod 托管接入站点）。"""
    try:
        return jsonify(get_client().add_domain_cname_record(zone_id, domain_name))
    except EdgeOneError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/zones/<zone_id>/domains", methods=["DELETE"])
def api_delete_domain(zone_id):
    domain_name = request.args.get("domainName", "")
    try:
        return jsonify(get_client().delete_domain(zone_id, domain_name))
    except EdgeOneError as e:
        return jsonify({"error": str(e)}), 400


# ------------------------------------------------------------------
# 日志查询接口
# ------------------------------------------------------------------
@app.route("/api/logs", methods=["GET"])
def api_logs():
    """读取最新 N 行日志。Query 参数：lines（默认 300，最大 2000），kw（可选，逗号分隔关键字过滤）。"""
    try:
        lines = int(request.args.get("lines", "300"))
    except ValueError:
        lines = 300
    lines = max(10, min(lines, 2000))
    kw_raw = request.args.get("kw", "")
    keywords = [k.strip() for k in kw_raw.split(",") if k.strip()] if kw_raw else None
    return jsonify({"lines": tail_log(lines, keywords=keywords)})


@app.route("/api/ddns/logs", methods=["GET"])
def api_ddns_logs():
    """读取 DDNS 相关日志。过滤关键字：[DDNS]、ddns、ip_detector。"""
    try:
        lines = int(request.args.get("lines", "500"))
    except ValueError:
        lines = 500
    lines = max(10, min(lines, 2000))
    return jsonify({"lines": tail_log(lines, keywords=["[DDNS]", "ddns", "ip_detector", "notifier"])})


@app.route("/api/logs", methods=["DELETE"])
def api_logs_clear():
    """清空日志文件。"""
    clear_log()
    return jsonify({"ok": True, "message": "日志已清空"})


# ------------------------------------------------------------------
# DDNS 自动更新源站组接口
# ------------------------------------------------------------------
import ddns_scheduler

@app.route("/api/ddns", methods=["GET"])
def api_ddns_status():
    """获取 DDNS 配置和运行状态。"""
    return jsonify(ddns_scheduler.get_status())


@app.route("/api/ddns", methods=["POST"])
def api_ddns_save():
    """保存 DDNS 配置并自动启动/停止调度器。"""
    data = request.get_json(silent=True) or {}
    try:
        status = ddns_scheduler.apply_config_and_restart(data)
        return jsonify(status)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/ddns/run", methods=["POST"])
def api_ddns_run():
    """手动执行一次 IP 检测和更新。"""
    try:
        result = ddns_scheduler.run_once()
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/ddns/test-webhook", methods=["POST"])
def api_ddns_test_webhook():
    """测试 webhook 推送。"""
    data = request.get_json(silent=True) or {}
    url = data.get("webhookUrl", "")
    if not url:
        return jsonify({"error": "请填写 webhook 地址"}), 400
    from notifier import send_message
    ok = send_message(url, "EdgeOne DDNS 测试消息", "这是一条测试消息，确认 webhook 配置正确。")
    if ok:
        return jsonify({"ok": True, "message": "测试消息已发送"})
    else:
        return jsonify({"error": "推送失败，请检查 webhook 地址"}), 400


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=settings.APP_PORT, debug=True)
