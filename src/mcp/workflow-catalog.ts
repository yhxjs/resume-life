import { mcpPresets } from "./config.mjs";
import { mcpContextPage, type ContextPageInput } from "@/lib/mcp-context";
import { McpOperationError } from "@/lib/mcp-errors";
import { step, type Tool, type Workflow } from "./workflow-catalog-types";
import { MCP_CONTENT_WORKFLOWS } from "./content-workflow-catalog";
import { MCP_RUNTIME_WORKFLOWS } from "./runtime-workflow-catalog";
export const MCP_WORKFLOWS: Workflow[] = [
  ...MCP_CONTENT_WORKFLOWS,
  ...MCP_RUNTIME_WORKFLOWS,
  { id: "resume-delivery", title: "诊断采纳到简历交付", prerequisites: ["已有简历和对应诊断报告；通过 get_ai_workflow_context / submit_ai_draft / save_ai_draft 可先生成并保存诊断"],
    dependencies: ["get_resume", "get_resume_diagnosis", "list_resume_versions"], steps: [
      step("get_diagnosis_adoption_context", "读取完整诊断与当前草稿", { resumeId: "$resumeId", diagnosisId: "$diagnosisId" }, "$adoption.revision"),
      step("preview_diagnosis_adoption", "选择建议并核对实际修改", { resumeId: "$resumeId", diagnosisId: "$diagnosisId", expectedRevision: "$adoption.revision", selections: "$selectedSuggestions" }, "$adoptionPreview.previewToken"),
      step("save_diagnosis_adoption", "原子保存草稿与采纳历史", { resumeId: "$resumeId", diagnosisId: "$diagnosisId", selections: "$selectedSuggestions", expectedRevision: "$adoption.revision", previewToken: "$adoptionPreview.previewToken", idempotencyKey: "$persisted.adoptionKey" }, "$diagnosisId"),
      step("get_resume_version_context", "读取修改后的版本来源", { resumeId: "$resumeId" }, "$version.revision"),
      step("publish_resume_version", "冻结命名发布版", { resumeId: "$resumeId", expectedRevision: "$version.revision", name: "$versionName", idempotencyKey: "$persisted.publishKey" }, "$published.id"),
      step("get_resume_export_context", "核对导出版本、匿名化与检查项", { source: { resumeId: "$resumeId", versionId: "$published.id" } }, "$export.revision"),
      step("export_resume", "生成指定格式文件", { source: { resumeId: "$resumeId", versionId: "$published.id" }, expectedRevision: "$export.revision", format: "$format", idempotencyKey: "$persisted.exportKey" }, "$artifact.artifactId"),
      step("read_export_artifact", "分段取回文件并校验 SHA-256", { artifactId: "$artifact.artifactId", offset: "$nextOffset" }, "$artifactBytes"),
      step("create_application", "将发布版绑定到新投递", { stage: "applied", resume_id: "$resumeId", resume_version_id: "$published.id", company: "$company", role: "$role", idempotencyKey: "$persisted.applicationKey" }, "$application.id"),
    ] },
  { id: "resume-layout", title: "模块排序与排版", prerequisites: ["已有简历草稿"], dependencies: ["get_resume"], steps: [
    step("get_resume_layout_context", "读取模块、模板及样式字段", { resumeId: "$resumeId" }, "$layout.revision"),
    step("preview_resume_layout", "预览排序和实际归一化样式", { resumeId: "$resumeId", expectedRevision: "$layout.revision", moduleOrder: "$allRetainedKeys", styleOverrides: "$styleOverrides" }, "$preview.previewToken"),
    step("save_resume_layout", "保存同一提案", { resumeId: "$resumeId", moduleOrder: "$allRetainedKeys", styleOverrides: "$styleOverrides", expectedRevision: "$layout.revision", previewToken: "$preview.previewToken", idempotencyKey: "$persisted.layoutKey" }, "$resumeId"),
  ] },
  { id: "resume-version-branch", title: "比较版本并继续编辑", prerequisites: ["已有发布版"], dependencies: ["get_resume", "list_resume_versions"], steps: [
    step("compare_resume_versions", "比较两版；省略一侧表示草稿", { resumeId: "$resumeId", beforeVersionId: "$versionId" }, "$changes"),
    step("get_resume_version_context", "选择历史版并读取当前草稿", { resumeId: "$resumeId", versionId: "$versionId" }, "$source.revision"),
    step("preview_resume_version_branch", "核对草稿替换差异", { resumeId: "$resumeId", versionId: "$versionId", expectedRevision: "$source.revision" }, "$preview.previewToken"),
    step("branch_resume_version", "将历史版写回草稿", { resumeId: "$resumeId", versionId: "$versionId", expectedRevision: "$source.revision", previewToken: "$preview.previewToken", idempotencyKey: "$persisted.branchKey" }, "$resumeId"),
  ] },
  { id: "bank-import", title: "题库批量导入", prerequisites: ["每行一道题，已选定方向和题型"], dependencies: ["list_bank_entries"], steps: [
    step("preview_bank_import", "逐项检查已有与批内重复", { direction: "$direction", kind: "$kind", text: "$questionLines" }, "$preview.previewToken"),
    step("save_bank_import", "一次事务保存题目与结果回执", { direction: "$direction", kind: "$kind", text: "$questionLines", previewToken: "$preview.previewToken", idempotencyKey: "$persisted.importKey" }, "$importResult"),
    step("get_bank_import_result", "读取同一批逐项题目 ID", { idempotencyKey: "$persisted.importKey" }, "$items"),
  ] },
  { id: "notebook-organization", title: "错题分类维护", prerequisites: ["移动操作需要已有错题"], dependencies: ["list_notebook_categories", "get_notebook_entry"], steps: [
    step("get_notebook_organization_context", "创建时省略 ID，改名传 categoryId，移动传 notebookId", {}, "$source.revision"),
    step("create_notebook_category", "创建分类", { name: "$name", expectedRevision: "$source.revision", idempotencyKey: "$persisted.categoryKey" }, "$category.id"),
    step("get_notebook_organization_context", "重新读取新分类的来源", { categoryId: "$category.id" }, "$renamingSource.revision"),
    step("rename_notebook_category", "使用重新读取的分类来源改名", { categoryId: "$category.id", expectedRevision: "$renamingSource.revision", name: "$newName", idempotencyKey: "$persisted.renameKey" }, "$category.id"),
    step("get_notebook_organization_context", "重新读取待移动错题的来源", { notebookId: "$notebookId" }, "$movingSource.revision"),
    step("move_notebook_entry", "使用重新读取的错题来源移动分类", { notebookId: "$notebookId", categoryId: "$category.id", expectedRevision: "$movingSource.revision", idempotencyKey: "$persisted.moveKey" }, "$notebookId"),
  ] },
  { id: "project-material-edit", title: "项目材料与来源维护", prerequisites: ["已有项目材料"], dependencies: ["get_project", "list_project_materials"], steps: [
    step("get_project_material_context", "读取完整材料与来源", { projectId: "$projectId", materialId: "$materialId" }, "$source.revision"),
    step("preview_project_material_edit", "核对正文、来源定位和结构来源变化", { projectId: "$projectId", materialId: "$materialId", expectedRevision: "$source.revision", filename: "$sourceLocator", content: "$fullContent" }, "$preview.previewToken"),
    step("save_project_material_edit", "保存材料并使旧总结预览失效", { projectId: "$projectId", materialId: "$materialId", filename: "$sourceLocator", content: "$fullContent", expectedRevision: "$source.revision", previewToken: "$preview.previewToken", idempotencyKey: "$persisted.materialKey" }, "$materialId"),
  ] },
  { id: "repository-evidence", title: "从仓库证据到项目档案", prerequisites: ["客户端设置 RESUME_LIFE_MCP_REPO_ROOTS 绝对目录 JSON 数组", "已有项目"], dependencies: ["get_project", "list_project_materials"], steps: [
    step("get_repository_catalog", "发现允许采集的目录", {}, "$catalog.revision"),
    step("get_project_material_context", "读取当前项目来源", { projectId: "$projectId" }, "$project.revision"),
    step("capture_project_repository", "采集并持久保存受限源码快照", { projectId: "$projectId", repositoryIndex: "$repositoryIndex", expectedCatalogRevision: "$catalog.revision", expectedProjectRevision: "$project.revision", idempotencyKey: "$persisted.captureKey" }, "$captureKey"),
    step("get_repository_capture", "读全文件、校验和与截断范围", { idempotencyKey: "$persisted.captureKey" }, "$capture.revision"),
    step("save_repository_evidence", "选择具体文件保存为材料", { projectId: "$projectId", captureKey: "$persisted.captureKey", fileIndexes: "$selectedFileIndexes", expectedCaptureRevision: "$capture.revision", expectedProjectRevision: "$project.revision", idempotencyKey: "$persisted.evidenceKey" }, "$materialIds"),
    step("get_project_summary_context", "以更新后的材料生成项目总结", { projectId: "$projectId" }, "$summary.revision"),
    step("preview_project_summary", "预览外部总结", { projectId: "$projectId", expectedRevision: "$summary.revision", result: "$generatedSummary" }, "$summaryPreview.previewToken"),
    step("save_project_summary", "保存同一总结提案", { projectId: "$projectId", result: "$generatedSummary", expectedRevision: "$summary.revision", previewToken: "$summaryPreview.previewToken", idempotencyKey: "$persisted.summaryKey" }, "$summaryHistoryId"),
  ] },
  { id: "jargon-decoding", title: "黑话解码", prerequisites: ["岗位或面试原文"], dependencies: [], steps: [
    step("get_jargon_generation_context", "读取完整原文与生成规则", { text: "$sourceText" }, "$source.revision"),
    step("save_jargon_result", "校验外部结果与原文引用后保存", { text: "$sourceText", expectedRevision: "$source.revision", result: "$generatedResult", idempotencyKey: "$persisted.jargonKey" }, "$record.id"),
    step("get_career_record", "读取与网页相同的正式报告", { kind: "jargon_decoding", id: "$record.id" }, "$record"),
  ] },
  { id: "portfolio-export", title: "作品集选材与匿名化导出", prerequisites: ["已有简历与项目档案"], dependencies: ["get_resume", "get_project"], steps: [
    step("get_portfolio_sources", "选择简历、版本、项目和模板", {}, "$sources"),
    step("get_portfolio_context", "核对匿名化后的实际正文和链接", { options: "$selectedOptions" }, "$preview.revision"),
    step("export_portfolio", "按同一选材打包离线 ZIP", { options: "$selectedOptions", expectedRevision: "$preview.revision", idempotencyKey: "$persisted.portfolioKey" }, "$artifact.artifactId"),
    step("read_export_artifact", "逐段解码并核对完整文件", { artifactId: "$artifact.artifactId", offset: "$nextOffset" }, "$zipBytes"),
  ] },
];

