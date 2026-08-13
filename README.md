# EdgeOne 域名管理

腾讯云 EdgeOne 加速域名管理工具，支持域名列表、编辑、启停、删除、HTTPS 配置、CNAME 一键添加、DDNS 自动更新源站组 IP 等功能。

## 功能特性

- 域名管理：列出、添加、编辑、启用/停用、删除加速域名
- HTTPS 配置：一键开启/关闭 HTTPS，查看证书信息
- CNAME 自动添加：根据站点接入类型自动创建并启用 CNAME 记录
- IPv6 支持：域名可开启 IPv6 加速，列表显示 IPv6 状态
- DDNS 自动更新源站组：定时检测本机 IP，自动更新 EdgeOne 源站组
  - 支持 IPv4 / IPv6
  - 支持网卡获取 / 公网接口获取两种方式
  - 支持自定义更新间隔
  - 支持 Webhook 消息推送（钉钉 / 企业微信机器人）
- 日志查看：应用运行日志、EdgeOne API 调用日志、DDNS 运行日志
- 管理员认证：单用户密码登录，默认密码 `admin`，支持修改

## 默认密码

首次登录使用默认密码：

```
admin
```

请登录后及时在「🔑 改密」中修改。

忘记密码可重装应用自动重置，或 SSH 执行 `/var/apps/edgeone-manager/cmd/reset_password` 重置。

---

## 部署方式

### 方式一：飞牛 NAS FPK 安装（推荐）

在 [Releases](https://github.com/gyc2432/edgeone-deocker/releases) 下载最新的 `edgeone-manager.fpk`，上传到飞牛 NAS 应用中心手动安装即可。

安装完成后访问：`http://<NAS IP>:8196`

---

### 方式二：Docker 手动运行

```bash
docker run -d \
  --name edgeone-manager \
  --network host \
  -v /path/to/data:/app/data \
  -e APP_PORT=8196 \
  -e DATA_DIR=/app/data \
  gyc2432/edgeone-manager:latest
```

启动后访问：`http://localhost:8196`

#### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--network host` | 使用宿主机网络（推荐，支持多网卡） | - |
| `-p 8196:8196` | 不用 host 网络时，用端口映射替代 | - |
| `-v /path/to/data:/app/data` | 配置与日志持久化目录 | 必需 |
| `-e APP_PORT=8196` | 应用监听端口 | `8196` |
| `-e DATA_DIR=/app/data` | 数据目录（与 volume 对应） | `/app/data` |
| `-e TENCENTCLOUD_SECRET_ID=xxx` | 腾讯云 SecretId（环境变量方式） | - |
| `-e TENCENTCLOUD_SECRET_KEY=xxx` | 腾讯云 SecretKey（环境变量方式） | - |
| `-e EDGEONE_REGION=ap-guangzhou` | EdgeOne 区域 | `ap-guangzhou` |

---

### 方式三：Docker Compose 运行

创建 `docker-compose.yml`：

```yaml
services:
  edgeone-manager:
    image: gyc2432/edgeone-manager:latest
    container_name: edgeone-manager
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./data:/app/data
    environment:
      - APP_PORT=8196
      - DATA_DIR=/app/data
      # 可选：通过环境变量预设腾讯云密钥（也可登录后在配置页设置）
      # - TENCENTCLOUD_SECRET_ID=your_secret_id
      # - TENCENTCLOUD_SECRET_KEY=your_secret_key
      # - EDGEONE_REGION=ap-guangzhou
```

启动：

```bash
docker compose up -d
```

启动后访问：`http://localhost:8196`

---

### 方式四：手动运行 Python

#### 环境要求

- Python 3.12+
- [uv](https://github.com/astral-sh/uv)（推荐）或 pip

#### 1. 克隆项目

```bash
git clone https://github.com/gyc2432/edgeone-deocker.git
cd edgeone-deocker
```

#### 2. 创建虚拟环境并安装依赖

使用 uv：

```bash
uv venv
uv pip install -r requirements.txt
```

或使用 pip：

```bash
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

#### 3. 配置（可选）

复制 `.env.example` 为 `.env`，填入腾讯云密钥（也可登录后在配置页设置）：

```bash
cp .env.example .env
# 编辑 .env，填入 TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY
```

#### 4. 启动应用

使用 Flask 开发服务器：

```bash
# Windows
.venv\Scripts\activate
python app.py

# Linux/macOS
source .venv/bin/activate
python app.py
```

或使用 gunicorn（推荐生产环境）：

```bash
gunicorn --bind 0.0.0.0:8196 --workers 2 --access-logfile - --error-logfile - app:app
```

启动后访问：`http://localhost:8196`

---

## 首次使用

1. 打开页面，输入默认密码 `admin` 登录
2. 进入「⚙️ 配置」页，填入腾讯云 SecretId / SecretKey，选择区域，点击「测试连接」验证后保存
3. 返回首页即可开始管理站点和域名

## 腾讯云密钥获取

登录腾讯云访问管理控制台：[访问密钥管理](https://console.cloud.tencent.com/cam/capi)

推荐使用子账号密钥并授权 `QcloudTEOFullAccess` 策略。
