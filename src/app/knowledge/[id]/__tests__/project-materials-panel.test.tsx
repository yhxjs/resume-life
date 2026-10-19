import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ProjectMaterialsPanel } from "../project-materials-panel";

describe("ProjectMaterialsPanel 方式三：扫描本地仓库与目录记录", () => {
  const defaultProps = {
    materials: [],
    error: "",
    matTitle: "",
    matContent: "",
    file: null,
    uploading: false,
    editingId: null,
    editTitle: "",
    editContent: "",
    editRevision: "",
    loadingEdit: false,
    editError: "",
    savingEdit: false,
    expanded: null,
    setMatTitle: vi.fn(),
    setMatContent: vi.fn(),
    setFile: vi.fn(),
    setEditingId: vi.fn(),
    setEditTitle: vi.fn(),
    setEditContent: vi.fn(),
    setExpanded: vi.fn(),
    addPaste: vi.fn(),
    addFile: vi.fn(),
    removeMaterial: vi.fn(),
    startEdit: vi.fn(),
    retryEdit: vi.fn(),
    saveEdit: vi.fn(),
    projectId: 1,
    repoPaths: [],
    onAddRepoPath: vi.fn(),
    onRemoveRepoPath: vi.fn(),
    onClearRepoPaths: vi.fn(),
    onOpenScanModal: vi.fn(),
  };

  it("正确渲染方式一、方式二与方式三", () => {
    const html = renderToStaticMarkup(<ProjectMaterialsPanel {...defaultProps} />);
    expect(html).toContain("导入架构材料");
    expect(html).toContain("方式一：粘贴文字材料");
    expect(html).toContain("方式二：直接上传文档");
    expect(html).toContain("方式三：扫描本地代码仓库");
    expect(html).toContain("浏览目录");
    expect(html).toContain("输入本地工程路径，按回车或点击添加");
  });

  it("当未记录代码目录时展示占位提示与通用打开按钮", () => {
    const html = renderToStaticMarkup(<ProjectMaterialsPanel {...defaultProps} repoPaths={[]} />);
    expect(html).toContain("尚未记录代码目录");
    expect(html).toContain("打开代码仓库扫描工作台");
  });

  it("当已记录选中代码目录时展示目录清单与针对性扫描按钮", () => {
    const html = renderToStaticMarkup(
      <ProjectMaterialsPanel
        {...defaultProps}
        repoPaths={["D:\\projects\\web-frontend", "D:\\projects\\api-backend"]}
      />
    );
    expect(html).toContain("已记录代码库目录（2 个）");
    expect(html).toContain("D:\\projects\\web-frontend");
    expect(html).toContain("D:\\projects\\api-backend");
    expect(html).toContain("清空");
    expect(html).toContain("扫描选中的 2 个代码库并提炼");
  });
});
