/**
 * 导入模块单测：覆盖设计文档第 7 节全部 6 条校验规则 + 正常路径 + 真实模板文件。
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { importWorkbookData, importWorkbook, formatErrors } from '../src/import/importer.js';

const STEP_HEADER_ROW = [
  '模板编号 *', '模板名称 *', '工序序号 *', '工序编码 *', '工序名称 *',
  '标准工时(h)', '前置工序编码', '建议设备类型', '备注',
];
const PROJ_HEADER_ROW = [
  '项目编号 *', '项目名称 *', '负责人 *', '优先级 *',
  '计划开始日期 *', '计划完工日期 *', '工序模板编号 *',
];
const STEP_TIPS = [
  '同一模板填相同编号', '同一编号下名称一致', '从1连续编号',
  '模板内唯一，建议OP10/OP20跳号', '不超过50字', '正数，可空',
  '可空，多个用英文逗号分隔', '可空', '可空',
];
const PROJ_TIPS = [
  '唯一', '', '', '高 / 中 / 低', 'YYYY-MM-DD', '不早于开始日期',
  '须已在「工序模板」Sheet 定义',
];

const validSteps = [
  ['TMPL-01', '机加路线', 1, 'OP10', '下料', 2, '', '锯床', ''],
  ['TMPL-01', '机加路线', 2, 'OP20', '粗加工', 8, 'OP10', '数控车床', ''],
  ['TMPL-01', '机加路线', 3, 'OP30', '精加工', 10, 'OP20', '加工中心', ''],
  ['TMPL-01', '机加路线', 4, 'OP40', '检验', 2, 'OP20,OP30', '三坐标', ''],
];
const validProjects = [
  ['PRJ-001', '传动箱试制', '张三', '高', '2026-10-01', '2026-12-31', 'TMPL-01'],
];

function makeWb(stepRows, projRows, { withTips = true, includeProjectSheet = true } = {}) {
  const wb = XLSX.utils.book_new();
  const stepAoa = [STEP_HEADER_ROW, ...(withTips ? [STEP_TIPS] : []), ...stepRows];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stepAoa), '工序模板');
  if (includeProjectSheet) {
    const projAoa = [PROJ_HEADER_ROW, ...(withTips ? [PROJ_TIPS] : []), ...projRows];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(projAoa), '项目清单');
  }
  return wb;
}

describe('正常路径', () => {
  it('合法数据导入成功并归一化（模板按序号排序、前置编码解析、日期格式化）', () => {
    const r = importWorkbookData(makeWb(validSteps, validProjects));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    const tpl = r.data.templates[0];
    expect(tpl.code).toBe('TMPL-01');
    expect(tpl.steps.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(tpl.steps[3].prevCodes).toEqual(['OP20', 'OP30']);
    expect(tpl.steps[1].stdHours).toBe(8);
    expect(r.data.projects[0]).toMatchObject({
      code: 'PRJ-001', owner: '张三', priority: '高',
      planStart: '2026-10-01', planEnd: '2026-12-31', templateCode: 'TMPL-01',
    });
  });

  it('删除提示行后数据从第 2 行开始也能正确导入', () => {
    const r = importWorkbookData(makeWb(validSteps, validProjects, { withTips: false }));
    expect(r.ok).toBe(true);
    expect(r.data.templates[0].steps).toHaveLength(4);
  });

  it('官方下发的真实模板文件（含示例行）可导入', () => {
    const p = fileURLToPath(new URL('../templates/工序模板导入模板.xlsx', import.meta.url));
    const r = importWorkbook(p);
    expect(formatErrors(r.errors)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.data.templates).toHaveLength(1);
    expect(r.data.templates[0].steps.map((s) => s.stepName))
      .toEqual(['下料', '粗加工', '热处理', '精加工', '检验']);
    expect(r.data.projects).toHaveLength(1);
  });
});

describe('规则 1：必填列缺失', () => {
  it('缺少工序名称时报具体行号与列名', () => {
    const rows = structuredClone(validSteps);
    rows[1][4] = '';
    const r = importWorkbookData(makeWb(rows, validProjects));
    expect(r.ok).toBe(false);
    expect(formatErrors(r.errors).some((m) => m.includes('第4行') && m.includes('工序名称'))).toBe(true);
  });
});

describe('规则 2：序号连续 / 编码重复 / 名称一致', () => {
  it('序号跳号（1,2,4）报连续编号错误', () => {
    const rows = structuredClone(validSteps);
    rows[3][2] = 5; // OP40 序号 4 → 5，变成 1,2,3,5
    rows[3][3] = 'OP50';
    rows.splice(2, 1); // 删掉 OP30 → 序号 1,2,5
    rows[2][6] = 'OP20'; // OP50 前置改为 OP20
    const r = importWorkbookData(makeWb(rows, validProjects));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('连续编号'))).toBe(true);
  });

  it('工序编码重复时报错并指出首次出现行', () => {
    const rows = structuredClone(validSteps);
    rows[2][3] = 'OP10'; // OP30 → OP10 重复
    rows[3][6] = 'OP20'; // 避免连锁的前置不存在报错干扰断言
    const r = importWorkbookData(makeWb(rows, validProjects));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('重复') && e.message.includes('OP10'))).toBe(true);
  });

  it('同一模板编号下名称不一致报错', () => {
    const rows = structuredClone(validSteps);
    rows[1][1] = '另一条路线';
    const r = importWorkbookData(makeWb(rows, validProjects));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('模板名称不一致'))).toBe(true);
  });
});

describe('规则 3：前置工序依赖', () => {
  it('前置工序编码不存在时报错', () => {
    const rows = structuredClone(validSteps);
    rows[1][6] = 'OP99';
    const r = importWorkbookData(makeWb(rows, validProjects));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('OP99') && e.message.includes('不存在'))).toBe(true);
  });

  it('前置工序序号不小于当前工序（循环依赖）时报错', () => {
    const rows = structuredClone(validSteps);
    rows[1][6] = 'OP40'; // OP20 的前置指向序号更大的 OP40
    const r = importWorkbookData(makeWb(rows, validProjects));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('必须小于当前工序'))).toBe(true);
  });

  it('支持中文逗号分隔的并行前置', () => {
    const rows = structuredClone(validSteps);
    rows[3][6] = 'OP20，OP30';
    const r = importWorkbookData(makeWb(rows, validProjects));
    expect(r.ok).toBe(true);
    expect(r.data.templates[0].steps[3].prevCodes).toEqual(['OP20', 'OP30']);
  });
});

describe('规则 4：项目引用的模板必须已定义', () => {
  it('引用未定义模板编号时报错', () => {
    const projects = structuredClone(validProjects);
    projects[0][6] = 'TMPL-NOT-EXIST';
    const r = importWorkbookData(makeWb(validSteps, projects));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.sheet === '项目清单' && e.message.includes('TMPL-NOT-EXIST'))).toBe(true);
  });
});

describe('规则 5：日期校验', () => {
  it('非法日期格式报错', () => {
    const projects = structuredClone(validProjects);
    projects[0][4] = '2026/10/01';
    const r = importWorkbookData(makeWb(validSteps, projects));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('计划开始日期') && e.message.includes('非法'))).toBe(true);
  });

  it('完工日期早于开始日期报错', () => {
    const projects = structuredClone(validProjects);
    projects[0][5] = '2026-09-01';
    const r = importWorkbookData(makeWb(validSteps, projects));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('早于计划开始日期'))).toBe(true);
  });
});

describe('规则 6：整体拒绝', () => {
  it('存在任一错误时不返回任何数据', () => {
    const rows = structuredClone(validSteps);
    rows[0][4] = ''; // 一个错误
    const r = importWorkbookData(makeWb(rows, validProjects));
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
  });
});

describe('附加规则与结构性错误', () => {
  it('优先级不在 高/中/低 时报错', () => {
    const projects = structuredClone(validProjects);
    projects[0][3] = '特急';
    const r = importWorkbookData(makeWb(validSteps, projects));
    expect(r.errors.some((e) => e.message.includes('优先级'))).toBe(true);
  });

  it('项目编号重复时报错', () => {
    const projects = [...validProjects, structuredClone(validProjects[0])];
    projects[1][1] = '另一个项目';
    const r = importWorkbookData(makeWb(validSteps, projects));
    expect(r.errors.some((e) => e.message.includes('项目编号') && e.message.includes('重复'))).toBe(true);
  });

  it('标准工时不是正数时报错', () => {
    const rows = structuredClone(validSteps);
    rows[0][5] = -3;
    const r = importWorkbookData(makeWb(rows, validProjects));
    expect(r.errors.some((e) => e.message.includes('标准工时'))).toBe(true);
  });

  it('缺少「工序模板」工作表时报结构性错误', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([PROJ_HEADER_ROW]), '项目清单');
    const r = importWorkbookData(wb);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('缺少「工序模板」工作表'))).toBe(true);
  });

  it('「工序模板」没有数据行时报错', () => {
    const r = importWorkbookData(makeWb([], validProjects));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('没有任何工序数据行'))).toBe(true);
  });
});
