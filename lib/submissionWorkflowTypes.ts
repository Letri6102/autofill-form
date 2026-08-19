import type { FormPayload } from "@/lib/googleFormSubmit";

export const MAX_WORKFLOW_SUBMISSIONS = 1000;
export const MIN_WORKFLOW_DELAY_SECONDS = 10;
export const MAX_WORKFLOW_DELAY_SECONDS = 3600;
export const RECENT_PROGRESS_EVENT_COUNT = 20;

export type SubmissionWorkflowItem = {
  index: number;
  payload: FormPayload;
  sourceRow?: number;
  delaySeconds: number;
};

export type SubmissionWorkflowInput = {
  sourceUrl: string;
  submissions: SubmissionWorkflowItem[];
};

type SubmissionProgressBase = {
  total: number;
  completed: number;
  failed: number;
  message: string;
};

export type SubmissionProgressEvent =
  | (SubmissionProgressBase & {
      type: "started";
    })
  | (SubmissionProgressBase & {
      type: "submitted";
      index: number;
      sourceRow?: number;
      ok: boolean;
      status: number | null;
      nextSubmitAt: string | null;
    })
  | (SubmissionProgressBase & {
      type: "finished";
      outcome: "completed" | "failed";
    });

export type SubmissionWorkflowResult = {
  total: number;
  completed: number;
  failed: number;
  outcome: "completed" | "failed";
};
