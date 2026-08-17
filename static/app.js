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
    rules: (zid) => `/api/zones/${zid}/rules`,
    rule: (zid, rid) => `/api/zones/${zid}/rules/${encodeURIComponent(rid)}`,
    createRule: (zid) => `/api/zones/${zid}/rules`,
    modifyRule: (zid, rid) => `/api/zones/${zid}/rules/${encodeURIComponent(rid)}`,
    ruleStatus: (zid, rid) => `/api/zones/${zid}/rules/${encodeURIComponent(rid)}/status`,
    deleteRule: (zid, rid) => `/api/zones/${zid}/rules/${encodeURIComponent(rid)}`,
    ruleTemplate: () => `/api/rule-template`,
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
// 创建一个按钮元素（footer 和 header 共用）
function _makeModalBtn(b) {
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
    return btn;
}

function openModal(title, bodyHtml, footerButtons, opts = {}) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml;
    const footer = $("#modalFooter");
    footer.innerHTML = "";
    (footerButtons || []).forEach((b) => footer.appendChild(_makeModalBtn(b)));

    // 顶部 header 工具栏按钮（如"添加规则"、"关闭"）
    const headerActions = $("#modalHeaderActions");
    headerActions.innerHTML = "";
    (opts.headerActions || []).forEach((b) => headerActions.appendChild(_makeModalBtn(b)));

    // 弹窗尺寸变体：modal-rules（规则引擎放大）、modal-lg 等
    const box = $("#modalBox");
    box.classList.remove("modal-rules", "modal-lg");
    if (opts.size === "rules") box.classList.add("modal-rules");

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

// 关闭规则引擎弹窗后强制刷新域名管理表格（规则启停/修改/删除/创建可能影响域名状态）
function closeRulesModal() {
    closeModal();
    loadDomains();
}

// ---------- 规则引擎 ----------
async function openRulesModal() {
    if (!state.zoneId) return toast("请先选择站点", "error");
    openModal("规则引擎 - 加载中", `<p>正在读取规则列表...</p>`, []);
    try {
        const r = await http(API.rules(state.zoneId));
        renderRulesList(r.rules || []);
    } catch (e) {
        closeModal();
        toast(e.message, "error");
    }
}

