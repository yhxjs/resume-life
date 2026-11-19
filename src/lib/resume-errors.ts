export class ResumeNotFoundError extends Error {
  constructor() {
    super("简历不存在");
    this.name = "ResumeNotFoundError";
  }
}

/** 职业材料无法完整读取，不能把编辑器的空预览当作模型输入。 */
export class ResumeContextError extends Error {
  constructor() {
    super("参考简历材料损坏，请先修复职业模块或恢复有效备份后再生成");
    this.name = "ResumeContextError";
  }
}
