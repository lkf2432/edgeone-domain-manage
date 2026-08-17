// EdgeOne 域名管理前端逻辑

const API = {
    zones: () => "/api/zones",
    originGroups: (zid) => `/api/zones/${zid}/origin-groups`,
    domains: (zid) => `/api/zones/${zid}/domains`,
    domain: (zid, name) => `/api/zones/${zid}/domains/${encodeURIComponent(name)}`,
    create: (zid) => `/api/zones/${zid}/domains`,
    modify: (zid) => `/api/zones/${zid}/domains`,
    status: (zid) => `/api/zones/${zid}/domains/status`,
    https: (zid) => `/api/zones/${zid}/domains/https`,
    addCname: (zid, name) => `/api/zones/${zid}/domains/${encodeURIComponent(name)}/add-cname`,
    delete: (zid, name) => `/api/zones/${zid}/domains?domainName=${encodeURIComponent(name)}`,
    settings: "/api/settings",
    settingsTest: "/api/settings/test",
    logs: (lines, kw) => `/api/logs?lines=${lines || 300}${kw ? `&kw=${encodeURIComponent(kw)}` : ""}`,
    ddns: "/api/ddns",
    ddnsRun: "/api/ddns/run",
    ddnsTestWebhook: "/api/ddns/test-webhook",
    ddnsLogs: (lines) => `/api/ddns/logs?lines=${lines || 500}`,
};

const state = { zones: [], domains: [], zoneId: "" };

// ---------- 工具 ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function http(url, opts = {}) {
    const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...opts,
    });
    const data = await res.json().catch(() => ({}));
    // 401 未登录 → 自动跳转登录页
    if (res.status === 401 && data.needLogin) {
        window.location.href = "/login";
        return new Promise(() => {}); // 阻止后续执行
    }
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
}

function toast(msg, type = "info") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    $("#toastWrap").appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "0.3s"; setTimeout(() => el.remove(), 300); }, 3000);
}

const ORIGIN_TYPES = [
    { value: "IP_DOMAIN", label: "IP / 域名" },
    { value: "COS", label: "腾讯云 COS" },
    { value: "AWS_S3", label: "AWS S3" },
    { value: "ORIGIN_GROUP", label: "源站组" },
    { value: "VOD", label: "云点播 VOD" },
];
// 源站类型枚举 → 中文展示
const ORIGIN_TYPE_LABEL = Object.fromEntries(ORIGIN_TYPES.map((t) => [t.value, t.label]));
// 回源协议枚举 → 中文展示
const FORWARD_PROTOCOL_LABEL = {
    FOLLOW: "协议跟随",
    HTTP: "HTTP 回源",
    HTTPS: "HTTPS 回源",
};
// HTTPS 证书模式
const CERT_MODES = [
    { value: "disable", label: "不配置证书" },
    { value: "eofreecert", label: "自动申请免费证书" },
    { value: "sslcert", label: "SSL 托管证书" },
];
// IPv6 状态枚举 → 中文展示
const IPV6_STATUS_LABEL = {
    follow: "遵循站点配置",
    on: "开启",
    off: "关闭",
};

// ---------- 站点 ----------
async function loadZones() {
    try {
        const data = await http(API.zones());
        state.zones = data.zones || [];
        const sel = $("#zoneSelect");
        sel.innerHTML = state.zones.length
            ? state.zones.map((z) => `<option value="${z.ZoneId}">${esc(z.ZoneName)} (${esc(z.ZoneId)})</option>`).join("")
            : `<option value="">未找到站点</option>`;
        if (state.zones.length) {
            state.zoneId = state.zones[0].ZoneId;
            sel.value = state.zoneId;
            loadDomains();
        }
    } catch (e) {
        toast(e.message, "error");
        $("#zoneSelect").innerHTML = `<option value="">加载失败</option>`;
    }
}

// ---------- 域名列表 ----------
async function loadDomains() {
    if (!state.zoneId) return;
    const tbody = $("#domainTbody");
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">加载中...</td></tr>`;
    try {
        const data = await http(API.domains(state.zoneId));
        state.domains = data.domains || [];
        renderDomains();
    } catch (e) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(e.message)}</td></tr>`;
    }
}

function renderDomains() {
    const tbody = $("#domainTbody");
    const kw = $("#searchInput").value.trim().toLowerCase();
    const list = state.domains.filter((d) => !kw || (d.DomainName || "").toLowerCase().includes(kw));
    if (!list.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${state.domains.length ? "无匹配域名" : "该站点下暂无加速域名"}</td></tr>`;
        return;
    }
    tbody.innerHTML = list.map(domainRow).join("");
    // 绑定操作按钮
    tbody.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (btn.disabled) return;
            btn.disabled = true;
            const origText = btn.textContent;
            const act = btn.dataset.act;
            // 加载类操作显示 loading 文案
            if (act === "edit" || act === "https") btn.textContent = "加载中...";
            else if (act === "enable") btn.textContent = "启用中...";
            else if (act === "disable") btn.textContent = "停用中...";
            else if (act === "delete") btn.textContent = "处理中...";
            handleAction(act, btn.dataset.name).finally(() => {
                btn.disabled = false;
                btn.textContent = origText;
            });
        });
    });
}

