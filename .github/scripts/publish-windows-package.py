"""Publish one verified Windows-only fork build, without rebuilding its bytes."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import urlencode
import zipfile

REPO = "chiyugui001/webcodex"
SOURCE = "b2452458745daec7b6d870d30d13803c71b6988f"
PRODUCER = "8adc084147f08b5295ff76b4a633ec46eddbfef1"
RUN = 38953132318
ARTIFACT = 12069574599
ARCHIVE_SHA = "e39484ab1dd6b02a90aa4a17edf4c91f850c543ba8d17a66c3bd2045476cc2c4"
TAG = "windows-b2452458"
ORIGINAL = "webcodex-desktop-local-b2452458745d-v0.4.1-win32-x64-setup.exe"
ASSET = "webcodex-desktop-v0.4.1-b2452458-win32-x64-setup.exe"
MARKER = f"<!-- windows-source:{SOURCE}; producer-run:{RUN} -->"


def api(path, *, method="GET", payload=None, input_file=None, allow_missing=False):
    args = ["gh", "api", "--method", method, "-H", "Accept: application/vnd.github+json", path]
    stdin = None
    if payload is not None:
        args += ["--input", "-"]
        stdin = json.dumps(payload).encode()
    if input_file is not None:
        args += ["-H", "Content-Type: application/octet-stream", "--input", str(input_file)]
    result = subprocess.run(args, input=stdin, capture_output=True, timeout=180)
    if result.returncode:
        status = re.search(rb"HTTP (\d{3})", result.stderr)
        if allow_missing and status and status[1] == b"404":
            return None
        code = status[1].decode() if status else "unknown"
        raise RuntimeError(f"GitHub {method} {path.split('?')[0]} failed (HTTP {code})")
    return json.loads(result.stdout) if result.stdout else None


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    require(os.environ.get("GITHUB_REPOSITORY") == REPO, "Unexpected publication repository")
    require(bool(os.environ.get("GH_TOKEN")), "GitHub job credential is unavailable")
    run = api(f"repos/{REPO}/actions/runs/{RUN}")
    require(run["status"] == "completed" and run["conclusion"] == "success", "Producer did not succeed")
    require(run["head_sha"] == PRODUCER, "Producer workflow commit differs")
    require(run["path"] == ".github/workflows/windows-package.yml", "Unexpected producer workflow")
    artifact = api(f"repos/{REPO}/actions/artifacts/{ARTIFACT}")
    require(artifact["name"] == "webcodex-windows-x64-b2452458745d", "Unexpected artifact name")
    require(not artifact["expired"] and artifact["workflow_run"]["id"] == RUN, "Wrong or expired artifact")
    require(artifact["workflow_run"]["head_sha"] == PRODUCER, "Artifact source differs")
    require(artifact["digest"] == f"sha256:{ARCHIVE_SHA}", "Artifact service digest differs")
    require(0 < artifact["size_in_bytes"] < 100 * 1024 * 1024, "Artifact exceeds download bound")

    with tempfile.TemporaryDirectory(prefix="webcodex-windows-release-") as temp:
        work = Path(temp)
        archive = work / "retained.zip"
        with archive.open("wb") as output:
            result = subprocess.run(
                ["gh", "api", f"repos/{REPO}/actions/artifacts/{ARTIFACT}/zip"],
                stdout=output, stderr=subprocess.PIPE, timeout=180,
            )
        require(result.returncode == 0, "Retained artifact download failed")
        require(digest(archive) == ARCHIVE_SHA, "Downloaded artifact checksum differs")
        with zipfile.ZipFile(archive) as bundle:
            entries = bundle.infolist()
            expected = {ORIGINAL, ORIGINAL + ".sha256"}
            require(len(entries) == 2 and {entry.filename for entry in entries} == expected, "Unexpected ZIP membership")
            for entry in entries:
                require(not entry.is_dir() and entry.file_size < 75 * 1024 * 1024, "ZIP entry exceeds bound")
                require((entry.external_attr >> 16) & 0o170000 != 0o120000, "ZIP symlink is not allowed")
            original = bundle.read(ORIGINAL)
            sidecar = bundle.read(ORIGINAL + ".sha256").decode("ascii").strip()
        checksum = hashlib.sha256(original).hexdigest()
        require(re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?" + re.escape(ORIGINAL), sidecar) is not None,
                "Malformed installer checksum sidecar")
        require(sidecar.split()[0].lower() == checksum, "Installer checksum differs")
        require(original[:2] == b"MZ", "Installer is not a Windows executable")
        installer = work / ASSET
        installer.write_bytes(original)
        sums = work / "SHA256SUMS"
        sums.write_text(f"{checksum}  {ASSET}\n", encoding="ascii")
        files = {path.name: path for path in [installer, sums]}
        expected_assets = {name: (path.stat().st_size, digest(path)) for name, path in files.items()}
        print(f"Verified retained installer: source={SOURCE}, sha256={checksum}", flush=True)

        release = api(f"repos/{REPO}/releases/tags/{TAG}", allow_missing=True)
        if release is None:
            releases = api(f"repos/{REPO}/releases?per_page=100")
            matches = [item for item in releases if item["tag_name"] == TAG]
            require(len(matches) <= 1, "Ambiguous existing release")
            release = matches[0] if matches else None
        if release is not None:
            require(MARKER in (release.get("body") or "") and release["prerelease"], "Refusing unrelated existing release")

        ref = api(f"repos/{REPO}/git/ref/tags/{TAG}", allow_missing=True)
        if ref is not None:
            obj = ref["object"]
            if obj["type"] == "tag":
                obj = api(f"repos/{REPO}/git/tags/{obj['sha']}")["object"]
            require(obj["type"] == "commit" and obj["sha"] == SOURCE, "Existing tag targets different source")
        else:
            tag = api(f"repos/{REPO}/git/tags", method="POST", payload={
                "tag": TAG, "message": f"Windows x64 modified build from {SOURCE}; producer run {RUN}",
                "object": SOURCE, "type": "commit",
            })
            api(f"repos/{REPO}/git/refs", method="POST", payload={"ref": f"refs/tags/{TAG}", "sha": tag["sha"]})

        notes = f"""## Windows x64 修改版

