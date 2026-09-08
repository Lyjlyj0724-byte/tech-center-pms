/**
 * 工序模板导入 —— 校验层
 * 实现《需求与数据模型设计》第 7 节的全部 6 条校验规则：
 *   1. 必填列缺失
 *   2. 工序序号不连续 / 工序编码重复（含同一编号下模板名称不一致）
 *   3. 前置工序编码不存在或序号 >= 当前行（循环依赖）
 *   4. 项目清单引用的模板编号未定义
 *   5. 日期非法或完工早于开始
 *   6. 任一错误整体拒绝（由 importer 编排层保证，本层只负责收集全部错误）
 * 附加规则：优先级枚举、项目编号唯一、标准工时为正数。
 */
import { STEP_SHEET, PROJECT_SHEET } from './parseImportFile.js';

export const PRIORITIES = ['高', '中', '低'];

const isBlank = (v) => v == null || String(v).trim() === '';
const str = (v) => (v == null ? '' : String(v).trim());

/** 把单元格值归一化为 YYYY-MM-DD；非法返回 null。 */
export function toDateStr(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (dt.getFullYear() === Number(m[1]) && dt.getMonth() === Number(m[2]) - 1 && dt.getDate() === Number(m[3])) {
        return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      }
    }
  }
  return null;
}