function domainRow(d) {
    // 状态字段为 DomainStatus：online/process/offline/init
    const status = (d.DomainStatus || "").toLowerCase();
    const statusBadge = status === "online"
        ? `<span class="badge online">已生效</span>`
        : status === "offline"
        ? `<span class="badge offline">已停用</span>`
        : status === "process"
        ? `<span class="badge processing">部署中</span>`
        : status === "init"
        ? `<span class="badge processing">未生效</span>`
        : `<span class="badge processing">${esc(d.DomainStatus || "未知")}</span>`;

    // 源站信息字段为 OriginDetail（读取用），回源协议为顶层 OriginProtocol
    const origin = d.OriginDetail || {};
    const originTypeText = ORIGIN_TYPE_LABEL[origin.OriginType] || origin.OriginType || "-";
    const forwardText = FORWARD_PROTOCOL_LABEL[d.OriginProtocol] || d.OriginProtocol || "-";

    // HTTPS 证书信息字段为 Certificate.Mode：
    //   disable：未配置；eofreecert：免费证书；sslcert：SSL 托管证书
    const cert = d.Certificate || {};
    const certMode = (cert.Mode || "disable").toLowerCase();
    const httpsEnabled = certMode !== "disable" && certMode !== "";
    let httpsBadge;
    if (certMode === "disable" || !certMode) {
        httpsBadge = `<span class="badge off">未配置</span>`;
    } else if (certMode === "eofreecert") {
        httpsBadge = `<span class="badge on">免费证书</span>`;
    } else if (certMode === "sslcert") {
        httpsBadge = `<span class="badge on">SSL 证书</span>`;
    } else {
        httpsBadge = `<span class="badge on">${esc(cert.Mode)}</span>`;
    }
    // HTTPS 按钮：已开启用 primary 高亮，未开启用 ghost 弱化
    const httpsBtnClass = httpsEnabled ? "primary" : "ghost";
    const httpsBtnLabel = httpsEnabled ? "HTTPS ✓" : "HTTPS";

    // IPv6 状态徽标：follow / on / off
    const ipv6Status = (d.IPv6Status || "").toLowerCase();
    let ipv6Badge;
    if (ipv6Status === "on") {
        ipv6Badge = `<span class="badge on">开启</span>`;
    } else if (ipv6Status === "off") {
        ipv6Badge = `<span class="badge off">关闭</span>`;
    } else {
        ipv6Badge = `<span class="badge processing">遵循站点</span>`;
    }

    // online/offline 状态可切换；process 部署中不允许操作
    const canToggle = status === "online" || status === "offline";
    const isOnline = status === "online";
    const isProcessing = status === "process";
    const dis = isProcessing ? "disabled" : "";
    // 删除按钮仅在已停用(offline)状态可用
    const delDis = status === "offline" ? "" : "disabled";
    return `
    <tr>
        <td><a href="https://${esc(d.DomainName)}" target="_blank" rel="noopener noreferrer" class="domain-link"><strong>${esc(d.DomainName)}</strong></a><div class="hint" style="color:var(--muted);font-size:12px;margin-top:2px">CNAME: ${esc(d.Cname || "-")}</div></td>
        <td>${statusBadge}</td>
        <td>${esc(originTypeText)}<div class="hint" style="color:var(--muted);font-size:12px;margin-top:2px">${esc(forwardText)}</div></td>
        <td>${esc(origin.Origin || "-")}${origin.BackupOrigin ? `<br><span style="color:var(--muted);font-size:12px">备用: ${esc(origin.BackupOrigin)}</span>` : ""}</td>
        <td>${httpsBadge}</td>
        <td>${ipv6Badge}</td>
        <td class="col-actions">
            <button class="btn sm ${httpsBtnClass}" data-act="https" data-name="${esc(d.DomainName)}">${httpsBtnLabel}</button>
            <button class="btn sm ghost" ${dis} data-act="edit" data-name="${esc(d.DomainName)}">编辑</button>
            ${(canToggle || isProcessing) ? `<button class="btn sm ${isOnline ? "ghost" : "primary"}" ${dis} data-act="${isOnline ? "disable" : "enable"}" data-name="${esc(d.DomainName)}">${isOnline ? "停用" : "启用"}</button>` : ""}
            <button class="btn sm danger" ${delDis} data-act="delete" data-name="${esc(d.DomainName)}">删除</button>
        </td>
    </tr>`;
}

// ---------- 操作分发 ----------
async function handleAction(act, name) {
    try {
        if (act === "edit") return openEditModal(name);
        if (act === "https") return openHttpsModal(name);
        if (act === "enable") return await toggleStatus(name, "online");
        if (act === "disable") return await toggleStatus(name, "offline");
        if (act === "delete") return await confirmDelete(name);
    } catch (e) {
        toast(e.message, "error");
    }
}

async function toggleStatus(name, status) {
    await http(API.status(state.zoneId), {
        method: "PUT",
        body: JSON.stringify({ domainName: name, status }),
    });
    toast(`${status === "online" ? "启用" : "停用"}成功`, "success");
    loadDomains();
}

async function confirmDelete(name) {
    openModal("删除域名", `
        <p>确定要删除域名 <strong>${esc(name)}</strong> 吗？此操作不可撤销。</p>
    `, [
        { label: "取消", class: "ghost", onClick: closeModal },
        {
            label: "确认删除", class: "danger", onClick: async () => {
                try {
                    await http(API.delete(state.zoneId, name), { method: "DELETE" });
                    toast("删除成功", "success");
                    closeModal();
                    loadDomains();
                } catch (e) { toast(e.message, "error"); }
            }
        },
    ]);
}

// ---------- 添加 / 编辑域名 ----------
async function openAddModal() {
    if (!state.zoneId) return toast("请先选择站点", "error");
    const d = { DomainName: "", OriginDetail: { OriginType: "IP_DOMAIN", Origin: "" }, OriginProtocol: "FOLLOW", HttpOriginPort: 80, HttpsOriginPort: 443, IPv6Status: "follow" };
    const body = domainFormHtml(d, false);
    openModal("添加加速域名", body, [
        { label: "取消", class: "ghost", onClick: closeModal },
        { label: "创建", class: "primary", onClick: submitDomain(false) },
    ]);
    try {
        // 预加载源站组列表，切到 ORIGIN_GROUP 时已就绪
        const r = await http(API.originGroups(state.zoneId));
        setupOriginForm(d, r.groups || []);
    } catch (e) {
        setupOriginForm(d, []);
    }
}

async function openEditModal(name) {
    try {
        openModal("加载中", `<p>正在读取 ${esc(name)} 的配置...</p>`, []);
        const d = await http(API.domain(state.zoneId, name));
        const body = domainFormHtml(d, true);
        openModal("编辑加速域名", body, [
            { label: "取消", class: "ghost", onClick: closeModal },
            { label: "保存", class: "primary", onClick: submitDomain(true) },
        ]);
        try {
            const r = await http(API.originGroups(state.zoneId));
            setupOriginForm(d, r.groups || []);
        } catch (e) {
            setupOriginForm(d, []);
        }
    } catch (e) {
        closeModal();
        toast(e.message, "error");
    }
}

