import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

test("投递与排期 HTTP 材料边界：坏请求不改材料、阶段、时间与投递快照", async ({ request }) => {
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const root = "/api/applications";
  try {
    const seeded = await request.post(root, { data: { company: "E2E材料边界", role: "接口开发", stage: "applied", jd: "原 JD <T> &amp;", notes: "原备注" } });
    expect(seeded.status()).toBe(201);
    const application = await seeded.json();
    const url = `${root}/${application.id}`;
    const roundResponse = await request.post(`${url}/interviews`, { data: { round_name: "原轮次", interview_time: "2026-12-01T10:00:00.000Z", notes: "原轮次备注" } });
    expect(roundResponse.status()).toBe(201);
    const round = await roundResponse.json();
    const read = async () => {
      const app = await request.get(url);
      const versions = await request.get(`${url}/versions`);
      const all = await request.get(root);
      expect(app.status()).toBe(200); expect(versions.status()).toBe(200); expect(all.status()).toBe(200);
      return { app: await app.json(), versions: await versions.json(), all: await all.json() };
    };
    const before = await read();
    const badValues: unknown[] = [null, 0, true, [], ["原文"], {}];
    for (const field of ["company", "role", "salary_range", "jd", "next_interview_at", "notes"]) {
      for (const value of badValues) {
        const body = { company: "不得新增公司", role: "不得修改岗位", stage: "interview", notes: "不可部分保存", [field]: value };
        const created = await request.post(root, { data: body });
        const patched = await request.patch(url, { data: body });
        expect(created.status(), `POST ${field}=${JSON.stringify(value)}`).toBe(400);
        expect(patched.status(), `PATCH ${field}=${JSON.stringify(value)}`).toBe(400);
      }
    }
    for (const field of ["round_name", "interview_time", "interviewer", "location", "meeting_url", "notes"]) {
      for (const value of badValues) {
        const body = { round_name: "不得新增轮次", interview_time: "2026-12-02T10:00:00.000Z", notes: "不可部分保存", advance_stage: true, [field]: value };
        const created = await request.post(`${url}/interviews`, { data: body });
        const patched = await request.patch(`${url}/interviews/${round.id}`, { data: body });
        expect(created.status(), `轮次 POST ${field}=${JSON.stringify(value)}`).toBe(400);
        expect(patched.status(), `轮次 PATCH ${field}=${JSON.stringify(value)}`).toBe(400);
      }
    }
    for (const advance of ["false", "true", 0, 1, null, [], {}]) {
      const response = await request.post(`${url}/interviews`, { data: { round_name: "不得推进阶段", advance_stage: advance } });
      expect(response.status()).toBe(400);
    }
    for (const value of [null, false, true, 0, 1, [], ["applied"], {}, "", "unknown"]) {
      const patched = await request.patch(url, { data: { stage: value, company: "不得部分保存", jd: "不得替换 JD", notes: "不得保存" } });
      expect(patched.status(), `PATCH stage=${JSON.stringify(value)}`).toBe(400);
      expect(await patched.json()).toEqual({ error: "投递阶段无效" });
      const roundPatched = await request.patch(`${url}/interviews/${round.id}`, { data: { status: value, interview_time: "2026-12-02T10:00:00.000Z", notes: "不得保存" } });
      expect(roundPatched.status(), `轮次 PATCH status=${JSON.stringify(value)}`).toBe(400);
      expect(await roundPatched.json()).toEqual({ error: "面试轮次状态无效" });
      expect(await read()).toEqual(before);
    }
    expect(await read()).toEqual(before);
    const text = "正文  <T> &amp;\n原样保留";
    const changed = await request.patch(url, { data: { jd: `  ${text}  `, notes: text } });
    expect(changed.status()).toBe(200);
    expect(await changed.json()).toMatchObject({ company: application.company, role: application.role, jd: text, notes: text, stage: "applied" });
    const unchangedStage = await request.post(`${url}/interviews`, { data: { round_name: "不推进", advance_stage: false, notes: text, reminder_minutes: 0 } });
    expect(unchangedStage.status()).toBe(201);
    expect(await unchangedStage.json()).toMatchObject({ notes: text, reminder_minutes: 0, interview_time: "", status: "scheduled" });
    expect((await read()).app.stage).toBe("applied");
    const advanced = await request.post(`${url}/interviews`, { data: { round_name: "确认推进", advance_stage: true } });
    expect(advanced.status()).toBe(201);
    const after = await read();
    expect(after.app.stage).toBe("interview");
    expect(after.app.next_interview_at).toBe("2026-12-01T10:00:00.000Z");
    expect(after.versions.submitted).toEqual(before.versions.submitted);
    for (const value of [undefined, null, ""]) {
      const created = await request.post(root, { data: { company: "默认阶段兼容", role: "岗位", stage: value } });
      expect(created.status()).toBe(201);
      expect(await created.json()).toMatchObject({ stage: "interested" });
      const createdRound = await request.post(`${url}/interviews`, { data: { round_name: "默认状态兼容", status: value } });
      expect(createdRound.status()).toBe(201);
      expect(await createdRound.json()).toMatchObject({ status: "scheduled" });
    }
  } finally {
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
