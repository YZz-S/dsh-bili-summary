/**
 * bili-summary.js — DeepSeek Harness Host 插件（ESM 模块）
 *
 * 注册一个模型可见工具 `bili_summary`：
 *   - 提取 B站视频元数据（标题 / UP主 / 投稿时间 / 数据 / 分P / cid）
 *   - 获取字幕时间轴（AI 字幕 / 人工字幕），生成 SRT 缓存
 *   - 可选"带图"：下载封面 + 用 sharp 从 videoshot 精灵图切章节代表帧
 *   - 全链路错误码检查、超时、重试、降级，跨平台（纯 Node，无 shell 依赖）
 *
 * 挂载方式（agent preset 行，见 README.md）：
 *   - id: tool-bili-summary
 *     name: ./bili-summary.js        # 相对组合文件目录解析；或用绝对路径
 *     config: { outputDir: bili-output }
 *
 * 设计要点：
 *   - 静态依赖只有 node: 内置模块；sharp 为可选增强（懒加载，缺失时降级为仅封面）
 *   - 工具定义采用 registry 的 wire 格式（JSON Schema parameters + output.render），
 *     不依赖 @deepseek-ai/dsh-tools 包，仓库可独立运行测试
 *   - 所有副作用都在 apply() 内，通过 ctx.tools.register 的 disposer + ctx.effect 随 fiber 回收
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// ---------------------------------------------------------------------------
// 常量与默认配置
// ---------------------------------------------------------------------------

const BILI_API = 'https://api.bilibili.com'
const BILI_REFERER = 'https://www.bilibili.com'
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const BV_RE = /BV[0-9A-Za-z]{10}/

const DEFAULT_CONFIG = {
  outputDir: 'bili-output', // 相对进程 cwd；可用绝对路径
  cookie: '', // 可选：'SESSDATA=...; bili_jct=...'，处理风控/需登录视频
  userAgent: DEFAULT_USER_AGENT,
  timeoutMs: 15000, // 单次 HTTP 超时
  retries: 2, // 网络失败 / 风控重试次数
  maxFrames: 12, // 带图模式下最多切帧数
  chapterIntervalSec: 180, // 章节划分粒度（秒）
  inlineSubtitleLimit: 10000, // 字幕全文内联返回的字符上限；超出则写入文件并返回摘录
}

/** B站 API 常见业务错误码 → 用户可读信息与处理建议。 */
const API_ERRORS = {
  '-404': { message: '视频不存在或已被删除', hint: '请核对 BV 号是否正确' },
  '-412': { message: '请求被风控拦截 (-412)', hint: '等待几秒后重试；若持续失败，请在插件配置中提供 cookie（SESSDATA）' },
  '-352': { message: '风控校验失败或需要登录 (-352)', hint: '该视频可能需要登录态，请在插件配置中提供 cookie（SESSDATA）' },
  '-403': { message: '权限不足 (-403)', hint: '接口拒绝了本次请求；尝试配置 cookie 或稍后重试' },
  '-400': { message: '请求参数错误 (-400)', hint: '请检查 BV 号格式' },
  '62002': { message: '番剧/影视内容需要大会员', hint: '本工具暂不支持番剧/影视页面' },
  '62012': { message: '仅大会员可见', hint: '本工具无法绕过会员限制' },
  '748': { message: '需要登录', hint: '请在插件配置中提供 cookie（SESSDATA）' },
}

// ---------------------------------------------------------------------------
// 纯函数（导出为 internals 供测试）
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(code, message) {
    super(message ?? `B站接口返回错误码 ${code}`)
    this.code = code
  }
}

function apiErrorFor(code, fallbackMessage) {
  const known = API_ERRORS[String(code)]
  return new ApiError(code, known ? known.message : (fallbackMessage ?? `B站接口返回错误码 ${code}`))
}

function hintFor(code) {
  return API_ERRORS[String(code)]?.hint
}

/** 统一补全协议前缀：`//i0.hdslb.com/...` → https，http → https。 */
function normalizeUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return ''
  if (url.startsWith('//')) return 'https:' + url
  if (url.startsWith('http://')) return 'https://' + url.slice('http://'.length)
  return url
}

