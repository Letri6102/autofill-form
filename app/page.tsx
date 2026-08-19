"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";

type ParsedQuestion = {
  questionOrder: number;
  sectionIndex: number;
  sectionTitle: string;
  questionText: string;
  questionDescription: string;
  entry: string;
  typeId: number | null;
  type: string;
  required: boolean;
  options: string[];
};

type ParsedSection = {
  sectionIndex: number;
  sectionTitle: string;
  sectionDescription: string;
  questions: ParsedQuestion[];
};

type ParsedGoogleForm = {
  formTitle: string;
  formDescription: string;
  pageHistory: string;
  sourceUrl: string;
  sections: ParsedSection[];
};

type ApiResponse =
  | {
      ok: true;
      data: ParsedGoogleForm;
    }
  | {
      ok: false;
      message: string;
    };

type StartSubmissionJobResponse =
  | {
      ok: true;
      runId: string;
      total: number;
    }
  | {
      ok: false;
      message: string;
    };

type SubmissionJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

type SubmissionJobStatusResponse =
  | {
      ok: true;
      runId: string;
      status: SubmissionJobStatus;
      total: number;
      completed: number;
      failed: number;
      message: string;
      nextSubmitAt: string | null;
      logs: SubmissionLog[];
    }
  | {
      ok: false;
      message: string;
    };

type SubmissionLog = {
  index: number;
  ok: boolean;
  status: number | null;
  message: string;
  sourceRow?: number;
};

type ImportedData = {
  fileName: string;
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  previewRows: Record<string, string>[];
};

type DataFileResponse =
  | {
      ok: true;
      data: ImportedData;
    }
  | {
      ok: false;
      message: string;
    };

const MAX_FORM_COUNT = 1000;
const MIN_DELAY_SECONDS = 10;
const MAX_DELAY_SECONDS = 3600;
const QUESTIONS_PER_PAGE = 5;
const WEIGHT_STEP = 10;
const ACTIVE_RUN_STORAGE_KEY = "google-form-active-workflow-run";
const JOB_POLL_INTERVAL_MS = 3000;
const MAX_START_REQUEST_BYTES = 4_000_000;
const WEIGHT_PERCENTAGES = Array.from({ length: 100 / WEIGHT_STEP + 1 }, (_, index) =>
  index * WEIGHT_STEP,
);

function getJobStatusLabel(status: SubmissionJobStatus | ""): string {
  switch (status) {
    case "pending":
      return "Đang xếp hàng";
    case "running":
      return "Đang chạy trên Vercel";
    case "completed":
      return "Đã hoàn tất";
    case "failed":
      return "Đã dừng do lỗi";
    case "cancelled":
      return "Đã hủy";
    default:
      return "Chưa chạy";
  }
}

