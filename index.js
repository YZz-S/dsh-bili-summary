/**
 * index.js — dsh.bundle 入口（可安装包形态）。
 *
 * `dsh plugin --profile <name> add github:YZz-S/dsh-bili-summary` 安装后，
 * cordis.patch.yml 插入的行以包名 `dsh-plugin-bili-summary` 解析到本模块。
 * 插件本体在 bili-summary.js（preset 行形态直接引用该文件即可），这里只做再导出。
 */
export { default, plugin, internals } from './bili-summary.js'