/** 从用户输入解析视频标识。返回 { kind, bvid?, url?, page }；不可识别时抛错。 */
function parseInput(input) {
  const s = String(input ?? '').trim()
  if (s.length === 0) throw new Error('输入为空：请提供 B站视频链接（含 b23.tv 短链）或 BV 号')
  const pageMatch = s.match(/[?&]p=(\d+)/)
  const page = pageMatch ? Math.max(1, Number(pageMatch[1])) : 1
  if (/b23\.tv|bili2233\.cn/i.test(s)) return { kind: 'short', url: s, page }
  const bv = s.match(BV_RE)
  if (bv) return { kind: 'bv', bvid: bv[0], page }
  if (/av\d+/i.test(s)) throw new Error('av 号暂不支持：请在视频页右键复制链接获取 BV 号')
  throw new Error('无法识别视频链接：请提供 b23.tv 短链、bilibili.com/video/ 链接或 BV 号')
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

/** 文件/目录名清洗：非法字符、Windows 保留名、首尾点空格、长度截断。 */
function sanitizeFilename(name, maxLen = 60) {
  let out = String(name ?? '')
    .replace(ILLEGAL_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
  out = out.replace(/^\.+|\.+$/g, '')
  // 清洗后不含任何字母/数字/CJK 字符（纯符号/emoji 标题）→ 兜底名
  if (!/[\p{L}\p{N}]/u.test(out)) out = 'untitled'
  if (WINDOWS_RESERVED.test(out)) out += '_'
  if (out.length > maxLen) out = out.slice(0, maxLen).replace(/[.\s]+$/g, '')
  return out
}

/** 秒 → `M:SS` / `H:MM:SS`（章节标签、笔记时间戳用）。 */
function clockText(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 秒 → `HHMMSS`（文件命名用，各段补零）。 */
function hms(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0))
  const h = String(Math.floor(t / 3600)).padStart(2, '0')
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0')
  const s = String(t % 60).padStart(2, '0')
  return h + m + s
}

/** 秒 → SRT 时间戳 `HH:MM:SS,mmm`（毫秒四舍五入，规避浮点误差）。 */
function srtTime(sec) {
  const totalMs = Math.max(0, Math.round((Number(sec) || 0) * 1000))
  const s = Math.floor(totalMs / 1000)
  const ms = totalMs % 1000
  const base = new Date(s * 1000).toISOString().slice(11, 19)
  return `${base},${String(ms).padStart(3, '0')}`
}

/** 字幕 body 条目 → SRT 文本。 */
function srtFromCues(cues) {
  return cues
    .map((cue, i) => {
      const from = srtTime(cue.from)
      const to = srtTime(cue.to)
      const content = String(cue.content ?? '').trim()
      return `${i + 1}\n${from} --> ${to}\n${content}`
    })
    .filter((_, i) => String(cues[i].content ?? '').trim().length > 0)
    .join('\n\n')
}

/** 字幕条目 → 纯文本行（供模型直接阅读）。 */
function textFromCues(cues) {
  return cues
    .filter((cue) => String(cue.content ?? '').trim().length > 0)
    .map((cue) => `[${clockText(cue.from)}] ${String(cue.content).trim()}`)
    .join('\n')
}

/**
 * 精灵图切帧坐标（修正版：先取图内序号再算行列）。
 * 帧 N 位于第 K = floor(N / fullCap) 张精灵图，图内序号 n = N % fullCap。
 * 返回 { k, x, y }；若坐标超出该精灵图实际高度则返回 null（数据异常）。
 */
function spriteFrameRect(frameIndex, imgXLen, imgYLen, imgXSize, imgYSize, spriteHeight) {
  const fullCap = imgXLen * imgYLen
  if (fullCap <= 0) return null
  const k = Math.floor(frameIndex / fullCap)
  const n = frameIndex % fullCap
  const col = n % imgXLen
  const row = Math.floor(n / imgXLen)
  const x = col * imgXSize
  const y = row * imgYSize
  if (Number.isFinite(spriteHeight) && spriteHeight > 0 && y + imgYSize > spriteHeight) return null
  return { k, x, y }
}

/**
 * 为章节时间点挑选最近的快照帧。
 * chapters: [{ t }]；valid: [{ n, t }]（t>=0 的有效帧，已按 t 升序）。
 * 同一帧只选一次，重复时该章跳过。
 */
function chooseFramesForChapters(chapters, valid) {
  const picks = []
  for (const chapter of chapters) {
    let best = null
    let bestDist = Infinity
    for (const frame of valid) {
      const d = Math.abs(frame.t - chapter.t)
      if (d < bestDist) {
        bestDist = d
        best = frame
      }
    }
    if (best && !picks.some((p) => p.frame.n === best.n)) picks.push({ chapter: chapter, frame: best })
  }
  return picks
}

/** 均分时长得到章节候选时间；有字幕时间轴时吸附到最近的 cue。 */
function buildChapters(duration, timeline, config) {
  if (!Number.isFinite(duration) || duration <= 0) return []
  const count = Math.max(1, Math.min(config.maxFrames, Math.ceil(duration / config.chapterIntervalSec)))
  const chapters = []
  for (let i = 0; i < count; i++) {
    let t = Math.round((duration * (i + 0.5)) / count)
    if (Array.isArray(timeline) && timeline.length > 0) {
      let best = timeline[0].t
      let bestDist = Infinity
      for (const cue of timeline) {
        const d = Math.abs(cue.t - t)
        if (d < bestDist) {
          bestDist = d
          best = cue.t
        }
      }
      t = Math.round(best)
    }
    chapters.push({ t, label: clockText(t) })
  }
  return chapters
}

/** Unix 秒时间戳（UTC+8）→ `YYYY-MM-DD`。 */
function dateText(pubdate) {
  if (!Number.isFinite(pubdate) || pubdate <= 0) return ''
  return new Date(pubdate * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

function dateYmd(pubdate) {
  return dateText(pubdate).replaceAll('-', '')
}

function durationText(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function backoffMs(attempt) {
  // 600ms、1500ms、3000ms + 抖动
  return Math.min(600 * 2 ** attempt, 3000) + Math.floor(Math.random() * 300)
}

// ---------------------------------------------------------------------------
// HTTP 层
// ---------------------------------------------------------------------------

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms).unref?.()
  return controller.signal
}

function baseHeaders(opts) {
  const headers = {
    'User-Agent': opts.userAgent,
    Referer: BILI_REFERER,
    Origin: BILI_REFERER,
    Accept: 'application/json, text/plain, */*',
  }
  if (opts.cookie) headers.Cookie = opts.cookie
  return headers
}

/**
 * GET JSON。`plain` 为 true 时返回整个响应体（用于无 code 字段的字幕 JSON）；
 * 否则要求 code==0 并返回 data。业务错误抛 ApiError，网络错误重试后抛出。
 */
async function fetchJson(url, opts, { plain = false } = {}) {
  let lastError
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt - 1))
    try {
      const res = await fetch(url, { headers: baseHeaders(opts), signal: timeoutSignal(opts.timeoutMs) })
      if (!res.ok && attempt < opts.retries && (res.status === 412 || res.status >= 500)) {
        lastError = new Error(`HTTP ${res.status}`)
        continue
      }
      const payload = await res.json().catch(() => null)
      if (payload && typeof payload === 'object') {
        if (plain) return payload
        if (payload.code === 0) return payload.data
        if (payload.code === -412 && attempt < opts.retries) {
          lastError = apiErrorFor(-412)
          continue
        }
        throw apiErrorFor(payload.code, payload.message)
      }
      throw new Error(`接口返回异常（HTTP ${res.status}，非 JSON 响应）`)
    } catch (error) {
      if (error instanceof ApiError) throw error
      lastError = error
      if (attempt < opts.retries) continue
      break
    }
  }
  const cause = lastError?.message ?? 'unknown'
  throw new Error(`网络请求失败（已重试 ${opts.retries} 次）：${cause}`)
}