function buildDefaultWeights(options: string[]): Record<string, number> {
  if (options.length === 0) return {};

  const totalUnits = 100 / WEIGHT_STEP;
  const baseUnits = Math.floor(totalUnits / options.length);
  const remainderUnits = totalUnits - baseUnits * options.length;

  return Object.fromEntries(
    options.map((option, index) => [
      option,
      (baseUnits + (index < remainderUnits ? 1 : 0)) * WEIGHT_STEP,
    ]),
  );
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function randomInt(min: number, max: number): number {
  const safeMin = Math.ceil(Math.min(min, max));
  const safeMax = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function parseTextAnswers(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((answer) => answer.trim())
    .filter(Boolean);
}

function normalizeMatchKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function buildAutoColumnMapping(questions: ParsedQuestion[], headers: string[]): Record<string, string> {
  const headerByKey = new Map(headers.map((header) => [normalizeMatchKey(header), header]));
  const mapping: Record<string, string> = {};

  for (const question of questions) {
    const titleCode = question.questionText.match(/^([A-Za-z]+\d+)(?:[\s.:-]|$)/)?.[1];
    const candidates = [
      question.entry,
      question.entry.replace(/^entry\./, ""),
      question.questionText,
      titleCode ?? "",
    ];
    const matchedHeader = candidates.map(normalizeMatchKey).map((key) => headerByKey.get(key)).find(Boolean);

    if (matchedHeader) {
      mapping[question.entry] = matchedHeader;
    }
  }

  return mapping;
}

export default function HomePage() {
  const [formUrl, setFormUrl] = useState("");
  const [data, setData] = useState<ParsedGoogleForm | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [optionWeights, setOptionWeights] = useState<Record<string, Record<string, number>>>({});
  const [pageHistoryValue, setPageHistoryValue] = useState("0");
  const [formCount, setFormCount] = useState(10);
  const [delayMinSeconds, setDelayMinSeconds] = useState(90);
  const [delayMaxSeconds, setDelayMaxSeconds] = useState(150);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitLogs, setSubmitLogs] = useState<SubmissionLog[]>([]);
  const [delayRemaining, setDelayRemaining] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [importedData, setImportedData] = useState<ImportedData | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState("");
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [textAnswerBanks, setTextAnswerBanks] = useState<Record<string, string>>({});
  const [fileStartLine, setFileStartLine] = useState(2);
  const [completedCount, setCompletedCount] = useState(0);
  const [submitTargetCount, setSubmitTargetCount] = useState(0);
  const [activeRunId, setActiveRunId] = useState("");
  const [jobStatus, setJobStatus] = useState<SubmissionJobStatus | "">("");
  const [jobMessage, setJobMessage] = useState("");
  const [nextSubmitAt, setNextSubmitAt] = useState<string | null>(null);

  useEffect(() => {
    const savedRunId = window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY);
    if (savedRunId) setActiveRunId(savedRunId);
  }, []);

  useEffect(() => {
    if (!activeRunId) return;

    let disposed = false;

    async function refreshJobStatus() {
      try {
        const response = await fetch(`/api/submission-jobs/${encodeURIComponent(activeRunId)}`, {
          cache: "no-store",
        });
        const result = (await response.json()) as SubmissionJobStatusResponse;
        if (disposed) return;

        if (!response.ok || !result.ok) {
          setSubmitError(result.ok ? "Không đọc được tiến độ Workflow." : result.message);
          return;
        }

        const isRunning = result.status === "pending" || result.status === "running";
        setJobStatus(result.status);
        setJobMessage(result.message);
        setSubmitTargetCount(result.total);
        setCompletedCount(result.completed);
        setSubmitLogs(result.logs);
        setNextSubmitAt(isRunning ? result.nextSubmitAt : null);
        setSubmitting(isRunning);

        if (result.status === "failed") {
          setSubmitError(result.message);
        } else if (result.status === "cancelled") {
          setSubmitError("Workflow đã được hủy.");
        } else {
          setSubmitError("");
        }

        if (!isRunning) {
          window.clearInterval(pollId);
        }
      } catch {
        if (!disposed) {
          setSubmitError("Tạm thời không đọc được tiến độ Workflow. Hệ thống sẽ thử lại.");
        }
      }
    }

    void refreshJobStatus();
    const pollId = window.setInterval(() => void refreshJobStatus(), JOB_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(pollId);
    };
  }, [activeRunId]);

  useEffect(() => {
    if (!nextSubmitAt) {
      setDelayRemaining(null);
      return;
    }

    function updateRemainingTime() {
      const remaining = Math.max(0, Math.ceil((new Date(nextSubmitAt!).getTime() - Date.now()) / 1000));
      setDelayRemaining(remaining > 0 ? remaining : null);
    }

    updateRemainingTime();
    const timerId = window.setInterval(updateRemainingTime, 1000);
    return () => window.clearInterval(timerId);
  }, [nextSubmitAt]);

  const totalQuestions = useMemo(() => {
    if (!data) return 0;
    return data.sections.reduce((sum, section) => sum + section.questions.length, 0);
  }, [data]);

  const allQuestions = useMemo(() => {
    if (!data) return [];
    return data.sections.flatMap((section) => section.questions);
  }, [data]);

  const optionQuestions = useMemo(() => {
    return allQuestions.filter((question) => question.options.length > 0);
  }, [allQuestions]);

  const textAnswerEntries = useMemo(() => {
    return new Set(
      Object.entries(textAnswerBanks)
        .filter(([, answers]) => parseTextAnswers(answers).length > 0)
        .map(([entry]) => entry),
    );
  }, [textAnswerBanks]);

  const mappedEntries = useMemo(() => {
    if (!importedData) return new Set<string>();
    const headers = new Set(importedData.headers);
    return new Set(
      Object.entries(columnMapping)
        .filter(([, header]) => header && headers.has(header))
        .map(([entry]) => entry),
    );
  }, [columnMapping, importedData]);

  const hasImportedMapping = Boolean(importedData && mappedEntries.size > 0);
  const hasTextAnswerBank = textAnswerEntries.size > 0;
  const fileStartIndex = Math.max(0, Math.floor(fileStartLine) - 2);
  const availableFileRows = importedData ? Math.max(0, importedData.rowCount - fileStartIndex) : 0;
  const plannedSubmitCount =
    Number.isFinite(formCount) && formCount > 0 ? Math.min(MAX_FORM_COUNT, Math.floor(formCount)) : 0;
  const progressTotal = submitTargetCount || plannedSubmitCount;
  const displayFileStartLine = Number.isFinite(fileStartLine) ? Math.floor(fileStartLine) : 2;
  const fileRunEndLine =
    hasImportedMapping && importedData && plannedSubmitCount > 0
      ? Math.min(displayFileStartLine + plannedSubmitCount - 1, importedData.rowCount + 1)
      : null;

  useEffect(() => {
    if (!data) {
      setOptionWeights({});
      setPageHistoryValue("0");
      setColumnMapping({});
      setTextAnswerBanks({});
      if (!window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY)) {
        setSubmitLogs([]);
        setSubmitError("");
        setCompletedCount(0);
        setSubmitTargetCount(0);
      }
      setFileStartLine(2);
      return;
    }

    const nextWeights: Record<string, Record<string, number>> = {};
    for (const section of data.sections) {
      for (const question of section.questions) {
        if (question.options.length > 0) {
          nextWeights[question.entry] = buildDefaultWeights(question.options);
        }
      }
    }

    setOptionWeights(nextWeights);
    setPageHistoryValue(data.pageHistory || "0");
    setSubmitLogs([]);
    setSubmitError("");
    setTextAnswerBanks({});
    setCompletedCount(0);
    setSubmitTargetCount(0);
    setCurrentPage(1);
  }, [data]);

  useEffect(() => {
    if (!importedData || allQuestions.length === 0) {
      setColumnMapping({});
      return;
    }

    setColumnMapping(buildAutoColumnMapping(allQuestions, importedData.headers));
  }, [allQuestions, importedData]);

  const filteredSections = useMemo(() => {
    if (!data) return [];
    const key = keyword.trim().toLowerCase();
    if (!key) return data.sections;

    return data.sections
      .map((section) => ({
        ...section,
        questions: section.questions.filter((question) => {
          const haystack = [
            section.sectionTitle,
            question.questionText,
            question.questionDescription,
            question.entry,
            question.type,
            question.options.join(" "),
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(key);
        }),
      }))
      .filter((section) => section.questions.length > 0);
  }, [data, keyword]);

  useEffect(() => {
    setCurrentPage(1);
  }, [keyword]);

  const filteredQuestions = useMemo(
    () => filteredSections.flatMap((section) => section.questions),
    [filteredSections],
  );

  const pageCount = Math.max(1, Math.ceil(filteredQuestions.length / QUESTIONS_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, pageCount);
  const pageStart = filteredQuestions.length === 0 ? 0 : (safeCurrentPage - 1) * QUESTIONS_PER_PAGE + 1;
  const pageEnd = Math.min(safeCurrentPage * QUESTIONS_PER_PAGE, filteredQuestions.length);

  const paginatedSections = useMemo(() => {
    if (!data) return [];

    const sectionMap = new Map(data.sections.map((section) => [section.sectionIndex, section]));
    const questions = filteredQuestions.slice(
      (safeCurrentPage - 1) * QUESTIONS_PER_PAGE,
      safeCurrentPage * QUESTIONS_PER_PAGE,
    );
    const sections: ParsedSection[] = [];

    for (const question of questions) {
      let section = sections.find((item) => item.sectionIndex === question.sectionIndex);
      if (!section) {
        const sourceSection = sectionMap.get(question.sectionIndex);
        section = {
          sectionIndex: question.sectionIndex,
          sectionTitle: question.sectionTitle,
          sectionDescription: sourceSection?.sectionDescription ?? "",
          questions: [],
        };
        sections.push(section);
      }
      section.questions.push(question);
    }

    return sections;
  }, [data, filteredQuestions, safeCurrentPage]);

  function getQuestionWeightTotal(question: ParsedQuestion): number {
    const weights = optionWeights[question.entry] ?? {};
    return question.options.reduce((sum, option) => sum + (Number(weights[option]) || 0), 0);
  }

  const submitConfigError = useMemo(() => {
    if (!data) return "Chưa có dữ liệu form.";
    if (optionQuestions.length === 0 && !hasImportedMapping && !hasTextAnswerBank) {
      return "Form chưa có options, dữ liệu file hoặc câu trả lời nhập tay để tạo payload tự động.";
    }
    if (formCount < 1 || formCount > MAX_FORM_COUNT) {
      return `Số lượng form phải từ 1 đến ${MAX_FORM_COUNT}.`;
    }
    if (hasImportedMapping && importedData) {
      if (fileStartLine < 2 || fileStartLine > importedData.rowCount + 1) {
        return `Dòng file bắt đầu phải từ 2 đến ${importedData.rowCount + 1}.`;
      }
      if (formCount > availableFileRows) {
        return `Từ dòng ${fileStartLine}, file chỉ còn ${availableFileRows} dòng dữ liệu.`;
      }
    }
    if (delayMinSeconds < MIN_DELAY_SECONDS || delayMaxSeconds > MAX_DELAY_SECONDS) {
      return `Delay phải nằm trong khoảng ${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS} giây.`;
    }
    if (delayMinSeconds > delayMaxSeconds) return "Delay bắt đầu không được lớn hơn delay kết thúc.";

    const invalidQuestion = optionQuestions
      .filter((question) => !mappedEntries.has(question.entry))
      .find(
        (question) =>
          question.options.reduce(
            (sum, option) => sum + (Number(optionWeights[question.entry]?.[option]) || 0),
            0,
          ) !== 100,
      );
    if (invalidQuestion) {
      return `Tổng tỉ lệ của "${invalidQuestion.questionText || invalidQuestion.entry}" phải bằng 100%.`;
    }

    const missingRequiredTextQuestion = allQuestions.find(
      (question) =>
        question.required &&
        question.options.length === 0 &&
        !mappedEntries.has(question.entry) &&
        !textAnswerEntries.has(question.entry),
    );
    if (missingRequiredTextQuestion) {
      return `Câu bắt buộc "${
        missingRequiredTextQuestion.questionText || missingRequiredTextQuestion.entry
      }" cần map cột dữ liệu hoặc nhập danh sách câu trả lời.`;
    }

    if (!pageHistoryValue.trim()) return "pageHistory không được để trống.";
    return "";
  }, [
    data,
    allQuestions,
    delayMaxSeconds,
    delayMinSeconds,
    availableFileRows,
    fileStartLine,
    formCount,
    hasImportedMapping,
    hasTextAnswerBank,
    importedData,
    mappedEntries,
    optionQuestions,
    optionWeights,
    pageHistoryValue,
    textAnswerEntries,
  ]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setData(null);

    try {
      const response = await fetch("/api/parse-form", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: formUrl }),
      });

      const result = (await response.json()) as ApiResponse;
      if (!result.ok) {
        setError(result.message || "Không thể đọc form.");
        return;
      }

      setFormUrl(result.data.sourceUrl);
      setData(result.data);
    } catch {
      setError("Không gọi được API. Hãy kiểm tra server NextJS đang chạy.");
    } finally {
      setLoading(false);
    }
  }

  async function handleDataFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportLoading(true);
    setImportError("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/parse-data-file", {
        method: "POST",
        body: formData,
      });
      const result = (await response.json()) as DataFileResponse;

      if (!result.ok) {
        setImportError(result.message || "Không đọc được file dữ liệu.");
        setImportedData(null);
        return;
      }

      setImportedData(result.data);
      setFileStartLine(2);
      setFormCount(Math.min(result.data.rowCount || 1, MAX_FORM_COUNT));
      setCompletedCount(0);
      setSubmitTargetCount(0);
    } catch {
      setImportError("Không gọi được API đọc file dữ liệu.");
      setImportedData(null);
    } finally {
      setImportLoading(false);
      event.target.value = "";
    }
  }

  function clearImportedData() {
    setImportedData(null);
    setImportError("");
    setColumnMapping({});
    setFileStartLine(2);
  }

  function updateColumnMapping(question: ParsedQuestion, header: string) {
    setColumnMapping((current) => ({
      ...current,
      [question.entry]: header,
    }));
  }

  function updateTextAnswerBank(question: ParsedQuestion, value: string) {
    setTextAnswerBanks((current) => ({
      ...current,
      [question.entry]: value,
    }));
  }

  function updateOptionWeight(question: ParsedQuestion, option: string, nextWeight: number) {
    const safeWeight = clampNumber(Math.round(nextWeight), 0, 100);

    setOptionWeights((current) => ({
      ...current,
      [question.entry]: {
        ...current[question.entry],
        [option]: safeWeight,
      },
    }));
  }

  function chooseWeightedOption(question: ParsedQuestion): string | null {
    const weights = optionWeights[question.entry] ?? {};
    const weightedOptions = question.options
      .map((option) => ({
        option,
        weight: Number(weights[option]) || 0,
      }))
      .filter((item) => item.weight > 0);

    const totalWeight = weightedOptions.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) return null;

    let cursor = Math.random() * totalWeight;
    for (const item of weightedOptions) {
      cursor -= item.weight;
      if (cursor <= 0) return item.option;
    }

    return weightedOptions.at(-1)?.option ?? null;
  }

  function chooseTextAnswer(question: ParsedQuestion): string | null {
    const answers = parseTextAnswers(textAnswerBanks[question.entry] ?? "");
    if (answers.length === 0) return null;
    return answers[randomInt(0, answers.length - 1)];
  }

  function buildSubmissionPayload(rowIndex?: number): Record<string, string> {
    const payload: Record<string, string> = {};
    const row = rowIndex !== undefined ? importedData?.rows[rowIndex] : undefined;

    for (const question of allQuestions) {
      const mappedHeader = columnMapping[question.entry];
      const importedValue = mappedHeader && row ? row[mappedHeader]?.trim() : "";

      if (importedValue) {
        payload[question.entry] = importedValue;
      } else if (question.options.length > 0) {
        const selectedOption = chooseWeightedOption(question);
        if (selectedOption) {
          payload[question.entry] = selectedOption;
        }
      } else {
        const selectedTextAnswer = chooseTextAnswer(question);
        if (selectedTextAnswer) {
          payload[question.entry] = selectedTextAnswer;
        }
      }
    }

    payload.pageHistory = pageHistoryValue.trim() || data?.pageHistory || "0";
    return payload;
  }

  async function stopSubmitting() {
    if (!activeRunId) return;

    try {
      const response = await fetch(`/api/submission-jobs/${encodeURIComponent(activeRunId)}`, {
        method: "DELETE",
      });
      const result = (await response.json()) as { ok: boolean; message?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.message || "Không hủy được Workflow.");
      }

      setSubmitting(false);
      setJobStatus("cancelled");
      setJobMessage("Workflow đã được hủy.");
      setSubmitError("Workflow đã được hủy.");
      setNextSubmitAt(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Không hủy được Workflow.");
    }
  }

  function clearSavedJob() {
    window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
    setActiveRunId("");
    setJobStatus("");
    setJobMessage("");
    setNextSubmitAt(null);
    setSubmitLogs([]);
    setSubmitError("");
    setCompletedCount(0);
    setSubmitTargetCount(0);
  }

  async function submitGeneratedPayloads() {
    if (!data) return;

    if (submitConfigError) {
      setSubmitError(submitConfigError);
      return;
    }

    const count = Math.floor(clampNumber(formCount, 1, MAX_FORM_COUNT));
    const minDelay = Math.floor(clampNumber(delayMinSeconds, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS));
    const maxDelay = Math.floor(clampNumber(delayMaxSeconds, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS));
    const safeFileStartLine =
      hasImportedMapping && importedData
        ? Math.floor(clampNumber(fileStartLine, 2, importedData.rowCount + 1))
        : 2;

    setFormCount(count);
    setFileStartLine(safeFileStartLine);
    setDelayMinSeconds(minDelay);
    setDelayMaxSeconds(maxDelay);
    setSubmitLogs([]);
    setSubmitError("");
    setCompletedCount(0);
    setSubmitTargetCount(count);
    setSubmitting(true);
    setDelayRemaining(null);
    setNextSubmitAt(null);
    setJobStatus("pending");
    setJobMessage("Đang tạo Workflow trên server.");

    try {
      const submissions = Array.from({ length: count }, (_, position) => {
        const index = position + 1;
        const sourceRow = hasImportedMapping ? safeFileStartLine + position : undefined;
        const payload = buildSubmissionPayload(sourceRow !== undefined ? sourceRow - 2 : undefined);

        return {
          index,
          sourceRow,
          payload,
          delaySeconds: index < count ? randomInt(minDelay, maxDelay) : 0,
        };
      });
      const requestBody = JSON.stringify({
        sourceUrl: data.sourceUrl,
        submissions,
      });
      if (new Blob([requestBody]).size > MAX_START_REQUEST_BYTES) {
        throw new Error("Dữ liệu vượt 4 MB. Hãy giảm số form và chia thành nhiều lượt chạy.");
      }

      const response = await fetch("/api/submission-jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: requestBody,
      });
      const result = (await response.json()) as StartSubmissionJobResponse;

      if (!response.ok || !result.ok) {
        throw new Error(result.ok ? "Không thể tạo Workflow." : result.message);
      }

      window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, result.runId);
      setActiveRunId(result.runId);
      setSubmitTargetCount(result.total);
      setJobMessage("Workflow đã được tạo và sẽ tiếp tục chạy khi đóng tab.");
    } catch (submitErrorValue) {
      const message =
        submitErrorValue instanceof Error ? submitErrorValue.message : "Không tạo được Workflow submit form.";
      setSubmitError(message);
      setSubmitting(false);
      setJobStatus("failed");
      setJobMessage(message);
    }
  }

  function downloadJson() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "google-form-structure.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">Google Form Parser</p>
          <h1>Cào cấu trúc Google Form</h1>
          <p className="subtitle">
            Nhập link Google Form, hệ thống sẽ đọc các Section, câu hỏi, mã entry và danh sách
            options rồi hiển thị thành giao diện dễ kiểm tra.
          </p>
        </div>

        <form className="form-box" onSubmit={handleSubmit} autoComplete="off">
          <label htmlFor="formUrl">Link Google Form</label>
          <div className="input-row">
            <input
              id="formUrl"
              value={formUrl}
              onChange={(event) => {
                setFormUrl(event.target.value);
                setData(null);
                setError("");
              }}
              placeholder="https://forms.gle/... hoặc https://docs.google.com/forms/..."
              required
            />
            <button type="submit" disabled={loading}>
              {loading ? "Đang đọc..." : "Lấy dữ liệu"}
            </button>
          </div>
          <p className="hint">
            Hỗ trợ link <code>forms.gle</code>, <code>viewform</code> hoặc <code>formResponse</code>.
          </p>
        </form>
      </section>

      {error ? <div className="alert-error">{error}</div> : null}

      {activeRunId && !data ? (
        <section className="background-job-panel" aria-live="polite">
          <div className="background-job-header">
            <div>
              <p className="eyebrow">Tác vụ nền</p>
              <h2>{getJobStatusLabel(jobStatus)}</h2>
              <p>{jobMessage || "Đang tải tiến độ Workflow..."}</p>
            </div>
            <div className="submit-actions">
              {submitting ? (
                <button className="secondary-button" type="button" onClick={stopSubmitting}>
                  Dừng
                </button>
              ) : (
                <button className="secondary-button" type="button" onClick={clearSavedJob}>
                  Ẩn tiến độ
                </button>
              )}
            </div>
          </div>
          <div className="submit-progress">
            <div>
              <span>Hoàn tất</span>
              <strong>
                {completedCount} / {submitTargetCount} form
              </strong>
            </div>
            <div>
              <span>Trạng thái</span>
              <strong>{getJobStatusLabel(jobStatus)}</strong>
            </div>
          </div>
          {delayRemaining !== null ? (
            <p className="submit-status">Lượt tiếp theo sau khoảng {delayRemaining} giây.</p>
          ) : null}
          {submitError ? <p className="submit-warning">{submitError}</p> : null}
        </section>
      ) : null}

      {data ? (
        <section className="result-card">
          <div className="result-header">
            <div>
              <p className="eyebrow">Kết quả</p>
              <h2>{data.formTitle || "Google Form"}</h2>
              {data.formDescription ? <p className="description">{data.formDescription}</p> : null}
              <div className="meta-list">
                <p className="meta">
                  {data.sections.length} section · {totalQuestions} câu hỏi
                </p>
                <p className="meta">
                  pageHistory: <code>{data.pageHistory || "Không tìm thấy"}</code>
                </p>
              </div>
            </div>
            <button className="secondary-button" type="button" onClick={downloadJson}>
              Tải JSON
            </button>
          </div>

          <div className="submit-panel">
            <div className="submit-panel-header">
              <div>
                <p className="eyebrow">Payload</p>
                <h3>Cấu hình submit form</h3>
              </div>
              <div className="submit-actions">
                {submitting ? (
                  <button className="secondary-button" type="button" onClick={stopSubmitting}>
                    Dừng
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={submitting || Boolean(submitConfigError)}
                  onClick={submitGeneratedPayloads}
                >
                  {submitting ? "Đang submit..." : "Submit form"}
                </button>
              </div>
            </div>

            <div className="submit-controls">
              <label>
                <span>pageHistory</span>
                <input
                  value={pageHistoryValue}
                  disabled={submitting}
                  onChange={(event) => setPageHistoryValue(event.target.value)}
                />
              </label>
              <label>
                <span>Số lượng form</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_FORM_COUNT}
                  disabled={submitting}
                  value={formCount}
                  onChange={(event) => {
                    setFormCount(Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0);
                    setCompletedCount(0);
                    setSubmitTargetCount(0);
                  }}
                />
              </label>
              {importedData ? (
                <label>
                  <span>Dòng file bắt đầu</span>
                  <input
                    type="number"
                    min={2}
                    max={importedData.rowCount + 1}
                    step={1}
                    disabled={submitting}
                    value={fileStartLine}
                    onChange={(event) => {
                      const nextLine = Number.isFinite(event.target.valueAsNumber)
                        ? Math.floor(event.target.valueAsNumber)
                        : 2;
                      setFileStartLine(nextLine);
                      setCompletedCount(0);
                      setSubmitTargetCount(0);
                    }}
                  />
                </label>
              ) : null}
              <label>
                <span>Delay từ (giây)</span>
                <input
                  type="number"
                  min={MIN_DELAY_SECONDS}
                  max={MAX_DELAY_SECONDS}
                  disabled={submitting}
                  value={delayMinSeconds}
                  onChange={(event) =>
                    setDelayMinSeconds(Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0)
                  }
                />
              </label>
              <label>
                <span>Delay đến (giây)</span>
                <input
                  type="number"
                  min={MIN_DELAY_SECONDS}
                  max={MAX_DELAY_SECONDS}
                  disabled={submitting}
                  value={delayMaxSeconds}
                  onChange={(event) =>
                    setDelayMaxSeconds(Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0)
                  }
                />
              </label>
            </div>

            {submitConfigError ? <p className="submit-warning">{submitConfigError}</p> : null}
            {submitError ? <p className="submit-warning">{submitError}</p> : null}
            {activeRunId ? (
              <p className="submit-status">
                {getJobStatusLabel(jobStatus)} · <code>{activeRunId}</code>
              </p>
            ) : null}
            {delayRemaining !== null ? (
              <p className="submit-status">Lượt tiếp theo sau khoảng {delayRemaining} giây.</p>
            ) : null}

            <div className="submit-progress" aria-live="polite">
              <div>
                <span>Hoàn tất</span>
                <strong>
                  {completedCount} / {progressTotal} form
                </strong>
              </div>
              {jobStatus === "failed" ? (
                <div>
                  <span>Lỗi</span>
                  <strong>{Math.max(0, progressTotal - completedCount)} form chưa gửi</strong>
                </div>
              ) : null}
              {fileRunEndLine ? (
                <div>
                  <span>Dòng file</span>
                  <strong>
                    {displayFileStartLine} - {fileRunEndLine}
                  </strong>
                </div>
              ) : null}
            </div>

            <div className="data-import-panel">
              <div className="data-import-header">
                <div>
                  <p className="eyebrow">Data file</p>
                  <h4>CSV / Excel</h4>
                </div>
                {importedData ? (
                  <button className="secondary-button" type="button" onClick={clearImportedData}>
                    Xóa file
                  </button>
                ) : null}
              </div>

              <label className="file-picker">
                <span>{importLoading ? "Đang đọc file..." : "Chọn file CSV/XLSX"}</span>
                <input
                  type="file"
                  accept=".csv,.tsv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  disabled={importLoading}
                  onChange={handleDataFileChange}
                />
              </label>

              {importError ? <p className="submit-warning">{importError}</p> : null}

              {importedData ? (
                <div className="import-summary">
                  <p>
                    {importedData.fileName} · {importedData.rowCount} dòng dữ liệu ·{" "}
                    {importedData.headers.length} cột · {mappedEntries.size} entry đã map
                  </p>
                  <div className="data-preview">
                    <table>
                      <thead>
                        <tr>
                          {importedData.headers.slice(0, 8).map((header) => (
                            <th key={header}>{header}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importedData.previewRows.map((row, index) => (
                          <tr key={`${importedData.fileName}-${index}`}>
                            {importedData.headers.slice(0, 8).map((header) => (
                              <td key={header}>{row[header]}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>

            {submitLogs.length > 0 ? (
              <div className="submit-log-list">
                {submitLogs.map((log) => (
                  <div className="submit-log-row" key={`${log.index}-${log.status}-${log.message}`}>
                    <span>#{log.index}</span>
                    <strong>{log.ok ? "OK" : "Lỗi"}</strong>
                    <code>{log.status ?? "-"}</code>
                    <span>
                      {log.message}
                      {log.sourceRow ? ` · Dòng file ${log.sourceRow}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="toolbar">
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="Tìm câu hỏi, entry, option..."
            />
          </div>

          <div className="pagination-bar">
            <p>
              Hiển thị {pageStart}-{pageEnd} / {filteredQuestions.length} câu hỏi
            </p>
            <div className="pagination-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={safeCurrentPage <= 1}
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              >
                Trước
              </button>
              <span>
                Trang {safeCurrentPage} / {pageCount}
              </span>
              <button
                className="secondary-button"
                type="button"
                disabled={safeCurrentPage >= pageCount}
                onClick={() => setCurrentPage((page) => Math.min(pageCount, page + 1))}
              >
                Sau
              </button>
            </div>
          </div>

          <div className="section-list">
            {paginatedSections.map((section) => (
              <article className="section-card" key={`${section.sectionIndex}-${section.sectionTitle}`}>
                <div className="section-title-row">
                  <span>Section {section.sectionIndex}</span>
                  <h3>{section.sectionTitle}</h3>
                </div>
                {section.sectionDescription ? (
                  <p className="section-description">{section.sectionDescription}</p>
                ) : null}

                <div className="question-list">
                  {section.questions.map((question) => (
                    <div className="question-card" key={`${question.questionOrder}-${question.entry}`}>
                      <div className="question-topline">
                        <span className="question-number">#{question.questionOrder}</span>
                        <span className="type-badge">{question.type}</span>
                        {question.required ? <span className="required-badge">Bắt buộc</span> : null}
                      </div>

                      <h4>{question.questionText || "Không có tiêu đề câu hỏi"}</h4>
                      {question.questionDescription ? (
                        <p className="question-description">{question.questionDescription}</p>
                      ) : null}

                      <div className="entry-line">
                        <span>Entry:</span>
                        <code>{question.entry}</code>
                      </div>

                      {importedData ? (
                        <label className="column-mapping-row">
                          <span>Cột dữ liệu</span>
                          <select
                            value={columnMapping[question.entry] ?? ""}
                            onChange={(event) => updateColumnMapping(question, event.target.value)}
                          >
                            <option value="">Không dùng file</option>
                            {importedData.headers.map((header) => (
                              <option value={header} key={header}>
                                {header}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}

                      {question.options.length > 0 ? (
                        <div className="options-box">
                          <div className="options-header">
                            <p>Options</p>
                            <span>Tổng {getQuestionWeightTotal(question)}%</span>
                          </div>
                          <div className="option-weight-list">
                            {question.options.map((option) => {
                              const weight = optionWeights[question.entry]?.[option] ?? 0;
                              const quickWeight = WEIGHT_PERCENTAGES.includes(weight) ? weight : "";

                              return (
                                <div className="option-weight-row" key={option}>
                                  <span>{option}</span>
                                  <input
                                    aria-label={`Nhập tỷ lệ cho ${option}`}
                                    type="number"
                                    min={0}
                                    max={100}
                                    step={5}
                                    value={weight}
                                    onChange={(event) =>
                                      updateOptionWeight(question, option, event.target.valueAsNumber)
                                    }
                                  />
                                  <strong>%</strong>
                                  <select
                                    aria-label={`Chọn nhanh tỷ lệ cho ${option}`}
                                    value={quickWeight}
                                    onChange={(event) =>
                                      updateOptionWeight(question, option, Number(event.target.value))
                                    }
                                  >
                                    <option value="" disabled>
                                      Chọn nhanh
                                    </option>
                                    {WEIGHT_PERCENTAGES.map((percentage) => (
                                      <option value={percentage} key={percentage}>
                                        {percentage}%
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <div className="text-answer-box">
                          <div className="text-answer-header">
                            <p>Câu trả lời ngẫu nhiên</p>
                            <span>{parseTextAnswers(textAnswerBanks[question.entry] ?? "").length} đáp án</span>
                          </div>
                          <textarea
                            value={textAnswerBanks[question.entry] ?? ""}
                            onChange={(event) => updateTextAnswerBank(question, event.target.value)}
                            placeholder={"Nhập mỗi đáp án một dòng\nVí dụ:\nLa Roche-Posay\nCocoon\nL'Oreal"}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
