/** 新生成模型输出的重复字段错误；不包含键名或模型正文。 */
export class DuplicateModelJsonKeyError extends SyntaxError {
  constructor() {
    super("模型 JSON 对象包含重复字段");
    this.name = "DuplicateModelJsonKeyError";
  }
}

/**
 * 只用于新生成的模型 JSON；历史存档仍沿用原来的兼容读取。
 * 先由原生解析器验证完整语法，再扫描结构中的键，不重写正文或选择重复键的值。
 * 迭代维护每个对象的键集合，避免递归扫描对深层合法 JSON 另加调用栈限制。
 */
export function parseModelJson<T = unknown>(raw: string): T {
  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    // 原生 SyntaxError 可能包含模型正文，不能带到上层错误或日志。
    throw new SyntaxError("模型输出不是有效 JSON");
  }

  const containers: (Set<string> | null)[] = [];
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === "{") containers.push(new Set<string>());
    else if (character === "[") containers.push(null);
    else if (character === "}" || character === "]") containers.pop();
    else if (character === '"') {
      const start = index;
      for (index++; index < raw.length; index++) {
        if (raw[index] === "\\") index++;
        else if (raw[index] === '"') break;
      }
      let next = index + 1;
      while (raw[next] === " " || raw[next] === "\t" || raw[next] === "\r" || raw[next] === "\n") next++;
      // 完整语法已验证，字符串后紧跟冒号只可能是当前对象的键。
      if (raw[next] === ":") {
        const keys = containers.at(-1)!;
        const key = JSON.parse(raw.slice(start, index + 1)) as string;
        if (keys!.has(key)) throw new DuplicateModelJsonKeyError();
        keys!.add(key);
      }
    }
  }
  return parsed;
}