/** GET 二进制（图片）。返回 { buffer, contentType }。 */
async function fetchBuffer(url, opts) {
  let lastError
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt - 1))
    try {
      const res = await fetch(url, { headers: baseHeaders(opts), signal: timeoutSignal(opts.timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buffer = Buffer.from(await res.arrayBuffer())
      return { buffer, contentType: res.headers.get('content-type') ?? '' }
    } catch (error) {
      lastError = error
      if (attempt < opts.retries) continue
      break
    }
  }
  throw new Error(`下载失败（已重试 ${opts.retries} 次）：${lastError?.message ?? 'unknown'}`)
}

// ---------------------------------------------------------------------------
// B站业务层
// ---------------------------------------------------------------------------

/** 解析 b23.tv / bili2233.cn 短链（手动跟随跳转，最多 5 跳）。 */
async function resolveShortLink(url, opts) {
  let current = url
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: baseHeaders(opts),
      signal: timeoutSignal(opts.timeoutMs),
    })
    const location = res.headers.get('location')
    if (location) {
      current = new URL(location, current).href
      continue
    }
    if (res.status >= 200 && res.status < 400) {
      const text = await res.text()
      const m = text.match(BV_RE)
      if (m) return { bvid: m[0] }
    }
    break
  }
  const m = current.match(BV_RE)
  if (m) return { bvid: m[0] }
  throw new Error('短链解析失败：请直接提供完整视频链接或 BV 号')
}

