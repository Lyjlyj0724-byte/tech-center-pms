/**
 * 导入落库桥接单测：importer 数据 → 存储，含全量校验与持久化往返。
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';
import { createDb, loadDbFile, saveDbFile } from '../src/store/db.js';
import { applyImportData, applyImportFile } from '../src/import/applyImport.js';

const importData = {
  templates: [{
    code: 'TMPL-01', name: '机加路线', version: 1,
    steps: [
      { seq: 1, stepCode: 'OP10', stepName: '下料', stdHours: 2, prevCodes: [], equipmentType: '锯床', remark: null },
      { seq: 2, stepCode: 'OP20', stepName: '粗加工', stdHours: 8, prevCodes: ['OP10'], equipmentType: '数控车床', remark: null },
      { seq: 3, stepCode: 'OP30', stepName: '检验', stdHours: 2, prevCodes: ['OP20'], equipmentType: '三坐标', remark: null },
    ],
  }],
  projects: [{
    code: 'PRJ-001', name: '传动箱试制', owner: '张三', priority: '高',
    planStart: '2026-10-01', planEnd: '2026-12-31', templateCode: 'TMPL-01',
  }],
};

describe('applyImportData', () => {
  it('模板与项目落库，项目自动实例化工序路线', () => {
    const db = createDb();
    const r = applyImportData(db, importData);
    expect(r.templates).toBe(1);
    expect(r.projects).toBe(1);
    expect(db.process_templates[0]).toMatchObject({ code: 'TMPL-01', status: 'active', version: 1 });
    expect(db.process_template_steps).toHaveLength(3);
    expect(db.projects[0].code).toBe('PRJ-001');
    const procs = db.project_processes.filter((p) => p.project_id === db.projects[0].id);
    expect(procs).toHaveLength(3);
    const byCode = new Map(procs.map((p) => [p.step_code, p]));
    expect(byCode.get('OP30').prev_ids).toEqual([byCode.get('OP20').id]);
  });

  it('模板编号已存在时整体拒绝（不落任何数据）', () => {
    const db = createDb();
    applyImportData(db, importData);
    expect(() => applyImportData(db, importData)).toThrow(/已存在/);
    expect(db.process_templates).toHaveLength(1);
  });

  it('项目引用缺失模板时报错', () => {
    const db = createDb();
    expect(() => applyImportData(db, {
      templates: importData.templates,
      projects: [{ ...importData.projects[0], templateCode: 'TMPL-X' }],
    })).toThrow(/引用的模板「TMPL-X」不存在/);
  });
});

describe('applyImportFile（真实 Excel 端到端 + 持久化）', () => {
  it('官方模板文件导入 → 保存 → 重新加载，数据完整', () => {
    const db = createDb();
    const xlsx = fileURLToPath(new URL('../templates/工序模板导入模板.xlsx', import.meta.url));
    const r = applyImportFile(db, xlsx);
    expect(r.ok).toBe(true);
    expect(r.templates).toBe(1);
    expect(r.projects).toBe(1);

    const dir = mkdtempSync(join(tmpdir(), 'pms-'));
    const file = join(dir, 'db.json');
    saveDbFile(file, db);
    const loaded = loadDbFile(file);
    expect(loaded.process_templates).toHaveLength(1);
    expect(loaded.process_template_steps).toHaveLength(5);
    expect(loaded.projects).toHaveLength(1);
    expect(loaded.project_processes).toHaveLength(5);
    expect(loaded.progress_logs).toEqual([]);
  });

  it('Excel 校验失败时不落任何数据', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['模板编号 *', '模板名称 *', '工序序号 *', '工序编码 *', '工序名称 *', '标准工时(h)', '前置工序编码', '建议设备类型', '备注'],
      ['TMPL-01', '机加路线', 1, 'OP10', '', 2, '', '', ''], // 缺工序名称
    ]), '工序模板');
    const dir = mkdtempSync(join(tmpdir(), 'pms-'));
    const file = join(dir, 'bad.xlsx');
    writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    const db = createDb();
    const r = applyImportFile(db, file);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(db.process_templates).toHaveLength(0);
    expect(db.projects).toHaveLength(0);
  });
});
