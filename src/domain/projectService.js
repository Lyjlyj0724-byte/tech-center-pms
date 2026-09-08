/**
 * 项目域服务：项目 CRUD + 套用工序模板实例化项目工序路线。
 * 关键设计：创建项目时把模板工序**复制**成项目自己的工序（project_processes），
 * 前置依赖由模板内的编码引用换算为项目工序 id 引用；此后模板修改不影响在建项目。
 */
import crypto from 'node:crypto';

export const PROJECT_STATUSES = ['未启动', '进行中', '已完成', '暂停', '已取消'];
export const PROCESS_STATUSES = ['未开始', '进行中', '已完成', '暂停'];
export const PRIORITIES = ['高', '中', '低'];

export class DomainError extends Error {}

const uid = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
const now = () => new Date().toISOString();
const isBlank = (v) => v == null || String(v).trim() === '';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireFields(input, fields, what) {
  for (const f of fields) {
    if (isBlank(input[f])) throw new DomainError(`${what}缺少必填字段「${f}」`);
  }
}

function checkDates(planStart, planEnd) {
  if (!DATE_RE.test(planStart) || !DATE_RE.test(planEnd)) {
    throw new DomainError('计划日期格式应为 YYYY-MM-DD');
  }
  if (planEnd < planStart) throw new DomainError(`计划完工日期 ${planEnd} 早于计划开始日期 ${planStart}`);
}

/**
 * 创建项目并套用模板实例化工序路线。
 * @param {object} db
 * @param {{code,name,owner,priority,planStart,planEnd,templateId,remark?}} input
 */
export function createProject(db, input) {
  requireFields(input, ['code', 'name', 'owner', 'priority', 'planStart', 'planEnd', 'templateId'], '项目');
  if (!PRIORITIES.includes(input.priority)) {
    throw new DomainError(`优先级「${input.priority}」无效，只能是 ${PRIORITIES.join(' / ')}`);
  }
  checkDates(input.planStart, input.planEnd);
  if (db.projects.some((p) => p.code === input.code)) {
    throw new DomainError(`项目编号「${input.code}」已存在`);
  }
  const template = db.process_templates.find((t) => t.id === input.templateId);
  if (!template) throw new DomainError(`工序模板「${input.templateId}」不存在`);
  if (template.status !== 'active') throw new DomainError(`工序模板「${template.name}」已停用，不能套用`);

  const steps = db.process_template_steps
    .filter((s) => s.template_id === template.id)
    .sort((a, b) => a.seq - b.seq);

  const project = {
    id: uid('prj'),
    code: input.code,
    name: input.name,
    owner: input.owner,
    priority: input.priority,
    plan_start: input.planStart,
    plan_end: input.planEnd,
    status: '未启动',
    template_id: template.id,
    remark: input.remark ?? null,
    created_at: now(),
    updated_at: now(),
  };

  // 模板编码 → 项目工序 id 的映射，用于换算前置依赖
  const idByCode = new Map(steps.map((s) => [s.step_code, uid('pp')]));
  const processes = steps.map((s) => ({
    id: idByCode.get(s.step_code),
    project_id: project.id,
    seq: s.seq,
    step_code: s.step_code,
    step_name: s.step_name,
    std_hours: s.std_hours,
    prev_ids: (s.prev_codes ?? []).map((c) => idByCode.get(c)).filter(Boolean),
    owner: null,
    plan_start: null,
    plan_end: null,
    actual_start: null,
    actual_end: null,
    status: '未开始',
    progress_pct: 0,
    remark: null,
  }));

  db.projects.push(project);
  db.project_processes.push(...processes);
  return { project, processes };
}

/** 项目详情（含按序号排序的工序路线）。 */
export function getProject(db, id) {
  const project = db.projects.find((p) => p.id === id);
  if (!project) throw new DomainError(`项目「${id}」不存在`);
  const processes = db.project_processes
    .filter((p) => p.project_id === id)
    .sort((a, b) => a.seq - b.seq);
  return { project, processes };
}

/** 项目列表，可按状态过滤。 */
export function listProjects(db, { status } = {}) {
  return db.projects.filter((p) => !status || p.status === status);
}

/** 更新项目基本信息（不含工序路线）。 */
export function updateProject(db, id, patch) {
  const project = db.projects.find((p) => p.id === id);
  if (!project) throw new DomainError(`项目「${id}」不存在`);
  const next = { ...project, ...patch };
  if (patch.status && !PROJECT_STATUSES.includes(patch.status)) {
    throw new DomainError(`项目状态「${patch.status}」无效`);
  }
  if (patch.priority && !PRIORITIES.includes(patch.priority)) {
    throw new DomainError(`优先级「${patch.priority}」无效`);
  }
  checkDates(next.plan_start, next.plan_end);
  const allowed = ['name', 'owner', 'priority', 'plan_start', 'plan_end', 'status', 'remark'];
  for (const k of allowed) {
    if (k in patch) project[k] = patch[k];
  }
  project.updated_at = now();
  return project;
}

