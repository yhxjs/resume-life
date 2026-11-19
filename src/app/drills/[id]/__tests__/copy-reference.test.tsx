// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "1" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/notebook", () => ({ NotebookStarButton: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("练习参考的复制边界", () => {
  it("复制失败只在当前参考旁显示，重试恢复，问题切换不带入其他参考的状态", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    try {
      const questions = [1, 2].map((id) => ({
        id, idx: id, question: `原问题${id}：如何核实接口范围？`, answer: `原回答${id}：只参与参数校验，尚未上线。`,
        comment: "仅对已提交回答给出练习建议", reference: `参考${id} <T> &amp;\n[待补充：个人分工]，尚未验证线上收益。`,
        scores: null, answered_at: "2026-10-28", kind: "tech", notebook_id: null,
      }));
      const original = structuredClone(questions);
      vi.mocked(jsonFetch).mockResolvedValue({
        id: 1, source: "project", project_id: 1, direction: "", jd: "", interview_id: null,
        focus: "", created_at: "2026-10-28", project_name: "原项目", questions,
      });
      render(<Page />);
      const reference = await screen.findByRole("region", { name: "本题回答参考" });
      const first = within(reference);
      fireEvent.click(first.getByRole("button", { name: "复制参考" }));
      const copied = await first.findByRole("button", { name: "已复制 ✓" });
      clipboard.mockRejectedValueOnce(new Error("denied"));
      fireEvent.click(copied);
      expect((await first.findByRole("alert")).textContent).toContain("复制失败");
      expect(first.queryByRole("button", { name: "已复制 ✓" })).toBeNull();
      fireEvent.click(first.getByRole("button", { name: "复制参考" }));
      await first.findByRole("button", { name: "已复制 ✓" });
      expect(first.queryByRole("alert")).toBeNull();
      expect(clipboard).toHaveBeenLastCalledWith(questions[0]!.reference);
      const secondQuestion = screen.getByRole("button", { name: "第 2 题（已答）" });
      fireEvent.click(secondQuestion);
      expect(reference.textContent).toContain(questions[1]!.reference);
      expect(within(reference).getByRole("button", { name: "复制参考" })).toBeTruthy();
      fireEvent.click(within(reference).getByRole("button", { name: "复制参考" }));
      await within(reference).findByRole("button", { name: "已复制 ✓" });
      expect(clipboard).toHaveBeenLastCalledWith(questions[1]!.reference);
      expect(questions).toEqual(original);
      expect(jsonFetch).toHaveBeenCalledOnce();
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});