function domainFormHtml(d, isEdit) {
    // 读取用 OriginDetail，回源协议是顶层 OriginProtocol
    const oi = d.OriginDetail || {};
    const forwardProtocol = d.OriginProtocol || "FOLLOW";
    const httpPort = d.HttpOriginPort ?? 80;
    const httpsPort = d.HttpsOriginPort ?? 443;
    const ipv6Status = d.IPv6Status || "follow";
    const typeOptions = ORIGIN_TYPES.map((t) =>
        `<option value="${t.value}" ${t.value === oi.OriginType ? "selected" : ""}>${t.label}</option>`).join("");
    const forwardOptions = Object.entries(FORWARD_PROTOCOL_LABEL)
        .map(([v, l]) => `<option value="${v}" ${v === forwardProtocol ? "selected" : ""}>${l}</option>`).join("");
    const ipv6Options = Object.entries(IPV6_STATUS_LABEL)
        .map(([v, l]) => `<option value="${v}" ${v === ipv6Status ? "selected" : ""}>${l}</option>`).join("");
    return `
    <div class="form-group">
        <label>加速域名</label>
        <input class="form-control" id="f-domainName" value="${esc(d.DomainName)}" ${isEdit ? "readonly" : ""} placeholder="例如 cdn.example.com" />
        ${isEdit ? '<div class="hint">编辑模式下域名不可修改</div>' : ""}
    </div>
    <div class="form-row">
        <div class="form-group">
            <label>源站类型</label>
            <select class="form-control" id="f-originType">${typeOptions}</select>
        </div>
        <div class="form-group">
            <label>回源协议</label>
            <select class="form-control" id="f-forwardProtocol">${forwardOptions}</select>
        </div>
    </div>
    <div id="origin-address-block">
        <div class="form-group" id="origin-input-block">
            <label>源站地址</label>
            <input class="form-control" id="f-origin" value="${esc(oi.Origin || "")}" placeholder="源站 IP 或域名" />
        </div>
        <div class="form-group" id="origin-group-block" style="display:none">
            <label>源站组</label>
            <select class="form-control" id="f-originGroup"><option value="">加载中...</option></select>
        </div>
    </div>
    <div class="form-group" id="backup-origin-block">
        <label>备用源站地址（可选）</label>
        <input class="form-control" id="f-backupOrigin" value="${esc(oi.BackupOrigin || "")}" placeholder="备用源站（仅 IP / 域名 / COS 类型可用）" />
    </div>
    <div class="form-row" id="origin-port-block">
        <div class="form-group" id="http-port-block">
            <label>HTTP 回源端口</label>
            <input class="form-control" id="f-httpOriginPort" type="number" min="1" max="65535" value="${esc(httpPort)}" placeholder="默认 80" />
            <div class="hint">FOLLOW / HTTP 回源协议时生效</div>
        </div>
        <div class="form-group" id="https-port-block">
            <label>HTTPS 回源端口</label>
            <input class="form-control" id="f-httpsOriginPort" type="number" min="1" max="65535" value="${esc(httpsPort)}" placeholder="默认 443" />
            <div class="hint">FOLLOW / HTTPS 回源协议时生效</div>
        </div>
    </div>
    <div class="form-group">
        <label>IPv6 访问</label>
        <select class="form-control" id="f-ipv6Status">${ipv6Options}</select>
        <div class="hint">控制该域名的 IPv6 访问开关，遵循站点配置则继承站点级 IPv6 设置</div>
    </div>`;
}

/**
 * 绑定表单的动态显隐逻辑：
 * - 源站类型 = ORIGIN_GROUP：源站地址替换为源站组下拉，隐藏备用源站输入
 * - 回源协议 = FOLLOW：同时显示 HTTP / HTTPS 端口
 * - 回源协议 = HTTP：只显示 HTTP 端口
 * - 回源协议 = HTTPS：只显示 HTTPS 端口
 */
function setupOriginForm(d, groups) {
    const originTypeSel = $("#f-originType");
    const originInputBlock = $("#origin-input-block");
    const originGroupBlock = $("#origin-group-block");
    const originGroupSel = $("#f-originGroup");
    const backupBlock = $("#backup-origin-block");
    const forwardSel = $("#f-forwardProtocol");
    const httpPortBlock = $("#http-port-block");
    const httpsPortBlock = $("#https-port-block");

    // --- 源站类型切换 ---
    // 填充源站组下拉
    if (groups.length === 0) {
        originGroupSel.innerHTML = `<option value="">当前站点暂无源站组，请先在 EdgeOne 控制台创建</option>`;
    } else {
        const currentGroupId = (d.OriginDetail && d.OriginDetail.OriginType === "ORIGIN_GROUP") ? d.OriginDetail.Origin : "";
        originGroupSel.innerHTML = groups.map((g) =>
            `<option value="${esc(g.GroupId)}" ${g.GroupId === currentGroupId ? "selected" : ""}>${esc(g.Name)} (${esc(g.GroupId)})</option>`).join("");
        // 若当前配置是 ORIGIN_GROUP 但返回的 groups 中没有该 ID，补一个占位选项
        if (currentGroupId && !groups.find((g) => g.GroupId === currentGroupId)) {
            originGroupSel.innerHTML = `<option value="${esc(currentGroupId)}" selected>当前源站组 (${esc(currentGroupId)})</option>` + originGroupSel.innerHTML;
        }
    }

    const updateOriginTypeUI = () => {
        const isGroup = originTypeSel.value === "ORIGIN_GROUP";
        originInputBlock.style.display = isGroup ? "none" : "block";
        originGroupBlock.style.display = isGroup ? "block" : "none";
        backupBlock.style.display = isGroup ? "none" : "block";
    };
    originTypeSel.addEventListener("change", updateOriginTypeUI);
    updateOriginTypeUI();

    // --- 回源协议切换 ---
    const updateForwardUI = () => {
        const p = forwardSel.value;
        httpPortBlock.style.display = (p === "FOLLOW" || p === "HTTP") ? "block" : "none";
        httpsPortBlock.style.display = (p === "FOLLOW" || p === "HTTPS") ? "block" : "none";
    };
    forwardSel.addEventListener("change", updateForwardUI);
    updateForwardUI();
}

function submitDomain(isEdit) {
    return async () => {
        const originType = $("#f-originType").value;
        let origin;
        let backupOrigin = "";
        if (originType === "ORIGIN_GROUP") {
            origin = $("#f-originGroup").value.trim();
            if (!origin) return toast("请选择源站组", "error");
            // 源站组模式不提交备用源站
        } else {
            origin = $("#f-origin").value.trim();
            backupOrigin = $("#f-backupOrigin").value.trim();
            if (!origin) return toast("请填写源站地址", "error");
        }
        const forwardProtocol = $("#f-forwardProtocol").value;
        const payload = {
            domainName: $("#f-domainName").value.trim(),
            originType,
            origin,
            backupOrigin,
            forwardProtocol,
            ipv6Status: $("#f-ipv6Status").value,
        };
        if (!payload.domainName) return toast("请填写域名", "error");

        // 按协议显式提交生效的端口
        const httpPortVal = $("#f-httpOriginPort").value;
        const httpsPortVal = $("#f-httpsOriginPort").value;
        if ((forwardProtocol === "FOLLOW" || forwardProtocol === "HTTP") && httpPortVal !== "") {
            payload.httpOriginPort = parseInt(httpPortVal, 10);
        }
        if ((forwardProtocol === "FOLLOW" || forwardProtocol === "HTTPS") && httpsPortVal !== "") {
            payload.httpsOriginPort = parseInt(httpsPortVal, 10);
        }

        try {
            const url = isEdit ? API.modify(state.zoneId) : API.create(state.zoneId);
            await http(url, { method: isEdit ? "PUT" : "POST", body: JSON.stringify(payload) });
            toast(isEdit ? "保存成功" : "创建成功", "success");
            closeModal();
            loadDomains();
            // 新建域名后弹出 CNAME 配置提示，提供一键添加 CNAME 记录
            if (!isEdit) {
                setTimeout(() => openCnameModal(payload.domainName), 300);
            }
        } catch (e) { toast(e.message, "error"); }
    };
}

