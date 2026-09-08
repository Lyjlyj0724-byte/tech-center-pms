/**
 * 工序模板导入 —— 编排层
 * parse → validate → normalize，任一错误则整体拒绝（规则 6），
 * 全部通过才返回可写入存储的规范化数据。
 */
import XLSX from 'xlsx';
import { parseImportWorkbook } from './parseImportFile.js';
import { validateImport, toDateStr, parsePrevCodes } from './validateImport.js';

const str = (v) => (v == null ? '' : String(v).trim());
const blankToNull = (v) => (v == null || String(v).trim() === '' ? null : str(v));

/**
 * 把校验通过的原始行归一化为存储结构：
 * templates: [{ code, name, version, steps: [{seq, stepCode, stepName, stdHours, prevCodes, equipmentType, remark}] }]
 * projects:  [{ code, name, owner, priority, planStart, planEnd, templateCode, remark }]
 */
function normalize(stepRows, projectRows) {
  const byTemplate = new Map();
  for (const { values: v } of stepRows) {
    const code = str(v['模板编号']);
    if (!byTemplate.has(code)) {
      byTemplate.set(code, { code, name: str(v['模板名称']), version: 1, steps: [] });
    }
    byTemplate.get(code).steps.push({
      seq: Number(v['工序序号']),
      stepCode: str(v['工序编码']),
      stepName: str(v['工序名称']),
      stdHours: blankToNull(v['标准工时(h)']) == null ? null : Number(v['标准工时(h)']),
      prevCodes: parsePrevCodes(v['前置工序编码']),
      equipmentType: blankToNull(v['建议设备类型']),
      remark: blankToNull(v['备注']),
    });
  }
  const templates = [...byTemplate.values()].map((t) => ({
    ...t,
    steps: t.steps.sort((a, b) => a.seq - b.seq),
  }));

  const projects = projectRows.map(({ values: v }) => ({
    code: str(v['项目编号']),
    name: str(v['项目名称']),
    owner: str(v['负责人']),
    priority: str(v['优先级']),
    planStart: toDateStr(v['计划开始日期']),
    planEnd: toDateStr(v['计划完工日期']),
    templateCode: str(v['工序模板编号']),
  }));

  return { templates, projects };
}

/**
 * 从已读取的工作簿导入。
 * @returns {{ ok: boolean, errors: Array, data?: {templates: Array, projects: Array} }}
 */
export function importWorkbookData(workbook) {
  const { stepRows, projectRows, errors: parseErrors } = parseImportWorkbook(workbook);
  if (parseErrors.length > 0) return { ok: false, errors: parseErrors };

  const errors = validateImport({ stepRows, projectRows });
  if (errors.length > 0) return { ok: false, errors }; // 规则 6：任一错误整体拒绝

  return { ok: true, errors: [], data: normalize(stepRows, projectRows) };
}

/** 从 Excel 文件路径导入。 */
export function importWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  return importWorkbookData(workbook);
}

/** 格式化错误为人类可读明细，如 「[工序模板] 第5行：缺少必填列「工序名称」」。 */
export function formatErrors(errors) {
  return errors.map((e) => `[${e.sheet}] ${e.row == null ? '' : `第${e.row}行：`}${e.message}`);
}