function renderRulesList(rules) {
    if (!rules.length) {
        openModal("规则引擎 - 规则列表", `
            <p style="color:var(--muted);margin-top:0">当前站点下暂无规则引擎规则。</p>
            <div class="hint">点击右上角 <strong>"添加规则"</strong> 按钮可创建一条新的加速规则。</div>
        `, [], {
            size: "rules",
            headerActions: [
                { label: "+ 添加规则", class: "primary", onClick: openAddRuleModal },
                { label: "关闭", class: "ghost", onClick: closeRulesModal },
            ],
        });
        return;
    }
    const rows = rules.map((r) => {
        const st = (r.Status || "").toLowerCase();
        const isOn = st === "enable";
        const statusBadge = isOn
            ? '<span class="badge online">启用</span>'
            : st === "disable"
            ? '<span class="badge offline">停用</span>'
            : `<span class="badge processing">${esc(r.Status || "未知")}</span>`;
        const rid = esc(r.RuleId || "");
        const toggleLabel = isOn ? "停用" : "启用";
        const toggleClass = isOn ? "warn" : "primary";
        return `
        <tr>
            <td><code>${rid}</code></td>
            <td>${esc(r.RuleName || "-")}</td>
            <td>${statusBadge}</td>
            <td>${esc(r.RulePriority ?? "-")}</td>
            <td class="col-actions">
                <button class="btn sm ${toggleClass}" data-act="toggle" data-rid="${rid}" data-status="${isOn ? "disable" : "enable"}">${toggleLabel}</button>
                <button class="btn sm ghost" data-act="view" data-rid="${rid}">查看</button>
                <button class="btn sm ghost" data-act="edit" data-rid="${rid}">修改</button>
                <button class="btn sm danger" data-act="delete" data-rid="${rid}" data-name="${esc(r.RuleName || "")}">删除</button>
            </td>
        </tr>`;
    }).join("");
    const body = `
    <p style="color:var(--muted);margin-top:0">当前站点共 ${rules.length} 条规则（按优先级升序排列，数值小先执行）。</p>
    <div class="table-wrap">
        <table class="domain-table">
            <thead><tr><th>规则 ID</th><th>规则名</th><th>状态</th><th>优先级</th><th class="col-actions">操作</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
    openModal("规则引擎 - 规则列表", body, [], {
        size: "rules",
        headerActions: [
            { label: "+ 添加规则", class: "primary", onClick: openAddRuleModal },
            { label: "关闭", class: "ghost", onClick: closeRulesModal },
        ],
    });
    // 绑定操作按钮
    document.querySelectorAll("[data-act][data-rid]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const act = btn.dataset.act;
            const rid = btn.dataset.rid;
            if (act === "toggle") return toggleRuleStatus(rid, btn.dataset.status);
            if (act === "view") return viewRule(rid);
            if (act === "edit") return openEditRuleModal(rid);
            if (act === "delete") return confirmDeleteRule(rid, btn.dataset.name);
        });
    });
}

async function toggleRuleStatus(ruleId, status) {
    try {
        const r = await http(API.ruleStatus(state.zoneId, ruleId), {
            method: "PATCH",
            body: JSON.stringify({ status }),
        });
        toast(r.message || "操作成功", "success");
        openRulesModal();
    } catch (e) {
        toast(e.message, "error");
    }
}

function confirmDeleteRule(ruleId, ruleName) {
    openModal("删除规则", `
        <p style="margin-top:0">确认删除以下规则吗？此操作不可撤销。</p>
        <div class="hint">
            规则 ID：<code>${esc(ruleId)}</code><br>
            规则名：${esc(ruleName || "-")}
        </div>
    `, [
        { label: "取消", class: "ghost", onClick: closeModal },
        { label: "确认删除", class: "danger", onClick: deleteRule(ruleId) },
    ], {
        size: "rules",
        headerActions: [{ label: "关闭", class: "ghost", onClick: closeRulesModal }],
    });
}

function deleteRule(ruleId) {
    return async () => {
        try {
            const r = await http(API.deleteRule(state.zoneId, ruleId), { method: "DELETE" });
            toast(r.message || "已删除", "success");
            closeModal();
            openRulesModal();
        } catch (e) {
            toast(e.message, "error");
        }
    };
}

// ============================================================
// 规则引擎图形化编辑器
// 动作元数据基于腾讯云 EdgeOne SDK RuleEngineAction 类定义
// ============================================================

// 匹配条件支持的变量
const CONDITION_VARS = [
    { v: "http.request.host", label: "请求 Host（域名）" },
    { v: "http.request.uri", label: "完整 URI（含参数）" },
    { v: "http.request.uri.path", label: "URI 路径（不含参数）" },
    { v: "http.request.uri.path.extension", label: "文件扩展名" },
    { v: "http.request.method", label: "请求方法" },
    { v: "http.request.scheme", label: "协议（http/https）" },
    { v: "http.request.user_agent", label: "User-Agent" },
    { v: "http.request.referer", label: "Referer" },
    { v: "http.request.client_ip", label: "客户端 IP" },
    { v: "ip.geo.country", label: "国家代码" },
    { v: "ip.geo.province", label: "省份" },
    { v: "ip.geo.isp", label: "运营商" },
];

// 匹配条件支持的操作符
const CONDITION_OPS = [
    { v: "in", label: "属于（多值）" },
    { v: "notIn", label: "不属于（多值）" },
    { v: "equal", label: "等于" },
    { v: "notEqual", label: "不等于" },
    { v: "match", label: "通配匹配 * ?" },
    { v: "notMatch", label: "通配不匹配" },
    { v: "startsWith", label: "前缀匹配" },
    { v: "endsWith", label: "后缀匹配" },
    { v: "contains", label: "包含" },
    { v: "notContains", label: "不包含" },
    { v: "regex", label: "正则匹配" },
    { v: "notRegex", label: "正则不匹配" },
    { v: "gt", label: "大于（数值）" },
    { v: "gte", label: "大于等于" },
    { v: "lt", label: "小于" },
    { v: "lte", label: "小于等于" },
];

// 动作类型元数据：label=中文名 cat=分类 paramsKey=Parameters字段名
// fields=null 表示该动作用 JSON 兜底编辑
const ACTION_META = {
    WebSocket: { label: "WebSocket", cat: "协议", paramsKey: "WebSocketParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
        { key: "Timeout", label: "超时时间（秒，≤120）", type: "number", min: 1, max: 120, when: { Switch: "on" } },
    ]},
    Cache: { label: "节点缓存 TTL", cat: "缓存", paramsKey: "CacheParameters", fields: [
        { key: "__cacheMode", label: "缓存模式", type: "cacheMode" },
    ]},
    CachePrefresh: { label: "缓存预刷新", cat: "缓存", paramsKey: "CachePrefreshParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
        { key: "CacheTimePercent", label: "预刷新百分比（1-99）", type: "number", min: 1, max: 99, when: { Switch: "on" } },
    ]},
    StatusCodeCache: { label: "状态码缓存 TTL", cat: "缓存", paramsKey: "StatusCodeCacheParameters", fields: [
        { key: "__statusCodeCache", label: "状态码缓存规则", type: "statusCodeCache", unit: "time" },
    ]},
    OfflineCache: { label: "离线缓存", cat: "缓存", paramsKey: "OfflineCacheParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
    ]},
    QUIC: { label: "QUIC（HTTP/3）", cat: "协议", paramsKey: "QUICParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
    ]},
    HTTP2: { label: "HTTP/2 接入", cat: "协议", paramsKey: "HTTP2Parameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
    ]},
    UpstreamHTTP2: { label: "HTTP/2 回源", cat: "协议", paramsKey: "UpstreamHTTP2Parameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
    ]},
    ForceRedirectHTTPS: { label: "强制 HTTPS 跳转", cat: "协议", paramsKey: "ForceRedirectHTTPSParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
        { key: "RedirectStatusCode", label: "跳转状态码", type: "select", options: [{ v: 301, t: "301" }, { v: 302, t: "302" }], when: { Switch: "on" } },
    ]},
    OriginPullProtocol: { label: "回源协议", cat: "协议", paramsKey: "OriginPullProtocolParameters", fields: [
        { key: "Protocol", label: "回源协议", type: "select", options: [{ v: "http", t: "HTTP" }, { v: "https", t: "HTTPS" }, { v: "follow", t: "协议跟随" }] },
    ]},
    HSTS: { label: "HSTS", cat: "协议", paramsKey: "HSTSParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
        { key: "Timeout", label: "缓存时间（1 秒 ~ 365 天）", type: "number", min: 1, max: 31536000, unit: "time", when: { Switch: "on" } },
        { key: "IncludeSubDomains", label: "子域名继承", type: "switch", when: { Switch: "on" } },
        { key: "Preload", label: "浏览器预加载", type: "switch", when: { Switch: "on" } },
    ]},
    OCSPStapling: { label: "OCSP 装订", cat: "协议", paramsKey: "OCSPStaplingParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
    ]},
    Compression: { label: "智能压缩", cat: "压缩", paramsKey: "CompressionParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
        { key: "Algorithms", label: "压缩算法", type: "multiselect", options: [{ v: "brotli", t: "Brotli" }, { v: "gzip", t: "Gzip" }], when: { Switch: "on" } },
    ]},
    ModifyRequestHeader: { label: "修改请求头", cat: "HTTP 头", paramsKey: "ModifyRequestHeaderParameters", fields: [
        { key: "__headerActions", label: "头部规则", type: "headerActions" },
    ]},
    ModifyResponseHeader: { label: "修改响应头", cat: "HTTP 头", paramsKey: "ModifyResponseHeaderParameters", fields: [
        { key: "__headerActions", label: "头部规则", type: "headerActions" },
    ]},
    HostHeader: { label: "Host Header 重写", cat: "HTTP 头", paramsKey: "HostHeaderParameters", fields: [
        { key: "Action", label: "动作", type: "select", options: [{ v: "followOrigin", t: "跟随源站域名" }, { v: "custom", t: "自定义" }] },
        { key: "ServerName", label: "域名", type: "text", when: { Action: "custom" } },
    ]},
    ClientIPHeader: { label: "客户端 IP 头", cat: "HTTP 头", paramsKey: "ClientIPHeaderParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
        { key: "HeaderName", label: "头名称（不可填 X-Forwarded-For）", type: "text", when: { Switch: "on" } },
    ]},
    PostMaxSize: { label: "POST 上传大小限制", cat: "其他", paramsKey: "PostMaxSizeParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
        { key: "MaxSize", label: "最大值（字节，1MB-800MB）", type: "number", min: 1048576, max: 838860800, when: { Switch: "on" } },
    ]},
    ResponseSpeedLimit: { label: "单连接下载限速", cat: "其他", paramsKey: "ResponseSpeedLimitParameters", fields: [
        { key: "Mode", label: "限速模式", type: "select", options: [{ v: "LimitUponDownload", t: "全过程限速" }, { v: "LimitAfterSpecificBytesDownloaded", t: "特定字节后限速" }, { v: "LimitAfterSpecificSecondsDownloaded", t: "特定时间后限速" }] },
        { key: "MaxSpeed", label: "限速值（如 1024KB/s）", type: "text" },
        { key: "StartAt", label: "开始值（KB 或 s，按模式）", type: "text", when: { Mode: "!LimitUponDownload" } },
    ]},
    HTTPResponse: { label: "HTTP 应答", cat: "其他", paramsKey: "HTTPResponseParameters", fields: [
        { key: "StatusCode", label: "状态码", type: "select", options: [{v:200,t:"200"},{v:204,t:"204"},{v:400,t:"400"},{v:403,t:"403"},{v:404,t:"404"},{v:500,t:"500"},{v:502,t:"502"},{v:503,t:"503"}] },
        { key: "ResponsePage", label: "响应页面 ID", type: "text" },
    ]},
    RangeOriginPull: { label: "分片回源", cat: "源站", paramsKey: "RangeOriginPullParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
    ]},
    SmartRouting: { label: "智能加速", cat: "源站", paramsKey: "SmartRoutingParameters", fields: [
        { key: "Switch", label: "开启", type: "switch" },
    ]},
    // 以下动作用 JSON 兜底编辑（字段较复杂或为白名单功能）
    CacheKey: { label: "自定义 Cache Key", cat: "缓存", paramsKey: "CacheKeyParameters", fields: null },
    MaxAge: { label: "浏览器缓存 TTL", cat: "缓存", paramsKey: "MaxAgeParameters", fields: null },
    AccessURLRedirect: { label: "访问 URL 重定向", cat: "其他", paramsKey: "AccessURLRedirectParameters", fields: null },
    UpstreamURLRewrite: { label: "回源 URL 重写", cat: "其他", paramsKey: "UpstreamURLRewriteParameters", fields: null },
    Authentication: { label: "Token 鉴权", cat: "其他", paramsKey: "AuthenticationParameters", fields: null },
    AdvancedOriginRouting: { label: "高级回源优化", cat: "源站", paramsKey: "AdvancedOriginRoutingParameters", fields: null },
    UpstreamRequest: { label: "回源请求参数", cat: "源站", paramsKey: "UpstreamRequestParameters", fields: null },
    Shield: { label: "源站卸载", cat: "源站", paramsKey: "ShieldParameters", fields: null },
    TLSConfig: { label: "SSL/TLS 安全", cat: "协议", paramsKey: "TLSConfigParameters", fields: null },
    ModifyOrigin: { label: "修改源站", cat: "源站", paramsKey: "ModifyOriginParameters", fields: null },
    SiteFailover: { label: "源站故障转移", cat: "源站", paramsKey: "SiteFailoverParameters", fields: null },
    HTTPUpstreamTimeout: { label: "七层回源超时", cat: "协议", paramsKey: "HTTPUpstreamTimeoutParameters", fields: null },
    ErrorPage: { label: "自定义错误页面", cat: "其他", paramsKey: "ErrorPageParameters", fields: null },
    ClientIPCountry: { label: "客户端 IP 地域", cat: "HTTP 头", paramsKey: "ClientIPCountryParameters", fields: null },
    UpstreamFollowRedirect: { label: "回源跟随重定向", cat: "源站", paramsKey: "UpstreamFollowRedirectParameters", fields: null },
    Vary: { label: "Vary 特性", cat: "其他", paramsKey: "VaryParameters", fields: null },
    SetContentIdentifier: { label: "设置内容标识符", cat: "其他", paramsKey: "SetContentIdentifierParameters", fields: null },
    ContentCompression: { label: "内容压缩", cat: "压缩", paramsKey: "ContentCompressionParameters", fields: null },
    OriginAuthentication: { label: "回源鉴权", cat: "源站", paramsKey: "OriginAuthenticationParameters", fields: null },
    CustomAction: { label: "定制配置", cat: "其他", paramsKey: "CustomActionParameters", fields: null },
};

// 动作分类顺序
const ACTION_CATS = ["缓存", "协议", "压缩", "HTTP 头", "源站", "其他"];

// 编辑器内部状态
let _ruleEditor = null;

// 生成动作下拉选项（按分类分组）
function _actionSelectOptions(selected) {
    const groups = ACTION_CATS.map((cat) => {
        const items = Object.entries(ACTION_META).filter(([, m]) => m.cat === cat);
        if (!items.length) return "";
        const opts = items.map(([name, m]) => `<option value="${name}" ${selected === name ? "selected" : ""}>${m.label}</option>`).join("");
        return `<optgroup label="${cat}">${opts}</optgroup>`;
    }).join("");
    return groups;
}

// ---------- 条件编辑器 ----------
// 从 Condition 表达式字符串解析回可视化结构（尽力解析）
// 时间单位：显示可选，内部始终按「秒」存储（提交给 EdgeOne API）
const TIME_UNITS = [
    { v: "s", t: "秒",  m: 1 },
    { v: "m", t: "分",  m: 60 },
    { v: "h", t: "时",  m: 3600 },
    { v: "d", t: "天",  m: 86400 },
];
function _findBestUnit(sec) {
    sec = Number(sec) || 0;
    if (sec <= 0) return "s";
    if (sec % 86400 === 0) return "d";
    if (sec % 3600 === 0) return "h";
    if (sec % 60 === 0) return "m";
    return "s";
}
function _timeUnitOptions(selected) {
    return TIME_UNITS.map((u) => `<option value="${u.v}" ${u.v === selected ? "selected" : ""}>${u.t}</option>`).join("");
}
function _timeToSec(val, unit) {
    const u = TIME_UNITS.find((x) => x.v === unit) || TIME_UNITS[0];
    return Math.max(0, Math.round((Number(val) || 0) * u.m));
}
function _secToDisp(sec, preferredUnit) {
    sec = Number(sec) || 0;
    const unit = preferredUnit || _findBestUnit(sec);
    const u = TIME_UNITS.find((x) => x.v === unit) || TIME_UNITS[0];
    const val = sec / u.m;
    // 整数就显示整数，否则保留最多4位小数
    const displayVal = Number.isInteger(val) ? val : Number(val.toFixed(4));
    return { val: displayVal, unit };
}

// ---------- 多 Branch 辅助 ----------
// ---- 作用域（scope）模型 ----
// _ruleEditor.activeScope = { kind: 'if1' }
//                 或 { kind: 'sub', subIdx: 0..2, tabIdx: 0..N }
// 每个 scope 对象结构：{ type: 'if'|'elseif'|'else', conditions, conditionAdvanced, conditionExpr, actions }
// 其中 type='else' 的条件字段不使用。
function _newScope(type) {
    return {
        type: type || "if",
        conditions: [],
        conditionAdvanced: false,
        conditionExpr: "",
        actions: [],
    };
}
function _newSubRule(idx1based) {
    return {
        title: `IF2 #${idx1based}`,
        tabs: [_newScope("if")],  // 第一个 Tab 固定为 IF
        activeTabIdx: 0,
    };
}
// ---------- 作用域解析（新版：堆叠内联，所有 scope 同时可编辑）----------
// kind='if1' 或 kind='sub'
// 容器元素会带 data-scope 标记：
//   IF1:         data-scope="if1"
//   IF2 分支:    data-scope="sub" data-subidx="0" data-tabidx="0"
function _getScope(kind, subIdx, tabIdx) {
    const ed = _ruleEditor;
    if (!ed) return null;
    if (!kind || kind === "if1") return ed.if1;
    const sub = (ed.subRules || [])[subIdx];
    if (!sub || !sub.tabs) return null;
    return sub.tabs[tabIdx] || null;
}
function _scopeAttrs(kind, subIdx, tabIdx) {
    if (kind === "if1") return `data-scope="if1"`;
    return `data-scope="sub" data-subidx="${subIdx}" data-tabidx="${tabIdx}"`;
}
function _parseScopeAttrs(el) {
    if (!el) return null;
    const k = el.getAttribute && el.getAttribute("data-scope");
    if (!k) return null;
    if (k === "if1") return { kind: "if1" };
    const si = +el.getAttribute("data-subidx");
    const ti = +el.getAttribute("data-tabidx");
    return { kind: "sub", subIdx: si, tabIdx: ti };
}
// 向上遍历找到最近的 scope 容器，并解析为 scope 对象 + 标记
function _resolveScope(el) {
    if (!el) return { scope: null, key: null };
    let node = el;
    let key = null;
    while (node && node.nodeType === 1) {
        key = _parseScopeAttrs(node);
        if (key) break;
        node = node.parentElement;
    }
    if (!key) return { scope: null, key: null };
    const scope = _getScope(key.kind, key.subIdx, key.tabIdx);
    return { scope, key, host: node };
}
// 保留旧函数作为兼容（不应再被新增代码调用）
function _curScope() {
    const ed = _ruleEditor; if (!ed) return null;
    const s = ed.activeScope;
    if (!s || s.kind === "if1") return ed.if1;
    const sub = (ed.subRules || [])[s.subIdx];
    if (!sub) return ed.if1;
    return sub.tabs[s.tabIdx] || (sub.tabs[0] || ed.if1);
}
function _curBranch() { return _curScope(); }