// ---------- CNAME 配置 ----------
// 新建加速域名后，EdgeOne 会分配一个 CNAME 地址（如 xxx.eo.dnse3.com）。
// NS 接入 / DNSPod 托管接入的站点可在 EdgeOne 内自动添加 CNAME 记录；
// CNAME 接入站点需用户自行在域名 DNS 服务商添加。
async function openCnameModal(name) {
    try {
        openModal("加载中", `<p>正在读取 ${esc(name)} 的 CNAME 信息...</p>`, []);
        const d = await http(API.domain(state.zoneId, name));
        const cname = d.Cname || "";
        const domainStatus = (d.DomainStatus || "").toLowerCase();

        if (!cname) {
            openModal(`CNAME 配置 - ${name}`, `
                <p style="color:var(--muted);margin-top:0">EdgeOne 尚未为 <strong>${esc(name)}</strong> 分配 CNAME 地址，请稍后刷新重试。</p>
                <div class="hint">新创建的域名 CNAME 分配可能有几秒延迟。</div>
            `, [{ label: "关闭", class: "primary", onClick: closeModal }]);
            return;
        }

        const body = `
        <p style="color:var(--muted);margin-top:0">加速域名 <strong>${esc(name)}</strong> 已创建成功。</p>
        <div class="form-group">
            <label>EdgeOne 分配的 CNAME 地址</label>
            <div class="cname-value-box">
                <code id="cname-value">${esc(cname)}</code>
                <button class="btn sm ghost" id="copyCnameBtn">复制</button>
            </div>
        </div>
        <div class="form-group">
            <label>需要在域名 DNS 解析中添加的 CNAME 记录</label>
            <div class="dns-record-box">
                <div class="dns-row"><span class="dns-label">主机记录</span><code>${esc(name)}</code></div>
                <div class="dns-row"><span class="dns-label">记录类型</span><code>CNAME</code></div>
                <div class="dns-row"><span class="dns-label">记录值</span><code>${esc(cname)}</code></div>
            </div>
        </div>
        <div class="hint" id="cname-status-hint">
            ${domainStatus === "online"
                ? '域名状态：已生效（CNAME 已配置）。'
                : '域名状态：待添加 CNAME。点击下方"一键添加 CNAME"可在当前站点自动添加 DNS 记录（仅 NS / DNSPod 托管接入站点可用）。'}
        </div>`;

        openModal(`CNAME 配置 - ${name}`, body, [
            { label: "关闭", class: "ghost", onClick: closeModal },
            { label: "一键添加 CNAME", class: "primary", onClick: submitAddCname(name) },
        ]);

        // 复制 CNAME 值
        $("#copyCnameBtn").addEventListener("click", () => {
            const text = $("#cname-value").textContent;
            navigator.clipboard.writeText(text).then(
                () => toast("CNAME 已复制到剪贴板", "success"),
                () => toast("复制失败，请手动选择文本复制", "error")
            );
        });
    } catch (e) {
        closeModal();
        toast(e.message, "error");
    }
}

function submitAddCname(name) {
    return async () => {
        try {
            const r = await http(API.addCname(state.zoneId, name), { method: "POST" });
            toast(r.message || "CNAME 记录已添加", "success");
            closeModal();
            loadDomains();
        } catch (e) {
            toast(e.message, "error");
            throw e;
        }
    };
}

// ---------- HTTPS 配置 ----------
// EdgeOne 通过 ModifyHostsCertificate 接口配置服务端证书：
//   disable：不配置；eofreecert：自动申请免费证书；sslcert：使用 SSL 托管证书
// 证书状态枚举（CertificateInfo.Status）→ 中文
const CERT_STATUS_LABEL = {
    deployed: "已部署",
    processing: "部署中",
    applying: "申请中",
    failed: "申请失败",
    issued: "绑定失败",
};
// 证书类型枚举（CertificateInfo.Type）→ 中文
const CERT_TYPE_LABEL = {
    default: "默认证书",
    upload: "用户上传",
    managed: "腾讯云托管",
};

async function openHttpsModal(name) {
    try {
        openModal("加载中", `<p>正在读取 ${esc(name)} 的 HTTPS 配置...</p>`, []);
        const d = await http(API.domain(state.zoneId, name));
        const cert = d.Certificate || {};
        const curMode = (cert.Mode || "disable").toLowerCase();
        // 已配置的证书列表（CertificateInfo[]）
        const certList = cert.List || [];
        const httpsEnabled = curMode !== "disable" && curMode !== "";

        const modeOptions = CERT_MODES.map((m) =>
            `<option value="${m.value}" ${m.value === curMode ? "selected" : ""}>${m.label}</option>`).join("");

        // 证书信息卡片：仅在有证书时显示
        let certInfoHtml = "";
        if (httpsEnabled && certList.length > 0) {
            certInfoHtml = certList.map((c, idx) => {
                const expireTime = c.ExpireTime || "-";
                const deployTime = c.DeployTime || "-";
                const statusText = CERT_STATUS_LABEL[c.Status] || c.Status || "-";
                const typeText = CERT_TYPE_LABEL[c.Type] || c.Type || "-";
                // 计算剩余天数（ExpireTime 形如 2025-12-31 23:59:59）
                let remainText = "";
                if (c.ExpireTime) {
                    const exp = new Date(c.ExpireTime.replace(/-/g, "/"));
                    if (!isNaN(exp.getTime())) {
                        const days = Math.ceil((exp.getTime() - Date.now()) / 86400000);
                        const danger = days <= 7;
                        const warn = days <= 30 && days > 7;
                        remainText = days < 0
                            ? `<span style="color:var(--danger)">已过期 ${-days} 天</span>`
                            : `<span style="color:${danger ? "var(--danger)" : warn ? "var(--warning)" : "var(--success)"}">剩余 ${days} 天${danger ? "（即将过期）" : ""}</span>`;
                    }
                }
                const alias = c.Alias ? `<div class="cert-row"><span class="cert-label">备注名</span><span class="cert-value">${esc(c.Alias)}</span></div>` : "";
                return `
                <div class="cert-card${idx > 0 ? " cert-card-extra" : ""}">
                    <div class="cert-card-title">证书 ${idx + 1}${c.Type === "default" ? "（默认）" : ""}</div>
                    <div class="cert-row"><span class="cert-label">证书 ID</span><span class="cert-value">${esc(c.CertId || "-")}</span></div>
                    ${alias}
                    <div class="cert-row"><span class="cert-label">类型</span><span class="cert-value">${esc(typeText)}</span></div>
                    <div class="cert-row"><span class="cert-label">状态</span><span class="cert-value">${esc(statusText)}</span></div>
                    <div class="cert-row"><span class="cert-label">签名算法</span><span class="cert-value">${esc(c.SignAlgo || "-")}</span></div>
                    <div class="cert-row"><span class="cert-label">部署时间</span><span class="cert-value">${esc(deployTime)}</span></div>
                    <div class="cert-row"><span class="cert-label">过期时间</span><span class="cert-value">${esc(expireTime)} ${remainText}</span></div>
                </div>`;
            }).join("");
            certInfoHtml = `
            <div class="cert-info-section">
                <div class="cert-info-title">当前证书信息</div>
                ${certInfoHtml}
            </div>`;
        }

        // 当前已配置证书的 ID（用于 sslcert 模式回填）
        const curCertId = (certList[0] && certList[0].CertId) || "";

        const body = `
        <p style="color:var(--muted);margin-top:0">为 <strong>${esc(name)}</strong> 配置 HTTPS 服务端证书</p>
        ${certInfoHtml}
        <div class="form-group">
            <label>证书模式</label>
            <select class="form-control" id="f-certMode">${modeOptions}</select>
            <div class="hint" id="mode-hint-disable">不配置服务端证书，HTTPS 请求将无法访问。</div>
            <div class="hint" id="mode-hint-eofreecert" style="display:none">EdgeOne 自动申请并部署免费证书，适用于 NS / DNSPod 托管接入。</div>
            <div class="hint" id="mode-hint-sslcert" style="display:none">使用 SSL 证书托管的证书，需填写证书 ID。可在 <a href="https://console.cloud.tencent.com/ssl" target="_blank">SSL 证书列表</a> 查看。</div>
        </div>
        <div class="form-group" id="certId-group" style="display:none">
            <label>SSL 证书 ID</label>
            <input class="form-control" id="f-certId" value="${esc(curCertId)}" placeholder="例如 cert-xxxxxxx" />
            <div class="hint">sslcert 模式必填</div>
        </div>`;

        openModal(`HTTPS 配置 - ${name}`, body, [
            { label: "取消", class: "ghost", onClick: closeModal },
            { label: "保存配置", class: "primary", onClick: submitHttps(name) },
        ]);

        // 根据当前模式切换证书 ID 输入框与提示
        const modeSel = $("#f-certMode");
        const updateModeVisibility = () => {
            const m = modeSel.value;
            $("#certId-group").style.display = (m === "sslcert") ? "block" : "none";
            ["disable", "eofreecert", "sslcert"].forEach((k) => {
                const el = document.getElementById(`mode-hint-${k}`);
                if (el) el.style.display = (k === m) ? "block" : "none";
            });
        };
        modeSel.addEventListener("change", updateModeVisibility);
        updateModeVisibility();
    } catch (e) {
        closeModal();
        toast(e.message, "error");
    }
}