/** 前置工序编码：支持英文/中文逗号分隔，去空白、去空项。 */
export function parsePrevCodes(v) {
  if (isBlank(v)) return [];
  return String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

const err = (sheet, row, message) => ({ sheet, row, message });

/**
 * 校验全部行数据，返回错误数组（空数组 = 全部通过）。
 * @param {{stepRows: Array, projectRows: Array}} input
 * @returns {Array<{sheet:string,row:number|null,message:string}>}
 */
export function validateImport({ stepRows, projectRows }) {
  const errors = [];

  // ---------- 规则 1：必填列 ----------
  for (const { rowNum, values: v } of stepRows) {
    for (const field of ['模板编号', '模板名称', '工序序号', '工序编码', '工序名称']) {
      if (isBlank(v[field])) errors.push(err(STEP_SHEET, rowNum, `缺少必填列「${field}」`));
    }
  }
  for (const { rowNum, values: v } of projectRows) {
    for (const field of ['项目编号', '项目名称', '负责人', '优先级', '计划开始日期', '计划完工日期', '工序模板编号']) {
      if (isBlank(v[field])) errors.push(err(PROJECT_SHEET, rowNum, `缺少必填列「${field}」`));
    }
  }

  // 必填缺失的行不再参与后续跨行校验，避免连锁误报
  const validStepRows = stepRows.filter(({ values: v }) =>
    ['模板编号', '工序序号', '工序编码'].every((f) => !isBlank(v[f])));

  // ---------- 规则 2：序号连续 / 编码重复 / 模板名称一致 ----------
  const byTemplate = new Map();
  for (const row of validStepRows) {
    const code = str(row.values['模板编号']);
    if (!byTemplate.has(code)) byTemplate.set(code, []);
    byTemplate.get(code).push(row);
  }

  for (const [tplCode, rows] of byTemplate) {
    // 2c 同一编号下模板名称须一致
    const names = new Set(rows.map((r) => str(r.values['模板名称'])).filter(Boolean));
    if (names.size > 1) {
      for (const r of rows) errors.push(err(STEP_SHEET, r.rowNum, `模板「${tplCode}」的模板名称不一致（${[...names].join(' / ')}）`));
    }
    // 2b 工序编码重复
    const seen = new Map();
    for (const r of rows) {
      const sc = str(r.values['工序编码']);
      if (seen.has(sc)) {
        errors.push(err(STEP_SHEET, r.rowNum, `工序编码「${sc}」在模板「${tplCode}」内重复（首次出现在第 ${seen.get(sc)} 行）`));
      } else {
        seen.set(sc, r.rowNum);
      }
    }
    // 2a 序号须为正整数且从 1 连续
    const seqs = [];
    for (const r of rows) {
      const n = Number(r.values['工序序号']);
      if (!Number.isInteger(n) || n < 1) {
        errors.push(err(STEP_SHEET, r.rowNum, `工序序号「${str(r.values['工序序号'])}」不是正整数`));
      } else {
        seqs.push(n);
      }
    }
    const sorted = [...seqs].sort((a, b) => a - b);
    const expected = Array.from({ length: sorted.length }, (_, i) => i + 1);
    if (sorted.length > 0 && sorted.some((n, i) => n !== expected[i])) {
      errors.push(err(STEP_SHEET, rows[0].rowNum,
        `模板「${tplCode}」的工序序号应从 1 连续编号，实际为 ${sorted.join('、')}`));
    }
  }

  // 标准工时：填了就必须是正数
  for (const { rowNum, values: v } of validStepRows) {
    if (!isBlank(v['标准工时(h)'])) {
      const h = Number(v['标准工时(h)']);
      if (!Number.isFinite(h) || h <= 0) {
        errors.push(err(STEP_SHEET, rowNum, `标准工时「${str(v['标准工时(h)'])}」不是正数`));
      }
    }
  }

  // ---------- 规则 3：前置工序存在且序号更小 ----------
  for (const [tplCode, rows] of byTemplate) {
    const seqOf = new Map(rows.map((r) => [str(r.values['工序编码']), Number(r.values['工序序号'])]));
    for (const r of rows) {
      const curSeq = Number(r.values['工序序号']);
      for (const prev of parsePrevCodes(r.values['前置工序编码'])) {
        if (!seqOf.has(prev)) {
          errors.push(err(STEP_SHEET, r.rowNum, `前置工序编码「${prev}」在模板「${tplCode}」内不存在`));
        } else if (seqOf.get(prev) >= curSeq) {
          errors.push(err(STEP_SHEET, r.rowNum,
            `前置工序「${prev}」(序号${seqOf.get(prev)}) 的序号必须小于当前工序「${str(r.values['工序编码'])}」(序号${curSeq})`));
        }
      }
    }
  }

  // ---------- 规则 4：项目引用的模板必须已定义 ----------
  const definedTemplates = new Set(byTemplate.keys());
  for (const { rowNum, values: v } of projectRows) {
    if (isBlank(v['工序模板编号'])) continue; // 规则 1 已报
    const tpl = str(v['工序模板编号']);
    if (!definedTemplates.has(tpl)) {
      errors.push(err(PROJECT_SHEET, rowNum, `工序模板编号「${tpl}」未在「工序模板」工作表中定义`));
    }
  }

  // ---------- 项目编号唯一 / 优先级枚举 ----------
  const seenProject = new Map();
  for (const { rowNum, values: v } of projectRows) {
    if (isBlank(v['项目编号'])) continue;
    const pc = str(v['项目编号']);
    if (seenProject.has(pc)) {
      errors.push(err(PROJECT_SHEET, rowNum, `项目编号「${pc}」重复（首次出现在第 ${seenProject.get(pc)} 行）`));
    } else {
      seenProject.set(pc, rowNum);
    }
    if (!isBlank(v['优先级']) && !PRIORITIES.includes(str(v['优先级']))) {
      errors.push(err(PROJECT_SHEET, rowNum, `优先级「${str(v['优先级'])}」无效，只能是 ${PRIORITIES.join(' / ')}`));
    }
  }

  // ---------- 规则 5：日期合法且完工不早于开始 ----------
  for (const { rowNum, values: v } of projectRows) {
    const start = toDateStr(v['计划开始日期']);
    const end = toDateStr(v['计划完工日期']);
    if (!isBlank(v['计划开始日期']) && !start) {
      errors.push(err(PROJECT_SHEET, rowNum, `计划开始日期「${str(v['计划开始日期'])}」格式非法，应为 YYYY-MM-DD`));
    }
    if (!isBlank(v['计划完工日期']) && !end) {
      errors.push(err(PROJECT_SHEET, rowNum, `计划完工日期「${str(v['计划完工日期'])}」格式非法，应为 YYYY-MM-DD`));
    }
    if (start && end && end < start) {
      errors.push(err(PROJECT_SHEET, rowNum, `计划完工日期 ${end} 早于计划开始日期 ${start}`));
    }
  }

  return errors;
}