// 兼容：构造一个"分支"对象
function _newBranch(nameHint) {
    return _newScope("if");
}

function _parseCondition(expr) {
    if (!expr || !expr.trim()) return [];
    // 按顶层 and 拆分（不处理括号内嵌套，复杂表达式保留为高级模式）
    const parts = expr.split(/\s+and\s+/i);
    return parts.map((p) => {
        p = p.trim().replace(/^\(|\)$/g, "").trim();
        const m = p.match(/^\$\{([^}]+)\}\s+(\w+)\s+(.+)$/);
        if (!m) return { raw: p };
        const [, variable, op, valStr] = m;
        let value = valStr.trim();
        if (/^\[.*\]$/.test(value)) {
            value = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^'|'$/g, "")).join(",");
        } else {
            value = value.replace(/^'|'$/g, "");
        }
        return { variable, op, value };
    });
}

function _parseBranchActions(rawActions) {
    return (rawActions || []).map((a) => {
        const meta = ACTION_META[a.Name];
        const params = meta ? (a[meta.paramsKey] || {}) : {};
        const ed = { Name: a.Name, params: JSON.parse(JSON.stringify(params)) };
        if (a.Name === "Cache") {
            if (params.FollowOrigin) ed.params.__cacheMode = "FollowOrigin";
            else if (params.NoCache) ed.params.__cacheMode = "NoCache";
            else if (params.CustomTime) {
                ed.params.__cacheMode = "CustomTime";
                ed.params.CustomTimeCacheTime = params.CustomTime.CacheTime;
            }
        }
        if (a.Name === "ModifyRequestHeader" || a.Name === "ModifyResponseHeader") {
            ed.params.__headerActions = (params.HeaderActions || []).map((h) => ({ Action: h.Action, Name: h.Name, Value: h.Value || "" }));
        }
        if (a.Name === "StatusCodeCache") {
            ed.params.__statusCodeCache = (params.StatusCodeCacheParams || []).map((s) => ({ StatusCode: s.StatusCode, CacheTime: s.CacheTime }));
        }
        return ed;
    });
}

// ---------- Scope 版渲染 ----------
function _renderCondEditorFor(key) {
    const scope = _getScope(key.kind, key.subIdx, key.tabIdx);
    if (!scope) return "";
    if (scope.type === "else") {
        return `<div class="cond-editor">
            <p class="hint" style="padding:12px 14px;background:#fff7e6;border:1px dashed #ffd591;border-radius:6px;margin:0">
                <b>ELSE 分支</b>：当前面 IF / ELSE IF 条件均未命中时，执行本分支的动作。无需配置匹配条件。
            </p>
        </div>`;
    }
    const prefix = _scopePrefix(key);
    const conds = scope.conditions || [];
    const rows = conds.map((c, i) => {
        const isRaw = c.raw !== undefined;
        const varOpts = CONDITION_VARS.map((v) => `<option value="${v.v}" ${!isRaw && c.variable === v.v ? "selected" : ""}>${v.label}</option>`).join("");
        const opOpts = CONDITION_OPS.map((o) => `<option value="${o.v}" ${!isRaw && c.op === o.v ? "selected" : ""}>${o.label}</option>`).join("");
        const valDisplay = isRaw ? "" : esc(c.value || "");
        const rawDisplay = isRaw ? esc(c.raw) : "";
        return `<div class="cond-row" data-i="${i}">
            <select class="form-control cond-var">${varOpts}</select>
            <select class="form-control cond-op">${opOpts}</select>
            <input class="form-control cond-val" value="${valDisplay}" placeholder="值（多值用英文逗号分隔）" />
            <input class="form-control cond-raw" value="${rawDisplay}" placeholder="原始表达式" style="display:none" />
            <button class="btn sm danger cond-del" type="button">删除</button>
        </div>`;
    }).join("");

    const empty = conds.length === 0
        ? `<p class="hint" style="margin:0 0 8px">无匹配条件 = 匹配所有请求。点击下方按钮添加条件。</p>` : "";

    const advChecked = scope.conditionAdvanced ? "checked" : "";
    const advId = prefix + "condAdvMode";
    const textId = prefix + "condAdvText";
    return `<div class="cond-editor">
        <div class="cond-toolbar">
            <label class="cond-adv"><input type="checkbox" class="cond-adv-mode" data-adv-id="${advId}" data-text-id="${textId}" ${advChecked} /> 高级模式（直接编辑表达式）</label>
        </div>
        <div class="cond-visual" style="${scope.conditionAdvanced ? "display:none" : ""}">
            ${empty}
            <div class="cond-rows">${rows}</div>
            <button class="btn sm ghost cond-add" type="button">+ 添加条件</button>
            <p class="hint">同一分支下多个条件之间为「且」关系。多值条件（in/notIn）的值用英文逗号分隔。</p>
        </div>
        <div class="cond-advanced" style="${scope.conditionAdvanced ? "" : "display:none"}">
            <textarea class="form-control cond-adv-text" rows="3" style="font-family:monospace;font-size:12px" placeholder="例：${'${http.request.host}'} in ['a.com'] and ${'${http.request.uri.path}'} startsWith '/api/'">${esc(scope.conditionExpr || "")}</textarea>
            <p class="hint">高级模式直接编写完整条件表达式，支持 and/or/not 与括号。</p>
        </div>
    </div>`;
}