/** 视频详情（view 接口）。 */
async function fetchView(bvid, opts) {
  const data = await fetchJson(`${BILI_API}/x/web-interface/view?bvid=${bvid}`, opts)
  if (data && typeof data === 'object' && typeof data.redirect_url === 'string' && data.redirect_url.length > 0) {
    throw new Error('这是番剧/影视页面：本工具暂不支持番剧、影视与直播内容，请使用普通视频（BV 号）')
  }
  return data
}

function pickSubtitleTrack(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  return (
    list.find((s) => s?.lan === 'zh-CN') ??
    list.find((s) => typeof s?.lan === 'string' && s.lan.startsWith('ai-zh')) ??
    list.find((s) => typeof s?.lan_doc === 'string' && s.lan_doc.includes('中文')) ??
    list[0]
  )
}

/**
 * 字幕获取：优先 view.subtitle.list，缺则 player/v2。
 * 返回 { available, source, reason?, cues? }；任何失败都降级而不是抛错。
 */
async function fetchSubtitle(view, bvid, cid, opts) {
  let list = view?.subtitle?.list
  let source = 'view'
  if (!Array.isArray(list) || list.length === 0) {
    try {
      const player = await fetchJson(`${BILI_API}/x/player/v2?bvid=${bvid}&cid=${cid}`, opts)
      list = player?.subtitle?.subtitles
      source = 'player'
    } catch (error) {
      return { available: false, reason: `无字幕且 player 接口不可用：${error.message}` }
    }
  }
  const track = pickSubtitleTrack(list)
  if (!track?.subtitle_url) return { available: false, reason: '无可用字幕轨道' }
  const url = normalizeUrl(track.subtitle_url)
  if (!url) return { available: false, reason: '字幕地址无效' }
  try {
    const payload = await fetchJson(url, opts, { plain: true })
    const body = Array.isArray(payload?.body) ? payload.body : []
    const cues = body
      .map((item) => ({
        from: Number(item?.from),
        to: Number(item?.to),
        content: String(item?.content ?? '').trim(),
      }))
      .filter((cue) => Number.isFinite(cue.from) && cue.content.length > 0)
      .sort((a, b) => a.from - b.from)
    if (cues.length === 0) return { available: false, reason: '字幕数据为空' }
    return { available: true, source, cues, lan: track.lan ?? '', lanDoc: track.lan_doc ?? '' }
  } catch (error) {
    return { available: false, reason: `字幕下载失败（可能是 403，需要登录态 cookie）：${error.message}` }
  }
}

// ---------------------------------------------------------------------------
// 图片层（sharp 切帧）
// ---------------------------------------------------------------------------

let sharpPromise
/** 懒加载 sharp；未安装时返回 null（降级为仅封面）。 */
async function getSharp() {
  if (sharpPromise === undefined) {
    sharpPromise = import('sharp')
      .then((mod) => mod.default ?? mod)
      .catch(() => null)
  }
  return sharpPromise
}

