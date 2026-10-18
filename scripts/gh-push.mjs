/**
 * 通过 GitHub REST API 推送 commit + tag。
 *
 *   node scripts/gh-push.mjs <tagName>
 *
 * 为什么存在：本机 git 的全局代理指向 127.0.0.1:33210（用户的梯子），
 * 梯子断开时 `git push` 必然失败，但 `gh api` 走另一条路仍然通。
 * 于是出现「Release 建好了、代码没推上去」的空洞。
 *
 * 做法：对 HEAD 相对 origin/master 的每个 commit，逐个建 blob → tree → commit
 * → 更新 ref。只支持线性历史（本仓库一直如此）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const OWNER_REPO = "Alanine-gH/dsh-huaweicloud-connect";
const tagName = process.argv[2];

if (tagName === undefined) {
  console.error("用法: node scripts/gh-push.mjs <tagName>");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** 调 GitHub API。body 一律走 --input 文件（小字段也会被 shell/gh 转义搞坏）。 */
const api = (path, fields) => {
  const file = `${tmpdir()}/gh-push-${Math.random().toString(36).slice(2)}.json`;
  writeFileSync(file, JSON.stringify(fields), "utf8");
  try {
    return execFileSync("gh", ["api", `${OWNER_REPO}/${path}`, "--input", file, "--jq", "."], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } finally {
    unlinkSync(file);
  }
};

// 1. 找出待推送的 commit（本地有、远程没有的）
const head = git("rev-parse", "HEAD");
let remoteMaster = null;
try {
  const ref = JSON.parse(
    execFileSync("gh", ["api", `${OWNER_REPO}/git/refs/heads/master`, "--jq", "."], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  remoteMaster = ref.object?.sha ?? null;
} catch {
  /* 仓库还没有 master：从头推 */
}
console.log(`本地 HEAD:   ${head.slice(0, 8)}`);
console.log(`远程 master: ${remoteMaster?.slice(0, 8) ?? "无"}`);

// 从本地找到与远程 master 相连的那个点，取它之后的所有 commit
let commits;
try {
  commits = git("rev-list", "--reverse", remoteMaster ? `${remoteMaster}..${head}` : head).split("\n").filter(Boolean);
} catch {
  // 远程 master 与本地历史不关联（极少见）：只推本地 HEAD 那一个
  commits = [head];
}
console.log(`待推送 ${commits.length} 个 commit`);

// 2. 逐个推
let parent = remoteMaster;
for (const sha of commits) {
  const message = git("log", "-1", "--pretty=%B", sha);
  const treeSha = git("rev-parse", `${sha}^{tree}`);
  // 相对上一个 commit 取差异；第一个 commit 相对根
  let changed;
  try {
    const base = git("rev-parse", `${sha}^`);
    changed = git("diff", "--name-only", `${base}..${sha}`).split("\n").filter(Boolean);
  } catch {
    // 根 commit 没有父节点：列出它的全部文件
    changed = git("ls-tree", "-r", "--name-only", sha).split("\n").filter(Boolean);
  }
  if (changed.length === 0) {
    // 空 commit（例如纯合并）：直接按原样建一个
    const commit = JSON.parse(
      api("git/commits", { message, tree: treeSha, ...(parent ? { parents: parent } : {}) }),
    );
    api("git/refs/heads/master", { sha: commit.sha, force: false });
    parent = commit.sha;
    continue;
  }

  const entries = changed.map((path) => {
    const content = readFileSync(path).toString("base64");
    // blob 的 content 是 base64（几十 KB），必须走 --input 文件：
    // `-f content=...` 会被 gh 拒绝（实测 404 / ENAMETOOLONG）
    const blob = JSON.parse(api("git/blobs", { content, encoding: "base64" }));
    return { path, mode: "100644", type: "blob", sha: blob.sha };
  });

  const tree = JSON.parse(
    api("git/trees", {
      ...(parent ? { base_tree: git("rev-parse", `${parent}^{tree}`) } : {}),
      tree: JSON.stringify(entries),
    }),
  );
  const commit = JSON.parse(
    api("git/commits", { message, tree: tree.sha, ...(parent ? { parents: parent } : {}) }),
  );
  api("git/refs/heads/master", { sha: commit.sha, force: false });
  console.log(`  ✓ ${commit.sha.slice(0, 8)} ${message.split("\n")[0].slice(0, 60)}`);
  parent = commit.sha;
}

// 3. 打 tag（附注 tag，指向本地 HEAD）
if (parent !== null) {
  const message = git("log", "-1", "--pretty=%B", head);
  const tagObj = JSON.parse(api("git/tags", { tag: tagName, message: message.trim(), object: head, type: "commit" }));
  api("git/refs", { ref: `refs/tags/${tagName}`, sha: tagObj.sha });
  console.log(`  ✓ tag ${tagName} → ${head.slice(0, 8)}`);
}

console.log("\n完成");
