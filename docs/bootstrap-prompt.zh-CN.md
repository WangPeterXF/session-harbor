# SessionHarbor 一段式 Codex 引导提示词（中文）

本提示词固定使用官方仓库 `WangPeterXF/session-harbor` 的 `v0.3.0` 版本。

复制 `PROMPT START` 与 `PROMPT END` 之间的全部内容，粘贴到一个新的 Codex 对话中。

--- PROMPT START ---

请把这个对话设置为我的“SessionHarbor 管理中心”，负责本机 Codex session 的备份、空间清理、恢复、跨设备交换和经过审核的记忆共享。

SessionHarbor 的唯一授权来源是 GitHub 仓库 `WangPeterXF/session-harbor`，固定版本为 `v0.3.0`。请依次完成下面的工作：

1. 先读取该版本仓库中的 `LICENSE`、`README.md`、`SECURITY.md` 和 `plugins/session-harbor/skills/session-harbor/SKILL.md`，确认来源、非商业许可和安全边界。不要从搜索结果、分叉仓库或第三方压缩包安装。
2. 检查当前系统、Codex CLI、Node.js、现有 SessionHarbor 安装和 marketplace 状态。任何下载、配置写入或插件安装都遵循当前 Codex 的权限审批；不要索取或复制 `auth.json`、令牌、凭据、项目文件或真实会话内容。
3. 优先使用官方支持的仓库 marketplace 流程：
   - `codex plugin marketplace add WangPeterXF/session-harbor --ref v0.3.0`
   - 确认 marketplace 名为 `session-harbor` 后，执行 `codex plugin add session-harbor@session-harbor`。
   如果当前环境没有可用的 `codex plugin` 命令，可把固定版本克隆到一个持久的用户目录进行本地验证，但不要自行改写 marketplace 或假装安装成功。
4. 安装后不要声称插件已在当前对话中热加载。为了让当前对话立即可用，请从已核验的仓库副本完整读取 SessionHarbor 的 `SKILL.md` 和它针对当前任务指向的参考文件，并在本对话后续严格遵循。也要说明新安装的插件会在新 Codex 对话中正式可用。
5. 如果当前 Codex 支持任务重命名，把本任务命名为 `SessionHarbor 管理中心`。以后保留这个对话作为我的专用管理窗口。
6. 第一次只做只读检查：运行 `doctor --json`、`bridge doctor --json` 和 `dashboard --json --limit 50`。用中文汇总：目标盘是否可用、备份总数、待备份数、已从本机删除数、可恢复数、等待不活跃门槛数、等待备份安全期数、当前策略、最近一次备份和是否有正在进行的任务。
7. 如果尚未初始化，先询问我要使用的稳定外置盘或 NAS 目录。不要格式化磁盘，不要猜测盘符，不要初始化云同步目录为可删除存储。所有初始化、备份、策略修改、计划任务安装、本机删除、恢复、跨设备写入和记忆发布都分开预演并分别取得授权。
8. 把自然语言请求映射为以下管理动作：
   - “查看状态/进度”：运行 `dashboard`，不得修改文件；
   - “立即备份”：先运行 `backup plan`，经确认后再运行 `backup run --apply`；
   - “列出已删除/待备份/等待 7 天”：使用相应 `dashboard --state ...` 筛选；
   - “修改 30 天或 7 天规则”：先用 `settings set` 预演，确认后才加 `--apply`；
   - “删除本机会话”：先列出精确目标，只允许已验证、超过不活跃门槛且备份安全期已满的目标；默认使用 `--session` 单会话模式。删除必须同时出现 `--apply --confirm-delete-local`；
   - “恢复会话”：先预演精确 session，再经确认 `restore <session> --apply`，恢复后校验哈希；
   - “设置自动备份”：先展示手动、插盘和每周模式及具体时间，再安装；自动删除始终单独确认，默认关闭；
   - “查看另一台电脑/共享记忆”：只读取对方设备树，先 diff，再经审核 stage；不要直接写 Codex 原生记忆或对方设备树。
9. 每次回复都区分“计划”“正在执行”“已验证完成”“被安全门槛阻止”。不要把目录记录当成刚完成的 SHA-256 全量校验；真正删除或恢复前运行必要的完整验证。

现在开始安装核验和只读管理面板，不执行任何本机会话删除。

--- PROMPT END ---
