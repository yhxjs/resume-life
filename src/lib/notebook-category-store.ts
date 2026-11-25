import { getDb, inTransaction, now } from "./db";
import { ApplicationInputError } from "./applications";
import { NotebookMutationError } from "./notebook-storage";

function checkedName(value: string, exceptId?: number) {
  const name = value.trim();
  if (!name || name.length > 30) throw new ApplicationInputError("分类名称须为 1–30 字");
  if (getDb().prepare("SELECT id FROM notebook_categories WHERE name=? AND (? IS NULL OR id<>?)").get(name, exceptId ?? null, exceptId ?? null)) {
    throw new NotebookMutationError("已存在同名分类", 409);
  }
  return name;
}
export function createNotebookCategory(name: string) {
  return inTransaction(() => {
    const value = checkedName(name);
    return { id: Number(getDb().prepare("INSERT INTO notebook_categories(name,created_at) VALUES(?,?)").run(value, now()).lastInsertRowid), name: value };
  });
}
export function renameNotebookCategory(id: number, name: string) {
  return inTransaction(() => {
    if (!getDb().prepare("SELECT 1 FROM notebook_categories WHERE id=?").get(id)) throw new NotebookMutationError("分类不存在", 404);
    const value = checkedName(name, id);
    if (!getDb().prepare("UPDATE notebook_categories SET name=? WHERE id=?").run(value, id).changes) throw new NotebookMutationError("分类不存在", 404);
    return { id, name: value };
  });
}
export function moveNotebookEntry(id: number, categoryId: number | null) {
  return inTransaction(() => {
    if (categoryId !== null && !getDb().prepare("SELECT 1 FROM notebook_categories WHERE id=?").get(categoryId)) throw new ApplicationInputError("分类不存在");
    if (!getDb().prepare("UPDATE notebook_entries SET category_id=?,updated_at=? WHERE id=?").run(categoryId, now(), id).changes) throw new NotebookMutationError("错题不存在", 404);
    return { id };
  });
}
