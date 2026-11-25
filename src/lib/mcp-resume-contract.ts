import * as z from "zod/v4";

const text = z.string().max(20_000), short = z.string().max(200), itemId = z.string().min(1).max(100);
const subItems = z.array(z.strictObject({ id: itemId, label: short, value: text })).max(30).optional();
const description = { description: text, descriptionItems: z.array(text).max(50).optional(), descriptionStyle: z.enum(["ordered", "unordered"]).optional(), subItems };
const common = { key: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), label: z.string().trim().min(1).max(50) };
export const mcpResumeModuleSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...common, type: z.literal("basic"), content: z.strictObject({ name: short, phone: short, email: short, location: short, birthday: short, links: text,
    gender: short.optional(), age: short.optional(), fieldOrder: z.array(short).max(20).optional(), avatar: short.optional(), avatarX: z.number().optional(),
    avatarY: z.number().optional(), avatarSize: z.number().optional(), avatarShape: z.enum(["circle", "rounded", "square"]).optional() }) }),
  z.strictObject({ ...common, type: z.literal("education"), content: z.array(z.strictObject({ id: itemId, school: short, degree: short, field: short, start: short, end: short, description: text })).max(50) }),
  z.strictObject({ ...common, type: z.literal("work"), content: z.array(z.strictObject({ id: itemId, company: short, title: short, start: short, end: short, ...description })).max(50) }),
  z.strictObject({ ...common, type: z.literal("projects"), content: z.array(z.strictObject({ id: itemId, name: short, role: short, start: short, end: short, ...description })).max(50) }),
  z.strictObject({ ...common, type: z.literal("skills"), content: z.strictObject({ items: z.array(text).max(100) }) }),
  z.strictObject({ ...common, type: z.literal("summary"), content: z.strictObject({ text, descriptionItems: z.array(text).max(50).optional(), descriptionStyle: z.enum(["ordered", "unordered"]).optional() }) }),
  z.strictObject({ ...common, type: z.literal("custom"), content: z.array(z.strictObject({ id: itemId, title: short, subTitle: short.optional(), start: short.optional(), end: short.optional(), ...description })).max(50) }),
]);
export type McpResumeModule = z.output<typeof mcpResumeModuleSchema>;