function _renderActEditorFor(key) {
    const scope = _getScope(key.kind, key.subIdx, key.tabIdx);
    if (!scope) return "";
    const actions = scope.actions || [];
    const cards = actions.map((a, i) => {
        const meta = ACTION_META[a.Name];
        const selectHtml = `<select class="form-control act-name" data-i="${i}">${_actionSelectOptions(a.Name)}</select>`;
        const paramsHtml = meta ? _renderActionParams(a, i, meta) : `<p class="hint">未知动作类型</p>`;
        return `<div class="act-card" data-i="${i}">
            <div class="act-card-head">
                <span class="act-idx">#${i + 1}</span>
                ${selectHtml}
                <button class="btn sm danger act-del" type="button">删除动作</button>
            </div>
            <div class="act-card-body">${paramsHtml}</div>
        </div>`;
    }).join("");

    const empty = actions.length === 0 ? `<p class="hint" style="margin:0 0 8px">暂无执行动作。点击下方按钮添加。</p>` : "";

    return `<div class="act-editor">
        ${empty}
        <div class="act-cards">${cards}</div>
        <button class="btn sm ghost act-add" type="button">+ 添加动作</button>
    </div>`;
}

function _scopePrefix(key) {
    if (key.kind === "if1") return "s_if1__";
    return `s_sub_${key.subIdx}_${key.tabIdx}__`;
}

// ---------- Scope 版条件收集 ----------
function _collectConditionFor(key, hostEl) {
    const scope = _getScope(key.kind, key.subIdx, key.tabIdx);
    if (!scope) return "";
    if (scope.type === "else") return "*";
    if (scope.conditionAdvanced) {
        const ta = hostEl.querySelector(".cond-adv-text");
        return ta ? ta.value.trim() : "";
    }
    return _collectConditionVisualFor(scope, hostEl);
}

function _collectConditionVisualFor(scope, hostEl) {
    const conds = (scope.conditions || []).filter((c) => c.raw !== undefined || (c.variable && c.op && c.value !== undefined && c.value !== ""));
    if (!conds.length) return "";
    const parts = conds.map((c) => {
        if (c.raw !== undefined) return c.raw;
        const op = c.op;
        const vals = c.value.split(",").map((s) => s.trim()).filter(Boolean);
        let valStr;
        if (op === "in" || op === "notIn") {
            valStr = "[" + vals.map((v) => `'${v}'`).join(", ") + "]";
        } else if (["gt", "gte", "lt", "lte"].includes(op)) {
            valStr = vals[0] || "0";
        } else {
            valStr = `'${vals[0] || ""}'`;
        }
        return `\${${c.variable}} ${op} ${valStr}`;
    });
    return parts.join(" and ");
}

// ---------- Scope 版绑定 ----------
function _bindCondEditorWithin(hostEl, scopeKey) {
    const scope = _getScope(scopeKey.kind, scopeKey.subIdx, scopeKey.tabIdx);
    if (!scope) return;
    const visual = hostEl.querySelector(".cond-visual");
    const advanced = hostEl.querySelector(".cond-advanced");
    const advMode = hostEl.querySelector(".cond-adv-mode");
    if (advMode && visual && advanced) {
        advMode.addEventListener("change", (e) => {
            scope.conditionAdvanced = e.target.checked;
            if (scope.conditionAdvanced) {
                scope.conditionExpr = _collectConditionVisualFor(scope, hostEl);
                const ta = hostEl.querySelector(".cond-adv-text");
                if (ta) ta.value = scope.conditionExpr;
            }
            visual.style.display = scope.conditionAdvanced ? "none" : "";
            advanced.style.display = scope.conditionAdvanced ? "" : "none";
            _updateJsonPreview();
        });
    }
    const advText = hostEl.querySelector(".cond-adv-text");
    if (advText) advText.addEventListener("input", (e) => { scope.conditionExpr = e.target.value; _updateJsonPreview(); });

    hostEl.querySelector(".cond-add")?.addEventListener("click", () => {
        scope.conditions.push({ variable: "http.request.host", op: "in", value: "" });
        _refreshRuleForm();
    });
    hostEl.querySelectorAll(".cond-del").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            const i = +e.target.closest(".cond-row").dataset.i;
            scope.conditions.splice(i, 1);
            _refreshRuleForm();
        });
    });
    hostEl.querySelectorAll(".cond-row").forEach((row) => {
        const i = +row.dataset.i;
        row.querySelector(".cond-var").addEventListener("change", (e) => { scope.conditions[i].variable = e.target.value; delete scope.conditions[i].raw; _updateJsonPreview(); });
        row.querySelector(".cond-op").addEventListener("change", (e) => { scope.conditions[i].op = e.target.value; delete scope.conditions[i].raw; _updateJsonPreview(); });
        row.querySelector(".cond-val").addEventListener("input", (e) => { scope.conditions[i].value = e.target.value; delete scope.conditions[i].raw; _updateJsonPreview(); });
        row.querySelector(".cond-raw").addEventListener("input", (e) => { scope.conditions[i].raw = e.target.value; _updateJsonPreview(); });
    });
}

function _bindActEditorWithin(hostEl, scopeKey) {
    const scope = _getScope(scopeKey.kind, scopeKey.subIdx, scopeKey.tabIdx);
    if (!scope) return;
    hostEl.querySelector(".act-add")?.addEventListener("click", () => {
        scope.actions.push({ Name: "WebSocket", params: { Switch: "off" } });
        _refreshRuleForm();
    });
    hostEl.querySelectorAll(".act-del").forEach((b) => b.addEventListener("click", (e) => {
        const i = +e.target.closest(".act-card").dataset.i;
        scope.actions.splice(i, 1);
        _refreshRuleForm();
    }));
    hostEl.querySelectorAll(".act-name").forEach((sel) => sel.addEventListener("change", (e) => {
        const i = +e.target.dataset.i;
        const meta = ACTION_META[e.target.value];
        scope.actions[i] = { Name: e.target.value, params: meta && meta.fields && meta.fields[0]?.type === "switch" ? { Switch: "off" } : {} };
        _refreshRuleForm();
    }));
    _bindActionParamsWithin(hostEl, scope);
}

function _bindActionParamsWithin(hostEl, scope) {
    hostEl.querySelectorAll(".act-switch").forEach((sw) => {
        sw.addEventListener("click", (e) => {
            const el = e.currentTarget;
            const i = +el.dataset.i, key = el.dataset.key;
            const on = el.classList.toggle("on");
            scope.actions[i].params[key] = on ? "on" : "off";
            el.nextElementSibling.textContent = on ? "开" : "关";
            _refreshRuleForm();
        });
    });
    hostEl.querySelectorAll(".act-select").forEach((sel) => sel.addEventListener("change", (e) => {
        const i = +e.target.dataset.i, key = e.target.dataset.key;
        const raw = e.target.value;
        scope.actions[i].params[key] = isNaN(Number(raw)) ? raw : Number(raw);
        _refreshRuleForm();
    }));
    hostEl.querySelectorAll(".act-multi").forEach((cb) => cb.addEventListener("change", () => {
        const i = +cb.dataset.i, key = cb.dataset.key;
        const vals = [...hostEl.querySelectorAll(`.act-multi[data-i="${i}"][data-key="${key}"]`)].filter((c) => c.checked).map((c) => c.value);
        scope.actions[i].params[key] = vals;
        _refreshRuleForm();
    }));
    hostEl.querySelectorAll(".act-number, .act-text").forEach((inp) => inp.addEventListener("input", (e) => {
        const i = +e.target.dataset.i, key = e.target.dataset.key;
        const isTime = e.target.classList.contains("act-time-val");
        const v = e.target.value;
        if (isTime) {
            const unitSel = e.target.parentElement.querySelector(".act-time-unit");
            const unit = unitSel ? unitSel.value : "s";
            scope.actions[i].params[key] = _timeToSec(v, unit);
            scope.actions[i].params[`__unit_${key}`] = unit;
        } else {
            scope.actions[i].params[key] = e.target.type === "number" && v !== "" ? Number(v) : v;
        }
        _updateJsonPreview();
    }));
    hostEl.querySelectorAll(".act-time-unit").forEach((sel) => sel.addEventListener("change", (e) => {
        const i = +e.target.dataset.i, key = e.target.dataset.key;
        const valInput = e.target.parentElement.querySelector(".act-time-val");
        const val = valInput ? valInput.value : 0;
        const unit = e.target.value;
        scope.actions[i].params[key] = _timeToSec(val, unit);
        scope.actions[i].params[`__unit_${key}`] = unit;
        _updateJsonPreview();
    }));
    hostEl.querySelectorAll(".act-cachemode").forEach((sel) => sel.addEventListener("change", (e) => {
        const i = +e.target.dataset.i;
        scope.actions[i].params.__cacheMode = e.target.value;
        _refreshRuleForm();
    }));
    hostEl.querySelectorAll(".act-cachetime").forEach((inp) => inp.addEventListener("input", (e) => {
        const i = +e.target.dataset.i;
        const unitSel = e.target.parentElement.querySelector(".act-cachetime-unit");
        const unit = unitSel ? unitSel.value : "s";
        scope.actions[i].params.CustomTimeCacheTime = _timeToSec(e.target.value, unit);
        scope.actions[i].params.__unit_CustomTimeCacheTime = unit;
        _updateJsonPreview();
    }));
    hostEl.querySelectorAll(".act-cachetime-unit").forEach((sel) => sel.addEventListener("change", (e) => {
        const i = +e.target.dataset.i;
        const valInput = e.target.parentElement.querySelector(".act-cachetime");
        const val = valInput ? valInput.value : 0;
        const unit = e.target.value;
        scope.actions[i].params.CustomTimeCacheTime = _timeToSec(val, unit);
        scope.actions[i].params.__unit_CustomTimeCacheTime = unit;
        _updateJsonPreview();
    }));
    _bindHeaderActionsWithin(hostEl, scope);
    _bindStatusCodeCacheWithin(hostEl, scope);
    hostEl.querySelectorAll(".act-json").forEach((ta) => ta.addEventListener("input", (e) => {
        const i = +e.target.dataset.i;
        try { scope.actions[i].params = JSON.parse(e.target.value) || {}; _updateJsonPreview(); } catch (_) { }
    }));
}

