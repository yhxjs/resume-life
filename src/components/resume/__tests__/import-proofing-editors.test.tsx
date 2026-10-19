// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BasicEditor, ListEditor } from "../module-editors";
import { ProjectsEditor, WorkEditor } from "../projects-editor";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("导入编辑器字段定位", () => {
  it("基本信息字段聚焦时报告稳定字段路径", () => {
    const locate = vi.fn();
    render(<BasicEditor content={{ phone: "13800138000" }} onChange={vi.fn()} status="idle" onProofingFieldFocus={locate} />);
    fireEvent.focus(screen.getByRole("textbox", { name: "电话" }));
    expect(locate).toHaveBeenCalledWith("basic.phone");
  });

  it("教育条目字段聚焦时报告条目序号和字段键", () => {
    const locate = vi.fn();
    render(<ListEditor itemName="教育经历" items={[{ id: "e1", school: "华中科技大学" }]} onChange={vi.fn()}
      status="idle" fields={[{ key: "school", label: "学校" }]} onProofingFieldFocus={locate} />);
    fireEvent.focus(screen.getByRole("textbox", { name: "学校" }));
    expect(locate).toHaveBeenCalledWith(0, "school");
  });

  it("工作和项目主字段聚焦时报告条目序号和字段键", () => {
    const workLocate = vi.fn();
    const projectLocate = vi.fn();
    render(<>
      <WorkEditor itemName="工作经历" items={[{ id: "w1", company: "示例科技", title: "工程师", start: "2022.03", end: "至今", description: "" }]}
        onChange={vi.fn()} status="idle" onProofingFieldFocus={workLocate} />
      <ProjectsEditor itemName="项目经历" items={[{ id: "p1", name: "平台", role: "开发", start: "2023.01", end: "至今", description: "" }]}
        onChange={vi.fn()} status="idle" onProofingFieldFocus={projectLocate} />
    </>);
    fireEvent.focus(screen.getByRole("textbox", { name: "公司名称" }));
    fireEvent.focus(screen.getAllByRole("textbox", { name: "开始时间" })[1]!);
    expect(workLocate).toHaveBeenCalledWith(0, "company");
    expect(projectLocate).toHaveBeenCalledWith(0, "start");
  });

  it("基本信息字段支持上移下移更新 fieldOrder", () => {
    const onChange = vi.fn();
    render(<BasicEditor content={{ fieldOrder: ["gender", "age", "phone", "email", "location", "birthday", "links"] }} onChange={onChange} status="idle" />);
    fireEvent.click(screen.getByRole("button", { name: "上移 年龄" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldOrder: ["age", "gender", "phone", "email", "location", "birthday", "links"],
      })
    );
  });
});
