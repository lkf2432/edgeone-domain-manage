"""腾讯云 EdgeOne (teo) API 客户端封装。

封装对加速域名（AccelerationDomain）的管理操作：
- 列出站点 / 列出加速域名
- 创建 / 编辑 / 启用 / 停用 / 删除加速域名
- 配置 HTTPS 证书（通过 ModifyHostsCertificate 专用接口）
"""

import json
import time
from typing import Any, Dict, List

from tencentcloud.common import credential
from tencentcloud.common.exception.tencent_cloud_sdk_exception import (
    TencentCloudSDKException,
)
from tencentcloud.common.profile.client_profile import ClientProfile
from tencentcloud.common.profile.http_profile import HttpProfile
from tencentcloud.teo.v20220901 import models, teo_client

from logger_setup import get_logger

_log = get_logger("edgeone")

# 加速域名状态（DomainStatus 字段枚举）
# online：已生效；process：部署中；offline：已停用；init：未生效，待激活站点
DOMAIN_STATUS_ONLINE = "online"
DOMAIN_STATUS_OFFLINE = "offline"

# HTTPS 证书配置模式（ModifyHostsCertificate.Mode）
# disable：不配置；eofreecert：自动申请免费证书；sslcert：使用 SSL 托管证书
CERT_MODE_DISABLE = "disable"
CERT_MODE_EOFREECERT = "eofreecert"
CERT_MODE_SSLCERT = "sslcert"


class EdgeOneError(Exception):
    """业务层错误，携带可读信息返回给前端。"""


