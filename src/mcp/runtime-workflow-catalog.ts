import { step, type Workflow } from "./workflow-catalog-types";

export const MCP_RUNTIME_WORKFLOWS: Workflow[] = [
  { id: "file-upload", title: "分块上传与断线续传", prerequisites: ["先持久保存原文件与 uploadKey；计算 byteLength 与 SHA-256", "循环 append 步骤直到 receivedBytes=byteLength，每块独立 base64 编码，最多 49152 字节；可用 uploadBytes 辅助函数"], dependencies: [], steps: [
    step("begin_mcp_upload", "创建上传或找回同键回执", { filename: "$filename", purpose: "$purpose", byteLength: "$byteLength", sha256: "$sha256", idempotencyKey: "$persisted.uploadKey" }, "$upload.uploadId"),
    step("get_mcp_upload", "重连后取得当前字节偏移", { uploadId: "$upload.uploadId" }, "$offset.receivedBytes"),
    step("append_mcp_upload", "追加下一块原文件字节", { uploadId: "$upload.uploadId", offset: "$offset.receivedBytes", data: "$chunkBase64" }, "$offset.receivedBytes"),
    step("complete_mcp_upload", "核对完整长度和 SHA-256", { uploadId: "$upload.uploadId" }, "$complete"),
  ] },
  { id: "file-import", title: "文件提取到可编辑简历或项目材料", prerequisites: ["先完成 file-upload；importSource 包含 extractionKey 与 target", "默认 ocrMode=off；循环查询 job，succeeded 后继续；generatedImport 来自完整原文", "kind=project 时使用 project-file-import 流程补齐来源权限"], dependencies: ["get_mcp_upload", "get_file_extraction", "extract_uploaded_file"], steps: [
    step("start_mcp_job", "提交持久文件提取", { operation: "extract_uploaded_file", arguments: { uploadId: "$uploadId", ocrMode: "off", idempotencyKey: "$persisted.extractionKey" } }, "$job.jobId"),
    step("get_mcp_job", "等待完成并核对错误状态", { jobId: "$job.jobId" }, "$jobState"),
    step("get_mcp_job_result", "读取完整提取结果入口", { jobId: "$job.jobId" }, "$extraction"),
    step("get_file_import_context", "读取原文、结构来源及结果格式", { source: "$importSource" }, "$basis.revision"),
    step("submit_file_import", "规范化外部结构化提案", { source: "$importSource", expectedRevision: "$basis.revision", result: "$generatedImport", idempotencyKey: "$persisted.proposalKey" }, "$proposal"),
    step("preview_file_import", "完整核对将保存的正文", { proposalKey: "$persisted.proposalKey" }, "$preview.previewToken"),
    step("save_file_import", "保存同一提案与回执", { proposalKey: "$persisted.proposalKey", kind: "$kind", previewToken: "$preview.previewToken", idempotencyKey: "$persisted.importKey" }, "$record.id"),
  ] },
  { id: "template-authoring", title: "复制并编辑自定义模板", prerequisites: ["templateRef 选择内置或自定义模板，name/editedName 为名称，style 为新样式", "保存前核对全部 affectedDrafts；发布版冻结"], dependencies: ["get_resume"], steps: [
    step("get_resume_template_context", "读取完整模板目录", {}, "$catalog.revision"),
    step("create_resume_template", "复制所选模板", { name: "$name", templateRef: "$templateRef", expectedRevision: "$catalog.revision", idempotencyKey: "$persisted.createKey" }, "$template.id"),
    step("get_resume_template_context", "读取受影响草稿与修订", { templateId: "$template.id" }, "$basis.revision"),
    step("preview_resume_template", "展示名称和样式变更", { templateId: "$template.id", name: "$editedName", style: "$style", expectedRevision: "$basis.revision" }, "$preview.previewToken"),
    step("save_resume_template", "保存同一预览提案", { templateId: "$template.id", name: "$editedName", style: "$style", expectedRevision: "$basis.revision", previewToken: "$preview.previewToken", idempotencyKey: "$persisted.saveKey" }, "$template.id"),
  ] },
  { id: "avatar-update", title: "替换或清除草稿头像", prerequisites: ["先以 purpose=avatar 完成 file-upload；uploadId=null 表示清除", "moduleKey 必须选择上下文中 type=basic 的模块"], dependencies: ["get_resume", "get_mcp_upload"], steps: [
    step("get_resume_avatar_context", "读取基本信息模块和当前版本", { resumeId: "$resumeId" }, "$basis.revision"),
    step("set_resume_avatar", "写入规范化头像并清理无引用旧图", { resumeId: "$resumeId", moduleKey: "$moduleKey", uploadId: "$uploadId", expectedRevision: "$basis.revision", idempotencyKey: "$persisted.avatarKey" }, "$resumeId"),
    step("get_resume", "回读当前草稿", { id: "$resumeId" }, "$resume"),
  ] },
  { id: "repository-incremental", title: "增量更新仓库证据", prerequisites: ["已有 baseCaptureKey，且已选择保存对应材料；仓库目录仍在允许清单", "selections 逐项选择 upsert/remove；not-captured 不能删除；保留历史并核对受影响总结"], dependencies: ["get_project", "list_project_materials", "get_repository_capture"], steps: [
    step("get_repository_catalog", "读取当前允许仓库", {}, "$catalog.revision"),
    step("get_project_material_context", "读取当前正式材料版本", { projectId: "$projectId" }, "$project.revision"),
    step("capture_project_repository", "采集新快照并确认基准文件缺失", { projectId: "$projectId", repositoryIndex: "$repositoryIndex", baselineCaptureKey: "$baseCaptureKey", expectedCatalogRevision: "$catalog.revision", expectedProjectRevision: "$project.revision", idempotencyKey: "$persisted.nextCaptureKey" }, "$capture"),
    step("get_repository_evidence_diff", "读取完整采集和材料差异", { projectId: "$projectId", baseCaptureKey: "$baseCaptureKey", nextCaptureKey: "$persisted.nextCaptureKey" }, "$basis.revision"),
    step("preview_repository_evidence_update", "核对所选材料修改与总结影响", { projectId: "$projectId", baseCaptureKey: "$baseCaptureKey", nextCaptureKey: "$persisted.nextCaptureKey", expectedRevision: "$basis.revision", selections: "$selections" }, "$preview.previewToken"),
    step("save_repository_evidence_update", "原子保存材料和历史", { projectId: "$projectId", baseCaptureKey: "$baseCaptureKey", nextCaptureKey: "$persisted.nextCaptureKey", expectedRevision: "$basis.revision", selections: "$selections", previewToken: "$preview.previewToken", idempotencyKey: "$persisted.updateKey" }, "$saved"),
    step("list_repository_evidence_history", "分页核对正式历史", { projectId: "$projectId" }, "$history"),
  ] },
  { id: "filtered-search", title: "按投递阶段完整检索", prerequisites: ["query 为关键词，stages 为投递阶段数组", "使用 readAllPages 遍历到 nextCursor=null；CONFLICT 从第一页重读；其他领域另需对应列表和读取权限"], dependencies: ["list_applications", "get_application"], steps: [
    step("search_records_page", "检索符合阶段的全部投递", { query: "$query", domains: ["application"], stages: "$stages" }, "$page"),
  ] },
  { id: "cache-maintenance", title: "预览并清理过期缓存", prerequisites: ["核对策略、候选数量和容量后提交同一 previewToken；正式资料及防重回执保留"], dependencies: [], steps: [
    step("preview_mcp_cache_cleanup", "核对本轮待清理缓存", {}, "$preview.previewToken"),
    step("cleanup_mcp_cache", "只清理已预览且未改变的候选", { previewToken: "$preview.previewToken" }, "$cleaned"),
  ] },
];
const fileImport = MCP_RUNTIME_WORKFLOWS.find(flow => flow.id === "file-import")!;
MCP_RUNTIME_WORKFLOWS.push({ ...fileImport, id: "project-file-import", title: "文件导入项目材料",
  prerequisites: ["先完成 file-upload，purpose=project；importSource.target={kind:'project',projectId}，kind=project", ...fileImport.prerequisites.slice(0, 2)],
  dependencies: [...fileImport.dependencies, "get_project", "list_project_materials", "get_project_material_context"] });