function submitHttps(name) {
    return async () => {
        const certMode = $("#f-certMode").value;
        const payload = { domainName: name, certMode };
        if (certMode === "sslcert") {
            const certId = $("#f-certId").value.trim();
            if (!certId) return toast("sslcert 模式必须填写证书 ID", "error");
            payload.certId = certId;
        }
        try {
            await http(API.https(state.zoneId), { method: "PUT", body: JSON.stringify(payload) });
            toast("HTTPS 配置已保存", "success");
            closeModal();
            loadDomains();
        } catch (e) { toast(e.message, "error"); }
    };
}

// ---------- 配置页 (Settings) ----------
async function openSettingsModal() {
    let cfg;
    try {
        cfg = await http(API.settings);
    } catch (e) {
        toast(e.message, "error");
        return;
    }
    const regionOptions = (cfg.regions || [])
        .map((r) => `<option value="${r.value}" ${r.value === cfg.region ? "selected" : ""}>${esc(r.label)} (${r.value})</option>`)
        .join("");
    const keyPlaceholder = cfg.secretKeyConfigured
        ? `已配置（${esc(cfg.secretKeyMasked)}），留空则保留原密钥`
        : "请输入 SecretKey";
    const body = `
        <p style="color:var(--muted);margin-top:0">配置腾讯云 API 密钥与 EdgeOne 接入区域。配置保存在服务器本地 <code>settings.json</code>，仅用于调用 EdgeOne 接口。</p>
        <div class="form-group">
            <label>SecretId</label>
            <input class="form-control" id="f-secretId" value="${esc(cfg.secretId || "")}" placeholder="AKID..." autocomplete="off" />
        </div>
        <div class="form-group">
            <label>SecretKey</label>
            <input class="form-control" id="f-secretKey" type="password" placeholder="${esc(keyPlaceholder)}" autocomplete="new-password" />
            ${cfg.secretKeyConfigured ? `<div class="hint">当前：${esc(cfg.secretKeyMasked)}。如需更换请输入新密钥，留空保持不变。</div>` : ""}
        </div>
        <div class="form-group">
            <label>接入区域 (Region)</label>
            <select class="form-control" id="f-region">${regionOptions}</select>
            <div class="hint">EdgeOne 为全球服务，通常选择广州即可</div>
        </div>
        <div id="testResult" class="test-result"></div>`;
    openModal("EdgeOne 接口配置", body, [
        { label: "测试连接", class: "ghost", onClick: testConnection },
        { label: "取消", class: "ghost", onClick: closeModal },
        { label: "保存配置", class: "primary", onClick: submitSettings },
    ]);
}

async function testConnection() {
    // 测试前先保存，确保用最新输入测试
    const payload = readSettingsForm();
    if (payload === null) return;
    const resultEl = $("#testResult");
    const btn = [...document.querySelectorAll("#modalFooter .btn")].find((b) => b.textContent.includes("测试连接"));
    if (btn) { btn.disabled = true; btn.textContent = "测试中..."; }
    resultEl.className = "test-result";
    resultEl.textContent = "正在测试连接...";
    try {
        await http(API.settings, { method: "POST", body: JSON.stringify(payload) });
        const r = await http(API.settingsTest, { method: "POST" });
        resultEl.className = `test-result ${r.ok ? "success" : "error"}`;
        resultEl.textContent = r.message || (r.ok ? "连接成功" : "连接失败");
    } catch (e) {
        resultEl.className = "test-result error";
        resultEl.textContent = e.message;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "测试连接"; }
    }
}

function readSettingsForm() {
    const secretId = $("#f-secretId").value.trim();
    const secretKey = $("#f-secretKey").value.trim();
    const region = $("#f-region").value;
    if (!secretId) { toast("请填写 SecretId", "error"); return null; }
    // secretKey 可为空（保留原值），但首次配置时必填
    if (!secretKey) {
        const hint = document.querySelector("#f-secretKey").parentElement.querySelector(".hint");
        if (!hint) { toast("请填写 SecretKey", "error"); return null; }
    }
    return { secretId, secretKey, region };
}

async function submitSettings() {
    const payload = readSettingsForm();
    if (payload === null) return;
    try {
        const r = await http(API.settings, { method: "POST", body: JSON.stringify(payload) });
        toast("配置已保存", "success");
        closeModal();
        applyConfigState(r);
        loadZones();
    } catch (e) { toast(e.message, "error"); }
}

function applyConfigState(cfg) {
    const alertEl = $("#configAlert");
    if (cfg && cfg.configured) {
        alertEl.style.display = "none";
    } else {
        alertEl.style.display = "block";
    }
}

