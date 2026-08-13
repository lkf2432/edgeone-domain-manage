"""将项目上传到 GitHub 并创建 Release（无需 git）。

使用 PyGithub + GitHub REST API：
1. 获取用户身份，确定 owner
2. 创建仓库 edgeone-deocker
3. 创建默认 main 分支的初始提交（读取本地文件，应用 .gitignore）
4. 推送整个源码树
5. 创建 release v1.0.0 并上传 edgeone-manager.fpk
"""
from __future__ import annotations

import base64
import fnmatch
import os
import sys
from pathlib import Path
from typing import Iterable

from github import Github, InputGitAuthor, InputGitTreeElement

TOKEN = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("GITHUB_TOKEN", "")
if not TOKEN:
    print("请传入 Token 参数或设置 GITHUB_TOKEN 环境变量")
    sys.exit(1)

REPO_NAME = "edgeone-deocker"
ROOT = Path(__file__).resolve().parent
FPK_FILE = ROOT / "edgeone-manager.fpk"
RELEASE_TAG = "v1.0.0"
RELEASE_NAME = "v1.0.0 - 飞牛 NAS Docker FPK"
RELEASE_BODY = """### 首次发布

- 腾讯云 EdgeOne 域名管理：列出/添加/编辑/启停/删除
- HTTPS 配置、CNAME 一键添加、IPv6 支持
- DDNS 自动更新源站组 IP，支持 IPv4/IPv6、网卡/公网接口、Webhook 推送
- 日志查看、管理员认证（默认密码 admin）
- 飞牛 NAS Docker FPK 应用包
- Docker Hub 镜像：gyc2432/edgeone-manager:latest

### 安装说明

1. 下载下方的 edgeone-manager.fpk
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


def is_ignored(rel_path: Path) -> bool:
    """按 .gitignore 规则判断文件是否应排除。"""
    s = str(rel_path).replace("\\", "/")
    name = rel_path.name
    # 以 / 结尾的规则只匹配目录
    for pat in GITIGNORE_PATTERNS:
        if pat.endswith("/"):
            # 该文件或任意祖先目录匹配
            parts = rel_path.parts
            for i, _ in enumerate(parts):
                sub = "/".join(parts[: i + 1]) + "/"
                if fnmatch.fnmatchcase(sub, pat):
                    return True
        else:
            # 同时匹配路径（完整/任意子路径）和文件名
            if fnmatch.fnmatchcase(s, pat):
                return True
            if fnmatch.fnmatchcase(name, pat):
                return True
            # 前缀 /foo 模式
            if pat.startswith("/") and fnmatch.fnmatchcase(s, pat.lstrip("/")):
                return True
    return False


def collect_files() -> list[Path]:
    """收集需要上传的文件路径（相对 ROOT）。"""
    files: list[Path] = []
    for p in ROOT.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT)
        # 先排除明显的目录名（.venv 等）
        if any(part in {".venv", "__pycache__", ".git"} for part in rel.parts):
            continue
        if is_ignored(rel):
            continue
        files.append(p)
    files.sort(key=lambda x: str(x.relative_to(ROOT)))
    return files


def to_github_path(p: Path) -> str:
    return str(p.relative_to(ROOT)).replace("\\", "/")


def main() -> None:
    load_gitignore()
    gh = Github(TOKEN)
    user = gh.get_user()
    owner = user.login
    print(f"当前登录 GitHub 用户: {owner}")

    # 1. 创建仓库（如存在则复用）
    try:
        repo = user.create_repo(
            REPO_NAME,
            description="腾讯云 EdgeOne 域名管理工具 - 支持域名增删改查、HTTPS、CNAME、DDNS 自动更新源站组 IP、日志查看、飞牛 NAS FPK 安装包",
            homepage=f"https://hub.docker.com/r/{owner}/edgeone-manager",
            private=False,
            has_issues=True,
            has_wiki=False,
            auto_init=False,
        )
        print(f"仓库已创建: {repo.html_url}")
    except Exception as e:  # noqa: BLE001
        # 可能已存在
        try:
            repo = gh.get_repo(f"{owner}/{REPO_NAME}")
            print(f"复用已有仓库: {repo.html_url}")
        except Exception as e2:  # noqa: BLE001
            print(f"创建/获取仓库失败: {e} | {e2}")
            sys.exit(1)

    # 2. 收集文件并创建 blobs
    files = collect_files()
    print(f"待上传文件数: {len(files)}")
    for f in files[:20]:
        print("   ", to_github_path(f))
    if len(files) > 20:
        print(f"    ... 省略 {len(files) - 20} 个文件")

    author = InputGitAuthor(user.name or owner, (user.email or f"{owner}@users.noreply.github.com"))
    commit_msg = "Initial commit: EdgeOne 域名管理工具（Flask + 腾讯云 EdgeOne SDK + Docker + FPK）"

    # 对于全新空仓库：先通过 contents API 创建 README.md 作为初始提交，再用 tree API 覆盖全量文件
    initial_commit_sha = None
    try:
        readme_path = to_github_path(ROOT / "README.md")
        readme_content = (ROOT / "README.md").read_bytes()
        try:
            # 用 base64 创建 README，使仓库产生第一个 commit
            r = repo.create_file(
                path=readme_path,
                message="init: README",
                content=base64.b64encode(readme_content).decode("ascii"),
                branch="main",
            )
            initial_commit_sha = r["commit"].sha
            print(f"空仓库初始化提交成功（README）: {initial_commit_sha[:7]}")
        except Exception as exc:  # noqa: BLE001
            print(f"初始化 README 失败（可能已存在）: {exc}")
    except FileNotFoundError:
        pass

    # 通过 low-level Git Data API 提交：创建 tree -> commit -> ref
    try:
        base_commit_sha = initial_commit_sha
        base_tree_sha = None
        if not base_commit_sha:
            for br in ["main", "master"]:
                try:
                    ref = repo.get_git_ref(f"heads/{br}")
                    base_commit_sha = ref.object.sha
                    break
                except Exception:  # noqa: BLE001
                    continue
        if base_commit_sha:
            base_tree_sha = repo.get_git_commit(base_commit_sha).tree.sha
            print(f"基于 commit {base_commit_sha[:7]} 创建全量文件树")
        else:
            print("未找到基础 commit，将创建全新 tree+commit")

        tree_elements: list[InputGitTreeElement] = []
        for p in files:
            rel = to_github_path(p)
            try:
                raw = p.read_bytes()
            except OSError as exc:
                print(f"  跳过 {rel}: {exc}")
                continue
            if len(raw) > 100 * 1024 * 1024:
                print(f"  跳过超大文件: {rel}")
                continue
            blob_sha = repo.create_git_blob(
                base64.b64encode(raw).decode("ascii"), "base64"
            ).sha
            tree_elements.append(
                InputGitTreeElement(
                    path=rel,
                    mode="100644",
                    type="blob",
                    sha=blob_sha,
                )
            )

        base_tree = repo.get_git_tree(base_tree_sha) if base_tree_sha else None
        tree = repo.create_git_tree(tree_elements, base_tree=base_tree)
        if base_commit_sha:
            parent_commits = [repo.get_git_commit(base_commit_sha)]
        else:
            parent_commits = []
        commit = repo.create_git_commit(commit_msg, tree, parent_commits, author=author)

        # 更新 main 分支
        try:
            ref = repo.get_git_ref("heads/main")
            ref.edit(commit.sha, force=True)
        except Exception:  # noqa: BLE001
            try:
                repo.create_git_ref(ref="refs/heads/main", sha=commit.sha)
            except Exception as exc:  # noqa: BLE001
                print(f"创建/更新 main 分支失败: {exc}")
        print(f"全量提交成功: {commit.sha[:7]}")

        # 设置仓库默认分支 main
        try:
            repo.edit(default_branch="main")
        except Exception:  # noqa: BLE001
            pass

    except Exception as exc:  # noqa: BLE001
        print(f"创建 Git 对象/提交失败: {exc}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    # 3. 创建 Release 并上传 .fpk
    print(f"准备创建 Release {RELEASE_TAG}，上传 FPK: {FPK_FILE.name} (存在={FPK_FILE.exists()})")
    if FPK_FILE.exists():
        fpk_size = FPK_FILE.stat().st_size
        print(f"FPK 大小: {fpk_size / 1024:.1f} KB")

    try:
        # 查找是否已有该 tag 的 release
        release = None
        for r in repo.get_releases():
            if r.tag_name == RELEASE_TAG:
                release = r
                break
        if release is None:
            release = repo.create_git_release(
                tag=RELEASE_TAG,
                name=RELEASE_NAME,
                message=RELEASE_BODY,
                draft=False,
                prerelease=False,
                target_commitish="main",
            )
            print(f"Release 已创建: {release.html_url}")
        else:
            print(f"复用已有 Release: {release.html_url}")

        if FPK_FILE.exists():
            # 删除同名旧资产
            for ass in release.get_assets():
                if ass.name == FPK_FILE.name:
                    try:
                        ass.delete_asset()
                        print(f"  已删除旧资产 {ass.name}")
                    except Exception as exc:  # noqa: BLE001
                        print(f"  删除旧资产失败: {exc}")
            try:
                ass = release.upload_asset(
                    path=str(FPK_FILE),
                    label="飞牛 NAS FPK 安装包",
                    content_type="application/octet-stream",
                )
                print(f"FPK 上传成功: {ass.browser_download_url}")
            except Exception as exc:  # noqa: BLE001
                print(f"FPK 上传失败: {exc}")
                import traceback
                traceback.print_exc()
    except Exception as exc:  # noqa: BLE001
        print(f"创建 Release 失败: {exc}")
        import traceback
        traceback.print_exc()

    print("\n===== 完成 =====")
    print(f"仓库地址: {repo.html_url}")
    print(f"Release:  {release.html_url if 'release' in dir() else '未创建'}")


if __name__ == "__main__":
    main()
