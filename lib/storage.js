/**
 * storage.js — 插件自有配置状态的 JSON 持久化原语（v0.2.2，借鉴 Minecraftbe/dsh-toolfold）。
 *
 * 现状背景：插件持有 warm 集合、上次折叠统计等自有状态，但此前无处可靠落盘。
 * 语义缓存已落盘 `~/.dsh/state/`，本模块提供通用的 read/write JSON 原语，
 * 供 index.js 实现「三级持久化」降级：
 *
 *   1. `~/.dsh/settings.yaml`（或 feedbackPath 同目录）
 *   2. `~/.dsh/state/`
 *   3. 进程内（最后兜底）
 *
 * 本模块只做一件事：对单个 JSON 文件的健壮读写。任何文件系统异常都以
 * 「降级返回值」处理，绝不向调用方抛错——持久化失败不等于插件崩溃。
 * ⚠️ 不碰 cordis.patch.yml：那是宿主配置，插件从不写。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 把 data 以 JSON 落盘到 file（自动创建父目录）。
 * @param {string} file  目标文件绝对路径
 * @param {unknown} data  可 JSON 序列化的值
 * @returns {boolean} true = 已写入；false = 任何失败（调用方降级到下一级存储）
 */
export function writeState(file, data) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), "utf8");
    return true;
  } catch {
    return false; // 目录不可写 / 权限 / 磁盘满 → 降级
  }
}

/**
 * 从 file 读取 JSON；任何失败（不存在/损坏/无权限/非对象）都返回 def。
 * @param {string} file
 * @param {unknown} def  默认值（读失败时的兜底）
 * @returns {unknown} 解析出的值（独立副本）或 def
 */
export function readState(file, def) {
  if (!file) return def;
  try {
    if (!fs.existsSync(file)) return def;
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return JSON.parse(JSON.stringify(j)); // 独立副本
    return def;
  } catch {
    return def; // 损坏 JSON / 权限 → 默认值降级
  }
}
