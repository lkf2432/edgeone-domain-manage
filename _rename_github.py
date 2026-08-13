"""1. 重命名 GitHub 仓库 edgeone-deocker -> edgeone-domain-manage
2. 推送当前本地改动（README、compose、manifest 等改名后的文件）为新 commit
3. 同步删除旧 release 资产，更新新 release
"""
from __future__ import annotations

import base64
import fnmatch
import os
import sys
from pathlib import Path
from typing import Any

from github import Github, InputGitAuthor, InputGitTreeElement

TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""
OLD_REPO = "lkf2432/edgeone-deocker"
NEW_NAME = "edgeone-domain-manage"
NEW_REPO = f"lkf2432/{NEW_NAME}"

ROOT = Path(__file__).resolve().parent
OLD_FPK_NAME = "edgeone-manager.fpk"
NEW_FPK_NAME = "edgeone-domain-manage.fpk"
RELEASE_TAG = "v1.0.0"
RELEASE_NAME = "v1.0.0 - 飞牛 NAS Docker FPK"
RELEASE_BODY = """### 首次发布

- 腾讯云 EdgeOne 域名管理：列出/添加/编辑/启停/删除
- HTTPS 配置、CNAME 一键添加、IPv6 支持
- DDNS 自动更新源站组 IP，支持 IPv4/IPv6、网卡/公网接口、Webhook 推送
- 日志查看、管理员认证（默认密码 admin）
- 飞牛 NAS Docker FPK 应用包
- Docker Hub 镜像：gyc2432/edgeone-domain-manage:latest

### 安装说明

1. 下载下方的 edgeone-domain-manage.fpk
2. 进入飞牛 NAS 应用中心 -> 手动安装 -> 选择 .fpk 文件
3. 访问 http://<NAS IP>:8196 ，默认管理员密码 admin
"""

GITIGNORE_PATTERNS: list[str] = []


def load_gitignore() -> None:
    gi = ROOT / ".gitignore"
    if not gi.exists():
        return
    for line in gi.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        GITIGNORE_PATTERNS.append(line)


def is_ignored(rel: Path) -> bool:
    s = str(rel).replace("\\", "/")
    name = rel.name
    for pat in GITIGNORE_PATTERNS:
        if pat.endswith("/"):
            parts = rel.parts
            for i in range(len(parts)):
                sub = "/".join(parts[: i + 1]) + "/"
                if fnmatch.fnmatchcase(sub, pat):
                    return True
        else:
            if fnmatch.fnmatchcase(s, pat):
                return True
            if fnmatch.fnmatchcase(name, pat):
                return True
            if pat.startswith("/") and fnmatch.fnmatchcase(s, pat.lstrip("/")):
                return True
    return False


def collect_files() -> list[Path]:
    files: list[Path] = []
    for p in ROOT.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT)
        if any(part in {".venv", "__pycache__", ".git", "data"} for part in rel.parts):
            continue
        if is_ignored(rel):
            continue
        files.append(p)
    files.sort(key=lambda x: str(x.relative_to(ROOT)))
    return files


def to_gh_path(p: Path) -> str:
    return str(p.relative_to(ROOT)).replace("\\", "/")


def main() -> None:
    load_gitignore()
    if not TOKEN:
        print("缺少 token")
        sys.exit(1)

    gh = Github(TOKEN)
    user = gh.get_user()
    print(f"当前用户: {user.login}")

    # 1. 重命名仓库
    repo = None
    try:
        repo = gh.get_repo(OLD_REPO)
        print(f"获取仓库 {OLD_REPO}，准备重命名为 {NEW_NAME}")
        repo.edit(name=NEW_NAME)
        print(f"仓库已重命名: https://github.com/{NEW_REPO}")
    except Exception as e:  # noqa: BLE001
        print(f"重命名失败，尝试直接获取新仓库: {e}")
        try:
            repo = gh.get_repo(NEW_REPO)
            print(f"已获取目标仓库 {NEW_REPO}")
        except Exception as e2:  # noqa: BLE001
            print(f"获取仓库失败: {e2}")
            sys.exit(1)

    # 2. 推送当前本地所有改动（README / build_fpk.py / compose 等 20 个文件）
    author = InputGitAuthor(user.name or user.login, (user.email or f"{user.login}@users.noreply.github.com"))
    msg = "Rename to edgeone-domain-manage: manifest, docker, README, FPK package name"

    files = collect_files()
    print(f"待上传文件数: {len(files)}")

    # 获取 main 分支 base commit
    base_commit_sha = None
    for br in ["main", "master"]:
        try:
            ref = repo.get_git_ref(f"heads/{br}")
            base_commit_sha = ref.object.sha
            print(f"基于已有分支 {br}: {base_commit_sha[:7]}")
            break
        except Exception:  # noqa: BLE001
            continue
    if not base_commit_sha:
        print("未找到 base commit，退出")
        sys.exit(1)
    base_tree_sha = repo.get_git_commit(base_commit_sha).tree.sha

    tree_elements: list[Any] = []
    for p in files:
        rel = to_gh_path(p)
        raw = p.read_bytes()
        if len(raw) > 100 * 1024 * 1024:
            continue
        blob_sha = repo.create_git_blob(base64.b64encode(raw).decode("ascii"), "base64").sha
        tree_elements.append(
            InputGitTreeElement(path=rel, mode="100644", type="blob", sha=blob_sha)
        )

    tree = repo.create_git_tree(tree_elements, base_tree=repo.get_git_tree(base_tree_sha))
    commit = repo.create_git_commit(msg, tree, [repo.get_git_commit(base_commit_sha)], author=author)
    ref.edit(commit.sha, force=True)
    print(f"推送成功: {commit.sha[:7]}")

    # 3. 更新 Release：删除旧 FPK 资产，更新描述，新增空的 release 资产位（稍后上传）
    print("更新 Release...")
    release = None
    for r in repo.get_releases():
        if r.tag_name == RELEASE_TAG:
            release = r
            break
    if release is None:
        release = repo.create_git_release(
            tag=RELEASE_TAG, name=RELEASE_NAME, message=RELEASE_BODY,
            draft=False, prerelease=False, target_commitish="main",
        )
    else:
        release.update_release(name=RELEASE_NAME, message=RELEASE_BODY, draft=False, prerelease=False,
                               tag_name=RELEASE_TAG, target_commitish="main")
    # 删除旧名字的 FPK 资产
    for ass in release.get_assets():
        if ass.name in {OLD_FPK_NAME, NEW_FPK_NAME}:
            try:
                ass.delete_asset()
                print(f"  已删除旧资产 {ass.name}")
            except Exception as exc:  # noqa: BLE001
                print(f"  删除失败: {exc}")
    print(f"Release 已更新: {release.html_url} （等待上传新 FPK 资产）")


if __name__ == "__main__":
    main()