export function getWorkflowCatalog(permits: (name: Tool) => boolean, workflowId: string | undefined, page: ContextPageInput) {
  const selected = workflowId ? MCP_WORKFLOWS.filter(workflow => workflow.id === workflowId) : MCP_WORKFLOWS;
  if (!selected.length) throw new McpOperationError("NOT_FOUND", "工作流不存在");
  return mcpContextPage({ catalogVersion: "1.5", workflows: selected.map(workflow => {
    const requiredTools = [...new Set([...workflow.dependencies, ...workflow.steps.map(step => step.tool)])];
    const missingTools = requiredTools.filter(name => !permits(name));
    return { ...workflow, requiredTools, missingTools, available: missingTools.length === 0,
      compatiblePresets: Object.entries(mcpPresets).filter(([, preset]) => requiredTools.every(name => preset.tools.includes(name))).map(([name]) => name) };
  }), bindingRules: "inputs 覆盖每步必填字段；以 $ 开头的字符串引用变量，其余值为字面值，嵌套对象递归绑定。output 指示需保留的返回字段，具体格式见 tools/list outputSchema。上下文及 preview 用 readContext 完整分页，JSON 正文在 value 中，revision/previewToken 在外层；列表用 readAllPages。生成结果来自外部 Agent，原答及采纳选择来自用户。预览与保存使用完全相同提案；循环流程见 prerequisites，重放原提交保持原键和原参数。",
  recovery: { CONFLICT: "重新读取完整来源并重新预览；先核对已保存记录，再为新的操作生成新幂等键。", BUSY: "退避后重试同一参数和幂等键。",
    TIMEOUT: "写操作先重放原始请求和幂等键核对回执，不盲目换键。", CANCELLED: "重新连接后用原始参数和幂等键核对提交结果。",
    FORBIDDEN: "核对 missingTools 和客户端预设。", restored: "旧令牌、产物和回执无效；重新读取正式业务记录。" },
  artifactReading: { offsetUnit: "bytes", encoding: "base64", maxChunkBytes: 8000, assembly: "每段单独 base64 解码，按 offset 拼接字节，最终校验 byteLength 与 sha256。" } }, page);
}
