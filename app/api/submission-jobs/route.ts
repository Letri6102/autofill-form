import { NextRequest, NextResponse } from "next/server";
import { start } from "workflow/api";
import { isValidPayload } from "@/lib/googleFormSubmit";
import { normalizeGoogleFormUrl } from "@/lib/googleFormParser";
import {
  MAX_WORKFLOW_DELAY_SECONDS,
  MAX_WORKFLOW_SUBMISSIONS,
  MIN_WORKFLOW_DELAY_SECONDS,
  type SubmissionWorkflowInput,
  type SubmissionWorkflowItem,
} from "@/lib/submissionWorkflowTypes";
import { submitFormsWorkflow } from "@/workflows/submitForms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StartSubmissionJobRequest = {
  sourceUrl?: unknown;
  submissions?: unknown;
};

function parseSubmissionItem(
  value: unknown,
  position: number,
  total: number,
): SubmissionWorkflowItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Payload #${position + 1} không hợp lệ.`);
  }

  const candidate = value as Record<string, unknown>;
  if (!isValidPayload(candidate.payload)) {
    throw new Error(`Payload #${position + 1} không hợp lệ.`);
  }

  const isLast = position === total - 1;
  const delaySeconds = Number(candidate.delaySeconds);
  if (
    !Number.isInteger(delaySeconds) ||
    (isLast
      ? delaySeconds !== 0
      : delaySeconds < MIN_WORKFLOW_DELAY_SECONDS ||
        delaySeconds > MAX_WORKFLOW_DELAY_SECONDS)
  ) {
    throw new Error(
      `Delay của payload #${position + 1} phải từ ${MIN_WORKFLOW_DELAY_SECONDS}-${MAX_WORKFLOW_DELAY_SECONDS} giây.`,
    );
  }

  const sourceRow = Number(candidate.sourceRow);
  const parsedSourceRow = Number.isInteger(sourceRow) && sourceRow >= 2 ? sourceRow : undefined;

  return {
    index: position + 1,
    payload: candidate.payload,
    sourceRow: parsedSourceRow,
    delaySeconds,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as StartSubmissionJobRequest;
    if (typeof body.sourceUrl !== "string") {
      throw new Error("Link Google Form không hợp lệ.");
    }

    if (!Array.isArray(body.submissions) || body.submissions.length === 0) {
      throw new Error("Danh sách payload đang trống.");
    }
    const submissions = body.submissions;
    if (submissions.length > MAX_WORKFLOW_SUBMISSIONS) {
      throw new Error(`Chỉ được chạy tối đa ${MAX_WORKFLOW_SUBMISSIONS} form mỗi lượt.`);
    }

    const sourceUrl = normalizeGoogleFormUrl(body.sourceUrl);
    const input: SubmissionWorkflowInput = {
      sourceUrl,
      submissions: submissions.map((item, index) =>
        parseSubmissionItem(item, index, submissions.length),
      ),
    };
    const run = await start(submitFormsWorkflow, [input]);

    return NextResponse.json(
      {
        ok: true,
        runId: run.runId,
        total: input.submissions.length,
      },
      { status: 202 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể tạo Workflow.";
    return NextResponse.json({ ok: false, message }, { status: 400 });
  }
}
