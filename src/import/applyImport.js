/**
 * 导入落库桥接：把 importer 的规范化数据写入存储。
 * 模板按编号去重（已存在则拒绝，避免静默覆盖在建项目引用的模板）；
 * 项目统一走 createProject 实例化工序路线，保证与手工创建行为一致。
 */
import crypto from 'node:crypto';
import { importWorkbook } from './importer.js';
import { createProject, DomainError } from '../domain/projectService.js';

const uid = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
const now = () => new Date().toISOString();

/**
 * @param {object} db
 * @param {{templates: Array, projects: Array}} data  importer 的 data
 * @returns {{ templates: number, projects: number, templateIds: string[], projectIds: string[] }}
 */
export function applyImportData(db, data) {
  // 先整体验证：任一模板编号已存在则整体拒绝（与导入校验"全或无"语义一致）
  const existing = data.templates.filter((t) => db.process_templates.some((x) => x.code === t.code));
  if (existing.length > 0) {
    throw new DomainError(
      `模板编号已存在，不能重复导入：${existing.map((t) => t.code).join('、')}`,
    );
  }

  const templateIds = [];
  for (const t of data.templates) {
    const template = {
      id: uid('tmpl'),
      code: t.code,
      name: t.name,
      category: null,
      version: t.version ?? 1,
      status: 'active',
      remark: null,
      created_at: now(),
      updated_at: now(),
    };
    db.process_templates.push(template);
    for (const s of t.steps) {
      db.process_template_steps.push({
        id: uid('ts'),
        template_id: template.id,
        seq: s.seq,
        step_code: s.stepCode,
        step_name: s.stepName,
        std_hours: s.stdHours,
        prev_codes: s.prevCodes,
        equipment_type: s.equipmentType,
        remark: s.remark,
      });
    }
    templateIds.push(template.id);
  }

  const projectIds = [];
  for (const p of data.projects ?? []) {
    const template = db.process_templates.find((t) => t.code === p.templateCode && t.status === 'active');
    if (!template) throw new DomainError(`项目「${p.code}」引用的模板「${p.templateCode}」不存在`);
    const { project } = createProject(db, {
      code: p.code,
      name: p.name,
      owner: p.owner,
      priority: p.priority,
      planStart: p.planStart,
      planEnd: p.planEnd,
      templateId: template.id,
    });
    projectIds.push(project.id);
  }

  return { templates: templateIds.length, projects: projectIds.length, templateIds, projectIds };
}

/**
 * 从 Excel 文件导入并落库。
 * @returns 成功：{ ok: true, ...applyImportData 结果 }；失败：{ ok: false, errors }
 */
export function applyImportFile(db, filePath) {
  const r = importWorkbook(filePath);
  if (!r.ok) return { ok: false, errors: r.errors };
  return { ok: true, ...applyImportData(db, r.data) };
}
