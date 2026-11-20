import { expect, it } from "vitest";
import { readHomePriorities, type HomePriorities, type HomePriority } from "../home-priorities-contract";

const application: HomePriority = {
  id: "application-8", kind: "interview", title: "公司 · 岗位", reason: "今天面试。",
  badge: "今天面试", urgent: true, href: "/applications/8/prepare", action: "进入面试准备",
};
const snapshot = (items: HomePriority[]): HomePriorities => ({ date: "2026-11-20", items });

it("允许不同历史记录共享看板入口，保留各自的任务", () => {
  const value = snapshot([-1, 0].map(id => ({ ...application, id: `application-${id}`, href: "/applications" })));
  expect(readHomePriorities(value)).toBe(value);
});

it.each([
  { href: "/applications/9/prepare" },
  { id: "application-0", href: "/applications/0/prepare" },
  { id: "application--1", href: "/applications/-1/prepare" },
  { id: "application--0", href: "/applications" },
  { id: "application-08", href: "/applications/08/prepare" },
  { id: "application-9007199254740992", href: "/applications/9007199254740992/prepare" },
  { href: "//example.com" },
  { href: "/applications?next=https://example.com" },
  { id: "unrelated", href: "/applications" },
])("拒绝不存在的准备页或与任务不符的链接 %j", patch => {
  expect(() => readHomePriorities(snapshot([{ ...application, ...patch }]))).toThrow("今日重点读取不完整");
});

it("共享看板入口不允许重复岗位，也不能绕过复习任务去重", () => {
  const legacy = { ...application, id: "application-0", href: "/applications" };
  expect(() => readHomePriorities(snapshot([legacy, { ...legacy, kind: "materials" }]))).toThrow();
  const review: HomePriority = { ...application, id: "reviews", kind: "review", href: "/reviews" };
  expect(readHomePriorities(snapshot([review])).items).toEqual([review]);
  expect(() => readHomePriorities(snapshot([review, { ...review, id: "reviews-2" }]))).toThrow();
});
