import { projectChallengeBoundaryCases } from "./project-challenge-boundaries-fixture";
import { projectPersonalScopeCases } from "./project-personal-scope-fixture";

const exampleMarker = "输出单个 JSON，保留全部八个字段，字段值不带标题前缀：\n";
const baselineKeys = ["overview", "architecture", "highlights", "responsibilities", "challenges", "techStack", "brief", "achievements"];
const candidateKeys = ["challenges", ...baselineKeys.filter(key => key !== "challenges")];

/** Move one intact member line; all values and text outside the output example stay unchanged. */
export function buildProjectChallengeOrderSystems(production: string): { baseline: string; candidate: string } {
  const fail = (): never => { throw new Error("project-challenge-order requires one complete eight-field example in a known order"); };
  if (production.split(exampleMarker).length !== 2) return fail();
  const start = production.indexOf(exampleMarker) + exampleMarker.length;
  const close = production.indexOf("\n}", start);
  if (close < 0) return fail();
  const example = production.slice(start, close + 2);
  const lines = example.split("\n");
  if (lines.length !== 10 || lines[0] !== "{" || lines.at(-1) !== "}") return fail();
  const members = lines.slice(1, -1);
  const keys = members.map(line => /^  "([A-Za-z]+)": /.exec(line)?.[1] ?? "");
  if (keys.join(",") !== baselineKeys.join(",") && keys.join(",") !== candidateKeys.join(",")) return fail();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(example) as Record<string, unknown>; } catch { return fail(); }
  if (Object.keys(parsed).length !== 8 || !baselineKeys.slice(0, -1).every(key => typeof parsed[key] === "string") ||
      !Array.isArray(parsed.achievements) || parsed.achievements.length !== 0) return fail();
  if (!members.every((line, index) => line === `  ${JSON.stringify(keys[index])}: ${JSON.stringify(parsed[keys[index]!])}${index === members.length - 1 ? "" : ","}`)) return fail();
  const byKey = new Map(keys.map((key, index) => [key, members[index]!]));
  const block = (order: string[]) => ["{", ...order.map(key => byKey.get(key)!), "}"].join("\n");
  const baseline = block(baselineKeys), candidate = block(candidateKeys);
  if (production.split(baseline).length + production.split(candidate).length !== 3) return fail();
  return { baseline: production.replace(example, baseline), candidate: production.replace(example, candidate) };
}

// Preserve the existing material and rubric text; the two safeguards add one direct criterion each.
const noChallengeDirect = "本例未提供实际技术问题，challenges应空；提交/未测试/未知实现/未发布不独立成为难点";
export const projectChallengeOrderCases = [
  ...projectChallengeBoundaryCases,
  {
    ...projectPersonalScopeCases[0],
    rubric: [noChallengeDirect, ...projectPersonalScopeCases[0].rubric],
  },
  {
    ...projectPersonalScopeCases[3],
    rubric: [noChallengeDirect, ...projectPersonalScopeCases[3].rubric],
  },
] as const;