function _bindHeaderActionsWithin(hostEl, scope) {
    hostEl.querySelectorAll(".hdr-rows").forEach((wrap) => {
        const idx = +wrap.dataset.i;
        wrap.querySelectorAll(".hdr-row").forEach((row) => {
            const i = +row.dataset.i;
            row.querySelector(".hdr-act").addEventListener("change", (e) => {
                _ensureList(scope.actions[idx].params, "__headerActions", i).Action = e.target.value;
                _refreshRuleForm();
            });
            row.querySelector(".hdr-name").addEventListener("input", (e) => { _ensureList(scope.actions[idx].params, "__headerActions", i).Name = e.target.value; _updateJsonPreview(); });
            row.querySelector(".hdr-val").addEventListener("input", (e) => { _ensureList(scope.actions[idx].params, "__headerActions", i).Value = e.target.value; _updateJsonPreview(); });
            row.querySelector(".hdr-del").addEventListener("click", () => {
                scope.actions[idx].params.__headerActions.splice(i, 1);
                _refreshRuleForm();
            });
        });
        wrap.parentElement.querySelector(".hdr-add")?.addEventListener("click", () => {
            if (!scope.actions[idx].params.__headerActions) scope.actions[idx].params.__headerActions = [];
            scope.actions[idx].params.__headerActions.push({ Action: "add", Name: "", Value: "" });
            _refreshRuleForm();
        });
    });
}

function _bindStatusCodeCacheWithin(hostEl, scope) {
    hostEl.querySelectorAll(".sc-rows").forEach((wrap) => {
        const idx = +wrap.dataset.i;
        wrap.querySelectorAll(".sc-row").forEach((row) => {
            const i = +row.dataset.i;
            row.querySelector(".sc-code").addEventListener("change", (e) => {
                _ensureList(scope.actions[idx].params, "__statusCodeCache", i).StatusCode = Number(e.target.value);
                _updateJsonPreview();
            });
            row.querySelector(".sc-time").addEventListener("input", (e) => {
                const unitSel = row.querySelector(".sc-time-unit");
                const unit = unitSel ? unitSel.value : "s";
                const sec = _timeToSec(e.target.value, unit);
                _ensureList(scope.actions[idx].params, "__statusCodeCache", i).CacheTime = sec;
                _ensureList(scope.actions[idx].params, "__statusCodeCache", i).__unit = unit;
                _updateJsonPreview();
            });
            row.querySelector(".sc-time-unit").addEventListener("change", (e) => {
                const valInput = row.querySelector(".sc-time");
                const unit = e.target.value;
                const sec = _timeToSec(valInput ? valInput.value : 0, unit);
                _ensureList(scope.actions[idx].params, "__statusCodeCache", i).CacheTime = sec;
                _ensureList(scope.actions[idx].params, "__statusCodeCache", i).__unit = unit;
                _updateJsonPreview();
            });
            row.querySelector(".sc-del").addEventListener("click", () => {
                scope.actions[idx].params.__statusCodeCache.splice(i, 1);
                _refreshRuleForm();
            });
        });
        wrap.parentElement.querySelector(".sc-add")?.addEventListener("click", () => {
            if (!scope.actions[idx].params.__statusCodeCache) scope.actions[idx].params.__statusCodeCache = [];
            scope.actions[idx].params.__statusCodeCache.push({ StatusCode: 404, CacheTime: 60, __unit: "s" });
            _refreshRuleForm();
        });
    });
}

// 保留旧函数（兼容，不应再被新增代码调用）
function _renderBranchTabs() { return ""; }
function _bindBranchTabs() { }

// 保留旧版单函数空壳（防止外部调用，不应再被新增代码调用）
function _renderConditionEditor() { return _renderCondEditorFor({ kind: "if1" }); }
function _renderActionEditor() { return _renderActEditorFor({ kind: "if1" }); }
function _bindConditionEditor() { }
function _bindActionEditor() { }
function _collectConditionVisual() { return _collectConditionVisualFor(_curBranch(), document); }
function _collectCondition() { return _collectConditionFor(_ruleEditor.activeScope || { kind: "if1" }, document); }

// 渲染完整编辑表单（堆叠卡片形式）
function _renderRuleForm(isEdit) {
    const ed = _ruleEditor;
    const body = `
    <div class="rule-form" id="ruleFormRoot">
        <div class="form-row">
            <div class="form-group"><label>规则名称 *</label><input type="text" id="f-rule-name" class="form-control" value="${esc(ed.ruleName)}" placeholder="如 cache-rule、ws-rule" /></div>
            <div class="form-group"><label>描述（可选）</label><input type="text" id="f-rule-desc" class="form-control" value="${esc(ed.description)}" placeholder="规则描述" /></div>
        </div>
        ${isEdit ? `<div class="hint" style="margin-bottom:12px">RuleId 由后端锁定为当前规则，不可修改。修改 Status 请返回列表用启停开关。</div>` : ""}

        <div id="ruleFormBody">
            ${_renderRuleFormBody()}
        </div>

        <details class="rule-json-preview">
            <summary>预览生成的规则 JSON（提交前可检查）</summary>
            <pre id="ruleJsonPreview" class="json-preview"></pre>
        </details>
    </div>`;
    openModal(isEdit ? "修改规则" : "添加规则", body, [], {
        size: "rules",
        headerActions: [
            { label: isEdit ? "保存修改" : "创建规则", class: "primary", onClick: isEdit ? submitEditRule(_ruleEditor._ruleId) : submitAddRule },
            { label: "关闭", class: "ghost", onClick: openRulesModal },
        ],
    });
    _bindRuleForm();
    _updateJsonPreview();
}

function _renderRuleFormBody() {
    const ed = _ruleEditor;
    const subs = ed.subRules || [];

    // IF1 卡片
    const if1Key = { kind: "if1" };
    const if1Card = `
    <div class="scope-card if1" ${_scopeAttrs("if1")}>
        <div class="scope-header type-if">
            <div class="scope-header-label"><span class="scope-badge if">IF1</span> 顶层主条件</div>
        </div>
        <div class="cond-block">
            <div class="section-subtitle">匹配条件</div>
            ${_renderCondEditorFor(if1Key)}
        </div>
        <div class="act-block">
            <div class="section-subtitle">执行动作</div>
            ${_renderActEditorFor(if1Key)}
        </div>
    </div>`;

    // IF2 组
    const subGroupsHtml = subs.map((sub, subIdx) => {
        const hasElse = sub.tabs.some((t) => t.type === "else");
        const tabsHtml = sub.tabs.map((tab, tabIdx) => {
            const innerKey = { kind: "sub", subIdx, tabIdx };
            let labelType, labelText, typeClass;
            if (tab.type === "if") { labelType = "if"; labelText = "IF"; typeClass = "type-if"; }
            else if (tab.type === "elseif") {
                let num = 0;
                for (let k = 0; k <= tabIdx; k++) if (sub.tabs[k].type === "elseif") num++;
                labelType = "elseif"; labelText = `ELSE IF #${num}`; typeClass = "type-elseif";
            }
            else { labelType = "else"; labelText = "ELSE"; typeClass = "type-else"; }
            const canDelete = tabIdx !== 0;
            const delBtn = canDelete
                ? `<button type="button" class="btn sm danger scope-del-tab" data-subidx="${subIdx}" data-tabidx="${tabIdx}" title="删除此 ${labelText} 分支">删除分支</button>`
                : "";
            return `
            <div class="scope-card inner" ${_scopeAttrs("sub", subIdx, tabIdx)}>
                <div class="scope-header ${typeClass}">
                    <div class="scope-header-label"><span class="scope-badge ${labelType}">${labelText}</span></div>
                    ${delBtn}
                </div>
                <div class="cond-block">
                    <div class="section-subtitle">匹配条件</div>
                    ${_renderCondEditorFor(innerKey)}
                </div>
                <div class="act-block">
                    <div class="section-subtitle">执行动作</div>
                    ${_renderActEditorFor(innerKey)}
                </div>
            </div>`;
        }).join("");

        const addElseIfBtn = !hasElse
            ? `<button type="button" class="btn sm ghost scope-btn add-elseif" data-subidx="${subIdx}">+ ELSE IF</button>`
            : "";
        const addElseBtn = !hasElse
            ? `<button type="button" class="btn sm ghost scope-btn add-else" data-subidx="${subIdx}">+ ELSE</button>`
            : `<span class="hint" style="display:inline-block;margin:4px 6px 10px 0;font-size:12px;color:#795548">已存在 ELSE 分支，之后不可再追加</span>`;

        return `
        <div class="subrule-group" data-subgroup="${subIdx}">
            <div class="subrule-header">
                <span>IF2 #${subIdx + 1}（子条件组，共 ${sub.tabs.length} 个分支）</span>
                <button type="button" class="btn sm danger del-subgroup" data-subidx="${subIdx}" title="删除此 IF2 组（含其下所有分支）">删除 IF2 组</button>
            </div>
            <div class="subrule-connector">
                ${tabsHtml}
            </div>
            ${addElseIfBtn}${addElseBtn}
        </div>`;
    }).join("");

    // 添加 IF2 组按钮
    const addSubBtn = subs.length < 3
        ? `<button type="button" class="btn sm ghost scope-btn add-subgroup">+ 加 IF2 组（共 ${subs.length}/3）</button>`
        : `<span class="hint" style="display:inline-block;margin:4px 0 10px;font-size:12px;color:#999">IF2 组最多 3 个</span>`;

    return if1Card + subGroupsHtml + addSubBtn;
}

