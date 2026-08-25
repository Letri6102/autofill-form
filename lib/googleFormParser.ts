export type ParsedQuestion = {
  questionOrder: number;
  sectionIndex: number;
  sectionTitle: string;
  groupTitle: string;
  questionText: string;
  questionDescription: string;
  entry: string;
  typeId: number | null;
  type: string;
  required: boolean;
  options: string[];
};

export type ParsedSection = {
  sectionIndex: number;
  sectionTitle: string;
  sectionDescription: string;
  questions: ParsedQuestion[];
};

export type ParsedGoogleForm = {
  formTitle: string;
  formDescription: string;
  pageHistory: string;
  sourceUrl: string;
  sections: ParsedSection[];
};

const TYPE_MAP: Record<number, string> = {
  0: "Short Answer",
  1: "Paragraph",
  2: "Multiple Choice",
  3: "Dropdown",
  4: "Checkboxes",
  5: "Linear Scale",
  7: "Grid / Multiple Choice Grid",
  9: "Date",
  10: "Time",
  11: "Checkbox Grid",
  13: "File Upload",
};

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(cleanText).filter(Boolean)));
}

function extractOptionLabels(optionsRaw: unknown): string[] {
  const labels: string[] = [];

  function walk(value: unknown, depth = 0) {
    if (depth > 4 || value === null || value === undefined) return;

    if (typeof value === "string") {
      const cleaned = cleanText(value);
      if (cleaned) labels.push(cleaned);
      return;
    }

    if (!Array.isArray(value)) return;

    for (const item of value) {
      if (Array.isArray(item)) {
        // Google Forms usually stores options like: ["Option text", null, null, ...]
        if (typeof item[0] === "string") {
          const label = cleanText(item[0]);
          if (label) labels.push(label);
        } else {
          walk(item, depth + 1);
        }
      } else if (typeof item === "string") {
        const label = cleanText(item);
        if (label) labels.push(label);
      }
    }
  }

  walk(optionsRaw);
  return unique(labels);
}

function extractGridRowLabel(detail: unknown[]): string {
  const rowMetadata = detail[3];
  if (Array.isArray(rowMetadata)) {
    const label = rowMetadata.find((value) => typeof value === "string");
    return cleanText(label);
  }

  return cleanText(rowMetadata);
}

function extractFormData(html: string): unknown[] {
  const patterns = [
    /var\s+FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]+?\]);\s*<\/script>/,
    /var\s+FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]+?\]);/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      try {
        return JSON.parse(match[1]);
      } catch {
        throw new Error("Tìm thấy FB_PUBLIC_LOAD_DATA_ nhưng không parse được JSON.");
      }
    }
  }

  throw new Error("Không tìm thấy dữ liệu FB_PUBLIC_LOAD_DATA_ trong Google Form.");
}

function extractInputAttribute(inputTag: string, attribute: string): string {
  const quotedPattern = new RegExp(`${attribute}\\s*=\\s*(["'])(.*?)\\1`, "i");
  const quotedMatch = inputTag.match(quotedPattern);
  if (quotedMatch?.[2] !== undefined) return cleanText(quotedMatch[2]);

  const unquotedPattern = new RegExp(`${attribute}\\s*=\\s*([^\\s>]+)`, "i");
  const unquotedMatch = inputTag.match(unquotedPattern);
  return cleanText(unquotedMatch?.[1]);
}

function extractPageHistory(html: string): string {
  const inputTags = html.match(/<input\b[^>]*>/gi) ?? [];

  for (const inputTag of inputTags) {
    if (extractInputAttribute(inputTag, "name") === "pageHistory") {
      return extractInputAttribute(inputTag, "value");
    }
  }

  return "";
}

function buildPageHistory(sectionCount: number): string {
  const count = Math.max(1, sectionCount);
  return Array.from({ length: count }, (_, index) => String(index)).join(",");
}

function parseGoogleFormUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("Vui lòng nhập link Google Form.");

  const urlWithProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(urlWithProtocol);
  } catch {
    throw new Error("Link không hợp lệ.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Link Google Form phải dùng http hoặc https.");
  }

  url.hash = "";
  return url;
}

export function normalizeGoogleFormInputUrl(rawUrl: string): string {
  const url = parseGoogleFormUrl(rawUrl);

  if (url.hostname === "forms.gle") {
    if (url.pathname === "/") throw new Error("Link forms.gle chưa đầy đủ.");
    url.protocol = "https:";
    return url.toString();
  }

  return normalizeGoogleFormUrl(url.toString());
}

