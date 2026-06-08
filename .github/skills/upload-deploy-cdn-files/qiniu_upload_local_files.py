#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
七牛云文件上传工具
将本地文件或目录上传到七牛存储桶，输出每个文件的外网 CDN 链接，并自动刷新 CDN 缓存。

默认远程前缀为 keepwork/cdn/。
可通过 --prefix 指定本次上传的远程前缀，例如 --prefix sdk/。

用法:
    python qiniu_upload_local_files.py [--prefix 前缀] <本地路径1> [本地路径2] ...

路径可以是文件或目录。目录会递归上传其中所有文件，保留相对目录结构。
"""

import sys
import os
import time
import subprocess
import yaml
from qiniu import Auth, put_file
from pathlib import Path

# ============= 全局配置 =============
# 将从 qiniu.yaml 中读取并覆盖以下默认值
REMOTE_PREFIX = "keepwork/cdn/"
BUCKET_NAME = "haqi"
DOMAIN = "https://cdn.keepwork.com"
ACCESS_KEY_REPO_URL = "http://code.kp-para.cn/devops/ai-skill-accesskey.git"
# ===================================


def _normalize_prefix(prefix):
    if not prefix:
        return ''
    return prefix if prefix.endswith('/') else prefix + '/'


def _candidate_config_paths():
    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent.parent.parent
    search_roots = [Path.cwd().resolve(), script_dir, repo_root]
    candidate_paths = []
    seen = set()

    def add_path(path):
        path = path.resolve()
        if path in seen:
            return
        seen.add(path)
        candidate_paths.append(path)

    for root in search_roots:
        add_path(root / 'qiniu.yaml')
        add_path(root / 'deploy_tools' / 'qiniu.yaml')
        add_path(root / 'ai-skill-accesskey' / 'qiniu.yaml')

    ignored_parts = {'.git', 'node_modules', 'dist', '__pycache__', '.venv', 'venv'}
    for root in search_roots:
        if not root.exists() or not root.is_dir():
            continue
        try:
            for path in root.rglob('qiniu.yaml'):
                if any(part in ignored_parts for part in path.parts):
                    continue
                add_path(path)
        except Exception:
            pass

    return candidate_paths


def print_download_instructions():
    """打印和 SKILL.md 一致的 qiniu.yaml 获取方式。"""
    script_dir = Path(__file__).resolve().parent
    print("提示：请按 SKILL.md 下载配置仓库，确保 qiniu.yaml 位于脚本同级目录或其 ai-skill-accesskey 子目录下。")
    print(f"Git 仓库: {ACCESS_KEY_REPO_URL}")
    print("PowerShell 示例:")
    print(f"  Set-Location \"{script_dir}\"")
    print(f"  git clone {ACCESS_KEY_REPO_URL}")
    print("Bash 示例:")
    print("  SKILL_DIR=$(dirname $(find . -name \"SKILL.md\" | grep \"upload-deploy-cdn-files\" | head -n 1))")
    print("  cd \"$SKILL_DIR\"")
    print(f"  git clone {ACCESS_KEY_REPO_URL}")
    print("  cd -")


def try_clone_access_key_repo():
    """缺少 qiniu.yaml 时，自动按 SKILL.md clone 配置仓库。"""
    script_dir = Path(__file__).resolve().parent
    target_dir = script_dir / 'ai-skill-accesskey'
    target_config = target_dir / 'qiniu.yaml'

    if target_config.is_file():
        return True

    if target_dir.exists():
        print(f"⚠️  配置仓库目录已存在但未找到 qiniu.yaml: {target_dir}")
        return False

    print(f"🔑 未找到可用 qiniu.yaml，正在自动 clone 配置仓库到: {target_dir}")
    print("如 Git 要求输入用户名/密码，请直接在终端中输入。")
    try:
        result = subprocess.run(
            ['git', 'clone', ACCESS_KEY_REPO_URL, str(target_dir)],
            cwd=str(script_dir),
            check=False
        )
    except FileNotFoundError:
        print("❌ 未找到 git 命令，无法自动 clone 配置仓库。")
        return False
    except Exception as e:
        print(f"❌ 自动 clone 配置仓库时发生异常: {e}")
        return False

    if result.returncode != 0:
        print(f"❌ 自动 clone 配置仓库失败，退出码: {result.returncode}")
        return False

    if not target_config.is_file():
        print(f"❌ 配置仓库已 clone，但仍未找到 qiniu.yaml: {target_config}")
        return False

    return True


def _load_config_from_paths(config_paths):
    """尝试从候选 qiniu.yaml 路径读取配置。"""
    global REMOTE_PREFIX, BUCKET_NAME, DOMAIN

    for p in config_paths:
        if p.is_file():
            with open(p, 'r', encoding='utf-8') as f:
                cfg = yaml.safe_load(f)

            # 支持嵌套在 qiniu 键下的配置，也兼容旧的扁平配置
            if not isinstance(cfg, dict):
                continue
            qiniu_cfg = cfg.get('qiniu', cfg)
            if not isinstance(qiniu_cfg, dict):
                continue

            ak = qiniu_cfg.get('accessKey', '')
            sk = qiniu_cfg.get('secretKey', '')

            if ak and sk:
                # 更新全局变量
                if qiniu_cfg.get('bucketName'):
                    BUCKET_NAME = qiniu_cfg.get('bucketName')
                if qiniu_cfg.get('publicDomain'):
                    DOMAIN = qiniu_cfg.get('publicDomain').rstrip('/')
                if qiniu_cfg.get('remotePrefix'):
                    REMOTE_PREFIX = _normalize_prefix(qiniu_cfg.get('remotePrefix'))

                return ak, sk

    return None

def load_config():
    """从 qiniu.yaml 读取配置项"""
    config_paths = _candidate_config_paths()
    loaded_config = _load_config_from_paths(config_paths)
    if loaded_config:
        return loaded_config

    if try_clone_access_key_repo():
        config_paths = _candidate_config_paths()
        loaded_config = _load_config_from_paths(config_paths)
        if loaded_config:
            return loaded_config

    print("❌ 找不到 qiniu.yaml 或其中缺少 accessKey / secretKey")
    print("已搜索以下位置:")
    for p in config_paths:
        print(f"  - {p}")
    print_download_instructions()
    sys.exit(2)

def format_size(size):
    if size > 1024 * 1024 * 1024:
        return f"{size/(1024*1024*1024):.2f} GB"
    elif size > 1024 * 1024:
        return f"{size/(1024*1024):.2f} MB"
    elif size > 1024:
        return f"{size/1024:.2f} KB"
    else:
        return f"{size} B"


class ProgressBar:
    """进度条显示"""
    def __init__(self, total_size):
        self.total_size = total_size
        self.start_time = time.time()
        self.last_print_time = 0

    def update(self, progress, total):
        current_time = time.time()
        if current_time - self.last_print_time < 0.5:
            return
        self.last_print_time = current_time
        percent = (progress / total) * 100
        elapsed = current_time - self.start_time
        if elapsed > 0 and progress > 0:
            speed = progress / elapsed
            if speed > 1024 * 1024:
                speed_str = f"{speed/(1024*1024):.2f} MB/s"
            elif speed > 1024:
                speed_str = f"{speed/1024:.2f} KB/s"
            else:
                speed_str = f"{speed:.2f} B/s"
            remaining = (total - progress) / speed
            remaining_str = f"{remaining:.0f}s"
        else:
            speed_str = "..."
            remaining_str = "..."
        bar_length = 40
        filled = int(bar_length * progress // total)
        bar = '█' * filled + '░' * (bar_length - filled)
        print(f"\r  [{bar}] {percent:.1f}% | {format_size(progress)}/{format_size(total)} | {speed_str} | ETA: {remaining_str}", end='', flush=True)

    def finish(self):
        print()


def upload_file(auth, local_path, remote_key):
    """上传单个文件，返回 CDN URL 或 None"""
    if not os.path.isfile(local_path):
        print(f"  ❌ 文件不存在: {local_path}")
        return None

    file_size = os.path.getsize(local_path)
    progress_bar = ProgressBar(file_size)

    def progress_handler(progress, total):
        progress_bar.update(progress, total)

    token = auth.upload_token(BUCKET_NAME, remote_key, 3600)

    if file_size < 10 * 1024 * 1024:
        ret, info = put_file(token, remote_key, local_path, progress_handler=progress_handler)
    else:
        ret, info = put_file(
            token, remote_key, local_path,
            part_size=4 * 1024 * 1024,
            progress_handler=progress_handler,
            version='v2'
        )
    progress_bar.finish()

    if info.status_code == 200:
        cdn_url = f"{DOMAIN}/{remote_key}"
        return cdn_url
    else:
        print(f"  ❌ 上传失败: {info}")
        return None


def collect_files(paths, remote_prefix):
    """
    从命令行参数收集所有待上传文件。
    返回列表 [(local_path, remote_key), ...]
    """
    entries = []
    for p in paths:
        p = os.path.normpath(p)
        if os.path.isfile(p):
            basename = os.path.basename(p)
            remote_key = remote_prefix + basename
            entries.append((p, remote_key))
        elif os.path.isdir(p):
            dir_name = os.path.basename(p.rstrip(os.sep))
            for root, _, files in os.walk(p):
                for f in files:
                    local_path = os.path.join(root, f)
                    rel = os.path.relpath(local_path, p)
                    remote_key = remote_prefix + dir_name + '/' + rel.replace(os.sep, '/')
                    entries.append((local_path, remote_key))
        else:
            print(f"⚠️  路径不存在，已跳过: {p}")
    return entries


def parse_args(argv):
    remote_prefix_override = None
    local_paths = []
    index = 0

    while index < len(argv):
        arg = argv[index]
        if arg == '--prefix':
            if index + 1 >= len(argv):
                print("❌ --prefix 需要一个参数，例如 --prefix sdk/")
                sys.exit(1)
            remote_prefix_override = _normalize_prefix(argv[index + 1])
            index += 2
            continue
        local_paths.append(arg)
        index += 1

    return remote_prefix_override, local_paths


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help', 'help'):
        print(__doc__)
        return

    remote_prefix_override, local_paths = parse_args(sys.argv[1:])
    if not local_paths:
        print("❌ 请至少提供一个本地文件或目录路径。")
        return
    
    # 先加载配置，以确保覆盖全局变量(REMOTE_PREFIX 等)
    ak, sk = load_config()
    auth = Auth(ak, sk)
    remote_prefix = remote_prefix_override or REMOTE_PREFIX
    
    entries = collect_files(local_paths, remote_prefix)

    if not entries:
        print("❌ 没有找到可上传的文件。")
        return

    print("=" * 60)
    print("🚀 七牛云上传工具")
    print(f"🎯 目标桶: {BUCKET_NAME}")
    prefixes = sorted({remote_prefix})
    print(f"📂 远程目录: {', '.join(prefixes)}")
    print(f"📄 共计 {len(entries)} 个文件")
    print("=" * 60)

    success = []
    failed = []

    for i, (local_path, remote_key) in enumerate(entries, 1):
        print(f"\n[{i}/{len(entries)}] {local_path}")
        print(f"  -> {remote_key}  ({format_size(os.path.getsize(local_path))})")
        cdn_url = upload_file(auth, local_path, remote_key)
        if cdn_url:
            success.append((local_path, cdn_url))
            print(f"  ✅ {cdn_url}")
        else:
            failed.append(local_path)

    # ===== 汇总 =====
    print("\n" + "=" * 60)
    print("📊 上传结果汇总")
    print(f"  ✅ 成功: {len(success)} 个")
    if failed:
        print(f"  ❌ 失败: {len(failed)} 个")
    print("=" * 60)

    if success:
        print("\n🔗 CDN 外网链接:")
        cdn_urls_to_refresh = []
        for local_path, cdn_url in success:
            print(f"  {cdn_url}")
            cdn_urls_to_refresh.append(cdn_url)

        print("\n" + "=" * 60)
        print("🔄 正在刷新 CDN 缓存...")
        try:
            from qiniu import CdnManager
            cdn_manager = CdnManager(auth)
            
            # 七牛云限制每次最多刷新 100 个 URL
            urls_chunks = [cdn_urls_to_refresh[i:i + 100] for i in range(0, len(cdn_urls_to_refresh), 100)]
            for chunk in urls_chunks:
                refresh_url_result, refresh_url_info = cdn_manager.refresh_urls(chunk)
                if refresh_url_info.status_code == 200:
                    print(f"  ✅ 成功提交刷新请求 ({len(chunk)} 个 URL)")
                else:
                    print(f"  ❌ 刷新请求失败: {refresh_url_info.text_body}")
        except Exception as e:
            print(f"  ❌ 刷新 CDN 缓存时发生异常: {e}")

    if failed:
        print("\n❌ 上传失败的文件:")
        for f in failed:
            print(f"  {f}")
        sys.exit(1)


if __name__ == "__main__":
    main()
