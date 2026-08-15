/**
 * sanity.mjs — bili-summary 插件纯函数回归测试
 * 运行：node test/sanity.mjs   （无需安装依赖、不访问网络）
 * 重点覆盖历史 bug：
 *   1. 精灵图切帧数学（多精灵图时 Y 坐标必须用图内序号计算）
 *   2. 文件名清洗（Windows 非法字符/保留名/长度）
 *   3. BV/短链输入解析、帧选择去重、SRT 时间格式
 */

import assert from 'node:assert/strict'
import { internals } from '../bili-summary.js'

const {
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
  durationText,
  normalizeUrl,
} = internals

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`✔ ${name}`)
  } catch (error) {
    console.error(`✘ ${name}\n  ${error.message}`)
    process.exitCode = 1
  }
}

// ---- 输入解析 ----
test('parseInput: 裸 BV 号', () => {
  const r = parseInput('BV1j9MP6wEV9')
  assert.equal(r.kind, 'bv')
  assert.equal(r.bvid, 'BV1j9MP6wEV9')
  assert.equal(r.page, 1)
})

test('parseInput: 完整链接带 p 参数', () => {
  const r = parseInput('https://www.bilibili.com/video/BV1j9MP6wEV9/?p=3&vd_source=x')
  assert.equal(r.bvid, 'BV1j9MP6wEV9')
  assert.equal(r.page, 3)
})

test('parseInput: b23.tv 短链', () => {
  const r = parseInput('https://b23.tv/abc123')
  assert.equal(r.kind, 'short')
})

test('parseInput: av 号明确报错', () => {
  assert.throws(() => parseInput('av170001'), /av 号暂不支持/)
})

test('parseInput: 无效输入报错', () => {
  assert.throws(() => parseInput('你好世界'), /无法识别/)
  assert.throws(() => parseInput('   '), /输入为空/)
})

// ---- URL 规范化 ----
test('normalizeUrl: 协议相对与 http 前缀', () => {
  assert.equal(normalizeUrl('//i0.hdslb.com/bfs/x.jpg'), 'https://i0.hdslb.com/bfs/x.jpg')
  assert.equal(normalizeUrl('http://i0.hdslb.com/a'), 'https://i0.hdslb.com/a')
  assert.equal(normalizeUrl('https://x.com/a'), 'https://x.com/a')
  assert.equal(normalizeUrl(''), '')
})

// ---- 精灵图切帧数学（历史 bug 回归） ----
test('spriteFrameRect: 第 1 张精灵图内的帧', () => {
  // 5x5=25 帧/张，160x90 单帧
  const r = spriteFrameRect(24, 5, 5, 160, 90, 450)
  assert.deepEqual(r, { k: 0, x: 4 * 160, y: 4 * 90 })
})

test('spriteFrameRect: 第 2 张精灵图内的帧（旧公式会算错 Y）', () => {
  // N=26 → 图内序号 1 → 列1 行0 → y=0；旧公式 (26//5)*90=450 已越界
  const r = spriteFrameRect(26, 5, 5, 160, 90, 450)
  assert.deepEqual(r, { k: 1, x: 1 * 160, y: 0 })
})

test('spriteFrameRect: 跨精灵图边界帧', () => {
  const r = spriteFrameRect(25, 5, 5, 160, 90, 450)
  assert.deepEqual(r, { k: 1, x: 0, y: 0 })
})

test('spriteFrameRect: 超出实际图高返回 null（最后一张精灵图不满）', () => {
  // 最后一张精灵图实际只有 2 行（高 180），行 3 的帧应判无效
  const r = spriteFrameRect(53, 5, 5, 160, 90, 180) // N=53 → k=2, n=3 → row=0 有效？
  assert.deepEqual(r, { k: 2, x: 3 * 160, y: 0 })
  const bad = spriteFrameRect(55, 5, 5, 160, 90, 180) // n=5 → row=1 → y=90，90+90=180 边界内
  assert.notEqual(bad, null)
  const worse = spriteFrameRect(60, 5, 5, 160, 90, 180) // n=10 → row=2 → y=180 越界
  assert.equal(worse, null)
})