function extFromContentType(contentType) {
  if (/image\/png/i.test(contentType)) return 'png'
  if (/image\/webp/i.test(contentType)) return 'webp'
  if (/image\/gif/i.test(contentType)) return 'gif'
  return 'jpg'
}

/**
 * 带图素材准备：封面 + 章节代表帧。
 * 返回 { coverPath, frames, skipped, degrade }；逐级降级，不抛错。
 */
async function prepareImages({ view, bvid, cid, pageIndex, chapters, outDir, opts, config, logger }) {
  const result = { coverPath: null, frames: [], skipped: [], degrade: [] }
  const safe = `${sanitizeFilename(view?.title, 50)}_${bvid}`
  const dir = path.join(outDir, 'images', safe)
  const warn = (msg) => {
    result.degrade.push(msg)
    logger?.warn?.(`bili-summary: ${msg}`)
  }

  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    warn(`无法创建图片目录：${error.message}`)
    return result
  }

  // 5.1 封面
  const pic = normalizeUrl(view?.pic)
  if (pic) {
    try {
      const { buffer, contentType } = await fetchBuffer(pic, opts)
      const file = `cover.${extFromContentType(contentType)}`
      await writeFile(path.join(dir, file), buffer)
      result.coverPath = path.join('images', safe, file)
    } catch (error) {
      warn(`封面下载失败：${error.message}`)
    }
  } else {
    warn('视频无封面 URL')
  }

  // 5.2 videoshot 快照切帧
  let shot = null
  try {
    shot = await fetchJson(`${BILI_API}/x/player/videoshot?bvid=${bvid}&cid=${cid}&index=${pageIndex}`, opts)
  } catch (error) {
    warn(`videoshot 接口失败：${error.message}`)
    return result
  }
  const images = Array.isArray(shot?.image) ? shot.image : []
  const index = Array.isArray(shot?.index) ? shot.index : []
  const xLen = Number(shot?.img_x_len)
  const yLen = Number(shot?.img_y_len)
  const xSize = Number(shot?.img_x_size)
  const ySize = Number(shot?.img_y_size)
  if (images.length === 0 || index.length === 0) {
    warn('videoshot 无快照数据（部分视频不支持）')
    return result
  }
  if (![xLen, yLen, xSize, ySize].every((n) => Number.isFinite(n) && n > 0)) {
    warn('videoshot 缺少精灵图尺寸字段，无法切帧')
    return result
  }

  const sharp = await getSharp()
  if (sharp === null) {
    warn('未安装 sharp（在插件所在目录执行 npm install 或把插件放进带 node_modules 的目录），本次仅封面配图')
    return result
  }

  const valid = index
    .map((t, n) => ({ n, t: Number(t) }))
    .filter((f) => Number.isFinite(f.t) && f.t >= 0)

  const picks = chooseFramesForChapters(chapters, valid)
  if (picks.length === 0) {
    warn('没有可用的快照帧')
    return result
  }

  const spriteCache = new Map()
  const usedNames = new Set()

  for (const pick of picks) {
    const rect = spriteFrameRect(pick.frame.n, xLen, yLen, xSize, ySize, undefined)
    if (rect === null) {
      result.skipped.push({ t: pick.chapter.t, reason: '精灵图布局数据异常' })
      continue
    }
    const spriteUrl = normalizeUrl(images[rect.k])
    if (!spriteUrl) {
      result.skipped.push({ t: pick.chapter.t, reason: `第 ${rect.k + 1} 张精灵图 URL 缺失` })
      continue
    }
    try {
      let entry = spriteCache.get(rect.k)
      if (entry === undefined) {
        const { buffer } = await fetchBuffer(spriteUrl, opts)
        const img = sharp(buffer, { animated: false })
        const info = await img.metadata()
        entry = { img, height: info.height ?? 0 }
        spriteCache.set(rect.k, entry)
      }
      // 用实际图高复核（最后一张精灵图可能不满）
      const checked = spriteFrameRect(pick.frame.n, xLen, yLen, xSize, ySize, entry.height)
      if (checked === null) {
        result.skipped.push({ t: pick.chapter.t, reason: '帧坐标超出精灵图实际高度（接口数据异常）' })
        continue
      }
      const base = `frame_${hms(pick.frame.t)}`
      let name = `${base}.jpg`
      let seq = 2
      while (usedNames.has(name)) name = `${base}_${seq++}.jpg`
      usedNames.add(name)
      const file = path.join(dir, name)
      await entry.img
        .clone()
        .extract({ left: checked.x, top: checked.y, width: xSize, height: ySize })
        .jpeg({ quality: 88 })
        .toFile(file)
      result.frames.push({
        t: pick.frame.t,
        tText: clockText(pick.frame.t),
        chapterT: pick.chapter.t,
        path: path.join('images', safe, name),
        frameIndex: pick.frame.n,
        spriteIndex: rect.k,
      })
    } catch (error) {
      result.skipped.push({ t: pick.chapter.t, reason: error.message })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

async function readJsonSafe(file) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

function buildToolDescription() {
  return [
    '获取哔哩哔哩（B站）视频的结构化信息，用于生成视频总结笔记：',
    '- 视频元数据：标题、UP主、投稿时间（UTC+8）、时长、播放/点赞/收藏、分P与 cid；',
    '- 字幕时间轴：优先 AI 字幕/人工字幕，生成 SRT 缓存；字幕较长时写入文件并只内联返回摘录，',
    '  此时用 read 工具分段阅读 srtPath 获取全文；',
    '- 可选带图素材（withImages=true，仅当用户明确要求"带图"时使用）：封面 + 每章代表帧，',
    '  帧由 sharp 从播放器快照接口（非官方）切出，图片存本地并用相对路径引用；',
    '- 内置超时/重试/风控处理与逐级降级，失败信息在 ok=false.message 与 notes/degrade 中说明。',
    '该工具只负责取数与素材，总结文本与 Markdown 笔记由模型生成；',
    '章节标题建议使用返回的 meta.url 加 ?t=<秒> 形式的时间点跳转链接。',
  ].join('')
}

function buildToolDef(config, logger) {
  return {
    name: 'bili_summary',
    description: buildToolDescription(),
    parameters: {
      type: 'object',
      properties: {
        video: {
          type: 'string',
          description: 'B站视频链接（支持 b23.tv 短链、bilibili.com/video/ 链接）或 BV 号',
        },
        withImages: {
          type: 'boolean',
          description: '是否准备配图素材（封面 + 章节代表帧）。默认 false（纯文字）。仅当用户明确要求"带图"时传 true',
        },
        page: {
          type: 'number',
          description: '多P视频的分P序号，从 1 开始，默认 1',
        },
        maxFrames: {
          type: 'number',
          description: '带图模式下最多切帧数（1–48），默认取插件配置 maxFrames（12）',
        },
        refresh: {
          type: 'boolean',
          description: '忽略磁盘缓存重新抓取，默认 false',
        },
      },
      required: ['video'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: renderDigest(value) }]
      },
    },
    // 闭包持有本 fiber 的 config：同一模块被多个会话并挂载时互不串扰
    async execute(args) {
      return runTool(args, config, logger)
    },
  }
}