function _bindRuleForm() {
    $("#f-rule-name").addEventListener("input", (e) => { _ruleEditor.ruleName = e.target.value; _updateJsonPreview(); });
    $("#f-rule-desc").addEventListener("input", (e) => { _ruleEditor.description = e.target.value; _updateJsonPreview(); });

    _bindAllScopesWithin($("#ruleFormBody"));
    _bindAllButtons();
}

function _bindAllScopesWithin(host) {
    if (!host) return;
    // 绑定 IF1
    const if1Host = host.querySelector('[data-scope="if1"]');
    if (if1Host) {
        const if1Key = { kind: "if1" };
        _bindCondEditorWithin(if1Host, if1Key);
        _bindActEditorWithin(if1Host, if1Key);
    }
    // 绑定每个 IF2 分支
    host.querySelectorAll('[data-scope="sub"]').forEach((hostEl) => {
        const key = _parseScopeAttrs(hostEl);
        if (key) {
            _bindCondEditorWithin(hostEl, key);
            _bindActEditorWithin(hostEl, key);
        }
    });
    // 绑定输入变更刷新 JSON 预览
    host.querySelectorAll("input, select, textarea").forEach((el) => {
        el.addEventListener("input", _updateJsonPreview);
        el.addEventListener("change", _updateJsonPreview);
    });
}

function _bindAllButtons() {
    // 添加 IF2 组
    const addSub = document.querySelector(".add-subgroup");
    if (addSub) addSub.addEventListener("click", () => {
        const subs = _ruleEditor.subRules;
        if (subs.length >= 3) return;
        const nextIdx = subs.length + 1;
        subs.push(_newSubRule(nextIdx));
        _refreshRuleForm();
    });
    // 删除 IF2 组
    document.querySelectorAll(".del-subgroup").forEach((btn) => btn.addEventListener("click", () => {
        const i = +btn.dataset.subidx;
        const subs = _ruleEditor.subRules || [];
        if (i < 0 || i >= subs.length) return;
        subs.splice(i, 1);
        subs.forEach((sr, idx) => { sr.title = `IF2 #${idx + 1}`; });
        _refreshRuleForm();
    }));
    // 添加 ELSE IF
    document.querySelectorAll(".add-elseif").forEach((btn) => btn.addEventListener("click", () => {
        const i = +btn.dataset.subidx;
        const sub = (_ruleEditor.subRules || [])[i];
        if (!sub) return;
        const elseIdx = sub.tabs.findIndex((t) => t.type === "else");
        const ns = _newScope("elseif");
        if (elseIdx >= 0) sub.tabs.splice(elseIdx, 0, ns);
        else sub.tabs.push(ns);
        _refreshRuleForm();
    }));
    // 添加 ELSE
    document.querySelectorAll(".add-else").forEach((btn) => btn.addEventListener("click", () => {
        const i = +btn.dataset.subidx;
        const sub = (_ruleEditor.subRules || [])[i];
        if (!sub) return;
        if (sub.tabs.some((t) => t.type === "else")) return;
        sub.tabs.push(_newScope("else"));
        _refreshRuleForm();
    }));
    // 删除单个分支（ELSE IF / ELSE）
    document.querySelectorAll(".scope-del-tab").forEach((btn) => btn.addEventListener("click", () => {
        const si = +btn.dataset.subidx;
        const ti = +btn.dataset.tabidx;
        const sub = (_ruleEditor.subRules || [])[si];
        if (!sub || ti === 0) return;
        sub.tabs.splice(ti, 1);
        _refreshRuleForm();
    }));
}

function _refreshRuleForm() {
    // 保留规则名和描述输入的 value
    const nameEl = $("#f-rule-name");
    const descEl = $("#f-rule-desc");
    const nameVal = nameEl ? nameEl.value : _ruleEditor.ruleName;
    const descVal = descEl ? descEl.value : _ruleEditor.description;
    _ruleEditor.ruleName = nameVal;
    _ruleEditor.description = descVal;

    const body = $("#ruleFormBody");
    if (body) {
        body.innerHTML = _renderRuleFormBody();
        _bindAllScopesWithin(body);
        _bindAllButtons();
    }
    if (nameEl) nameEl.value = nameVal;
    if (descEl) descEl.value = descVal;
    _updateJsonPreview();
}

function _updateJsonPreview() {
    const pre = $("#ruleJsonPreview");
    if (pre) pre.textContent = JSON.stringify(_collectRuleJson(), null, 2);
}

// 收集完整规则 JSON（按 DOM 分区收集，无需切换 activeScope）
function _collectRuleJson() {
    const ed = _ruleEditor;
    const desc = (ed.description || "").trim();

    // 收集 IF1
    const if1HostEl = document.querySelector('[data-scope="if1"]');
    const if1Branch = {
        Condition: if1HostEl ? _collectConditionFor({ kind: "if1" }, if1HostEl) : "",
        Actions: (ed.if1.actions || []).map((a) => _collectAction(a)),
    };

    // 收集 SubRules（IF2 组）
    const SubRules = (ed.subRules || []).map((sub, subIdx) => {
        const Branches = sub.tabs.map((tab, tabIdx) => {
            const key = { kind: "sub", subIdx, tabIdx };
            const tabHostEl = document.querySelector(`[data-scope="sub"][data-subidx="${subIdx}"][data-tabidx="${tabIdx}"]`);
            let cond;
            if (tab.type === "else") cond = "*";
            else cond = tabHostEl ? _collectConditionFor(key, tabHostEl) : "";
            return {
                Condition: cond,
                Actions: (tab.actions || []).map((a) => _collectAction(a)),
            };
        });
        return {
            Branches,
            Description: [],
        };
    });
    if1Branch.SubRules = SubRules;

    const rule = {
        RuleName: ed.ruleName.trim() || "未命名规则",
        Branches: [if1Branch],
        Description: desc ? desc.split("\n") : [],
    };
    if (ed._ruleId) rule.RuleId = ed._ruleId;
    if (ed._status) rule.Status = ed._status;
    return { FormatVersion: "1.0", Rules: [rule] };
}

// ---------- 动作参数渲染（保留原实现）----------
function _renderActionParams(action, idx, meta) {
    if (!meta.fields) {
        const json = JSON.stringify(action.params || {}, null, 2);
        return `<div class="hint" style="margin-bottom:6px">该动作参数较复杂，请直接编辑 JSON（${meta.paramsKey} 字段内容）：</div>
            <textarea class="form-control act-json" data-i="${idx}" rows="8" style="font-family:monospace;font-size:12px">${esc(json)}</textarea>`;
    }
    const params = action.params || {};
    return meta.fields.map((f) => {
        if (f.type === "headerActions") return _renderHeaderActions(idx, f, params);
        if (f.type === "statusCodeCache") return _renderStatusCodeCache(idx, f, params);
        if (f.type === "cacheMode") return _renderCacheMode(idx, f, params);
        const show = _checkWhen(f.when, params);
        const styleHide = show ? "" : ` style="display:none"`;
        const val = params[f.key] !== undefined ? params[f.key] : "";
        return `<div class="form-group act-field" data-key="${f.key}"${styleHide}>${_renderField(f, val, idx, params)}</div>`;
    }).join("");
}