class EdgeOneClient:
    def __init__(self, secret_id: str, secret_key: str, region: str = "ap-guangzhou"):
        if not secret_id or not secret_key:
            raise EdgeOneError("未配置腾讯云密钥，请在 .env 中设置 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY")
        cred = credential.Credential(secret_id, secret_key)
        http_profile = HttpProfile()
        http_profile.endpoint = "teo.tencentcloudapi.com"
        http_profile.reqTimeout = 30
        profile = ClientProfile()
        profile.httpProfile = http_profile
        profile.signMethod = "TC3-HMAC-SHA256"
        self.region = region
        self.client = teo_client.TeoClient(cred, region, profile)

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------
    def _invoke(self, action: str, req):
        """统一调用 SDK 并把异常转成 EdgeOneError，同时记录完整请求/响应日志。"""
        # 脱敏后的请求参数（保留字段名，去掉潜在敏感值）
        try:
            req_dict = req._serialize(allow_none=True) if hasattr(req, "_serialize") else {}
            req_safe = _sanitize(req_dict)
        except Exception:
            req_safe = {}
        _log.info(
            "[API] -> %s | region=%s | params=%s",
            action, self.region, json.dumps(req_safe, ensure_ascii=False),
        )
        t0 = time.time()
        try:
            method = getattr(self.client, action)
            resp = method(req)
            elapsed = time.time() - t0
            try:
                resp_dict = resp._serialize(allow_none=True) if hasattr(resp, "_serialize") else {}
                # 响应可能很大，只记录顶层 key 与计数，列表截断展示
                resp_summary = _summarize(resp_dict)
            except Exception:
                resp_summary = {"<serialize_error>": True}
            _log.info(
                "[API] <- %s | OK | %.2fs | resp=%s",
                action, elapsed, json.dumps(resp_summary, ensure_ascii=False),
            )
            return resp
        except TencentCloudSDKException as e:
            elapsed = time.time() - t0
            _log.error(
                "[API] <- %s | FAIL | %.2fs | code=%s | msg=%s | requestId=%s",
                action, elapsed, e.code, e.message, e.requestId,
            )
            raise EdgeOneError(f"{e.code}: {e.message}") from e
        except AttributeError as e:
            elapsed = time.time() - t0
            _log.error("[API] <- %s | FAIL | %.2fs | %s", action, elapsed, e)
            raise EdgeOneError(f"不支持的接口: {action}") from e

    @staticmethod
    def _to_dict(model) -> Dict[str, Any]:
        """把 SDK 模型对象转为字典。

        腾讯云 SDK 的 AbstractModel 提供 _serialize() 返回普通字典，
        键名为公开属性名（去掉下划线前缀）。None 对象返回空字典。
        """
        if model is None:
            return {}
        return model._serialize(allow_none=True)

    # ------------------------------------------------------------------
    # 站点 (Zone)
    # ------------------------------------------------------------------
    def list_zones(self) -> Dict[str, Any]:
        req = models.DescribeZonesRequest()
        req.Offset = 0
        req.Limit = 100
        resp = self._invoke("DescribeZones", req)
        zones: List[Dict[str, Any]] = [self._to_dict(z) for z in resp.Zones]
        return {"zones": zones, "total": resp.TotalCount}

    def get_zone(self, zone_id: str) -> Dict[str, Any]:
        """查询单个站点信息（用于判断接入类型 Type：full/partial/dnsPodAccess）。"""
        if not zone_id:
            raise EdgeOneError("缺少 zone_id")
        req = models.DescribeZonesRequest()
        req.Offset = 0
        req.Limit = 100
        resp = self._invoke("DescribeZones", req)
        for z in resp.Zones:
            if z.ZoneId == zone_id:
                return self._to_dict(z)
        raise EdgeOneError(f"未找到站点: {zone_id}")

    # ------------------------------------------------------------------
    # 源站组 (OriginGroup)
    # ------------------------------------------------------------------
    def list_origin_groups(self, zone_id: str) -> Dict[str, Any]:
        if not zone_id:
            raise EdgeOneError("缺少 zone_id")
        req = models.DescribeOriginGroupRequest()
        req.ZoneId = zone_id
        req.Offset = 0
        req.Limit = 200
        resp = self._invoke("DescribeOriginGroup", req)
        groups: List[Dict[str, Any]] = [self._to_dict(g) for g in resp.OriginGroups]
        return {"groups": groups, "total": resp.TotalCount}

    def modify_origin_group(self, zone_id: str, group_id: str, origin_records: List[Dict[str, Any]],
                            group_type: str = "GENERAL", name: str = "") -> Dict[str, Any]:
        """修改源站组的源站记录。

        Args:
            zone_id: 站点 ID
            group_id: 源站组 ID
            origin_records: 源站记录列表，每项 {"Record": "1.2.3.4", "Type": "IP_DOMAIN"}
            group_type: 源站组类型 GENERAL / HTTP
            name: 源站组名称（为空保持原配置）
        """
        if not zone_id or not group_id:
            raise EdgeOneError("缺少 zone_id 或 group_id")
        req = models.ModifyOriginGroupRequest()
        req.ZoneId = zone_id
        req.GroupId = group_id
        req.Type = group_type
        if name:
            req.Name = name
        records = []
        for r in origin_records:
            rec = models.OriginRecord()
            rec.Record = r.get("Record", "")
            rec.Type = r.get("Type", "IP_DOMAIN")
            records.append(rec)
        req.Records = records
        resp = self._invoke("ModifyOriginGroup", req)
        return self._to_dict(resp)

    # ------------------------------------------------------------------
    # DNS 记录 (DnsRecord)
    # 仅 NS 接入(full) / DNSPod 托管接入(dnsPodAccess) 的站点可在 EdgeOne 内管理 DNS 记录。
    # CNAME 接入(partial) 的站点需用户自行在域名 DNS 服务商添加记录。
    # ------------------------------------------------------------------
    def list_dns_records(self, zone_id: str, domain_name: str = "") -> Dict[str, Any]:
        """列出站点下的 DNS 记录，可按域名过滤。"""
        if not zone_id:
            raise EdgeOneError("缺少 zone_id")
        req = models.DescribeDnsRecordsRequest()
        req.ZoneId = zone_id
        req.Offset = 0
        req.Limit = 1000
        if domain_name:
            req.Filters = [
                {"Name": "name", "Values": [domain_name], "Fuzzy": False}
            ]
        resp = self._invoke("DescribeDnsRecords", req)
        records: List[Dict[str, Any]] = [self._to_dict(r) for r in resp.DnsRecords]
        return {"records": records, "total": resp.TotalCount}

    def create_dns_record(self, zone_id: str, name: str, record_type: str, content: str, ttl: int = 300) -> Dict[str, Any]:
        """创建一条 DNS 记录。

        典型用途：为加速域名自动添加 CNAME 记录，指向 EdgeOne 分配的 CNAME 地址。
        """
        if not zone_id or not name or not content:
            raise EdgeOneError("缺少 zone_id / name / content")
        req = models.CreateDnsRecordRequest()
        req.ZoneId = zone_id
        req.Name = name
        req.Type = record_type
        req.Content = content
        req.TTL = ttl
        resp = self._invoke("CreateDnsRecord", req)
        return self._to_dict(resp)

    def enable_dns_record(self, zone_id: str, record_id: str) -> Dict[str, Any]:
        """启用指定的 DNS 记录。"""
        if not zone_id or not record_id:
            raise EdgeOneError("缺少 zone_id 或 record_id")
        req = models.ModifyDnsRecordsStatusRequest()
        req.ZoneId = zone_id
        req.RecordsToEnable = [record_id]
        resp = self._invoke("ModifyDnsRecordsStatus", req)
        return self._to_dict(resp)

    def add_domain_cname_record(self, zone_id: str, domain_name: str) -> Dict[str, Any]:
        """为加速域名自动添加 CNAME 记录。

        流程：
        1. 查询加速域名，获取 EdgeOne 分配的 CNAME 地址
        2. 查询站点接入类型，仅 NS 接入(full) / DNSPod 托管(dnsPodAccess) 可自动添加
        3. 检查是否已存在同名 CNAME 记录，避免重复添加
        4. 调用 CreateDnsRecord 添加 CNAME 记录
        5. 启用 DNS 记录（创建后默认为 disable 状态）
        6. 启用加速域名
        """
        # 1. 获取加速域名的 CNAME 地址
        domain = self.get_domain(zone_id, domain_name)
        cname = domain.get("Cname", "")
        if not cname:
            raise EdgeOneError(f"加速域名 {domain_name} 尚未分配 CNAME 地址，请稍后重试")

        # 2. 检查站点接入类型
        zone = self.get_zone(zone_id)
        zone_type = (zone.get("Type") or "").lower()
        if zone_type not in ("full", "dnspodaccess"):
            raise EdgeOneError(
                f"当前站点接入类型为 {zone_type or '未知'}，仅 NS 接入(full) / DNSPod 托管接入(dnsPodAccess) "
                "的站点可在 EdgeOne 内自动添加 CNAME 记录。CNAME 接入站点请前往域名 DNS 服务商手动添加。"
            )

        # 用于收集启用结果
        dns_enabled = False
        domain_enabled = False
        errors = []

        # 3. 检查是否已存在同名 CNAME 记录（避免重复添加导致报错）
        existing = self.list_dns_records(zone_id, domain_name)
        record_id = None
        already_exists = False
        for r in existing.get("records", []):
            r_name = (r.get("Name") or "").lower()
            r_type = (r.get("Type") or "").upper()
            if r_type == "CNAME" and (r_name == domain_name.lower() or r_name.endswith("." + domain_name.lower())):
                already_exists = True
                record_id = r.get("RecordId", "")
                # 如果 DNS 记录已存在且是 disable 状态，先启用它
                if (r.get("Status") or "").lower() == "disable" and record_id:
                    try:
                        self.enable_dns_record(zone_id, record_id)
                        dns_enabled = True
                    except Exception as e:
                        print(f"[CNAME] 启用 DNS 记录 {record_id} 失败: {e}")
                        errors.append(f"DNS 记录启用失败: {e}")
                else:
                    dns_enabled = True
                break

        # 4. 不存在则添加 CNAME 记录
        if not already_exists:
            zone_name = (zone.get("ZoneName") or "").lower()
            record_name = domain_name.lower()
            if zone_name and record_name.endswith("." + zone_name):
                record_name = record_name[: -(len(zone_name) + 1)]

            result = self.create_dns_record(zone_id, record_name, "CNAME", cname, 300)
            record_id = result.get("RecordId", "")

            # 5. 启用刚创建的 DNS 记录（默认为 disable 状态）
            if record_id:
                try:
                    self.enable_dns_record(zone_id, record_id)
                    dns_enabled = True
                except Exception as e:
                    print(f"[CNAME] 启用 DNS 记录 {record_id} 失败: {e}")
                    errors.append(f"DNS 记录启用失败: {e}")

        # 6. 启用加速域名（若已为 online 状态则视为已启用）
        #    添加 CNAME 后可能触发四层转发代理变更，需要重试等待变更完成
        import time
        max_retries = 6  # 最多重试 6 次，每次间隔 5 秒，共 30 秒
        for attempt in range(max_retries):
            try:
                self.modify_domain_status(zone_id, domain_name, DOMAIN_STATUS_ONLINE)
                domain_enabled = True
                break
            except Exception as e:
                err_str = str(e)
                if "AlreadyOnline" in err_str:
                    domain_enabled = True
                    break
                if "ResourceInUse" in err_str and attempt < max_retries - 1:
                    print(f"[CNAME] 域名 {domain_name} 变更中，{5}秒后重试 ({attempt + 1}/{max_retries})...")
                    time.sleep(5)
                    continue
                print(f"[CNAME] 自动启用域名 {domain_name} 失败: {e}")
                errors.append(f"域名启用失败: {e}")
                break

        # 构建返回消息
        if already_exists:
            msg = f"域名 {domain_name} 已存在 CNAME 记录，指向 {cname}"
        else:
            msg = f"已为 {domain_name} 添加 CNAME 记录，指向 {cname}"

        if dns_enabled and domain_enabled:
            msg += "，并已自动启用 DNS 记录和加速域名"
        elif dns_enabled:
            msg += "，DNS 记录已启用，但加速域名启用失败"
        elif domain_enabled:
            msg += "，加速域名已启用，但 DNS 记录启用失败"
        else:
            msg += "。启用失败，请手动启用"

        if errors:
            msg += f"（错误详情：{'; '.join(errors)}）"

        return {
            "alreadyExists": already_exists,
            "record": {"RecordId": record_id} if record_id else {},
            "cname": cname,
            "dnsEnabled": dns_enabled,
            "domainEnabled": domain_enabled,
            "message": msg,
        }

    # ------------------------------------------------------------------
    # 加速域名 (AccelerationDomain)
    # ------------------------------------------------------------------
    def list_domains(self, zone_id: str) -> Dict[str, Any]:
        if not zone_id:
            raise EdgeOneError("缺少 zone_id")
        req = models.DescribeAccelerationDomainsRequest()
        req.ZoneId = zone_id
        req.Offset = 0
        req.Limit = 200
        resp = self._invoke("DescribeAccelerationDomains", req)
        domains: List[Dict[str, Any]] = [self._to_dict(d) for d in resp.AccelerationDomains]
        # 按创建时间倒序排列（最新添加的在前）
        domains.sort(key=lambda d: d.get("CreatedOn", ""), reverse=True)
        return {"domains": domains, "total": resp.TotalCount}

    def get_domain(self, zone_id: str, domain_name: str) -> Dict[str, Any]:
        """查询单个加速域名的当前配置（用于编辑前回填）。"""
        req = models.DescribeAccelerationDomainsRequest()
        req.ZoneId = zone_id
        req.Offset = 0
        req.Limit = 100
        req.Filters = [
            {"Name": "domain-name", "Values": [domain_name], "Fuzzy": False}
        ]
        resp = self._invoke("DescribeAccelerationDomains", req)
        for d in resp.AccelerationDomains:
            if d.DomainName == domain_name:
                return self._to_dict(d)
        raise EdgeOneError(f"未找到域名: {domain_name}")

    def create_domain(self, zone_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        req = models.CreateAccelerationDomainRequest()
        req.ZoneId = zone_id
        req.DomainName = data["domainName"]
        req.OriginInfo = self._build_origin_info(data)
        # 回源协议与回源端口为顶层独立字段
        forward_protocol = data.get("forwardProtocol")
        if forward_protocol:
            req.OriginProtocol = forward_protocol
        http_port = data.get("httpOriginPort")
        if http_port is not None and http_port != "":
            req.HttpOriginPort = int(http_port)
        https_port = data.get("httpsOriginPort")
        if https_port is not None and https_port != "":
            req.HttpsOriginPort = int(https_port)
        ipv6_status = data.get("ipv6Status")
        if ipv6_status:
            req.IPv6Status = ipv6_status
        resp = self._invoke("CreateAccelerationDomain", req)
        return self._to_dict(resp)

    def modify_domain(self, zone_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        req = models.ModifyAccelerationDomainRequest()
        req.ZoneId = zone_id
        req.DomainName = data["domainName"]
        req.OriginInfo = self._build_origin_info(data)
        # 回源协议与回源端口为顶层独立字段，不填保持原配置
        forward_protocol = data.get("forwardProtocol")
        if forward_protocol:
            req.OriginProtocol = forward_protocol
        http_port = data.get("httpOriginPort")
        if http_port is not None and http_port != "":
            req.HttpOriginPort = int(http_port)
        https_port = data.get("httpsOriginPort")
        if https_port is not None and https_port != "":
            req.HttpsOriginPort = int(https_port)
        ipv6_status = data.get("ipv6Status")
        if ipv6_status:
            req.IPv6Status = ipv6_status
        resp = self._invoke("ModifyAccelerationDomain", req)
        return self._to_dict(resp)

    def modify_domain_status(self, zone_id: str, domain_name: str, status: str) -> Dict[str, Any]:
        """切换加速域名状态。status 取值：online（启用）/ offline（停用）。

        注意：EdgeOne 接口名为 ModifyAccelerationDomainStatuses（复数），
        参数 DomainNames 为列表。
        """
        if status not in (DOMAIN_STATUS_ONLINE, DOMAIN_STATUS_OFFLINE):
            raise EdgeOneError("status 只能为 online / offline")
        req = models.ModifyAccelerationDomainStatusesRequest()
        req.ZoneId = zone_id
        req.DomainNames = [domain_name]
        req.Status = status
        resp = self._invoke("ModifyAccelerationDomainStatuses", req)
        return self._to_dict(resp)

    def delete_domain(self, zone_id: str, domain_name: str) -> Dict[str, Any]:
        """删除加速域名。"""
        if not zone_id or not domain_name:
            raise EdgeOneError("缺少 zone_id 或 domain_name")
        req = models.DeleteAccelerationDomainsRequest()
        req.ZoneId = zone_id
        req.DomainNames = [domain_name]
        req.Force = False  # 非强制删除，存在关联资源时会报错
        resp = self._invoke("DeleteAccelerationDomains", req)
        return self._to_dict(resp)

    # ------------------------------------------------------------------
    # HTTPS 证书配置
    # EdgeOne 通过独立的 ModifyHostsCertificate 接口配置服务端证书，
    # 支持：disable（关闭）、eofreecert（自动免费证书）、sslcert（SSL 托管证书）
    # ------------------------------------------------------------------
    def modify_domain_https(self, zone_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        mode = data.get("certMode", CERT_MODE_DISABLE)
        if mode not in (CERT_MODE_DISABLE, CERT_MODE_EOFREECERT, CERT_MODE_SSLCERT):
            raise EdgeOneError("certMode 只能为 disable / eofreecert / sslcert")

        req = models.ModifyHostsCertificateRequest()
        req.ZoneId = zone_id
        req.Hosts = [data["domainName"]]
        req.Mode = mode

        # sslcert 模式需要传入证书 ID
        if mode == CERT_MODE_SSLCERT:
            cert_id = data.get("certId", "")
            if not cert_id:
                raise EdgeOneError("sslcert 模式必须填写证书 ID (certId)")
            cert_info = models.ServerCertInfo()
            cert_info.CertId = cert_id
            req.ServerCertInfo = [cert_info]

        resp = self._invoke("ModifyHostsCertificate", req)
        return self._to_dict(resp)

    # ------------------------------------------------------------------
    # 字段构造
    # ------------------------------------------------------------------
    @staticmethod
    def _build_origin_info(data: Dict[str, Any]) -> models.OriginInfo:
        """构造 OriginInfo 对象（创建/修改域名时使用）。

        OriginInfo 仅支持 OriginType / Origin / BackupOrigin / PrivateAccess / HostHeader
        等字段，回源协议是 ModifyAccelerationDomain 的顶层字段 OriginProtocol。
        """
        info = models.OriginInfo()
        info.OriginType = data.get("originType", "IP_DOMAIN")
        info.Origin = data.get("origin", "")
        backup = data.get("backupOrigin")
        if backup:
            info.BackupOrigin = backup
        host_header = data.get("hostHeader")
        if host_header:
            info.HostHeader = host_header
        return info


# ------------------------------------------------------------------
# 日志辅助：脱敏与响应摘要
# ------------------------------------------------------------------

_SENSITIVE_KEYS = {
    "secretid", "secretkey", "secretkeyconfigured", "secretkeymasked",
    "secret_id", "secret_key", "password", "token", "credential",
}


def _sanitize(obj: Any) -> Any:
    """递归遍历，把密钥相关字段值替换为 '***'，避免日志泄密。"""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if isinstance(k, str) and k.lower() in _SENSITIVE_KEYS:
                out[k] = "***"
            else:
                out[k] = _sanitize(v)
        return out
    if isinstance(obj, list):
        if len(obj) > 20:
            return [_sanitize(obj[0]), f"...(共 {len(obj)} 项，已截断)..."]
        return [_sanitize(i) for i in obj]
    return obj


def _summarize(obj: Any) -> Any:
    """对响应做摘要：长列表替换为计数，大对象保留顶层键。"""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if isinstance(v, list) and len(v) > 5:
                out[k] = {
                    "count": len(v),
                    "sample": [_summarize(v[0]), _summarize(v[1])] if len(v) >= 2 else [],
                }
            elif isinstance(v, dict) and len(v) > 15:
                out[k] = {"keys": list(v.keys())[:15], "totalKeys": len(v)}
            else:
                out[k] = _summarize(v)
        return out
    if isinstance(obj, list) and len(obj) > 5:
        return {"count": len(obj), "sample": [_summarize(obj[0])]}
    if isinstance(obj, list):
        return [_summarize(i) for i in obj]
    return obj
