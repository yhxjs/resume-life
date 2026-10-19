// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BUILTIN_STYLES } from "@/lib/templates";
import { TemplatePicker } from "../template-picker";

afterEach(cleanup);

it("损坏模板在选择器中标明原因，鼠标和键盘均不能应用", async () => {
  const onChange = vi.fn();
  render(<TemplatePicker value="classic" customs={[{ id: 1, name: "旧模板", style: BUILTIN_STYLES.classic,
    corrupted: true, created_at: "", updated_at: "" }]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: /模板/ }));
  const card = await screen.findByRole("button", { name: /旧模板.*损坏/ });
  expect(card.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(card);
  fireEvent.keyDown(card, { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
});
