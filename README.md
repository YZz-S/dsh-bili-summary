# bili-summary

[English](#english) · [中文](#中文)

> DeepSeek Harness Host plugin: registers the model tool `bili_summary` — a single call fetches a Bilibili video's metadata, subtitle timeline and optional image material (sharp frame extraction), letting the Agent produce structured summary notes with time-stamped jump links.
>
> DeepSeek Harness Host 插件：注册模型工具 `bili_summary`，一次调用取回 B 站视频的元数据、字幕时间轴与可选配图素材（sharp 切帧），供 Agent 生成带时间点跳转链接的结构化总结笔记。

## English

[中文](#中文) · [← Back to DeepSeekHarnessPlugins](../README.md)

### Features

- **One tool for the whole flow**: the `video` input accepts BV IDs, `bilibili.com/video/` links and `b23.tv` short links (redirect auto-resolved)
- **Subtitles first**: AI/human subtitle timeline → SRT cache; when subtitles are too long, writes a file and inlines only an excerpt — the model reads the rest with `read` in segments
- **Optional images** (only when the user explicitly asks for "with images"): cover + one representative frame per chapter, extracted by sharp from the player snapshot API, stored locally, referenced by relative paths
- **Error handling is code behavior**: Bilibili error-code mapping (-404/-412/-352/62002…), timeouts, exponential-backoff retries, automatic risk-control retries; business failures return structured JSON instead of throwing
- **Progressive degradation**: subtitles → "no subtitle" note; frame extraction → cover only → plain text — every degradation reason is returned to the model
- **Cross-platform**: pure Node (≥ 20.9), no shell calls, no encoding pitfalls; file-name sanitization handles Windows illegal characters and reserved names
- **Multi-part videos**: the `page` parameter switches parts, each part has its own cid; out-of-range returns the total part count

### Installation (dsh.bundle)

This repo is also an installable dsh plugin package (`package.json` declares `dsh.bundle`, `cordis.patch.yml` declares the insertion row):

```sh
dsh plugin --profile web add github:YZz-S/dsh-bili-summary
```

After installation, start with `dsh --profile web` and the `bili_summary` tool mounts automatically; headless users switch the profile to `headless`. Notes:

- `dsh plugin` forwards to pnpm internally (pnpm must be installed first); the profile is initialized automatically on first run;
- If pnpm asks to approve build scripts, approving **sharp** enables frame extraction; you can also install without it — the plugin automatically degrades to "cover-only images";
- Row-level config (outputDir / cookie etc.) is overridden in the profile's own `cordis.patch.yml` under the row id `bili-summary`.

### Installation (agent preset row)

1. Prepare your own DSH agent preset (user presets live in `${DSH_HOME}/.agent-presets/<id>/`, composition file `agent.cordis.yml`).
2. Put `bili-summary.js` into the preset directory and add a row to the composition:

```yaml
- id: tool-bili-summary
  name: ./bili-summary.js
  config:
    outputDir: bili-output
```

(A full example is in `examples/cordis.row.yml`; this row only registers the tool in the host `tools` registry and publishes no services, so **no isolate realm is needed**.)

3. **sharp (optional)**: run `npm install` inside the plugin directory tree. It works without it — automatically degrading to "cover-only images" and stating so in the result.
4. Validate the mount with `standingKeyFor(<preset-id>)`, then open a new session and confirm `bili_summary` appears in the tool list.

### Tool Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `video` | string (required) | Bilibili link (`b23.tv` short link, `bilibili.com/video/` link) or BV ID |
| `withImages` | boolean | Default `false` (plain text); pass `true` only when the user explicitly asks for "with images" |
| `page` | number | Part number of multi-part videos (default 1) |
| `maxFrames` | number | Max frames to extract in image mode (1–48, default 12) |
| `refresh` | boolean | Re-fetch ignoring the disk cache (default false) |

### Configuration (inline `config`)

| Field | Default | Description |
| --- | --- | --- |
| `outputDir` | `bili-output` | Output root: `images/<safe-title>_<bvid>/`, `cache/<bvid>/` (meta.json / subtitle.json / subtitle.srt) |
| `cookie` | empty | `SESSDATA=...; bili_jct=...`. Use when risk control (-412) or login (-352) triggers; **used only in request headers, never written to logs or results** |
| `userAgent` | built-in browser UA | Overrides the default UA |
| `timeoutMs` | 15000 | Per-HTTP timeout |
| `retries` | 2 | Retry count for network failures / 5xx / risk control (exponential backoff) |
| `maxFrames` | 12 | Max frames in image mode |
| `chapterIntervalSec` | 180 | Chapter granularity (snaps to the nearest subtitle start when subtitles exist) |
| `inlineSubtitleLimit` | 10000 | Max characters of inlined subtitles returned |

### Known Limitations

- Anime/movies (`redirect_url`), live streams and interactive videos are explicitly unsupported (structured error instead of blind attempts)
- Subtitles go through the legacy `view`/`player/v2` endpoints without WBI signing; if Bilibili tightens this, subtitles degrade to "no subtitle" with an explanation
- videoshot is a Bilibili **unofficial** interface and may change; some videos have no snapshot data
- The plugin writes `outputDir` with process-level Node fs (bypassing the session file sandbox) — treat the preset mounting it as trusted
- Why not the cordis_define dynamic plugin form: the dynamic Host sandbox has no fetch/require/sharp, and this deployment's `web` service has no fetch provider

### Tests

```bash
npm test        # or node test/sanity.mjs
```

No network or dependencies required. Covers input parsing, **sprite-frame extraction math regression (multi-sprite Y-coordinate bug)**, file-name sanitization, SRT formatting, frame-selection dedup and chapter snapping.

### Security (dependencies)

- **sharp version requirement**: ≥ 0.35.3 (bundled libvips 8.18.3). sharp < 0.35.0 ships a libvips with CVE-2026-33327 / CVE-2026-33328 / CVE-2026-35590 / CVE-2026-35591 (triggerable by maliciously crafted images; two of them are HIGH on the CVSSv4 scale). This plugin only decodes Bilibili CDN covers and snapshot images, so the real exposure is limited — but upgrading is side-effect-free, so always stay current.
- **Node requirement**: sharp 0.35+ requires Node ≥ 20.9.0; this package's `engines` is in sync.
- **Optional hardening** (standalone usage): to shrink the decode surface further, restrict decoders at plugin init:

  ```js
  sharp.block({ operation: ['VipsForeignLoadNsgif', 'VipsForeignLoadTiff', 'VipsForeignLoadVips'] })
  ```

  Note `sharp.block` is a **process-wide global**: if the process is shared with other programs that handle GIF/TIFF (e.g. other plugins inside the dsh harness), do not enable it, to avoid affecting them.

### Compliance & Disclaimer

Depends on Bilibili unofficial interfaces; for personal study and note-taking only. Please follow Bilibili's user agreement, control request frequency, and do not use for commercial scraping; screenshots and subtitles are for personal use only; summaries should be general content rather than large verbatim copies.

### GitHub About

**Description**: `DeepSeek Harness Host plugin: bili_summary tool — Bilibili video metadata, subtitle timeline and sharp frame extraction, with built-in error handling and degradation, cross-platform pure Node implementation`

**Topics**: `bilibili` `bilibili-api` `deepseek-harness` `cordis` `ai-agents` `llm-tools` `video-summary` `subtitle` `sharp` `markdown` `nodejs`

### License

MIT (see `LICENSE`).

---

## 中文

[English](#english) · [← 返回 DeepSeekHarnessPlugins](../README.md)

> DeepSeek Harness Host 插件：注册模型工具 `bili_summary`，一次调用取回 B 站视频的元数据、字幕时间轴与可选配图素材（sharp 切帧），供 Agent 生成带时间点跳转链接的结构化总结笔记。

### 特性

- **一个工具走完全流程**：`video` 输入支持 BV 号、`bilibili.com/video/` 链接与 `b23.tv` 短链（自动解析跳转）
- **字幕优先**：AI 字幕/人工字幕时间轴 → SRT 缓存；字幕过长时写文件并只内联返回摘录，模型用 `read` 分段阅读
- **可选配图**（仅当用户明确要求"带图"）：封面 + 每章代表帧，sharp 从播放器快照接口切出，本地存储、相对路径引用
- **错误处理是代码行为**：B 站错误码映射（-404/-412/-352/62002…）、超时、指数退避重试、风控自动重试，业务失败返回结构化 JSON 不抛异常
- **逐级降级**：字幕 → 无字幕说明；切帧 → 仅封面 → 纯文字，每级失败原因都返回给模型
- **跨平台**：纯 Node 实现（≥20.9），无 shell 调用、无编码坑；文件名清洗兼容 Windows 非法字符与保留名
- **多P视频**：`page` 参数切换分P，每 P 独立 cid；越界给出总 P 数

### 安装（dsh.bundle）

本仓库同时是可安装的 dsh 插件包（`package.json` 声明 `dsh.bundle`，`cordis.patch.yml` 声明插入行）：

```sh
dsh plugin --profile web add github:YZz-S/dsh-bili-summary
```

安装后以 `dsh --profile web` 启动即自动挂载 `bili_summary` 工具；headless 用户把 profile 换成 `headless`。注意：

- `dsh plugin` 内部转发给 pnpm（需先装 pnpm），首次会自动初始化 profile；
- 若 pnpm 提示批准构建脚本，批准 **sharp** 可获得切帧能力；不批准也能安装，插件自动降级为"仅封面配图"；
- 行级配置（outputDir / cookie 等）在 profile 自己的 `cordis.patch.yml` 中按行 id `bili-summary` 覆盖。

### 安装（agent preset 行）

1. 准备一个自己的 DSH agent preset（用户 preset 位于 `${DSH_HOME}/.agent-presets/<id>/`，组合文件 `agent.cordis.yml`）。
2. 把 `bili-summary.js` 放进 preset 目录，在组合里加一行：

```yaml
- id: tool-bili-summary
  name: ./bili-summary.js
  config:
    outputDir: bili-output
```

（完整示例见 `examples/cordis.row.yml`；该行只向宿主 `tools` 注册表注册工具、不发布服务，**不需要 isolate realm**。）

3. **sharp（可选）**：在插件目录树内执行 `npm install`。不装也能用——自动降级为"仅封面配图"并在结果里说明。
4. 用 `standingKeyFor(<preset-id>)` 挂载校验，然后开新会话确认工具列表出现 `bili_summary`。

### 工具参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `video` | string（必填） | B 站链接（b23.tv 短链、`bilibili.com/video/` 链接）或 BV 号 |
| `withImages` | boolean | 默认 `false`（纯文字）；仅当用户明确要求"带图"时传 `true` |
| `page` | number | 多P视频分P序号（默认 1） |
| `maxFrames` | number | 带图模式最多切帧数（1–48，默认 12） |
| `refresh` | boolean | 忽略磁盘缓存重新抓取（默认 false） |

### 配置（行内 `config`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `outputDir` | `bili-output` | 输出根目录：`images/<安全标题>_<bvid>/`、`cache/<bvid>/`（meta.json / subtitle.json / subtitle.srt） |
| `cookie` | 空 | `SESSDATA=...; bili_jct=...`。风控(-412)/需登录(-352)时启用；**仅用于请求头，绝不写入日志或结果** |
| `userAgent` | 内置浏览器 UA | 覆盖默认 UA |
| `timeoutMs` | 15000 | 单次 HTTP 超时 |
| `retries` | 2 | 网络失败 / 5xx / 风控重试次数（指数退避） |
| `maxFrames` | 12 | 带图模式最多切帧数 |
| `chapterIntervalSec` | 180 | 章节划分粒度（有字幕时吸附到最近字幕起点） |
| `inlineSubtitleLimit` | 10000 | 字幕内联返回字符上限 |

### 已知限制

- 番剧/影视（`redirect_url`）、直播、互动视频明确不支持（结构化报错而非瞎试）
- 字幕走 `view`/`player/v2` 遗留接口，未实现 WBI 签名；B 站收紧时字幕会降级为"无字幕"并说明
- videoshot 为 B 站**非官方接口**，可能变动；部分视频无快照数据
- 插件以进程级 Node fs 写 `outputDir`（不经过会话文件沙箱）——挂载它的 preset 视为可信
- 为什么不做 cordis_define 动态插件形态：动态 Host 沙箱无 fetch/require/sharp，且本部署 `web` 服务无 fetch provider

### 测试

```bash
npm test        # 或 node test/sanity.mjs
```

无需网络与依赖。覆盖输入解析、**精灵图切帧数学回归（多精灵图 Y 坐标 bug）**、文件名清洗、SRT 格式、帧选择去重、章节吸附。

### 安全（依赖）

- **sharp 版本要求**：≥ 0.35.3（内置 libvips 8.18.3）。< 0.35.0 的 sharp 自带 libvips 存在
  CVE-2026-33327 / CVE-2026-33328 / CVE-2026-35590 / CVE-2026-35591（处理恶意构造的图片可触发，
  其中两项 CVSSv4 为高危）；本插件只解码 B 站 CDN 的封面与快照图，实际暴露面有限，但升级无副作用，务必保持最新。
- **Node 要求**：sharp 0.35 起要求 Node ≥ 20.9.0，本包 `engines` 已同步。
- **可选加固**（standalone 使用场景）：如需进一步缩小解码面，可在插件初始化处限制解码器：

  ```js
  sharp.block({ operation: ['VipsForeignLoadNsgif', 'VipsForeignLoadTiff', 'VipsForeignLoadVips'] })
  ```

  注意 `sharp.block` 是**进程级全局**生效：若与处理 GIF/TIFF 的其他程序共享进程（例如 DSH harness 内的其他插件），请勿启用，以免影响它们。

### 合规与免责声明

依赖 B 站非官方接口，仅供个人学习与笔记用途；请遵守 B 站用户协议、控制请求频率、勿用于商业抓取；截图与字幕仅限个人使用；总结应为概括性内容而非大段复制原文。

### GitHub About

**Description**：`DeepSeek Harness Host 插件：bili_summary 工具——B站视频元数据、字幕时间轴与 sharp 切帧配图，错误处理与降级内置，跨平台纯 Node 实现`

**Topics**：`bilibili` `bilibili-api` `deepseek-harness` `cordis` `ai-agents` `llm-tools` `video-summary` `subtitle` `sharp` `markdown` `nodejs`

### License

MIT（见 `LICENSE`）。

---

[English](#english) · [中文](#中文)
