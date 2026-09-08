# -*- coding: utf-8 -*-
"""当 github.com:443 被间歇性阻断时，通过 api.github.com Git Data REST API 推送分支。
做法：blobs → tree（基于 main 的 base_tree）→ commit → 创建/更新 ref。
远端 commit SHA 会与本地不同（committer 时间戳差异），网络恢复后 git fetch + reset 即可对齐。
"""
import base64
import subprocess
import sys
import requests

REPO = "Lyjlyj0724-byte/tech-center-pms"
API = f"https://api.github.com/repos/{REPO}/git"
BRANCH = "feature/ci-test-pipeline"
COMMIT_MSG = "ci: 接入 CI 门禁与本地工程化（eslint + vitest + husky/lint-staged + README badge）"

token = subprocess.run(
    [r"C:\Program Files\GitHub CLI\gh.exe", "auth", "token"],
    capture_output=True, text=True, check=True,
).stdout.strip()
H = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}

def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True,
                          encoding="utf-8").stdout.strip()

# 1. main 的 commit 与 base tree
r = requests.get(f"{API}/refs/heads/main", headers=H); r.raise_for_status()
main_sha = r.json()["object"]["sha"]
r = requests.get(f"{API}/commits/{main_sha}", headers=H); r.raise_for_status()
base_tree = r.json()["tree"]["sha"]
print("main:", main_sha, "base_tree:", base_tree)

# 2. 相对 origin/main 的变更文件
changed = git("diff", "--name-status", "origin/main", "HEAD").splitlines()
tree_entries = []
for line in changed:
    status, path = line.split("\t", 1)
    if status.startswith("D"):
        tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
        continue
    with open(path, "rb") as f:
        content = base64.b64encode(f.read()).decode()
    r = requests.post(f"{API}/blobs", headers=H,
                      json={"content": content, "encoding": "base64"})
    r.raise_for_status()
    mode = "100755" if path == ".husky/pre-commit" else "100644"
    tree_entries.append({"path": path, "mode": mode, "type": "blob", "sha": r.json()["sha"]})
    print("blob:", path, r.json()["sha"][:8])

# 3. tree → commit → ref
r = requests.post(f"{API}/trees", headers=H,
                  json={"base_tree": base_tree, "tree": tree_entries})
r.raise_for_status()
tree_sha = r.json()["sha"]
r = requests.post(f"{API}/commits", headers=H,
                  json={"message": COMMIT_MSG, "tree": tree_sha, "parents": [main_sha]})
r.raise_for_status()
commit_sha = r.json()["sha"]
r = requests.post(f"{API}/refs", headers=H,
                  json={"ref": f"refs/heads/{BRANCH}", "sha": commit_sha})
if r.status_code == 422:  # 已存在则更新
    r = requests.patch(f"{API}/refs/heads/{BRANCH}", headers=H, json={"sha": commit_sha})
r.raise_for_status()
print(f"pushed {BRANCH}: {commit_sha} (tree {tree_sha})")
print("local tree:", git("rev-parse", "HEAD^{tree}"))
