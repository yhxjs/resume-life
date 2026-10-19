import { errorMessage } from "@/lib/error-message";
export class InterviewCommandError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "InterviewCommandError";
  }
}

export function interviewCommandStatus(error: unknown): number {
  return error instanceof InterviewCommandError ? error.status : 500;
}

export function interviewCommandMessage(error: unknown): string {
  return errorMessage(error);
}

