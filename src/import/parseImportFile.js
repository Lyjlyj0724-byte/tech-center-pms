/**
 * 工序模板导入 —— Excel 解析层
 * 把「工序模板」「项目清单」两个 Sheet 解析成带行号的原始行数据，
 * 不做业务校验（校验在 validateImport.js）。
 */
import XLSX from 'xlsx';

export const STEP_SHEET = '工序模板';
export const PROJECT_SHEET = '项目清单';

/** 期望列（去掉必填标记 * 后的列名） */
export const STEP_HEADERS = [
  '模板编号', '模板名称', '工序序号', '工序编码', '工序名称',
  '标准工时(h)', '前置工序编码', '建议设备类型', '备注',
];
export const PROJECT_HEADERS = [
  '项目编号', '项目名称', '负责人', '优先级',
  '计划开始日期', '计划完工日期', '工序模板编号',
];

/** 官方模板第 2 行的填写提示（导入时忽略该行；若用户删除了提示行则自动从第 2 行读数据） */
const STEP_TIPS = [
  '同一模板填相同编号', '同一编号下名称一致', '从1连续编号',
  '模板内唯一，建议OP10/OP20跳号', '不超过50字', '正数，可空',
  '可空，多个用英文逗号分隔', '可空', '可空',
];
const PROJECT_TIPS = [
  '唯一', '', '', '高 / 中 / 低', 'YYYY-MM-DD', '不早于开始日期',
  '须已在「工序模板」Sheet 定义',
];

const stripStar = (s) => String(s).replace(/\s*\*\s*$/, '').trim();

/**
 * 解析单个 Sheet 为行数组。
 * @returns {{ rows: Array<{rowNum:number, values:Object}>, error: string|null }}
 */
function parseSheet(workbook, sheetName, headers, tips, required) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) {
    if (required) return { rows: [], error: `缺少「${sheetName}」工作表` };
    return { rows: [], error: null };
  }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  if (aoa.length === 0) {
    return { rows: [], error: required ? `「${sheetName}」工作表为空` : null };
  }

  // 表头映射：按列名定位列序号，容忍列顺序变化
  const headerRow = aoa[0].map((c) => (c == null ? '' : stripStar(c)));
  const colIndex = new Map();
  headerRow.forEach((name, i) => { if (name) colIndex.set(name, i); });
  const missing = headers.filter((h) => !colIndex.has(h));
  if (missing.length > 0) {
    return { rows: [], error: `「${sheetName}」缺少列：${missing.join('、')}` };
  }

  const rows = [];
  for (let r = 1; r < aoa.length; r += 1) {
    const raw = aoa[r];
    const values = {};
    headers.forEach((h) => { values[h] = raw[colIndex.get(h)] ?? null; });

    // 跳过官方模板的提示行
    const asStrings = headers.map((h) => (values[h] == null ? '' : String(values[h]).trim()));
    if (tips && asStrings.every((v, i) => v === tips[i])) continue;
    // 跳过整行空白
    if (asStrings.every((v) => v === '')) continue;

    rows.push({ rowNum: r + 1, values });
  }
  return { rows, error: null };
}

/**
 * 解析整个导入工作簿。
 * @param {XLSX.WorkBook} workbook
 * @returns {{ stepRows: Array, projectRows: Array, errors: Array<{sheet:string,row:null,message:string}> }}
 */
export function parseImportWorkbook(workbook) {
  const errors = [];

  const steps = parseSheet(workbook, STEP_SHEET, STEP_HEADERS, STEP_TIPS, true);
  if (steps.error) errors.push({ sheet: STEP_SHEET, row: null, message: steps.error });

  const projects = parseSheet(workbook, PROJECT_SHEET, PROJECT_HEADERS, PROJECT_TIPS, false);
  if (projects.error) errors.push({ sheet: PROJECT_SHEET, row: null, message: projects.error });

  if (!steps.error && steps.rows.length === 0) {
    errors.push({ sheet: STEP_SHEET, row: null, message: '「工序模板」没有任何工序数据行' });
  }

  return { stepRows: steps.rows, projectRows: projects.rows, errors };
}

/**
 * 从文件读取并解析（cellDates: true 让日期列直接得到 Date 对象）。
 * @param {string} filePath
 */
export function parseImportFile(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  return parseImportWorkbook(workbook);
}
