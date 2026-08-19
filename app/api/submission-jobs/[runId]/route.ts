import { NextRequest, NextResponse } from "next/server";
import { getRun } from "workflow/api";
import {
  RECENT_PROGRESS_EVENT_COUNT,
  type SubmissionProgressEvent,
  type SubmissionWorkflowResult,
} from "@/lib/submissionWorkflowTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    runId: string;
  }>;
};

function validateRunId(value: string): string {
  if (!/^wrun_[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Mã Workflow không hợp lệ.");
  }
  return value;
}

async function readRecentProgressEvents(
  runId: string,
): Promise<SubmissionProgressEvent[]> {
  const run = getRun<SubmissionWorkflowResult>(runId);
  const probe = run.getReadable<SubmissionProgressEvent>();
  const tailIndex = await probe.getTailIndex();

  if (tailIndex < 0) return [];

  const startIndex = Math.max(0, tailIndex - RECENT_PROGRESS_EVENT_COUNT + 1);
  const expectedCount = tailIndex - startIndex + 1;
  const reader = run
    .getReadable<SubmissionProgressEvent>({ startIndex })
    .getReader();
  const events: SubmissionProgressEvent[] = [];

  try {
    for (let index = 0; index < expectedCount; index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      events.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return events;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const runId = validateRunId((await context.params).runId);
    const run = getRun<SubmissionWorkflowResult>(runId);

    if (!(await run.exists)) {
      return NextResponse.json({ ok: false, message: "Không tìm thấy Workflow." }, { status: 404 });
    }

    const [workflowStatus, events] = await Promise.all([
      run.status,
      readRecentProgressEvents(runId),
    ]);
    const latest = events.at(-1);
    const submittedEvents = events.filter(
      (event): event is Extract<SubmissionProgressEvent, { type: "submitted" }> =>
        event.type === "submitted",
    );
    const status =
      latest?.type === "finished"
        ? latest.outcome
        : workflowStatus;

    return NextResponse.json({
      ok: true,
      runId,
      status,
      total: latest?.total ?? 0,
      completed: latest?.completed ?? 0,
      failed: latest?.failed ?? 0,
      message: latest?.message ?? "Workflow đang khởi tạo.",
      nextSubmitAt:
        latest?.type === "submitted" ? latest.nextSubmitAt : null,
      logs: submittedEvents
        .map((event) => ({
          index: event.index,
          sourceRow: event.sourceRow,
          ok: event.ok,
          status: event.status,
          message: event.message,
        }))
        .reverse(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không đọc được Workflow.";
    return NextResponse.json({ ok: false, message }, { status: 400 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const runId = validateRunId((await context.params).runId);
    const run = getRun<SubmissionWorkflowResult>(runId);

    if (!(await run.exists)) {
      return NextResponse.json({ ok: false, message: "Không tìm thấy Workflow." }, { status: 404 });
    }

    await run.cancel();
    return NextResponse.json({ ok: true, runId, status: "cancelled" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không hủy được Workflow.";
    return NextResponse.json({ ok: false, message }, { status: 400 });
  }
}