// ---------- 模态框 ----------
function openModal(title, bodyHtml, footerButtons) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml;
    const footer = $("#modalFooter");
    footer.innerHTML = "";
    footerButtons.forEach((b) => {
        const btn = document.createElement("button");
        btn.className = `btn ${b.class || ""}`;
        btn.textContent = b.label;
        btn.addEventListener("click", async () => {
            // ghost/取消类按钮不阻塞
            if (b.class === "ghost") { b.onClick(); return; }
            if (btn.disabled) return;
            btn.disabled = true;
            const origText = b.label;
            btn.textContent = "处理中...";
            try { await b.onClick(); }
            finally {
                // 若弹窗已关闭则无需恢复；否则恢复按钮状态
                if ($("#modalOverlay").classList.contains("active")) {
                    btn.disabled = false;
                    btn.textContent = origText;
                }
            }
        });
        footer.appendChild(btn);
    });
    $("#modalOverlay").classList.add("active");
}

function closeModal() {
    // 关闭弹窗时清理 DDNS 日志定时器
    if (_ddnsLogsTimer) {
        clearInterval(_ddnsLogsTimer);
        _ddnsLogsTimer = null;
    }
    // 同时清理系统日志定时器
    if (_logsTimer) {
        clearInterval(_logsTimer);
        _logsTimer = null;
    }
    $("#modalOverlay").classList.remove("active");
}

// ---------- DDNS 自动更新源站组 ----------
async function openDdnsModal() {
    openModal("加载中", `<p>正在读取 DDNS 配置...</p>`, []);
    try {
        // 确保站点列表已加载（解决站点为空问题）
        if (!state.zones || state.zones.length === 0) {
            await loadZones();
        }

        const cfg = await http(API.ddns);
        // 若配置中没有站点，默认使用当前页面选中的站点（若仍为空则用第一个站点）
        if (!cfg.zoneId) {
            if (state.zoneId) {
                cfg.zoneId = state.zoneId;
            } else if (state.zones && state.zones.length) {
                cfg.zoneId = state.zones[0].ZoneId;
                state.zoneId = cfg.zoneId;
            }
        }
        // 读取当前站点下的源站组
        let groups = [];
        if (cfg.zoneId) {
            try {
                const r = await http(API.originGroups(cfg.zoneId));
                groups = r.groups || [];
            } catch (e) { /* 忽略 */ }
        }
        renderDdnsModal(cfg, groups);
    } catch (e) {
        closeModal();
        toast(e.message, "error");
    }
}