本预发布供此分支修改版的 Windows 安装和测试使用，源码内应用版本为 0.4.1。

- 源码提交：[`{SOURCE[:8]}`](https://github.com/{REPO}/commit/{SOURCE})。
- 修改：展开活动详情，修复 Windows 项目重复显示。
- 验证：桌面前端测试、Windows x64 构建、原生安装与卸载、内置运行时版本检查通过。
- 文件复用自[构建 #{RUN}](https://github.com/{REPO}/actions/runs/{RUN})；归档 SHA-256 和安装包 SHA-256 均已核对。

下载下方 `.exe` 安装；`SHA256SUMS` 提供安装包校验值。

此处仅分发此 Windows 修改版，不代表上游跨平台正式版本发布。

{MARKER}
"""
        if release is None:
            release = api(f"repos/{REPO}/releases", method="POST", payload={
                "tag_name": TAG, "target_commitish": SOURCE, "name": "Windows x64 修改版（b2452458）",
                "body": notes, "draft": True, "prerelease": True, "make_latest": "false",
            })
        require(MARKER in (release.get("body") or "") and release["prerelease"], "Refusing unrelated existing release")
        release_id = release["id"]
        assets = {item["name"]: item for item in api(f"repos/{REPO}/releases/{release_id}/assets?per_page=100")}
        require(set(assets) <= set(files), "Existing release contains unexpected assets")
        for name, path in files.items():
            if name not in assets:
                require(release["draft"], "Refusing to change an already published release")
                upload = release["upload_url"].split("{", 1)[0] + "?" + urlencode({"name": name})
                api(upload, method="POST", input_file=path)

        deadline = time.monotonic() + 60
        while True:
            assets = {item["name"]: item for item in api(f"repos/{REPO}/releases/{release_id}/assets?per_page=100")}
            require(set(assets) == set(files), "Release asset membership differs")
            if all(item.get("digest") for item in assets.values()):
                break
            require(time.monotonic() < deadline, "Release asset digests did not become available")
            time.sleep(min(2, max(0, deadline - time.monotonic())))
        for name, (size, sha) in expected_assets.items():
            item = assets[name]
            require(item["state"] == "uploaded" and item["size"] == size and item["digest"] == f"sha256:{sha}",
                    f"Release asset size or digest differs: {name}")
        print("Draft asset verification passed", flush=True)
        if release["draft"]:
            release = api(f"repos/{REPO}/releases/{release_id}", method="PATCH", payload={
                "draft": False, "prerelease": True, "make_latest": "false",
            })
        require(not release["draft"] and release["prerelease"], "Release was not published as a prerelease")
        public_assets = api(f"repos/{REPO}/releases/{release_id}/assets?per_page=100")
        require({item["name"] for item in public_assets} == set(files), "Published release asset membership differs")
        for item in public_assets:
            size, sha = expected_assets[item["name"]]
            require(item["size"] == size and item["digest"] == f"sha256:{sha}", "Published asset integrity differs")
        print(f"Published release: {release['html_url']}", flush=True)
        for item in public_assets:
            print(f"Published asset: {item['browser_download_url']}", flush=True)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with Path(summary).open("a") as output:
                output.write(f"## Windows x64 修改版已发布\n\n[Releases 下载页面]({release['html_url']})\n\n")
                output.write(f"源码：`{SOURCE}`\n\n安装包 SHA-256：`{checksum}`\n")


if __name__ == "__main__":
    main()
