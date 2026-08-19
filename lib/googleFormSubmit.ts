import { normalizeGoogleFormUrl, toGoogleFormResponseUrl } from "@/lib/googleFormParser";

export type PayloadValue = string | string[];
export type FormPayload = Record<string, PayloadValue>;

export type GoogleFormSubmitResult = {
  ok: boolean;
  status: number;
  statusText: string;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isValidPayload(payload: unknown): payload is FormPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  return Object.entries(payload).every(
    ([key, value]) => key.trim() && (typeof value === "string" || isStringArray(value)),
  );
}

function toUrlSearchParams(payload: FormPayload): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item);
      }
    } else {
      params.append(key, value);
    }
  }

  return params;
}

export async function submitGoogleForm(
  sourceUrlValue: string,
  payload: FormPayload,
): Promise<GoogleFormSubmitResult> {
  const sourceUrl = normalizeGoogleFormUrl(sourceUrlValue);
  const formResponseUrl = toGoogleFormResponseUrl(sourceUrl);
  const params = toUrlSearchParams(payload);

  const response = await fetch(formResponseUrl, {
    method: "POST",
    cache: "no-store",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Origin: "https://docs.google.com",
      Referer: sourceUrl,
    },
    body: params.toString(),
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
  };
}
