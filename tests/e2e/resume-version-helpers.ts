import { expect, type APIRequestContext } from "@playwright/test";
import type { ResumeVersion } from "../../src/lib/resume-version-types";

export async function publishResume(request: APIRequestContext, resumeId: number, name = "测试发布版本"): Promise<ResumeVersion> {
  const current = await request.get(`/api/resumes/${resumeId}/versions`);
  expect(current.status()).toBe(200);
  const { draft_revision } = await current.json();
  const published = await request.post(`/api/resumes/${resumeId}/versions`, { data: { name, draft_revision } });
  expect(published.status()).toBe(201);
  return published.json();
}
