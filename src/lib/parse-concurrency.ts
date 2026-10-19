import { AsyncLocalStorage } from "node:async_hooks";

const MAX_CONCURRENT_EXTRACTIONS = 2;
let extractionsInFlight = 0;
const resourceScope = new AsyncLocalStorage<() => () => void>();

export class ParseBusyError extends Error {
  constructor() {
    super(`同时进行的文件解析过多（上限 ${MAX_CONCURRENT_EXTRACTIONS} 个），请等待当前任务完成后再试`);
    this.name = "ParseBusyError";
  }
}

/** OCR 初始化可晚于请求取消完成，资源持有者必须在实际终止后归还名额。 */
export function retainParseResource(): () => void {
  return resourceScope.getStore()?.() ?? (() => {});
}

export async function withParsingSlot<Result>(extract: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
  signal?.throwIfAborted();
  if (extractionsInFlight >= MAX_CONCURRENT_EXTRACTIONS) throw new ParseBusyError();
  extractionsInFlight += 1;
  let references = 1;
  const release = () => {
    references -= 1;
    if (references === 0) extractionsInFlight -= 1;
  };
  const retain = () => {
    references += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
  try {
    const result = await resourceScope.run(retain, extract);
    signal?.throwIfAborted();
    return result;
  } finally {
    release();
  }
}
