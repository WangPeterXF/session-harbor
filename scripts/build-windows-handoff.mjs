#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const ALLOWED_TOP_LEVEL = [
  ".agents",
  ".github",
  ".gitignore",
  "CHANGELOG.md",
  "COMMERCIAL-LICENSE.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY.md",
  "docs",
  "examples",
  "package-lock.json",
  "package.json",
  "plugins",
  "schemas",
  "scripts",
  "tests",
];
const EXCLUDED_NAMES = new Set([".DS_Store", "node_modules"]);

export async function buildWindowsHandoff(options = {}) {
  const outputRoot = options.outputRoot ? path.resolve(options.outputRoot) : null;
  if (!outputRoot) throw new Error("Handoff build requires --output <directory>.");
  const packageJson = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
  const createdAt = options.createdAt || new Date().toISOString();
  const handoffId = options.handoffId || `${compactTimestamp(createdAt)}-v${packageJson.version}`;
  const producerDeviceId = options.producerDeviceId || "mac-producer";
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(producerDeviceId)) {
    throw new Error("Producer device ID must match [a-z0-9][a-z0-9-]{2,63}.");
  }
  const producerEvidence =
    options.producerEvidence || `../../results/${producerDeviceId}-delete-restore-result.json`;
  const releaseRoot = path.join(outputRoot, "releases", handoffId);
  const sourceRoot = path.join(releaseRoot, "source");
  const sourceFiles = await collectSourceFiles(REPOSITORY_ROOT);
  const plan = {
    ok: true,
    apply: Boolean(options.apply),
    handoffId,
    outputRoot,
    releaseRoot,
    sourceFileCount: sourceFiles.length,
    projectVersion: packageJson.version,
  };
  if (!options.apply) return plan;

  const partialRoot = `${releaseRoot}.partial`;
  await rm(partialRoot, { recursive: true, force: true });
  await mkdir(path.join(partialRoot, "source"), { recursive: true, mode: 0o700 });
  try {
    const checksumRows = [];
    for (const relativePath of sourceFiles) {
      const source = path.join(REPOSITORY_ROOT, relativePath);
      const destination = path.join(partialRoot, "source", relativePath);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      checksumRows.push({
        path: toPosix(path.join("source", relativePath)),
        sha256: await sha256File(destination),
      });
    }

    const handoffGuidePath = path.join(partialRoot, "WINDOWS_HANDOFF.md");
    const windowsPromptPath = path.join(partialRoot, "WINDOWS_CODEX_PROMPT.zh-CN.txt");
    const resultTemplatePath = path.join(partialRoot, "windows-result-template.json");
    await copyFile(path.join(REPOSITORY_ROOT, "docs", "windows-handoff.md"), handoffGuidePath);
    await writeFile(
      windowsPromptPath,
      renderWindowsCodexPrompt(handoffId, producerDeviceId, producerEvidence),
      {
      encoding: "utf8",
      mode: 0o600,
      },
    );
    await copyFile(
      path.join(REPOSITORY_ROOT, "examples", "windows-handoff-result.example.json"),
      resultTemplatePath,
    );
    checksumRows.push(
      { path: "WINDOWS_HANDOFF.md", sha256: await sha256File(handoffGuidePath) },
      { path: "WINDOWS_CODEX_PROMPT.zh-CN.txt", sha256: await sha256File(windowsPromptPath) },
      { path: "windows-result-template.json", sha256: await sha256File(resultTemplatePath) },
    );
    checksumRows.sort((left, right) => left.path.localeCompare(right.path));
    const checksumsText = checksumRows.map((row) => `${row.sha256}  ${row.path}`).join("\n") + "\n";
    const checksumsPath = path.join(partialRoot, "SHA256SUMS");
    await writeFile(checksumsPath, checksumsText, { encoding: "utf8", mode: 0o600 });
    const handoff = {
      schemaVersion: 1,
      handoffId,
      createdAt,
      status: "ready-for-windows",
      project: {
        name: packageJson.name,
        version: packageJson.version,
        license: packageJson.license,
        sourceState: "source-snapshot",
      },
      source: {
        path: "source",
        fileCount: sourceFiles.length,
        checksumsFile: "SHA256SUMS",
        checksumsSha256: await sha256File(checksumsPath),
      },
      ownership: {
        producerDeviceId,
        windowsMustUseUniqueDeviceId: true,
        windowsMayWritePeerTree: false,
      },
      producerEvidence,
      resultTarget: "../../results/windows-<device-id>-result.json",
      instructions: "Read WINDOWS_HANDOFF.md before copying source or running tests.",
    };
    await writeFile(path.join(partialRoot, "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await mkdir(path.dirname(releaseRoot), { recursive: true, mode: 0o700 });
    try {
      await stat(releaseRoot);
      throw new Error(`Handoff release already exists: ${releaseRoot}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await removeAppleDoubleFiles(partialRoot);
    await rename(partialRoot, releaseRoot);
    await mkdir(path.join(outputRoot, "results"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(outputRoot, "START_HERE.txt"),
      [
        "SessionHarbor Windows handoff",
        "",
        "1. Read LATEST.json and open its releasePath.",
        "2. Paste WINDOWS_CODEX_PROMPT.zh-CN.txt into a new Windows Codex task.",
        "3. Verify SHA256SUMS from inside that release directory.",
        "4. Copy source/ to a local NTFS development directory.",
        "5. Read the producer pilot evidence under results/; do not edit it.",
        "6. Write Windows results only under this handoff root's results/ directory.",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    const latest = {
      schemaVersion: 1,
      handoffId,
      releasePath: toPosix(path.join("releases", handoffId)),
      handoffSha256: await sha256File(path.join(releaseRoot, "handoff.json")),
      publishedAt: new Date().toISOString(),
    };
    const latestTemporary = path.join(outputRoot, `LATEST.json.tmp-${handoffId}`);
    await writeFile(latestTemporary, `${JSON.stringify(latest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(latestTemporary, path.join(outputRoot, "LATEST.json"));
    await removeAppleDoubleFiles(outputRoot, { recursive: false });
    return { ...plan, apply: true, checksumsSha256: handoff.source.checksumsSha256 };
  } catch (error) {
    await rm(partialRoot, { recursive: true, force: true });
    throw error;
  }
}

function renderWindowsCodexPrompt(handoffId, producerDeviceId, producerEvidence) {
  return [
    "请接管 SessionHarbor 的 Windows 部署与物理移动硬盘测试。持续推进到通过或出现有证据的安全阻塞，不要只给计划。",
    "",
    `本次不可变交接版本：${handoffId}`,
    "",
    "1. 在已连接卷中定位 SessionHarbor-Handoff/START_HERE.txt，读取 LATEST.json；只接受 LATEST 指向的上述 handoffId。",
    `2. 阅读该 release 下的 WINDOWS_HANDOFF.md、handoff.json、SHA256SUMS，以及 handoff.json 引用的生产端证据 ${producerEvidence}。生产端结果只读。`,
    "3. 在 release 目录核验 SHA256SUMS。若任一文件不匹配，立即停止并记录 exact blocker。",
    "4. 将 source/ 完整复制到本机 NTFS 开发目录；不要直接在移动硬盘的 exFAT 副本上开发或安装。",
    "5. 在本机副本运行 npm ci --ignore-scripts、npm run check、npm test，并执行可用的 plugin/skill validator。保留准确通过数和错误文本。",
    "6. 从本机副本的本地 marketplace 安装 session-harbor；使用新的 Windows Codex 任务确认插件已加载。",
    "7. 所有写入测试先使用合成 %USERPROFILE%\\.codex 和临时目的地。验证备份、dashboard、cleanup safety gate、restore SHA-256、Windows Task Scheduler 渲染与 missing-drive no-op。",
    `8. 再检查真实移动硬盘盘符、文件系统、剩余空间和 destination marker；Windows 必须使用唯一 device ID（例如 win-<computer-name>），绝不能写 devices/${producerDeviceId}/**。`,
    "9. 对 Windows 本机全部 Codex 会话执行增量备份并核验；只读验证 Mac peer 的发现和导出。未经用户另行明确授权，不删除任何真实 Windows 会话，也不使用 --finalize 制造保留策略通过。",
    "10. 按 windows-result-template.json 把准确结果写到 SessionHarbor-Handoff/results/windows-<device-id>-result.json。不得修改 LATEST、旧 release、生产端结果或生产端 writer tree。",
    "",
    "成功必须有：校验和、Node/Codex/Windows/文件系统版本、测试数、插件版本、设备标识、备份与 dashboard 计数、peer 只读证据、restore 字节/哈希相等、调度器证据。无法完成时写 status=blocked 和精确阻塞原因。",
    "",
  ].join("\n");
}

async function removeAppleDoubleFiles(directory, options = {}) {
  const recursive = options.recursive !== false;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.name.startsWith("._")) {
      await rm(absolute, { recursive: true, force: true });
    } else if (recursive && entry.isDirectory()) {
      await removeAppleDoubleFiles(absolute);
    }
  }
}

async function collectSourceFiles(repositoryRoot) {
  const files = [];
  for (const name of ALLOWED_TOP_LEVEL) {
    const candidate = path.join(repositoryRoot, name);
    try {
      const info = await stat(candidate);
      if (info.isFile()) files.push(name);
      else if (info.isDirectory()) await walk(candidate, name, files);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files.sort();
}

async function walk(directory, relativeDirectory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (EXCLUDED_NAMES.has(entry.name) || entry.name.startsWith("._")) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) await walk(absolute, relative, files);
    else if (entry.isFile() && !entry.name.endsWith(".tgz")) files.push(relative);
  }
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function compactTimestamp(value) {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") options.apply = true;
    else if (token === "--output") options.outputRoot = argv[++index];
    else if (token === "--handoff-id") options.handoffId = argv[++index];
    else if (token === "--producer-device-id") options.producerDeviceId = argv[++index];
    else if (token === "--producer-evidence") options.producerEvidence = argv[++index];
    else throw new Error(`Unknown option: ${token}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildWindowsHandoff(parseOptions(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