// ---- 文件名清洗 ----
test('sanitizeFilename: 非法字符替换', () => {
  assert.equal(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j')
})

test('sanitizeFilename: Windows 保留名', () => {
  assert.equal(sanitizeFilename('CON'), 'CON_')
  assert.equal(sanitizeFilename('lpt3.txt'), 'lpt3.txt_')
})

test('sanitizeFilename: 长度截断与空名兜底', () => {
  assert.equal(sanitizeFilename('x'.repeat(200), 60).length, 60)
  assert.equal(sanitizeFilename('///???'), 'untitled')
})

test('sanitizeFilename: 首尾点与空格', () => {
  assert.equal(sanitizeFilename('  .abc.  '), 'abc')
})

// ---- 时间格式 ----
test('clockText / hms / srtTime', () => {
  assert.equal(clockText(222), '03:42')
  assert.equal(clockText(3661), '1:01:01')
  assert.equal(hms(222), '000342')
  assert.equal(hms(3661), '010101')
  assert.equal(srtTime(3.42), '00:00:03,420')
  assert.equal(srtTime(222.005), '00:03:42,005')
})

test('durationText', () => {
  assert.equal(durationText(90), '01:30')
  assert.equal(durationText(3661), '1:01:01')
})

test('dateText: pubdate 转 UTC+8 日期', () => {
  // 2026-01-01 00:00:00 UTC+8 = 2025-12-31T16:00:00Z = 1767196800
  assert.equal(dateText(1767196800), '2026-01-01')
})

// ---- 字幕转换 ----
test('srtFromCues: 时间戳与内容', () => {
  const cues = [
    { from: 0.3, to: 4.1, content: '  第一句  ' },
    { from: 5, to: 8, content: '  ' },
  ]
  const srt = srtFromCues(cues)
  assert.match(srt, /00:00:00,300 --> 00:00:04,100/)
  assert.match(srt, /第一句/)
  assert.doesNotMatch(srt, /第二句/)
})

test('textFromCues: 纯文本行', () => {
  const cues = [{ from: 60, to: 63, content: '要点A' }, { from: 70, to: 73, content: ' ' }]
  assert.equal(textFromCues(cues), '[01:00] 要点A')
})

// ---- 帧选择 ----
test('chooseFramesForChapters: 最近帧 + 去重', () => {
  const valid = [
    { n: 0, t: 0 },
    { n: 1, t: 10 },
    { n: 2, t: 20 },
  ]
  const picks = chooseFramesForChapters([{ t: 8 }, { t: 12 }, { t: 19 }], valid)
  assert.equal(picks.length, 2) // 8→n1, 12→n1 重复跳过, 19→n2
  assert.equal(picks[0].frame.n, 1)
  assert.equal(picks[1].frame.n, 2)
})

test('chooseFramesForChapters: -1 无效帧已被上游过滤', () => {
  const valid = [{ n: 0, t: 5 }]
  const picks = chooseFramesForChapters([{ t: 100 }], valid)
  assert.equal(picks[0].frame.n, 0)
})

// ---- 章节生成 ----
test('buildChapters: 均分时长', () => {
  const chapters = buildChapters(600, [], { maxFrames: 4, chapterIntervalSec: 180 })
  assert.equal(chapters.length, 4)
  assert.equal(chapters[0].t, 75)
  assert.equal(chapters[3].t, 525)
})

test('buildChapters: 有字幕时间轴时吸附', () => {
  const timeline = [{ t: 0 }, { t: 120 }, { t: 300 }]
  const chapters = buildChapters(600, timeline, { maxFrames: 3, chapterIntervalSec: 180 })
  assert.deepEqual(chapters.map((c) => c.t), [120, 300, 300]) // 500 → 最近 300
})

console.log(`\n${passed} 项测试通过${process.exitCode ? '（有失败）' : ''}`)