function renderDdnsModal(cfg, groups) {
    const ifaceOpts = (cfg.interfaces || []).map(i =>
        `<option value="${esc(i.name)}" ${cfg.interfaceName === i.name ? "selected" : ""}>${esc(i.name)} (v4: ${i.ipv4.join(",") || "无"} | v6: ${i.ipv6.join(",") || "无"})</option>`
    ).join("");

    const groupOpts = groups.map(g =>
        `<option value="${esc(g.GroupId)}" data-name="${esc(g.Name)}" ${cfg.groupId === g.GroupId ? "selected" : ""}>${esc(g.Name)}</option>`
    ).join("");

    let zoneOpts;
    if (state.zones && state.zones.length) {
        zoneOpts = state.zones.map(z =>
            `<option value="${esc(z.ZoneId)}" ${cfg.zoneId === z.ZoneId ? "selected" : ""}>${esc(z.ZoneName)} (${esc(z.ZoneId)})</option>`
        ).join("");
    } else {
        zoneOpts = `<option value="">站点列表未加载，请点击右上角刷新按钮</option>`;
    }

    const statusBadge = cfg.running
        ? '<span class="badge online">运行中</span>'
        : '<span class="badge offline">已停止</span>';

    const lastStatusBadge = cfg.lastStatus === "success"
        ? '<span class="badge online">成功</span>'
        : cfg.lastStatus === "fail"
        ? '<span class="badge offline">失败</span>'
        : '<span class="badge processing">未执行</span>';

    const body = `
    <div class="ddns-tabs">
        <button class="ddns-tab active" data-tab="config">配置</button>
        <button class="ddns-tab" data-tab="logs">运行日志</button>
    </div>
    <div class="ddns-tab-content" data-tab="config">
        <div class="ddns-status-bar">
            <div><strong>调度器状态：</strong>${statusBadge}</div>
            <div><strong>上次结果：</strong>${lastStatusBadge}</div>
            ${cfg.lastUpdate ? `<div><strong>上次时间：</strong>${esc(cfg.lastUpdate)}</div>` : ""}
            ${cfg.lastIp ? `<div><strong>上次 IP：</strong><code>${esc(cfg.lastIp)}</code></div>` : ""}
        </div>
        ${cfg.lastMessage ? `<div class="ddns-last-msg">${esc(cfg.lastMessage)}</div>` : ""}

        <div class="form-group">
            <label><input type="checkbox" id="f-ddns-enabled" ${cfg.enabled ? "checked" : ""} /> 启用自动更新</label>
        </div>
        <div class="form-group">
            <label>站点</label>
            <select class="form-control" id="f-ddns-zone">${zoneOpts}</select>
        </div>
        <div class="form-group">
            <label>源站组</label>
            <select class="form-control" id="f-ddns-group"><option value="">请选择源站组</option>${groupOpts}</select>
        </div>
        <div class="form-row">
            <div class="form-group" style="flex:1">
                <label>更新间隔（秒）</label>
                <input class="form-control" type="number" id="f-ddns-interval" value="${cfg.interval || 300}" min="30" />
            </div>
            <div class="form-group" style="flex:1">
                <label>IP 类型</label>
                <select class="form-control" id="f-ddns-ipType">
                    <option value="ipv4" ${cfg.ipType === "ipv4" ? "selected" : ""}>IPv4</option>
                    <option value="ipv6" ${cfg.ipType === "ipv6" ? "selected" : ""}>IPv6</option>
                </select>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group" style="flex:1">
                <label>获取方式</label>
                <select class="form-control" id="f-ddns-method">
                    <option value="network_interface" ${cfg.method === "network_interface" ? "selected" : ""}>网卡获取（本机 IP）</option>
                    <option value="external_api" ${cfg.method === "external_api" ? "selected" : ""}>网络接口获取（公网出口 IP）</option>
                </select>
            </div>
            <div class="form-group" style="flex:1" id="iface-group" ${cfg.method !== "network_interface" ? 'style="display:none"' : ""}>
                <label>网卡名称（为空自动选择）</label>
                <select class="form-control" id="f-ddns-interface"><option value="">自动选择</option>${ifaceOpts}</select>
            </div>
        </div>
        <hr style="border:none;border-top:1px dashed var(--border);margin:16px 0" />
        <div class="form-group">
            <label><input type="checkbox" id="f-ddns-webhookEnabled" ${cfg.webhookEnabled ? "checked" : ""} /> 启用 Webhook 消息推送</label>
        </div>
        <div class="form-group" id="webhook-group" ${!cfg.webhookEnabled ? 'style="display:none"' : ""}>
            <label>Webhook 地址（钉钉/企微机器人）</label>
            <div style="display:flex;gap:8px">
                <input class="form-control" id="f-ddns-webhookUrl" value="${esc(cfg.webhookUrl || "")}" placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxx" />
                <button class="btn ghost sm" id="testWebhookBtn">测试</button>
            </div>
            <div class="hint">自动识别钉钉/企微机器人，URL 中包含 oapi.dingtalk.com 或 qyapi.weixin.qq.com 即可</div>
            <label style="margin-top:10px">消息模板（留空使用默认模板，支持 Markdown）</label>
            <textarea class="form-control" id="f-ddns-webhookTemplate" rows="6" style="font-family:monospace;font-size:13px" placeholder="### {title}

**源站组**: {group_name}
**旧 IP**: {old_ip}
**新 IP**: {new_ip}
**状态**: {status}
**时间**: {time}">${esc(cfg.webhookTemplate || "")}</textarea>
            <div class="hint">可用变量: {title} {group_name} {old_ip} {new_ip} {status} {time} {message}</div>
        </div>
    </div>
    <div class="ddns-tab-content" data-tab="logs" style="display:none">
        <div class="log-controls">
            <label><input type="checkbox" id="ddnsLogFollow" checked /> 自动滚动</label>
            <label><input type="checkbox" id="ddnsLogAuto" /> 自动刷新 (3秒)</label>
            <span class="spacer"></span>
            <button class="btn sm ghost" id="ddnsLogRefreshBtn">刷新</button>
        </div>
        <div id="ddnsLogBox" class="log-box"></div>
    </div>`;

    openModal("DDNS 自动更新源站组", body, [
        { label: "手动执行一次", class: "ghost", onClick: runDdnsOnce },
        { label: "保存配置", class: "primary", onClick: submitDdns },
    ]);

    // 标签页切换
    document.querySelectorAll(".ddns-tab").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".ddns-tab").forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".ddns-tab-content").forEach(c => c.style.display = "none");
            btn.classList.add("active");
            document.querySelector(`.ddns-tab-content[data-tab="${btn.dataset.tab}"]`).style.display = "";
            if (btn.dataset.tab === "logs") {
                refreshDdnsLogs();
            }
        });
    });

    // 联动：获取方式切换时显隐网卡选择
    $("#f-ddns-method").addEventListener("change", (e) => {
        $("#iface-group").style.display = e.target.value === "network_interface" ? "" : "none";
    });
    // 联动：webhook 开关
    $("#f-ddns-webhookEnabled").addEventListener("change", (e) => {
        $("#webhook-group").style.display = e.target.checked ? "" : "none";
    });
    // 切换站点时重新加载源站组
    $("#f-ddns-zone").addEventListener("change", async (e) => {
        try {
            const r = await http(API.originGroups(e.target.value));
            const opts = (r.groups || []).map(g =>
                `<option value="${esc(g.GroupId)}" data-name="${esc(g.Name)}">${esc(g.Name)}</option>`
            ).join("");
            $("#f-ddns-group").innerHTML = `<option value="">请选择源站组</option>${opts}`;
        } catch (e) { /* 忽略 */ }
    });
    // 测试 webhook
    $("#testWebhookBtn").addEventListener("click", async () => {
        const url = $("#f-ddns-webhookUrl").value.trim();
        if (!url) return toast("请填写 webhook 地址", "error");
        const btn = $("#testWebhookBtn");
        btn.disabled = true; btn.textContent = "发送中...";
        try {
            const r = await http(API.ddnsTestWebhook, { method: "POST", body: JSON.stringify({ webhookUrl: url }) });
            toast(r.message || "已发送", "success");
        } catch (e) { toast(e.message, "error"); }
        finally { btn.disabled = false; btn.textContent = "测试"; }
    });

    // DDNS 日志控件绑定
    if ($("#ddnsLogFollow")) {
        $("#ddnsLogFollow").addEventListener("change", (e) => {
            _ddnsLogsFollow = e.target.checked;
            if (_ddnsLogsFollow) {
                const box = $("#ddnsLogBox");
                box.scrollTop = box.scrollHeight;
            }
        });
    }
    if ($("#ddnsLogAuto")) {
        $("#ddnsLogAuto").addEventListener("change", (e) => {
            if (e.target.checked) {
                _ddnsLogsTimer = setInterval(refreshDdnsLogs, 3000);
            } else if (_ddnsLogsTimer) {
                clearInterval(_ddnsLogsTimer);
                _ddnsLogsTimer = null;
            }
        });
    }
    if ($("#ddnsLogRefreshBtn")) {
        $("#ddnsLogRefreshBtn").addEventListener("click", refreshDdnsLogs);
    }
}

// DDNS 日志相关
let _ddnsLogsFollow = true;
let _ddnsLogsTimer = null;

async function refreshDdnsLogs() {
    try {
        const r = await http(API.ddnsLogs(500));
        const box = $("#ddnsLogBox");
        if (!box) return;
        box.innerHTML = (r.lines && r.lines.length)
            ? r.lines.map(l => `<div class="log-line">${esc(l)}</div>`).join("")
            : `<div class="log-empty">暂无 DDNS 日志</div>`;
        if (_ddnsLogsFollow) {
            box.scrollTop = box.scrollHeight;
        }
    } catch (e) { /* 忽略 */ }
}

async function submitDdns() {
    const data = {
        enabled: $("#f-ddns-enabled").checked,
        zoneId: $("#f-ddns-zone").value,
        groupId: $("#f-ddns-group").value,
        groupName: ($("#f-ddns-group").selectedOptions[0] || {}).dataset?.name || "",
        interval: parseInt($("#f-ddns-interval").value, 10) || 300,
        ipType: $("#f-ddns-ipType").value,
        method: $("#f-ddns-method").value,
        interfaceName: $("#f-ddns-interface").value,
        webhookEnabled: $("#f-ddns-webhookEnabled").checked,
        webhookUrl: $("#f-ddns-webhookUrl").value.trim(),
        webhookTemplate: $("#f-ddns-webhookTemplate").value,
    };
    if (data.enabled && (!data.zoneId || !data.groupId)) {
        return toast("启用时必须选择站点和源站组", "error");
    }
    try {
        const r = await http(API.ddns, { method: "POST", body: JSON.stringify(data) });
        toast("配置已保存" + (data.enabled ? "，调度器已启动" : ""), "success");
        closeModal();
    } catch (e) { toast(e.message, "error"); }
}