/** 删除项目：级联删除其工序与进度记录，返回删除数量。 */
export function deleteProject(db, id) {
  const project = db.projects.find((p) => p.id === id);
  if (!project) throw new DomainError(`项目「${id}」不存在`);
  const processIds = new Set(db.project_processes.filter((p) => p.project_id === id).map((p) => p.id));
  const before = { processes: db.project_processes.length, logs: db.progress_logs.length };
  db.project_processes = db.project_processes.filter((p) => p.project_id !== id);
  db.progress_logs = db.progress_logs.filter((l) => !processIds.has(l.project_process_id));
  db.projects = db.projects.filter((p) => p.id !== id);
  return {
    removedProcesses: before.processes - db.project_processes.length,
    removedLogs: before.logs - db.progress_logs.length,
  };
}

// ---------- 项目内工序路线调整 ----------

function mustProcess(db, processId) {
  const p = db.project_processes.find((x) => x.id === processId);
  if (!p) throw new DomainError(`项目工序「${processId}」不存在`);
  return p;
}

function checkPrevIds(db, projectId, prevIds, selfId) {
  for (const pid of prevIds) {
    const prev = db.project_processes.find((x) => x.id === pid);
    if (!prev || prev.project_id !== projectId) {
      throw new DomainError(`前置工序「${pid}」不属于本项目`);
    }
    if (pid === selfId) throw new DomainError('工序不能以前置依赖自己');
  }
  // 循环检测：从每个前置沿 prev_ids 向上走，不能回到 selfId
  const reaches = (startId, targetId, seen = new Set()) => {
    if (startId === targetId) return true;
    if (seen.has(startId)) return false;
    seen.add(startId);
    const node = db.project_processes.find((x) => x.id === startId);
    return (node?.prev_ids ?? []).some((p) => reaches(p, targetId, seen));
  };
  for (const pid of prevIds) {
    if (reaches(pid, selfId)) throw new DomainError('前置依赖会形成循环');
  }
}

/** 项目内新增工序（追加到路线末尾）。 */
export function addProcess(db, projectId, input) {
  const { project } = getProject(db, projectId);
  requireFields(input, ['stepCode', 'stepName'], '工序');
  const siblings = db.project_processes.filter((p) => p.project_id === projectId);
  if (siblings.some((p) => p.step_code === input.stepCode)) {
    throw new DomainError(`工序编码「${input.stepCode}」在项目「${project.name}」内已存在`);
  }
  const prevIds = input.prevIds ?? [];
  const process = {
    id: uid('pp'),
    project_id: projectId,
    seq: siblings.length ? Math.max(...siblings.map((p) => p.seq)) + 1 : 1,
    step_code: input.stepCode,
    step_name: input.stepName,
    std_hours: input.stdHours ?? null,
    prev_ids: prevIds,
    owner: input.owner ?? null,
    plan_start: input.planStart ?? null,
    plan_end: input.planEnd ?? null,
    actual_start: null,
    actual_end: null,
    status: '未开始',
    progress_pct: 0,
    remark: input.remark ?? null,
  };
  checkPrevIds(db, projectId, prevIds, process.id);
  if (process.plan_start && process.plan_end) checkDates(process.plan_start, process.plan_end);
  db.project_processes.push(process);
  return process;
}

/** 更新项目工序（名称/工时/负责人/计划/前置依赖）。 */
export function updateProcess(db, processId, patch) {
  const process = mustProcess(db, processId);
  if ('prevIds' in patch) checkPrevIds(db, process.project_id, patch.prevIds, processId);
  const map = {
    stepName: 'step_name', stdHours: 'std_hours', owner: 'owner',
    planStart: 'plan_start', planEnd: 'plan_end', remark: 'remark', prevIds: 'prev_ids',
  };
  const next = { ...process };
  for (const [from, to] of Object.entries(map)) {
    if (from in patch) next[to] = patch[from];
  }
  if (next.plan_start && next.plan_end) checkDates(next.plan_start, next.plan_end);
  Object.assign(process, next);
  return process;
}

/**
 * 删除项目工序。若被其他工序引用为前置：默认拒绝；force 时自动剥离这些引用。
 */
export function removeProcess(db, processId, { force = false } = {}) {
  const process = mustProcess(db, processId);
  const dependents = db.project_processes.filter((p) => p.prev_ids.includes(processId));
  if (dependents.length > 0 && !force) {
    throw new DomainError(
      `工序「${process.step_name}」被 ${dependents.map((d) => d.step_name).join('、')} 引用为前置，不能删除`,
    );
  }
  for (const d of dependents) d.prev_ids = d.prev_ids.filter((x) => x !== processId);
  db.project_processes = db.project_processes.filter((p) => p.id !== processId);
  db.progress_logs = db.progress_logs.filter((l) => l.project_process_id !== processId);
  return { strippedDependents: dependents.map((d) => d.id) };
}

/** 重排工序顺序：orderedIds 必须是本项目全部工序 id 的一个排列。 */
export function reorderProcesses(db, projectId, orderedIds) {
  const siblings = db.project_processes.filter((p) => p.project_id === projectId);
  const ids = new Set(siblings.map((p) => p.id));
  if (orderedIds.length !== siblings.length || !orderedIds.every((i) => ids.has(i))) {
    throw new DomainError('重排参数必须是本项目全部工序 id 的一个排列');
  }
  orderedIds.forEach((pid, i) => {
    db.project_processes.find((p) => p.id === pid).seq = i + 1;
  });
  return getProject(db, projectId).processes;
}