export function normalizeGoogleFormUrl(rawUrl: string): string {
  const url = parseGoogleFormUrl(rawUrl);

  if (url.hostname !== "docs.google.com" || !url.pathname.startsWith("/forms/")) {
    throw new Error("Link phải thuộc Google Forms (docs.google.com hoặc forms.gle).");
  }

  url.protocol = "https:";

  url.pathname = url.pathname.replace(/\/formResponse\/?$/, "/viewform");
  if (!/\/viewform\/?$/.test(url.pathname)) {
    const formPath = url.pathname.match(/^(\/forms(?:\/u\/\d+)?\/d\/(?:e\/)?[^/]+)(?:\/.*)?$/)?.[1];
    if (!formPath) throw new Error("Không nhận ra đường dẫn Google Form.");
    url.pathname = `${formPath}/viewform`;
  }

  return url.toString();
}

export function toGoogleFormResponseUrl(rawUrl: string): string {
  const viewFormUrl = normalizeGoogleFormUrl(rawUrl);
  const url = new URL(viewFormUrl);
  url.pathname = url.pathname.replace(/\/viewform\/?$/, "/formResponse");
  return url.toString();
}

export function parseGoogleFormHtml(html: string, sourceUrl: string): ParsedGoogleForm {
  const data = extractFormData(html);
  const root = data?.[1] as unknown[] | undefined;

  if (!Array.isArray(root)) {
    throw new Error("Không đọc được cấu trúc form. Có thể form đang giới hạn quyền truy cập.");
  }

  const questionsRaw = Array.isArray(root[1]) ? (root[1] as unknown[]) : [];
  const formDescription = cleanText(root[0]);
  const formTitle = cleanText(root[8]) || "Google Form";
  const pageHistoryFromHtml = extractPageHistory(html);

  const sections: ParsedSection[] = [
    {
      sectionIndex: 1,
      sectionTitle: "Section 1",
      sectionDescription: "",
      questions: [],
    },
  ];

  let currentSection = sections[0];
  let hasSeenSectionHeader = false;
  let questionOrder = 0;

  for (const rawItem of questionsRaw) {
    if (!Array.isArray(rawItem)) continue;

    const itemTitle = cleanText(rawItem[1]);
    const itemDescription = cleanText(rawItem[2]);
    const itemType = typeof rawItem[3] === "number" ? rawItem[3] : null;
    const details = rawItem[4];

    // Google Forms marks a new section/page with item type 8.
    const hasEntryDetails = Array.isArray(details) && details.length > 0;
    const isSectionHeader = itemType === 8;

    if (isSectionHeader) {
      const isInitialEmptySection =
        !hasSeenSectionHeader &&
        sections.length === 1 &&
        currentSection === sections[0] &&
        currentSection.questions.length === 0 &&
        currentSection.sectionTitle === "Section 1" &&
        !currentSection.sectionDescription;

      if (isInitialEmptySection) {
        currentSection.sectionTitle = itemTitle || "Section 1";
        currentSection.sectionDescription = itemDescription;
      } else {
        currentSection = {
          sectionIndex: sections.length + 1,
          sectionTitle: itemTitle || `Section ${sections.length + 1}`,
          sectionDescription: itemDescription,
          questions: [],
        };
        sections.push(currentSection);
      }
      hasSeenSectionHeader = true;
      continue;
    }

    if (!hasEntryDetails) continue;

    if (!Array.isArray(details)) continue;

    for (const detail of details) {
      if (!Array.isArray(detail) || detail.length === 0) continue;

      const rawEntryId = detail[0];
      if (rawEntryId === null || rawEntryId === undefined) continue;

      const entryId = String(rawEntryId);
      const optionsRaw = detail[1];
      const required = Boolean(detail[2]);
      const type = itemType !== null ? TYPE_MAP[itemType] ?? `Unknown Type ${itemType}` : "Unknown";
      const options = extractOptionLabels(optionsRaw);
      const isGridQuestion = itemType === 7 || itemType === 11;
      const gridRowLabel = isGridQuestion ? extractGridRowLabel(detail) : "";

      questionOrder += 1;

      currentSection.questions.push({
        questionOrder,
        sectionIndex: currentSection.sectionIndex,
        sectionTitle: currentSection.sectionTitle,
        groupTitle: isGridQuestion ? itemTitle : "",
        questionText: gridRowLabel || itemTitle,
        questionDescription: itemDescription,
        entry: entryId.startsWith("entry.") ? entryId : `entry.${entryId}`,
        typeId: itemType,
        type,
        required,
        options,
      });
    }
  }

  const nonEmptySections = sections.filter(
    (section, index) => index === 0 || section.questions.length > 0 || section.sectionTitle !== "Section 1",
  );
  const inferredPageHistory = buildPageHistory(nonEmptySections.length);
  const pageHistory = nonEmptySections.length > 1 ? inferredPageHistory : pageHistoryFromHtml || inferredPageHistory;

  return {
    formTitle,
    formDescription,
    pageHistory,
    sourceUrl,
    sections: nonEmptySections,
  };
}
