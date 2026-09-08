/**
 * JSON 文件存储层（对齐 tech-center-board 的 db.json 方案）。
 * 内存中 db 是一个普通对象：{ 集合名: 行数组 }，持久化仅 load/save 两个函数。
 * 数据量增大后可平迁 SQLite，集合与字段不变。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const COLLECTIONS = [
  'process_templates',
  'process_template_steps',
  'projects',
  'project_processes',
  'progress_logs',
];

/** 空库结构 */
export function createDb() {
  return Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
}

/** 从文件加载；文件不存在返回空库；缺失集合补空数组。 */
export function loadDbFile(path) {
  if (!existsSync(path)) return createDb();
  const data = JSON.parse(readFileSync(path, 'utf8'));
  for (const c of COLLECTIONS) {
    if (!Array.isArray(data[c])) data[c] = [];
  }
  return data;
}

/** 持久化到文件（自动建目录）。 */
export function saveDbFile(path, db) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(db, null, 2), 'utf8');
}
