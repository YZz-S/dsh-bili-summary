/**
 * index.js — dsh.bundle 入口（可安装包形态）。
 *
 * `dsh plugin --profile <name> add github:YZz-S/dsh-bili-summary` 安装后，
 * cordis.patch.yml 插入的行以包名 `dsh-plugin-bili-summary` 解析到本模块。
 * 插件本体在 bili-summary.js（preset 行形态直接引用该文件即可），这里只做再导出。
 *
 * 除 default 外，同时以命名导出暴露 name/inject/apply/plugin，兼容 cordis
 * loader 直接消费本模块（与 dshx lib 模块的约定一致）。
 */
import plugin from './bili-summary.js'

export { internals } from './bili-summary.js'
export default plugin
export const name = plugin.name
export const inject = plugin.inject
export const apply = plugin.apply
