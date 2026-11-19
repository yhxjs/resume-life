// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GapGeneratorForm } from "../gap-generator-form";
import type { PersonaStyle, ScenarioType } from "@/lib/career-gap-remedy";

afterEach(cleanup);

function Harness({ onGenerate }: { onGenerate: (data: { rawStory: string; personaStyle: PersonaStyle }) => void }) {
  const [rawStory, setRawStory] = useState("");
  const [scenarioType, setScenarioType] = useState<ScenarioType>("gap");
  const [personaStyle, setPersonaStyle] = useState<PersonaStyle>("pragmatic");
  const [targetRole, setTargetRole] = useState("");
  return <GapGeneratorForm scenarioType={scenarioType} rawStory={rawStory} targetRole={targetRole} personaStyle={personaStyle} submitting={false}
    setScenarioType={setScenarioType} setRawStory={setRawStory} setTargetRole={setTargetRole} setPersonaStyle={setPersonaStyle}
    onGenerate={() => onGenerate({ rawStory, personaStyle })} />;
}

describe("空窗原始经历输入的可访问名称与原文", () => {
  it("输入后出现清空按钮，文本框仍关联原标签；切换风格不改变材料或自动生成", () => {
    const onGenerate = vi.fn();
    render(<Harness onGenerate={onGenerate} />);
    const input = screen.getByRole("textbox", { name: "真实经历与希望说明的问题" }) as HTMLTextAreaElement;
    const story = "休息六个月，没有学习或项目；到岗安排尚未确认。";
    fireEvent.change(input, { target: { value: story } });
    expect(screen.getByRole("textbox", { name: "真实经历与希望说明的问题" })).toBe(input);
    expect(screen.getByRole("button", { name: "清空内容" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /自驱进取型/ }));
    expect(input.value).toBe(story);
    expect(onGenerate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "生成沟通方案 →" }));
    expect(onGenerate).toHaveBeenCalledWith({ rawStory: story, personaStyle: "driven" });
    fireEvent.click(screen.getByRole("button", { name: "清空内容" }));
    expect(screen.getByRole("textbox", { name: "真实经历与希望说明的问题" })).toBe(input);
    expect(input.value).toBe("");
    expect((screen.getByRole("button", { name: "生成沟通方案 →" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
