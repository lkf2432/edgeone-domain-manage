#!/usr/bin/env python3
"""EdgeOne 域名管理 - 飞牛NAS Docker FPK 安装包构建脚本

用法:
    python build_fpk.py

功能:
    1. 复制 Python 源码、Dockerfile、模板、静态资源到 fpk_build/app/docker/
    2. 生成应用图标
    3. 下载 fnpack 工具并打包 .fpk
"""

import os
import platform
import shutil
import stat
import struct
import sys
import zlib
import urllib.request

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
BUILD_DIR = os.path.join(PROJECT_ROOT, "fpk_build")
FNPACK_VERSION = "1.2.1"


def _read_version():
    """从 fpk_base/manifest 读取应用版本号"""
    manifest = os.path.join(PROJECT_ROOT, "fpk_base", "manifest")
    if os.path.exists(manifest):
        with open(manifest, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("version"):
                    parts = line.split("=", 1)
                    if len(parts) == 2:
                        return parts[1].strip()
    return "1.0.0"


APP_VERSION = _read_version()


def _fnpack_artifact():
    """返回 fnpack 二进制文件名后缀 + 下载 URL（固定 amd64，Docker 应用无需 arm64）"""
    system = platform.system().lower()
    if system.startswith("win"):
        suffix = "windows-amd64"
    elif system == "darwin":
        suffix = "darwin-amd64"
    else:
        suffix = "linux-amd64"
    url = f"https://static2.fnnas.com/fnpack/fnpack-{FNPACK_VERSION}-{suffix}"
    return suffix, url


def step(n, total, msg):
    print(f"[{n}/{total}] {msg}")


def copy_source():
    """复制 FPK 预置结构（manifest/cmd/config/ui/config）+ 源码 + Docker 相关文件到 fpk_build"""
    step(1, 4, "复制预置结构和源码文件...")
    base_dir = os.path.join(PROJECT_ROOT, "fpk_base")
    docker_dir = os.path.join(BUILD_DIR, "app", "docker")
    os.makedirs(BUILD_DIR, exist_ok=True)

    # ---------- 1. 先复制 fpk_base/ 预置结构（manifest, cmd/, config/, app/ui/config）----------
    if os.path.isdir(base_dir):
        for item in os.listdir(base_dir):
            src_item = os.path.join(base_dir, item)
            dst_item = os.path.join(BUILD_DIR, item)
            if os.path.isdir(src_item):
                if os.path.exists(dst_item):
                    shutil.rmtree(dst_item)
                shutil.copytree(src_item, dst_item)
            else:
                shutil.copy2(src_item, dst_item)
        print(f"  <- fpk_base/（预置 manifest/cmd/config/ui/config）")
        # 给 cmd/ 目录下所有脚本强制加执行权限（防止 Windows 提交的 git mode=644 导致 fnOS 下无法执行）
        cmd_dir = os.path.join(BUILD_DIR, "cmd")
        if os.path.isdir(cmd_dir):
            for cmd_f in os.listdir(cmd_dir):
                cmd_path = os.path.join(cmd_dir, cmd_f)
                if os.path.isfile(cmd_path):
                    try:
                        st = os.stat(cmd_path)
                        os.chmod(cmd_path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                    except Exception as e:
                        print(f"  !! chmod +x {cmd_f} 失败: {e}")
            print(f"  -> cmd/* 已添加可执行权限 (chmod +x)")
    else:
        print(f"  !! fpk_base/ 目录不存在（{base_dir}），将缺失 manifest/cmd 等预置文件")

    os.makedirs(docker_dir, exist_ok=True)

    # ---------- 2. 覆盖复制最新源码和配置文件到 app/docker/ ----------
    py_files = [
        "app.py", "edgeone_client.py", "settings.py", "logger_setup.py",
        "ddns_scheduler.py", "ip_detector.py", "notifier.py", "requirements.txt",
        "rule-engine-default.json",
    ]
    for f in py_files:
        src = os.path.join(PROJECT_ROOT, f)
        if os.path.exists(src):
            shutil.copy2(src, docker_dir)
            print(f"  -> {f}")
        else:
            print(f"  !! {f} not found")

    # ---------- 3. 复制最新 Dockerfile 和 docker-compose（.yml → .yaml）----------
    df_src = os.path.join(PROJECT_ROOT, "Dockerfile")
    if os.path.exists(df_src):
        shutil.copy2(df_src, os.path.join(docker_dir, "Dockerfile"))
        print("  -> Dockerfile")

    dc_src = os.path.join(PROJECT_ROOT, "docker-compose.yml")
    if os.path.exists(dc_src):
        shutil.copy2(dc_src, os.path.join(docker_dir, "docker-compose.yaml"))
        print("  -> docker-compose.yaml")
    else:
        dc_yaml_src = os.path.join(PROJECT_ROOT, "docker-compose.yaml")
        if os.path.exists(dc_yaml_src):
            shutil.copy2(dc_yaml_src, os.path.join(docker_dir, "docker-compose.yaml"))
            print("  -> docker-compose.yaml")

    # ---------- 4. 复制 templates ----------
    tpl_src = os.path.join(PROJECT_ROOT, "templates")
    tpl_dst = os.path.join(docker_dir, "templates")
    if os.path.exists(tpl_dst):
        shutil.rmtree(tpl_dst)
    if os.path.exists(tpl_src):
        shutil.copytree(tpl_src, tpl_dst)
        print("  -> templates/")

    # ---------- 5. 复制 static ----------
    static_src = os.path.join(PROJECT_ROOT, "static")
    static_dst = os.path.join(docker_dir, "static")
    if os.path.exists(static_dst):
        shutil.rmtree(static_dst)
    if os.path.exists(static_src):
        shutil.copytree(static_src, static_dst)
        print("  -> static/")

    print()


def create_png_icon(width, height, filepath):
    """生成带有 EO 文字的蓝色圆角 PNG 图标"""
    pixels = []
    cx, cy = width // 2, height // 2
    radius = int(width * 0.38)

    for y in range(height):
        row = bytearray([0])  # filter byte
        for x in range(width):
            dx, dy = x - cx, y - cy
            dist = (dx * dx + dy * dy) ** 0.5

            if dist < radius:
                r, g, b, a = 0, 110, 255, 255
                stroke = max(2, int(width * 0.04))
                text_h = int(height * 0.3)
                e_x1 = cx - int(width * 0.2)
                e_x2 = e_x1 + int(width * 0.13)
                o_x1 = cx + int(width * 0.03)
                o_x2 = o_x1 + int(width * 0.13)

                # E 字母
                if e_x1 <= x <= e_x2 and (cy - text_h // 2) <= y <= (cy + text_h // 2):
                    top = cy - text_h // 2
                    bot = cy + text_h // 2
                    if (y <= top + stroke or y >= bot - stroke or
                        x <= e_x1 + stroke or
                        (cy - stroke // 2 <= y <= cy + stroke // 2 and x <= e_x1 + stroke)):
                        r, g, b = 255, 255, 255

                # O 字母 (环形)
                if o_x1 <= x <= o_x2 and (cy - text_h // 2) <= y <= (cy + text_h // 2):
                    ocx = (o_x1 + o_x2) // 2
                    ody = y - cy
                    odx = x - ocx
                    odist = (odx * odx + ody * ody) ** 0.5
                    inner_r = int(width * 0.05)
                    outer_r = int(width * 0.065)
                    if inner_r < odist < outer_r:
                        r, g, b = 255, 255, 255

            elif dist < radius + 2:
                alpha = int(255 * (1 - (dist - radius) / 2))
                r, g, b, a = 0, 110, 255, alpha
            else:
                r, g, b, a = 0, 0, 0, 0

            row.extend([r, g, b, a])
        pixels.append(bytes(row))

    raw = b"".join(pixels)
    compressed = zlib.compress(raw)

    def chunk(ctype, data):
        c = ctype + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")

    with open(filepath, "wb") as f:
        f.write(png)


def generate_icons():
    """生成应用图标"""
    step(2, 4, "生成应用图标...")
    create_png_icon(64, 64, os.path.join(BUILD_DIR, "ICON.PNG"))
    print("  -> ICON.PNG (64x64)")
    create_png_icon(256, 256, os.path.join(BUILD_DIR, "ICON_256.PNG"))
    print("  -> ICON_256.PNG (256x256)")

    ui_dir = os.path.join(BUILD_DIR, "app", "ui", "images")
    os.makedirs(ui_dir, exist_ok=True)
    create_png_icon(64, 64, os.path.join(ui_dir, "icon_64.png"))
    create_png_icon(256, 256, os.path.join(ui_dir, "icon_256.png"))
    print("  -> ui/images/icon_64.png")
    print("  -> ui/images/icon_256.png")
    print()


def download_fnpack():
    """下载 fnpack 打包工具（跨平台：自动识别 Windows/Linux/macOS + amd64/arm64）"""
    step(3, 4, "下载 fnpack 打包工具...")
    suffix, url = _fnpack_artifact()
    fnpack_path = os.path.join(PROJECT_ROOT, f"fnpack-{FNPACK_VERSION}-{suffix}")

    if os.path.exists(fnpack_path):
        print(f"  -> fnpack 已存在 ({suffix})，跳过下载")
        return fnpack_path

    print(f"  平台: {suffix}")
    print(f"  下载: {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            with open(fnpack_path, "wb") as f:
                f.write(resp.read())
        # Linux/macOS 下给执行权限
        if not platform.system().lower().startswith("win"):
            st = os.stat(fnpack_path)
            os.chmod(fnpack_path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        print("  -> 下载完成")
        return fnpack_path
    except Exception as e:
        print(f"  !! 下载失败: {e}")
        print(f"  !! 请手动下载 {url} 并放在项目根目录，重命名为 {os.path.basename(fnpack_path)}")
        return None


def build_fpk():
    """打包 FPK"""
    step(4, 4, "构建 FPK 安装包...")
    fnpack_path = download_fnpack()

    output_file = os.path.join(PROJECT_ROOT, "edgeone-domain-manage.fpk")

    if fnpack_path and os.path.exists(fnpack_path):
        import subprocess
        print("  使用 fnpack 打包...")
        # fnpack build -d <目录>，在项目目录下生成 .fpk 文件
        result = subprocess.run(
            [fnpack_path, "build", "-d", BUILD_DIR],
            capture_output=True, text=True
        )
        print(f"  fnpack 输出: {result.stdout}")
        if result.stderr:
            print(f"  fnpack 日志: {result.stderr}")
        if result.returncode == 0:
            # fnpack 默认在当前目录生成 <appname>.fpk
            # 查找生成的 fpk 文件
            generated = None
            for f in os.listdir(PROJECT_ROOT):
                if f.endswith(".fpk") and f != output_name:
                    generated = os.path.join(PROJECT_ROOT, f)
                    break
            # 也可能在 build 目录下
            if not generated:
                for f in os.listdir(BUILD_DIR):
                    if f.endswith(".fpk"):
                        generated = os.path.join(BUILD_DIR, f)
                        break
            if generated and generated != output_file:
                shutil.move(generated, output_file)
            if os.path.exists(output_file):
                print("  -> fnpack 打包成功!")
            else:
                print("  -> 未找到生成的 fpk 文件，回退到 tar.gz...")
                _tar_pack(output_file)
        else:
            print(f"  !! fnpack 返回码: {result.returncode}")
            print("  -> 回退到 tar.gz 手动打包...")
            _tar_pack(output_file)
    else:
        print("  -> 使用 tar.gz 手动打包...")
        _tar_pack(output_file)

    print()

    if os.path.exists(output_file):
        size_kb = os.path.getsize(output_file) / 1024
        print("=" * 50)
        print("  Docker FPK 构建完成!")
        print(f"  输出: {output_name} ({size_kb:.1f} KB)")
        print("=" * 50)
        print()
        print("安装方法:")
        print(f"  1. 将 {output_name} 上传到飞牛NAS")
        print("  2. fnOS 应用中心 -> 手动安装 -> 选择 .fpk 文件")
        print(f"  3. 或 SSH 执行: appcenter-cli install-fpk {output_name}")
        print()
        print("注意:")
        print("  - 首次安装时会自动从 Docker Hub 拉取镜像，请耐心等待")
        print("  - 默认管理员密码: admin")
        print("  - 忘记密码: SSH 执行 /var/apps/edgeone-domain-manage/cmd/reset_password")
    else:
        print("构建失败!")
        sys.exit(1)


def _tar_pack(output_file):
    """备用：用 tar.gz 手动打包，确保 cmd 脚本有执行权限"""
    import tarfile

    def set_perms(tarinfo):
        """设置文件权限：cmd/ 下脚本为 755，其他文件为 644"""
        if tarinfo.name.startswith("cmd/"):
            tarinfo.mode = 0o755
        else:
            tarinfo.mode = 0o644
        return tarinfo

    with tarfile.open(output_file, "w:gz") as tar:
        for item in os.listdir(BUILD_DIR):
            item_path = os.path.join(BUILD_DIR, item)
            tar.add(item_path, arcname=item, filter=set_perms)
    print("  -> tar.gz 打包完成 (cmd 脚本权限 755)")


if __name__ == "__main__":
    print("=" * 50)
    print("  EdgeOne 域名管理 - Docker FPK 构建脚本")
    print("=" * 50)
    print()
    copy_source()
    generate_icons()
    build_fpk()