function renderDigest(value) {
  if (!value || typeof value !== 'object') return 'bili_summary: 无结果'
  if (value.ok === false) {
    const hint = value.hint ? `\n建议：${value.hint}` : ''
    return `✗ bili_summary 失败 [${value.code ?? 'error'}] ${value.message}${hint}`
  }
  const lines = [
    `✔ ${value.meta.title}`,
    `BV: ${value.bvid}  UP主: ${value.meta.up}  时长: ${value.meta.durationText}`,
    `播放 ${value.meta.stat.view} · 点赞 ${value.meta.stat.like} · 收藏 ${value.meta.stat.favorite}`,
  ]
  if (value.meta.multiP) lines.push(`多P视频：共 ${value.meta.pageCount} P，本次取第 ${value.meta.pageIndex} P`)
  if (value.subtitle.available) {
    lines.push(`字幕：${value.subtitle.cueCount} 条（来源 ${value.subtitle.source}）`)
    if (!value.subtitle.fullTextIncluded) lines.push(`字幕全文：${value.subtitle.srtPath}（分段用 read 工具阅读）`)
  } else {
    lines.push(`字幕不可用：${value.subtitle.reason}`)
  }
  if (value.images?.withImages) {
    lines.push(`配图：封面 ${value.images.coverPath ?? '失败'} · 代表帧 ${value.images.frames.length} 张 · 跳过 ${value.images.skipped.length} 帧`)
  }
  lines.push(`建议笔记文件名：${value.suggestedFilename}`)
  if (Array.isArray(value.notes) && value.notes.length > 0) lines.push(`注意：${value.notes.join('；')}`)
  return lines.join('\n')
}

