import { ResumeContextError, ResumeNotFoundError } from "@/lib/resume-errors";
import { loadResumeContext } from "@/lib/resumes";

/** 固定模型实际读取的职业材料；保存时在调用方的事务内复核，不改选发布版。 */
export function captureInterviewResumeContext(
  resumeId: number,
  versionId: number | null,
  missingText: string,
) {
  const read = () => {
    try { return loadResumeContext(resumeId, versionId); }
    catch (error) {
      if (!(error instanceof ResumeNotFoundError)) throw error;
      return missingText;
    }
  };
  const text = read();
  return {
    text,
    isCurrent() {
      try { return read() === text; }
      catch (error) {
        // 原先可读的发布材料在等待期间损坏，同样不能归档旧结果。
        if (error instanceof ResumeContextError || error instanceof SyntaxError || error instanceof TypeError) return false;
        throw error;
      }
    },
  };
}