async function runDdnsOnce() {
    try {
        // 先收集弹窗中的当前配置并保存，确保执行时用的是最新选择
        const zoneId = $("#f-ddns-zone")?.value || "";
        const groupId = $("#f-ddns-group")?.value || "";
        if (!zoneId || !groupId) {
            return toast("请先选择站点和源站组", "error");
        }
        const data = {
            enabled: $("#f-ddns-enabled")?.checked ?? false,
            zoneId,
            groupId,
            groupName: ($("#f-ddns-group").selectedOptions[0] || {}).dataset?.name || "",
            interval: parseInt($("#f-ddns-interval")?.value, 10) || 300,
            ipType: $("#f-ddns-ipType")?.value || "ipv4",
            method: $("#f-ddns-method")?.value || "network_interface",
            interfaceName: $("#f-ddns-interface")?.value || "",
            webhookEnabled: $("#f-ddns-webhookEnabled")?.checked ?? false,
            webhookUrl: $("#f-ddns-webhookUrl")?.value.trim() || "",
            webhookTemplate: $("#f-ddns-webhookTemplate")?.value || "",
        };
        // 保存配置（不启动调度器，保持 enabled 原值）
        await http(API.ddns, { method: "POST", body: JSON.stringify(data) });
        // 再执行一次更新
        const r = await http(API.ddnsRun, { method: "POST" });
        toast(r.message || "执行完成", r.ok ? "success" : "error");
    } catch (e) { toast(e.message, "error"); }
}

// ---------- 日志查看弹窗 ----------
let _logsTimer = null;
let _logsFollow = true;  // 是否自动滚动到底部

async function refreshLogs() {
    try {
        const r = await http(API.logs(500));
        const box = document.getElementById("logBox");
        if (!box) return;
        const lines = r.lines || [];
        box.innerHTML = lines.map(colorizeLogLine).join("\n");
        if (_logsFollow) {
            box.scrollTop = box.scrollHeight;
        }
    } catch (e) {
        const box = document.getElementById("logBox");
        if (box) box.textContent = `读取日志失败: ${e.message}`;
    }
}

function colorizeLogLine(line) {
    let cls = "log-line";
    if (/\[(ERROR|ERR)\]/.test(line)) cls += " log-err";
    else if (/\[(WARN|WARNING)\]/.test(line)) cls += " log-warn";
    else if (/\[INFO\]/.test(line)) cls += " log-info";
    else if (/<- FAIL/.test(line)) cls += " log-err";
    else if (/-> |<- /.test(line)) cls += " log-api";
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<div class="${cls}">${esc(line)}</div>`;
}

async function clearLogsAction() {
    if (!confirm("确认清空所有日志？")) return;
    try {
        const r = await http(API.logs(), { method: "DELETE" });
        toast(r.message || "已清空", "success");
        await refreshLogs();
    } catch (e) { toast(e.message, "error"); }
}

function openLogsModal() {
    const body = `
        <div class="log-controls">
            <label><input type="checkbox" id="logFollow" checked /> 自动滚动</label>
            <label><input type="checkbox" id="logAuto" /> 自动刷新 (3秒)</label>
            <span class="spacer"></span>
            <button class="btn sm ghost" id="logRefreshBtn">刷新</button>
            <button class="btn sm danger" id="logClearBtn">清空</button>
        </div>
        <div id="logBox" class="log-box"></div>
    `;
    openModal("系统日志", body, [{ label: "关闭", class: "primary", onClick: closeLogsModal }]);

    // 绑定控件
    $("#logFollow").addEventListener("change", (e) => {
        _logsFollow = e.target.checked;
        if (_logsFollow) {
            const box = $("#logBox");
            box.scrollTop = box.scrollHeight;
        }
    });
    $("#logAuto").addEventListener("change", (e) => {
        if (e.target.checked) {
            _logsTimer = setInterval(refreshLogs, 3000);
        } else if (_logsTimer) {
            clearInterval(_logsTimer);
            _logsTimer = null;
        }
    });
    $("#logRefreshBtn").addEventListener("click", refreshLogs);
    $("#logClearBtn").addEventListener("click", clearLogsAction);

    // 首次加载
    refreshLogs();
}

function closeLogsModal() {
    if (_logsTimer) { clearInterval(_logsTimer); _logsTimer = null; }
    closeModal();
}

async function bootstrap() {
    // 先检查配置状态，未配置则提示并自动打开设置页
    try {
        const cfg = await http(API.settings);
        applyConfigState(cfg);
        if (!cfg.configured) {
            $("#zoneSelect").innerHTML = `<option value="">未配置</option>`;
            setTimeout(openSettingsModal, 300);
            return;
        }
    } catch (e) {
        toast(e.message, "error");
    }
    loadZones();
}

// ---------- 认证 ----------
async function logout() {
    try {
        await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } });
    } catch (e) { /* 忽略 */ }
    window.location.href = "/login";
}

function openChangePasswordModal() {
    const body = `
        <div class="form-group">
            <label>旧密码</label>
            <input class="form-control" type="password" id="f-oldPw" autocomplete="current-password" />
        </div>
        <div class="form-group">
            <label>新密码（至少 3 个字符）</label>
            <input class="form-control" type="password" id="f-newPw" autocomplete="new-password" />
        </div>
        <div class="form-group">
            <label>确认新密码</label>
            <input class="form-control" type="password" id="f-confirmPw" autocomplete="new-password" />
        </div>`;
    openModal("修改管理员密码", body, [{ label: "保存", class: "primary", onClick: submitChangePassword }]);
}

async function submitChangePassword() {
    const oldPw = $("#f-oldPw").value;
    const newPw = $("#f-newPw").value;
    const confirmPw = $("#f-confirmPw").value;
    if (!oldPw || !newPw) return toast("请填写旧密码和新密码", "error");
    if (newPw.length < 3) return toast("新密码至少 3 个字符", "error");
    if (newPw !== confirmPw) return toast("两次输入的新密码不一致", "error");

    const btn = document.querySelector(".modal-footer .btn.primary");
    if (btn) { btn.disabled = true; btn.textContent = "保存中..."; }
    try {
        const r = await http("/api/auth/change-password", {
            method: "POST", body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw })
        });
        toast(r.message || "密码修改成功", "success");
        closeModal();
    } catch (e) {
        toast(e.message, "error");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "保存"; }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    $("#zoneSelect").addEventListener("change", (e) => {
        state.zoneId = e.target.value;
        loadDomains();
    });
    $("#refreshBtn").addEventListener("click", loadZones);
    $("#addBtn").addEventListener("click", openAddModal);
    $("#settingsBtn").addEventListener("click", openSettingsModal);
    $("#logsBtn").addEventListener("click", openLogsModal);
    $("#ddnsBtn").addEventListener("click", openDdnsModal);
    $("#changePwBtn").addEventListener("click", openChangePasswordModal);
    $("#logoutBtn").addEventListener("click", logout);
    $("#searchInput").addEventListener("input", renderDomains);
    $("#modalClose").addEventListener("click", closeModal);
    // 禁用点击弹窗外部关闭，仅通过按钮或关闭按钮关闭
    bootstrap();
});