async function runTool(args, config, logger) {
  const opts = {
    userAgent: config.userAgent,
    cookie: config.cookie,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
  }
  const outDir = path.resolve(config.outputDir)
  try {
    const parsed = parseInput(args.video)
    const bvid = parsed.kind === 'bv' ? parsed.bvid : (await resolveShortLink(parsed.url, opts)).bvid
    const page = clampInt(args.page ?? parsed.page, 1, 10000, 1)
    const withImages = args.withImages === true
    const maxFrames = clampInt(args.maxFrames ?? config.maxFrames, 1, 48, config.maxFrames)
    const refresh = args.refresh === true
    const notes = []

    const cacheDir = path.join(outDir, 'cache', bvid)

    // 1. 元数据（带缓存）
    let view = refresh ? null : await readJsonSafe(path.join(cacheDir, 'meta.json'))
    if (!view) {
      view = await fetchView(bvid, opts)
      try {
        await mkdir(cacheDir, { recursive: true })
        await writeFile(path.join(cacheDir, 'meta.json'), JSON.stringify(view, null, 2))
      } catch {
        /* 缓存写入失败不影响主流程 */
      }
    }

    // 2. 分P / cid
    const pages = Array.isArray(view?.pages) ? view.pages : []
    const multiP = pages.length > 1
    if (multiP && page > pages.length) {
      throw new Error(`分P序号 ${page} 超出范围（共 ${pages.length} P）`)
    }
    const cid = pages[page - 1]?.cid ?? view?.cid
    if (!cid) throw new Error('接口未返回 cid，无法继续')
    if (multiP) notes.push(`多P视频共 ${pages.length} P，本次取第 ${page} P（可用 page 参数切换）`)

    // 3. 字幕（带缓存）
    let subtitle = refresh ? null : await readJsonSafe(path.join(cacheDir, 'subtitle.json'))
    if (!subtitle) {
      const fetched = await fetchSubtitle(view, bvid, cid, opts)
      subtitle = {
        available: fetched.available,
        source: fetched.source ?? null,
        reason: fetched.reason ?? '',
        cues: fetched.cues ?? [],
        lan: fetched.lan ?? '',
        lanDoc: fetched.lanDoc ?? '',
      }
      if (fetched.available) {
        try {
          await mkdir(cacheDir, { recursive: true })
          await writeFile(path.join(cacheDir, 'subtitle.json'), JSON.stringify(subtitle, null, 2))
          await writeFile(path.join(cacheDir, 'subtitle.srt'), srtFromCues(fetched.cues) + '\n')
        } catch {
          /* 缓存写入失败不影响主流程 */
        }
      }
    }
    if (!subtitle.available) notes.push(`字幕降级：${subtitle.reason ?? '无字幕'}`)

    // 4. 章节候选（帧选择与给模型的章节提示共用）
    const timeline = (subtitle.cues ?? []).map((cue) => ({ t: cue.from }))
    const duration = Number(view?.duration)
    const chapters = buildChapters(duration, timeline, { maxFrames, chapterIntervalSec: config.chapterIntervalSec })

    // 5. 图片素材
    let images = { withImages: false, coverPath: null, frames: [], skipped: [], degrade: [] }
    if (withImages) {
      images = await prepareImages({
        view,
        bvid,
        cid,
        pageIndex: page,
        chapters,
        outDir,
        opts,
        config,
        logger,
      })
      images.withImages = true
      if (images.degrade.length > 0) notes.push(`配图降级：${images.degrade.join('；')}`)
    }

    // 6. 元数据精简（只带模型需要的标量字段）
    const stat = view?.stat ?? {}
    const meta = {
      title: String(view?.title ?? ''),
      up: String(view?.owner?.name ?? ''),
      pubdate: Number(view?.pubdate) || 0,
      pubdateText: dateText(Number(view?.pubdate)),
      duration: duration,
      durationText: durationText(duration),
      stat: {
        view: Number(stat.view) || 0,
        like: Number(stat.like) || 0,
        coin: Number(stat.coin) || 0,
        favorite: Number(stat.favorite) || 0,
        danmaku: Number(stat.danmaku) || 0,
        reply: Number(stat.reply) || 0,
      },
      tname: String(view?.tname ?? ''),
      desc: String(view?.desc ?? '').slice(0, 500),
      pageIndex: page,
      pageCount: pages.length || 1,
      multiP,
      cid,
      url: `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`,
    }

    // 7. 字幕内联策略：小字幕全量返回；超长写文件 + 摘录
    const fullText = textFromCues(subtitle.cues ?? [])
    const fullTextIncluded = fullText.length <= config.inlineSubtitleLimit
    const headLen = Math.floor(config.inlineSubtitleLimit * 0.6)
    const tailLen = Math.floor(config.inlineSubtitleLimit * 0.3)
    const subtitleResult = {
      available: subtitle.available,
      source: subtitle.source,
      reason: subtitle.reason,
      cueCount: (subtitle.cues ?? []).length,
      firstCue: subtitle.cues?.[0]?.from ?? null,
      lastCue: subtitle.cues?.[subtitle.cues.length - 1]?.from ?? null,
      srtPath: subtitle.available ? path.join(outDir, 'cache', bvid, 'subtitle.srt') : null,
      fullTextIncluded,
      text: fullTextIncluded ? fullText : `${fullText.slice(0, headLen)}\n\n…（中间省略，全文见 ${path.join(outDir, 'cache', bvid, 'subtitle.srt')}，用 read 工具分段阅读）…\n\n${fullText.slice(-tailLen)}`,
    }

    const upName = sanitizeFilename(meta.up, 30) || 'up'
    const titleName = sanitizeFilename(meta.title, 40) || bvid
    const suggestedFilename = `${upName}_${dateYmd(meta.pubdate) || 'YYYYMMDD'}_${titleName}_${bvid}_视频总结.md`

    return {
      ok: true,
      bvid,
      meta,
      subtitle: subtitleResult,
      images,
      chapters: chapters.map((c) => ({ t: c.t, tText: c.label })),
      suggestedFilename,
      notes,
      generatedAt: new Date().toISOString(),
    }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof ApiError ? String(error.code) : 'bili_error',
      message: error?.message ?? String(error),
      hint: error instanceof ApiError ? hintFor(error.code) : undefined,
    }
  }
}

// ---------------------------------------------------------------------------
// Cordis 插件
// ---------------------------------------------------------------------------

const plugin = {
  name: 'bili-summary',
  inject: ['tools'],
  apply(ctx, lineConfig) {
    // cordis 里插件行配置通过 apply 第二参传入；ctx.config 走 proxy trap，
    // 未 inject 会抛 "cannot get property \"config\" without inject"
    const config = { ...DEFAULT_CONFIG, ...(lineConfig ?? {}) }
    config.retries = clampInt(config.retries, 0, 5, DEFAULT_CONFIG.retries)
    config.timeoutMs = clampInt(config.timeoutMs, 3000, 120000, DEFAULT_CONFIG.timeoutMs)

    const disposer = ctx.tools.register(buildToolDef(config, ctx.logger))
    if (typeof disposer === 'function') ctx.effect(() => disposer)
  },
}

const internals = {
  parseInput,
  sanitizeFilename,
  clockText,
  hms,
  srtTime,
  srtFromCues,
  textFromCues,
  spriteFrameRect,
  chooseFramesForChapters,
  buildChapters,
  dateText,
  dateYmd,
  durationText,
  normalizeUrl,
  apiErrorFor,
}

export { internals }
export default plugin