function _checkWhen(when, params) {
    if (!when) return true;
    return Object.entries(when).every(([k, v]) => {
        if (typeof v === "string" && v.startsWith("!")) return params[k] !== v.slice(1);
        return params[k] === v;
    });
}

function _renderField(f, val, idx, params) {
    const label = `<label>${f.label}</label>`;
    const name = `data-i="${idx}" data-key="${f.key}"`;
    if (f.type === "switch") {
        const on = val === "on";
        return `${label}<div class="switch-row"><div class="switch ${on ? "on" : ""} act-switch" ${name}></div><span class="switch-label">${on ? "开" : "关"}</span></div>`;
    }
    if (f.type === "select") {
        const opts = (f.options || []).map((o) => `<option value="${o.v}" ${val === o.v || String(val) === String(o.v) ? "selected" : ""}>${o.t}</option>`).join("");
        return `${label}<select class="form-control act-select" ${name}>${opts}</select>`;
    }
    if (f.type === "multiselect") {
        const vals = Array.isArray(val) ? val : (val ? [val] : []);
        const boxes = (f.options || []).map((o) => {
            const checked = vals.includes(o.v) ? "checked" : "";
            return `<label class="cb"><input type="checkbox" value="${o.v}" class="act-multi" data-i="${idx}" data-key="${f.key}" ${checked}/> ${o.t}</label>`;
        }).join("");
        return `${label}<div class="cb-group">${boxes}</div>`;
    }
    if (f.type === "number") {
        if (f.unit === "time") {
            const unitKey = `__unit_${f.key}`;
            const preferredUnit = params[unitKey] || _findBestUnit(val);
            const disp = _secToDisp(val, preferredUnit);
            const max = f.max != null ? Math.max(1, Math.floor(f.max / (TIME_UNITS.find((u) => u.v === disp.unit) || { m: 1 }).m)) : undefined;
            const min = f.min != null ? Math.ceil(f.min / (TIME_UNITS.find((u) => u.v === disp.unit) || { m: 1 }).m) : 0;
            return `${label}<div class="time-input">
                <input type="number" class="form-control act-number act-time-val" ${name} value="${disp.val}" ${min != null ? `min="${min}"` : ""} ${max != null ? `max="${max}"` : ""} />
                <select class="form-control act-time-unit" ${name}>${_timeUnitOptions(disp.unit)}</select>
            </div>`;
        }
        return `${label}<input type="number" class="form-control act-number" ${name} value="${esc(val)}" ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""} />`;
    }
    return `${label}<input type="text" class="form-control act-text" ${name} value="${esc(val)}" />`;
}

function _renderCacheMode(idx, f, params) {
    const mode = params.__cacheMode || "";
    const timeSec = params.CustomTimeCacheTime || 0;
    const opts = [{ v: "", t: "不设置" }, { v: "FollowOrigin", t: "遵循源站" }, { v: "NoCache", t: "不缓存" }, { v: "CustomTime", t: "自定义时间" }]
        .map((o) => `<option value="${o.v}" ${mode === o.v ? "selected" : ""}>${o.t}</option>`).join("");
    let timeField = "";
    if (mode === "CustomTime") {
        const preferredUnit = params.__unit_CustomTimeCacheTime || _findBestUnit(timeSec);
        const disp = _secToDisp(timeSec, preferredUnit);
        timeField = `<div class="form-group"><label>缓存时间（最长 365 天）</label>
            <div class="time-input">
                <input type="number" class="form-control act-cachetime" data-i="${idx}" min="0" value="${disp.val}" />
                <select class="form-control act-cachetime-unit" data-i="${idx}">${_timeUnitOptions(disp.unit)}</select>
            </div>
        </div>`;
    }
    return `<div class="form-group"><label>${f.label}</label><select class="form-control act-cachemode" data-i="${idx}">${opts}</select></div>${timeField}`;
}

function _renderHeaderActions(idx, f, params) {
    const list = params.__headerActions || [];
    const rows = list.map((h, i) => {
        const actOpts = [{ v: "add", t: "添加" }, { v: "set", t: "设置" }, { v: "del", t: "删除" }]
            .map((o) => `<option value="${o.v}" ${h.Action === o.v ? "selected" : ""}>${o.t}</option>`).join("");
        const showVal = h.Action !== "del";
        return `<div class="hdr-row" data-i="${i}">
            <select class="form-control hdr-act">${actOpts}</select>
            <input class="form-control hdr-name" value="${esc(h.Name || "")}" placeholder="头部名" />
            <input class="form-control hdr-val" value="${esc(h.Value || "")}" placeholder="头部值" ${showVal ? "" : 'style="visibility:hidden"'} />
            <button class="btn sm danger hdr-del" type="button">删除</button>
        </div>`;
    }).join("");
    return `<div class="form-group"><label>${f.label}</label><div class="hdr-rows" data-i="${idx}">${rows}</div>
        <button class="btn sm ghost hdr-add" type="button">+ 添加头部规则</button></div>`;
}

function _renderStatusCodeCache(idx, f, params) {
    const list = params.__statusCodeCache || [];
    const codes = [400, 401, 403, 404, 405, 407, 414, 500, 501, 502, 503, 504, 509, 514];
    const rows = list.map((s, i) => {
        const codeOpts = codes.map((c) => `<option value="${c}" ${s.StatusCode === c ? "selected" : ""}>${c}</option>`).join("");
        const preferredUnit = s.__unit || _findBestUnit(s.CacheTime);
        const disp = _secToDisp(s.CacheTime, preferredUnit);
        return `<div class="sc-row" data-i="${i}">
            <select class="form-control sc-code">${codeOpts}</select>
            <div class="time-input sc-time-wrap">
                <input type="number" class="form-control sc-time" value="${esc(disp.val)}" min="0" placeholder="时间" />
                <select class="form-control sc-time-unit">${_timeUnitOptions(disp.unit)}</select>
            </div>
            <button class="btn sm danger sc-del" type="button">删除</button>
        </div>`;
    }).join("");
    return `<div class="form-group"><label>${f.label}</label><div class="sc-rows" data-i="${idx}">${rows}</div>
        <button class="btn sm ghost sc-add" type="button">+ 添加状态码规则</button></div>`;
}

function _ensureList(obj, key, i) {
    if (!obj[key]) obj[key] = [];
    if (!obj[key][i]) obj[key][i] = {};
    return obj[key][i];
}

// 收集单个动作的最终 {Name, XxxParameters}
function _collectAction(action) {
    const meta = ACTION_META[action.Name];
    if (!meta) return { Name: action.Name };
    const params = action.params || {};
    if (!meta.fields) {
        return { Name: action.Name, [meta.paramsKey]: params };
    }
    const result = {};
    if (params.__cacheMode === "FollowOrigin") result.FollowOrigin = { Switch: "on" };
    else if (params.__cacheMode === "NoCache") result.NoCache = { Switch: "on" };
    else if (params.__cacheMode === "CustomTime") {
        result.CustomTime = { Switch: "on", CacheTime: Number(params.CustomTimeCacheTime) || 0 };
    }
    if (params.__headerActions) {
        result.HeaderActions = params.__headerActions.filter((h) => h.Name).map((h) => {
            const o = { Action: h.Action, Name: h.Name };
            if (h.Action !== "del") o.Value = h.Value;
            return o;
        });
    }
    if (params.__statusCodeCache) {
        result.StatusCodeCacheParams = params.__statusCodeCache.map((s) => ({
            StatusCode: Number(s.StatusCode),
            CacheTime: Number(s.CacheTime) || 0,
        }));
    }
    meta.fields.forEach((f) => {
        if (f.type === "switch" || f.type === "select" || f.type === "multiselect" || f.type === "number" || f.type === "text") {
            if (params[f.key] !== undefined && params[f.key] !== "") {
                result[f.key] = params[f.key];
            }
        }
    });
    return { Name: action.Name, [meta.paramsKey]: result };
}

// 从规则 JSON 解析为编辑器状态（修改时预填）
function _parseRuleToEditor(rule) {
    const rawBranches = rule.Branches || [];
    const if1Raw = rawBranches[0];
    const if1Scope = {
        type: "if",
        conditions: if1Raw ? _parseCondition(if1Raw.Condition || "") : [],
        conditionAdvanced: false,
        conditionExpr: if1Raw ? (if1Raw.Condition || "") : "",
        actions: if1Raw ? _parseBranchActions(if1Raw.Actions) : [],
    };
    const rawSubRules = (if1Raw && if1Raw.SubRules) || [];
    const subRules = rawSubRules.map((sr, srIdx) => {
        const tabs = (sr.Branches || []).map((tb, tabIdx) => {
            const condStr = tb.Condition || "";
            const isElse = condStr === "*";
            const type = isElse ? "else" : (tabIdx === 0 ? "if" : "elseif");
            return {
                type,
                conditions: isElse ? [] : _parseCondition(condStr),
                conditionAdvanced: false,
                conditionExpr: condStr,
                actions: _parseBranchActions(tb.Actions),
            };
        });
        if (!tabs.length) tabs.push(_newScope("if"));
        return {
            title: `IF2 #${srIdx + 1}`,
            tabs,
            activeTabIdx: 0,
        };
    });
    return {
        ruleName: rule.RuleName || "",
        description: Array.isArray(rule.Description) ? rule.Description.join("\n") : (rule.Description || ""),
        if1: if1Scope,
        subRules,
        activeScope: { kind: "if1" },
    };
}

