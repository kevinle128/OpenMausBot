import type { PaseoPermissionRequest, PaseoPermissionResponse } from "./connection.ts";
import { isRegularFile, type PermissionContext } from "./permission-rules.ts";

/** The words of the privacy hook of AgentKit, which blocks a file read and tells the model to ask the person. */
/** The whole question of the hook for a plain read, with its fixed ending. The longer wording that offers to trust project
 * rules has a different ending and is never matched. */
const READ_QUESTION = /^I need to read "([^"\n]+)" \((.+)\), which may contain sensitive data \(API keys, passwords, tokens\)\. Do you approve this one time\?$/;
const HOOK_HEADER = "File Access";
export const APPROVE_ONCE = "Yes, approve once";
export const ASK_USER_QUESTION = /^askuserquestion$/i;

export interface PaseoQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  /** The option labels exactly as the agent wrote them. */
  labels: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The questions of an `AskUserQuestion` request. Null when the input is not that shape. */
export function readQuestions(request: Pick<PaseoPermissionRequest, "input">): PaseoQuestion[] | null {
  const raw = isRecord(request.input) ? request.input.questions : undefined;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: PaseoQuestion[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.question !== "string" || !entry.question.trim()) return null;
    const labels: string[] = [];
    for (const option of Array.isArray(entry.options) ? entry.options : []) {
      const label = typeof option === "string" ? option : isRecord(option) && typeof option.label === "string" ? option.label : "";
      if (label && !labels.includes(label)) labels.push(label);
    }
    questions.push({
      question: entry.question,
      ...(typeof entry.header === "string" ? { header: entry.header } : {}),
      multiSelect: entry.multiSelect === true,
      labels,
    });
  }
  return questions;
}

/** The answer that picks `label` for the one question; the questions go back as the agent sent them. */
export function questionAnswer(request: Pick<PaseoPermissionRequest, "input">, question: string, label: string): PaseoPermissionResponse {
  return { behavior: "allow", updatedInput: { questions: request.input?.questions, answers: { [question]: label } } };
}

/** The file a privacy hook question asks to read, when the question may be answered "Yes, approve once" without the
 * person: one question, the read wording of the hook, that option offered, and a path that is a regular file. A write
 * question, any other question, and a path that is missing or not a plain file are not. */
export async function hookReadQuestion(
  request: Pick<PaseoPermissionRequest, "kind" | "name" | "input">,
  context: PermissionContext = {},
): Promise<{ filePath: string; question: string } | null> {
  const asked = hookReadShape(request);
  return asked && (await isRegularFile(context, asked.filePath)) ? asked : null;
}

/** The file a privacy hook read question names, whatever is at that path. Null for any other question. */
export function hookReadShape(request: Pick<PaseoPermissionRequest, "kind" | "name" | "input">): { filePath: string; question: string } | null {
  if (request.kind !== "question" || !ASK_USER_QUESTION.test(request.name)) return null;
  const questions = readQuestions(request);
  const only = questions?.length === 1 ? questions[0]! : null;
  if (!only || only.header !== HOOK_HEADER || only.multiSelect || !only.labels.includes(APPROVE_ONCE)) return null;
  const match = READ_QUESTION.exec(only.question);
  if (!match) return null;
  const [, name, filePath] = match as unknown as [string, string, string];
  if (filePath.split(/[\\/]/).pop() !== name) return null;
  return { filePath, question: only.question };
}
