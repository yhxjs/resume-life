export class ResumeNotFoundError extends Error {
  constructor() {
    super("简历不存在");
    this.name = "ResumeNotFoundError";
  }
}