async function openEditRuleModal(ruleId) {
    openModal("修改规则 - 加载中", `<p>正在读取规则 ${esc(ruleId)} 的内容...</p>`, [], {
        size: "rules",
        headerActions: [{ label: "关闭", class: "ghost", onClick: openRulesModal }],
    });
    let rule;
    try {
        rule = await http(API.rule(state.zoneId, ruleId));
    } catch (e) {
        closeModal();
        toast(e.message, "error");
        return;
    }
    _ruleEditor = _parseRuleToEditor(rule);
    _ruleEditor._ruleId = ruleId;
    _ruleEditor._status = rule.Status;
    _renderRuleForm(true);
}

function _validateRuleStructure(rule) {
    // IF1
    const if1 = (rule.Branches || [])[0];
    if (!if1) return "缺少 IF1 主分支";
    if (!Array.isArray(if1.Actions) || !if1.Actions.length) return "IF1 至少需要一个执行动作";
    // SubRules (IF2 组)
    const subs = if1.SubRules || [];
    if (subs.length > 3) return "IF2 组最多 3 个";
    for (let si = 0; si < subs.length; si++) {
        const sub = subs[si];
        const tabs = sub.Branches || [];
        if (!tabs.length) return `IF2 #${si + 1} 为空`;
        for (let ti = 0; ti < tabs.length; ti++) {
            const tb = tabs[ti];
            if (!Array.isArray(tb.Actions) || !tb.Actions.length) {
                const label = ti === 0 ? "IF" : tb.Condition === "*" ? "ELSE" : `ELSE IF #${ti}`;
                return `IF2 #${si + 1} 的 ${label} 分支至少需要一个执行动作`;
            }
        }
    }
    return null;
}

function submitEditRule(ruleId) {
    return async () => {
        const ruleJson = _collectRuleJson();
        const rule = ruleJson.Rules[0];
        if (!rule.RuleName) return toast("请填写规则名称", "error");
        const err = _validateRuleStructure(rule);
        if (err) return toast(err, "error");
        try {
            const r = await http(API.modifyRule(state.zoneId, ruleId), { method: "PUT", body: JSON.stringify(rule) });
            toast(r.message || "修改成功", "success");
            closeModal();
            openRulesModal();
        } catch (e) {
            toast(e.message, "error");
        }
    };
}

async function viewRule(ruleId) {
    openModal("规则详情 - 加载中", `<p>正在读取规则 ${esc(ruleId)} 的内容...</p>`, [], {
        size: "rules",
        headerActions: [{ label: "关闭", class: "ghost", onClick: closeRulesModal }],
    });
    let r;
    try {
        r = await http(API.rule(state.zoneId, ruleId));
    } catch (e) {
        closeModal();
        toast(e.message, "error");
        return;
    }
    const jsonStr = JSON.stringify(r, null, 2);
    const st = (r.Status || "").toLowerCase();
    const stBadge = st === "enable" ? `<span class="badge ok">启用</span>` : `<span class="badge off">停用</span>`;
    const actionsHtml = (actions) => (actions || []).map((a, i) => {
        const meta = ACTION_META[a.Name];
        const label = meta ? meta.label : a.Name;
        const pk = meta ? meta.paramsKey : null;
        let paramHtml;
        if (pk && a[pk]) {
            paramHtml = Object.entries(a[pk]).map(([k, v]) => {
                let vs = typeof v === "object" ? JSON.stringify(v) : String(v);
                return `<span class="kv"><b>${esc(k)}</b>: ${esc(vs)}</span>`;
            }).join("");
        } else { paramHtml = `<span class="hint">无参数</span>`; }
        return `<div class="view-act"><div class="view-act-head"><span class="act-idx">#${i + 1}</span><b>${esc(label)}</b> <code>${esc(a.Name)}</code></div><div class="view-act-params">${paramHtml}</div></div>`;
    }).join("") || `<p class="hint">无动作</p>`;

    const branches = r.Branches || [];
    const if1 = branches[0];
    let if1Html = "";
    if (if1) {
        const condText = if1.Condition || "（无条件，匹配所有请求）";
        if1Html = `<div class="view-branch">
            <div class="view-branch-head"><b>IF1</b>（顶层主条件）</div>
            <div class="view-section">
                <h4>匹配条件</h4>
                <code class="view-cond">${esc(condText)}</code>
            </div>
            <div class="view-section">
                <h4>执行动作（${(if1.Actions || []).length}）</h4>
                ${actionsHtml(if1.Actions)}
            </div>
        </div>`;
    }
    const subRules = if1 && if1.SubRules ? if1.SubRules : [];
    const subRulesHtml = subRules.length ? subRules.map((sub, si) => {
        const tabs = sub.Branches || [];
        const tabHtmls = tabs.map((tb, ti) => {
            const isElse = tb.Condition === "*";
            const label = ti === 0 ? "IF" : isElse ? "ELSE" : `ELSE IF #${ti}`;
            const condShow = isElse ? "（上述 IF / ELSE IF 均未命中时执行）" : (tb.Condition || "（无条件）");
            return `<div class="view-branch inner">
                <div class="view-branch-head inner-head"><b>${label}</b></div>
                <div class="view-section">
                    <h4>匹配条件</h4>
                    <code class="view-cond">${esc(condShow)}</code>
                </div>
                <div class="view-section">
                    <h4>执行动作（${(tb.Actions || []).length}）</h4>
                    ${actionsHtml(tb.Actions)}
                </div>
            </div>`;
        }).join("");
        return `<div class="view-subrule">
            <div class="view-subrule-head"><b>IF2 #${si + 1}</b>（子条件组，共 ${tabs.length} 个分支）</div>
            <div class="view-subrule-body">${tabHtmls}</div>
        </div>`;
    }).join("") : `<p class="hint">没有 IF2 子条件组。</p>`;
    const branchHtml = if1Html + subRulesHtml;

    const body = `
    <div class="rule-view">
        <div class="view-meta">
            <div><span class="label">规则名</span> <b>${esc(r.RuleName || "-")}</b></div>
            <div><span class="label">状态</span> ${stBadge}</div>
            <div><span class="label">优先级</span> ${esc(r.RulePriority ?? "-")}</div>
        </div>
        ${r.Description && r.Description.length ? `<div class="view-desc"><span class="label">描述</span> ${esc((Array.isArray(r.Description) ? r.Description : [r.Description]).join("；"))}</div>` : ""}
        ${branchHtml}
        <details class="rule-json-preview" style="margin-top:14px">
            <summary>原始 JSON</summary>
            <pre class="json-preview">${esc(jsonStr)}</pre>
        </details>
    </div>`;
    openModal(`规则详情 - ${ruleId}`, body, [], {
        size: "rules",
        headerActions: [
            { label: "复制 JSON", class: "ghost", onClick: () => {
                navigator.clipboard.writeText(jsonStr).then(
                    () => toast("JSON 已复制到剪贴板", "success"),
                    () => toast("复制失败，请手动选择文本", "error")
                );
            }},
            { label: "编辑", class: "primary", onClick: () => openEditRuleModal(ruleId) },
            { label: "返回列表", class: "ghost", onClick: openRulesModal },
        ],
    });
}

async function openAddRuleModal() {
    let tpl;
    try {
        tpl = await http(API.ruleTemplate());
    } catch (e) {
        toast(e.message, "error");
        return;
    }
    const rule = (tpl.Rules || [])[0] || {};
    _ruleEditor = _parseRuleToEditor(rule);
    _ruleEditor._ruleId = null;
    if (!_ruleEditor.ruleName || _ruleEditor.ruleName.includes("请修改")) _ruleEditor.ruleName = "";
    _renderRuleForm(false);
}

async function submitAddRule() {
    const ruleJson = _collectRuleJson();
    const rule = ruleJson.Rules[0];
    if (!rule.RuleName) return toast("请填写规则名称", "error");
    const err = _validateRuleStructure(rule);
    if (err) return toast(err, "error");
    try {
        const r = await http(API.createRule(state.zoneId), { method: "POST", body: JSON.stringify(ruleJson) });
        toast(r.message || "规则创建成功", "success");
        closeModal();
        openRulesModal();
    } catch (e) {
        toast(e.message, "error");
    }
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
    $("#rulesBtn").addEventListener("click", openRulesModal);
    $("#changePwBtn").addEventListener("click", openChangePasswordModal);
    $("#logoutBtn").addEventListener("click", logout);
    $("#searchInput").addEventListener("input", renderDomains);
    $("#modalClose").addEventListener("click", () => {
        // 规则引擎弹窗（modalBox 带 modal-rules class）点 × 也强制刷新域名表格
        if ($("#modalBox").classList.contains("modal-rules")) {
            closeRulesModal();
        } else {
            closeModal();
        }
    });
    // 禁用点击弹窗外部关闭，仅通过按钮或关闭按钮关闭
    bootstrap();
});
