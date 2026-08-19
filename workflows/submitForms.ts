import { getWritable, sleep } from "workflow";
import { submitGoogleForm } from "@/lib/googleFormSubmit";
import type {
  SubmissionProgressEvent,
  SubmissionWorkflowInput,
  SubmissionWorkflowItem,
  SubmissionWorkflowResult,
} from "@/lib/submissionWorkflowTypes";

type SubmissionStepResult = {
  ok: boolean;
  completed: number;
  failed: number;
};

async function writeProgress(event: SubmissionProgressEvent): Promise<void> {
  "use step";

  const writer = getWritable<SubmissionProgressEvent>().getWriter();
  try {
    await writer.write(event);
  } finally {
    writer.releaseLock();
  }
}

async function submitOneForm(
  sourceUrl: string,
  item: SubmissionWorkflowItem,
  total: number,
  completed: number,
  failed: number,
  hasNextSubmission: boolean,
): Promise<SubmissionStepResult> {
  "use step";

  let ok = false;
  let status: number | null = null;
  let message = "Không gửi được form.";

  try {
    const result = await submitGoogleForm(sourceUrl, item.payload);
    ok = result.ok;
    status = result.status;
    message = result.ok ? "Đã gửi" : `HTTP ${result.status}`;
  } catch (error) {
    message = error instanceof Error ? error.message : message;
  }

  const nextCompleted = completed + (ok ? 1 : 0);
  const nextFailed = failed + (ok ? 0 : 1);
  const nextSubmitAt =
    ok && hasNextSubmission
      ? new Date(Date.now() + item.delaySeconds * 1000).toISOString()
      : null;
  const event: SubmissionProgressEvent = {
    type: "submitted",
    total,
    completed: nextCompleted,
    failed: nextFailed,
    message,
    index: item.index,
    sourceRow: item.sourceRow,
    ok,
    status,
    nextSubmitAt,
  };

  const writer = getWritable<SubmissionProgressEvent>().getWriter();
  try {
    await writer.write(event);
  } catch (error) {
    console.error("Không ghi được tiến độ Workflow:", error);
  } finally {
    writer.releaseLock();
  }

  return {
    ok,
    completed: nextCompleted,
    failed: nextFailed,
  };
}

export async function submitFormsWorkflow(
  input: SubmissionWorkflowInput,
): Promise<SubmissionWorkflowResult> {
  "use workflow";

  const total = input.submissions.length;
  let completed = 0;
  let failed = 0;

  await writeProgress({
    type: "started",
    total,
    completed,
    failed,
    message: "Workflow đã bắt đầu.",
  });

  for (let position = 0; position < total; position += 1) {
    const item = input.submissions[position];
    const hasNextSubmission = position < total - 1;
    const result = await submitOneForm(
      input.sourceUrl,
      item,
      total,
      completed,
      failed,
      hasNextSubmission,
    );

    completed = result.completed;
    failed = result.failed;

    if (!result.ok) break;
    if (hasNextSubmission) {
      await sleep(`${item.delaySeconds}s`);
    }
  }

  const outcome = failed > 0 ? "failed" : "completed";
  await writeProgress({
    type: "finished",
    total,
    completed,
    failed,
    outcome,
    message:
      outcome === "completed"
        ? `Đã gửi hoàn tất ${completed}/${total} form.`
        : `Đã dừng sau lỗi. Hoàn tất ${completed}/${total} form.`,
  });

  return {
    total,
    completed,
    failed,
    outcome,
  };
}
