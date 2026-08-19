import { NextRequest, NextResponse } from "next/server";
import { isValidPayload, submitGoogleForm } from "@/lib/googleFormSubmit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SubmitRequest = {
  sourceUrl?: string;
  payload?: unknown;
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SubmitRequest;

    if (!isValidPayload(body.payload)) {
      return NextResponse.json(
        {
          ok: false,
          message: "Payload không hợp lệ.",
        },
        { status: 400 },
      );
    }

    const result = await submitGoogleForm(body.sourceUrl ?? "", body.payload);

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Có lỗi không xác định.";
    return NextResponse.json(
      {
        ok: false,
        message,
      },
      { status: 400 },
    );
  }
}
