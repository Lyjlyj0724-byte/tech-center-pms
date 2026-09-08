/**
 * 项目域服务单测：CRUD、模板实例化、项目内工序路线调整。
 */
import { describe, it, expect } from 'vitest';
import { createDb } from '../src/store/db.js';
import {
  createProject, getProject, listProjects, updateProject, deleteProject,
  addProcess, updateProcess, removeProcess, reorderProcesses, DomainError,
} from '../src/domain/projectService.js';

function seedDb() {
  const db = createDb();
  db.process_templates.push({
    id: 'tmpl_1', code: 'TMPL-01', name: '机加路线', category: null,
    version: 1, status: 'active', remark: null, created_at: '', updated_at: '',
  });
  const steps = [
    ['OP10', '下料', 2, []],
    ['OP20', '粗加工', 8, ['OP10']],
    ['OP30', '精加工', 10, ['OP20']],
    ['OP40', '检验', 2, ['OP20', 'OP30']],
  ];
  steps.forEach(([code, name, hours, prev], i) => {
    db.process_template_steps.push({
      id: `ts_${code}`, template_id: 'tmpl_1', seq: i + 1,
      step_code: code, step_name: name, std_hours: hours,
      prev_codes: prev, equipment_type: null, remark: null,
    });
  });
  return db;
}

const validInput = {
  code: 'PRJ-001', name: '传动箱试制', owner: '张三', priority: '高',
  planStart: '2026-10-01', planEnd: '2026-12-31', templateId: 'tmpl_1',
};

describe('createProject：套用模板实例化', () => {
  it('复制模板工序为项目工序，前置编码换算为 id 引用', () => {
    const db = seedDb();
    const { project, processes } = createProject(db, validInput);
    expect(project.status).toBe('未启动');
    expect(processes.map((p) => p.seq)).toEqual([1, 2, 3, 4]);
    expect(processes.every((p) => p.project_id === project.id)).toBe(true);
    const byCode = new Map(processes.map((p) => [p.step_code, p]));
    expect(byCode.get('OP40').prev_ids)
      .toEqual([byCode.get('OP20').id, byCode.get('OP30').id]);
    expect(processes.every((p) => p.status === '未开始' && p.progress_pct === 0)).toBe(true);
  });

  it('实例化后修改模板不影响在建项目', () => {
    const db = seedDb();
    const { processes } = createProject(db, validInput);
    db.process_template_steps.find((s) => s.step_code === 'OP10').step_name = '激光下料';
    expect(processes.find((p) => p.step_code === 'OP10').step_name).toBe('下料');
  });

  it('项目编号重复 / 模板不存在 / 模板停用 / 日期非法均拒绝', () => {
    const db = seedDb();
    createProject(db, validInput);
    expect(() => createProject(db, validInput)).toThrow(DomainError);
    expect(() => createProject(db, { ...validInput, code: 'PRJ-002', templateId: 'nope' }))
      .toThrow(/不存在/);
    db.process_templates[0].status = 'disabled';
    expect(() => createProject(db, { ...validInput, code: 'PRJ-002' })).toThrow(/停用/);
    db.process_templates[0].status = 'active';
    expect(() => createProject(db, { ...validInput, code: 'PRJ-002', planEnd: '2026-09-01' }))
      .toThrow(/早于/);
    expect(() => createProject(db, { ...validInput, code: 'PRJ-002', priority: '特急' }))
      .toThrow(/优先级/);
  });
});

describe('项目 CRUD', () => {
  it('getProject / listProjects / updateProject', () => {
    const db = seedDb();
    const { project } = createProject(db, validInput);
    createProject(db, { ...validInput, code: 'PRJ-002', name: '另一项目' });
    expect(listProjects(db)).toHaveLength(2);
    expect(getProject(db, project.id).processes).toHaveLength(4);

    const updated = updateProject(db, project.id, { status: '进行中', owner: '李四' });
    expect(updated.status).toBe('进行中');
    expect(updated.owner).toBe('李四');
    expect(listProjects(db, { status: '进行中' })).toHaveLength(1);
    expect(() => updateProject(db, project.id, { status: '归档' })).toThrow(/状态/);
    expect(() => updateProject(db, project.id, { plan_end: '2026-01-01' })).toThrow(/早于/);
  });

  it('deleteProject 级联删除工序与进度记录', () => {
    const db = seedDb();
    const { project, processes } = createProject(db, validInput);
    db.progress_logs.push({
      id: 'log_1', project_process_id: processes[0].id,
      record_date: '2026-10-02', progress_pct: 50, note: null, recorded_by: '张三',
    });
    const r = deleteProject(db, project.id);
    expect(r).toEqual({ removedProcesses: 4, removedLogs: 1 });
    expect(db.projects).toHaveLength(0);
    expect(db.project_processes).toHaveLength(0);
    expect(db.progress_logs).toHaveLength(0);
  });
});

describe('项目内工序路线调整', () => {
  it('addProcess 追加到末尾，编码重复与跨项目前置被拒绝', () => {
    const db = seedDb();
    const { project, processes } = createProject(db, validInput);
    const { project: other } = createProject(db, { ...validInput, code: 'PRJ-002' });
    const otherProc = db.project_processes.find((p) => p.project_id === other.id);

    const added = addProcess(db, project.id, {
      stepCode: 'OP50', stepName: '包装', prevIds: [processes[3].id],
    });
    expect(added.seq).toBe(5);
    expect(() => addProcess(db, project.id, { stepCode: 'OP10', stepName: 'x' }))
      .toThrow(/已存在/);
    expect(() => addProcess(db, project.id, { stepCode: 'OP60', stepName: 'y', prevIds: [otherProc.id] }))
      .toThrow(/不属于本项目/);
  });

  it('updateProcess 检测前置依赖循环', () => {
    const db = seedDb();
    const { processes } = createProject(db, validInput);
    const [op10, op20, , op40] = processes;
    // OP20 本来就依赖 OP10，直接互指立即成环
    expect(() => updateProcess(db, op10.id, { prevIds: [op20.id] })).toThrow(/循环/);
    // 合法调整：OP40 改为只依赖 OP10
    updateProcess(db, op40.id, { prevIds: [op10.id], owner: '王五' });
    expect(op40.prev_ids).toEqual([op10.id]);
    expect(op40.owner).toBe('王五');
    // 再让 OP10 依赖 OP40 → 经由 OP40.prev=[OP10] 成环
    expect(() => updateProcess(db, op10.id, { prevIds: [op40.id] })).toThrow(/循环/);
  });

  it('removeProcess 被引用时拒绝，force 时剥离引用', () => {
    const db = seedDb();
    const { processes } = createProject(db, validInput);
    const op20 = processes[1];
    expect(() => removeProcess(db, op20.id)).toThrow(/引用为前置/);
    const r = removeProcess(db, op20.id, { force: true });
    expect(r.strippedDependents).toHaveLength(2);
    const remaining = db.project_processes;
    expect(remaining).toHaveLength(3);
    expect(remaining.every((p) => !p.prev_ids.includes(op20.id))).toBe(true);
  });

  it('reorderProcesses 要求完整排列并重写序号', () => {
    const db = seedDb();
    const { project, processes } = createProject(db, validInput);
    const reversed = processes.map((p) => p.id).reverse();
    const after = reorderProcesses(db, project.id, reversed);
    expect(after.map((p) => p.step_code)).toEqual(['OP40', 'OP30', 'OP20', 'OP10']);
    expect(after.map((p) => p.seq)).toEqual([1, 2, 3, 4]);
    expect(() => reorderProcesses(db, project.id, [processes[0].id])).toThrow(/排列/);
  });
});
