# tech-center-pms

技术中心内部项目管理系统。工序模板可配置、可批量导入，项目套用模板生成工序路线，按工序采集进度并做延期预警。

![CI](https://github.com/Lyjlyj0724-byte/tech-center-pms/actions/workflows/ci.yml/badge.svg)

## 目录

- `需求与数据模型设计.md` — 需求框架、数据模型、导入格式定义、任务拆分
- `templates/工序模板导入模板.xlsx` — 下发给技术中心填写的导入模板
- `src/import/` — Excel 导入解析 + 校验（parse → validate → normalize，任一错误整体拒绝）
- `tests/` — vitest 单测

## 开发

```bash
npm install
npm run lint   # eslint
npm test       # vitest
```

## 协作流程

trunk-based：从 main 开 `feature/*` 分支 → PR → CI 绿 → squash 合并。main 受分支保护，禁止直推。
