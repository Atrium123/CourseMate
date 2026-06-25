import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import mammoth from "mammoth";
import multer from "multer";
import OpenAI from "openai";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fssync from "node:fs";
import process from "node:process";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type {
  CourseFile,
  CoursePart,
  CourseSession,
  FollowUpAnswer,
  HistoryItem,
  LearningProgress,
  LessonMode,
  PartLesson,
  SessionLearningState,
} from "../src/types";

dotenv.config();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 35 * 1024 * 1024,
    files: 20,
  },
});

const port = Number(process.env.SERVER_PORT ?? 3001);
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const maxOutlineCharacters = Number(process.env.MAX_OUTLINE_CHARACTERS ?? 28000);
const maxLessonCharacters = Number(process.env.MAX_LESSON_CHARACTERS ?? 60000);
const dataDir = path.join(process.cwd(), "server-data", "history");

const sessions = new Map<string, CourseSession>();
const sessionFiles = new Map<
  string,
  Map<
    string,
    {
      buffer: Buffer;
      mimeType: string;
      name: string;
      text: string;
    }
  >
>();

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

function getSessionDir(sessionId: string) {
  return path.join(dataDir, sessionId);
}

function getSessionPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "session.json");
}

function getFilesDir(sessionId: string) {
  return path.join(getSessionDir(sessionId), "files");
}

function getLessonsDir(sessionId: string) {
  return path.join(getSessionDir(sessionId), "lessons");
}

function getProgressPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "progress.json");
}

function safeFileName(fileName: string) {
  return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function countMojibakeMarkers(text: string) {
  return Array.from(text).filter((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint === 0xfffd || (codePoint >= 0x0080 && codePoint <= 0x009f) || (codePoint >= 0x00c0 && codePoint <= 0x00ff);
  }).length;
}

function decodeUploadedFileName(fileName: string) {
  const decoded = Buffer.from(fileName, "latin1").toString("utf8");

  if (decoded.includes("�")) {
    return fileName;
  }

  const originalMojibakeScore = countMojibakeMarkers(fileName);
  const decodedMojibakeScore = countMojibakeMarkers(decoded);
  const decodedHasCjk = /[\u3400-\u9fff]/.test(decoded);

  if (originalMojibakeScore > decodedMojibakeScore && decodedHasCjk) {
    return decoded;
  }

  return fileName;
}

function normalizeLessonMode(mode: unknown): LessonMode {
  return "detailed";
}

async function readJsonFile<T>(filePath: string) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text) as T;
}

async function writeJsonFile(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  }),
);

function createOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  });
}

function isPlaceholderApiKey() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  return !apiKey || apiKey === "sk-coursemate-placeholder-key" || apiKey.startsWith("fake-");
}

function formatTotalSize(size: number) {
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

interface ExtractedFileText {
  text: string;
  pages: Array<{
    pageNumber: number;
    text: string;
  }>;
}

async function extractFileText(file: Express.Multer.File): Promise<ExtractedFileText> {
  const extension = path.extname(file.originalname).toLowerCase();

  if (extension === ".pdf" || file.mimetype === "application/pdf") {
    const parser = new PDFParse({ data: file.buffer });
    const data = await parser.getText();
    await parser.destroy();
    return {
      text: data.text,
      pages: data.pages.map((page) => ({
        pageNumber: page.num,
        text: page.text,
      })),
    };
  }

  if (extension === ".docx") {
    const data = await mammoth.extractRawText({ buffer: file.buffer });
    return {
      text: data.value,
      pages: [{ pageNumber: 1, text: data.value }],
    };
  }

  if (extension === ".txt" || file.mimetype.startsWith("text/")) {
    const text = file.buffer.toString("utf8");
    return {
      text,
      pages: [{ pageNumber: 1, text }],
    };
  }

  return {
    text: "",
    pages: [{ pageNumber: 1, text: "" }],
  };
}

function normalizeText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function trimText(text: string, limit: number) {
  const normalized = normalizeText(text);
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function parseJsonObject<T>(content: string): T {
  const trimmed = content.trim();
  const jsonText = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    const repairedJsonText = jsonText.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");

    try {
      return JSON.parse(repairedJsonText) as T;
    } catch {
      throw error;
    }
  }
}

function buildPageLabeledText(pages: ExtractedFileText["pages"], limit: number) {
  const labeledText = pages
    .map((page) => `[Page ${page.pageNumber}]\n${normalizeText(page.text)}`)
    .join("\n\n");

  return trimText(labeledText, limit);
}

function collectPagesText(pages: ExtractedFileText["pages"], pageStart: number, pageEnd: number) {
  return pages
    .filter((page) => page.pageNumber >= pageStart && page.pageNumber <= pageEnd)
    .map((page) => `[Page ${page.pageNumber}]\n${normalizeText(page.text)}`)
    .join("\n\n")
    .trim();
}

function buildFallbackParts(fileId: string, fileName: string, text: string, totalPages: number) {
  return [
    {
      title: "完整课件讲解",
      description: "按原课件顺序，从零开始完整讲清楚这一份资料。",
      pageStart: 1,
      pageEnd: Math.max(1, totalPages),
      sourceText: text,
    },
  ];
}

async function createOutlineForFile(
  fileId: string,
  fileName: string,
  extracted: ExtractedFileText,
) {
  const text = normalizeText(extracted.text);
  const totalPages = Math.max(1, extracted.pages.length);

  if (isPlaceholderApiKey() || !text.trim()) {
    return buildFallbackParts(fileId, fileName, text, totalPages);
  }

  const openai = createOpenAIClient();
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "你负责把一份大学课件拆成适合完整讲解的教学目录。目录的 title 和 description 必须使用中文；英文只允许作为必要专业术语保留，并写成 English term（中文解释）的形式。你必须返回合法 JSON，不能返回 Markdown。",
      },
      {
        role: "user",
        content: `请根据这份课件内容生成教学目录。

重要要求：
1. 不要按固定字数切分，要按课件语义结构拆分。
2. 如果这是一份完整课件，目录应该覆盖课件中所有主要内容，不要只挑重点。
3. 每个部分之后会被 AI 老师完整讲解，所以标题要清楚、范围要合理。
4. 如果内容无法可靠拆分，就只返回 1 个部分，标题为“完整课件讲解”。
5. 必须给每个部分估计 pageStart/pageEnd，页码必须来自我提供的 [Page n]。
6. 所有目录标题 title 必须是中文。不要输出纯英文标题，例如不要写 "Use of HTTP Verbs"，应该写成“HTTP verbs（HTTP 动词）的使用”。
7. 所有目录说明 description 必须是中文。课件是英文也一样，目录主体必须中文。
8. 输出必须是 JSON：
{
  "parts": [{"title": string, "description": string, "pageStart": number, "pageEnd": number}]
}

文件名：${fileName}

课件文本：
${buildPageLabeledText(extracted.pages, maxOutlineCharacters)}`,
      },
    ],
    temperature: 0.15,
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    return buildFallbackParts(fileId, fileName, text, totalPages);
  }

  const parsed = parseJsonObject<{
    parts?: Array<{ title?: string; description?: string; pageStart?: number; pageEnd?: number }>;
  }>(content);
  const parts = parsed.parts
    ?.filter((part) => part.title && part.description)
    .slice(0, 12)
    .map((part) => ({
      title: part.title ?? "完整课件讲解",
      description: part.description ?? "完整讲解这一部分内容。",
      pageStart: Math.min(Math.max(1, Math.floor(part.pageStart ?? 1)), totalPages),
      pageEnd: Math.min(Math.max(1, Math.floor(part.pageEnd ?? part.pageStart ?? totalPages)), totalPages),
      sourceText: collectPagesText(
        extracted.pages,
        Math.min(Math.max(1, Math.floor(part.pageStart ?? 1)), totalPages),
        Math.min(Math.max(1, Math.floor(part.pageEnd ?? part.pageStart ?? totalPages)), totalPages),
      ),
    }));

  return parts && parts.length > 0 ? parts : buildFallbackParts(fileId, fileName, text, totalPages);
}

async function createCourseSession(files: Express.Multer.File[]): Promise<CourseSession> {
  await ensureDataDir();
  const sessionId = crypto.randomUUID();
  const sessionDir = getSessionDir(sessionId);
  const filesDir = getFilesDir(sessionId);
  await fs.mkdir(filesDir, { recursive: true });
  await fs.mkdir(getLessonsDir(sessionId), { recursive: true });

  const courseFiles: CourseFile[] = [];
  const parts: CoursePart[] = [];
  const filesById = new Map<
    string,
    {
      buffer: Buffer;
      mimeType: string;
      name: string;
      text: string;
    }
  >();

  for (const file of files) {
    const fileId = crypto.randomUUID();
    const displayFileName = decodeUploadedFileName(file.originalname);
    const storedFileName = `${fileId}-${safeFileName(displayFileName)}`;
    const storedFilePath = path.join(filesDir, storedFileName);
    await fs.writeFile(storedFilePath, file.buffer);

    const extracted = await extractFileText(file);
    const extractedText =
      normalizeText(extracted.text) ||
      `当前暂未能从文件中提取正文。文件名：${displayFileName}。如果这是 PPT/PPTX，当前版本只能先记录文件名，后续可接入 PPT 文本解析。`;

    filesById.set(fileId, {
      buffer: file.buffer,
      mimeType: file.mimetype || "application/octet-stream",
      name: displayFileName,
      text: extractedText,
    });

    const outlineParts = await createOutlineForFile(fileId, displayFileName, {
      ...extracted,
      text: extractedText,
    });
    const partIds: string[] = [];

    outlineParts.forEach((outlinePart, index) => {
      const partId = crypto.randomUUID();
      partIds.push(partId);
      parts.push({
        id: partId,
        fileId,
        fileName: displayFileName,
        title: outlinePart.title,
        description: outlinePart.description,
        index,
        pageStart: outlinePart.pageStart,
        pageEnd: outlinePart.pageEnd,
        sourceText: outlinePart.sourceText,
      });
    });

    courseFiles.push({
      id: fileId,
      name: displayFileName,
      size: file.size,
      mimeType: file.mimetype || "application/octet-stream",
      previewUrl: `/api/files/${sessionId}/${fileId}`,
      partIds,
    });
  }

  const session = {
    id: sessionId,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    createdAt: new Date().toISOString(),
    files: courseFiles,
    parts,
  };

  sessions.set(sessionId, session);
  sessionFiles.set(sessionId, filesById);
  await writeJsonFile(getSessionPath(sessionId), session);
  return session;
}

async function loadSession(sessionId: string) {
  const cached = sessions.get(sessionId);

  if (cached) {
    return cached;
  }

  const sessionPath = getSessionPath(sessionId);

  if (!fssync.existsSync(sessionPath)) {
    return null;
  }

  const session = await readJsonFile<CourseSession>(sessionPath);
  sessions.set(sessionId, session);
  return session;
}

async function loadSessionFiles(session: CourseSession) {
  const cached = sessionFiles.get(session.id);

  if (cached) {
    return cached;
  }

  const filesDir = getFilesDir(session.id);
  const diskFiles = await fs.readdir(filesDir).catch(() => []);
  const filesById = new Map<
    string,
    {
      buffer: Buffer;
      mimeType: string;
      name: string;
      text: string;
    }
  >();

  for (const file of session.files) {
    const diskFile = diskFiles.find((item) => item.startsWith(`${file.id}-`));

    if (!diskFile) {
      continue;
    }

    const buffer = await fs.readFile(path.join(filesDir, diskFile));
    filesById.set(file.id, {
      buffer,
      mimeType: file.mimeType,
      name: file.name,
      text: session.parts.find((part) => part.fileId === file.id)?.sourceText ?? "",
    });
  }

  sessionFiles.set(session.id, filesById);
  return filesById;
}

async function listHistoryItems(): Promise<HistoryItem[]> {
  await ensureDataDir();
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  const items = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const session = await readJsonFile<CourseSession>(path.join(dataDir, entry.name, "session.json"));
          return {
          id: session.id,
          title: session.files.map((file) => file.name).join("、"),
          createdAt: session.createdAt,
          totalSize: session.totalSize,
          fileCount: session.files.length,
          partCount: session.parts.length,
          };
        } catch {
          return null;
        }
      }),
  );

  return items
    .filter((item): item is HistoryItem => item !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function deleteSessionHistory(sessionId: string) {
  sessions.delete(sessionId);
  sessionFiles.delete(sessionId);
  await fs.rm(getSessionDir(sessionId), { recursive: true, force: true });
}

function getLessonPath(sessionId: string, partId: string) {
  return path.join(getLessonsDir(sessionId), `${partId}.json`);
}

function getFollowUpsPath(sessionId: string, blockId: string) {
  return path.join(getLessonsDir(sessionId), `followups-${blockId}.json`);
}

async function readCachedLesson(sessionId: string, partId: string) {
  const lessonPath = getLessonPath(sessionId, partId);

  if (!fssync.existsSync(lessonPath)) {
    return null;
  }

  return readJsonFile<PartLesson>(lessonPath);
}

async function writeCachedLesson(sessionId: string, lesson: PartLesson) {
  await writeJsonFile(getLessonPath(sessionId, lesson.partId), lesson);
}

async function readCachedFollowUps(sessionId: string, blockId: string) {
  const followUpsPath = getFollowUpsPath(sessionId, blockId);

  if (!fssync.existsSync(followUpsPath)) {
    return [];
  }

  return readJsonFile<FollowUpAnswer[]>(followUpsPath);
}

async function appendCachedFollowUp(sessionId: string, blockId: string, answer: FollowUpAnswer) {
  const currentAnswers = await readCachedFollowUps(sessionId, blockId);
  await writeJsonFile(getFollowUpsPath(sessionId, blockId), [...currentAnswers, answer]);
}

async function readLearningProgress(sessionId: string) {
  const progressPath = getProgressPath(sessionId);

  if (!fssync.existsSync(progressPath)) {
    return null;
  }

  return readJsonFile<LearningProgress>(progressPath);
}

async function writeLearningProgress(sessionId: string, progress: LearningProgress) {
  await writeJsonFile(getProgressPath(sessionId), progress);
}

async function listGeneratedPartIds(session: CourseSession) {
  const lessonsDir = getLessonsDir(session.id);
  const files = await fs.readdir(lessonsDir).catch((): string[] => []);

  return session.parts
    .filter((part) => {
      const lessonPath = path.basename(getLessonPath(session.id, part.id));
      return files.includes(lessonPath);
    })
    .map((part) => part.id);
}

async function readAllFollowUps(sessionId: string) {
  const lessonsDir = getLessonsDir(sessionId);
  const files = await fs.readdir(lessonsDir).catch((): string[] => []);
  const entries = await Promise.all(
    files
      .filter((fileName) => fileName.startsWith("followups-") && fileName.endsWith(".json"))
      .map(async (fileName) => {
        const blockId = fileName.replace(/^followups-/, "").replace(/\.json$/, "");
        const answers = await readJsonFile<FollowUpAnswer[]>(path.join(lessonsDir, fileName));
        return [blockId, answers] as const;
      }),
  );

  return Object.fromEntries(entries);
}

function buildLessonPrompt(part: CoursePart, session: CourseSession) {
  return `你是 CourseMate 的大学课程老师。学生从来没学过这门课，现在需要你把课件讲清楚。
当前讲解模式：详细讲解。请像正式上课一样，从零开始完整讲清楚这一部分，不要只总结。

语言硬性要求：
- 除英文专业词汇、公式、代码、接口路径外，所有解释必须使用中文。
- 不允许整段英文讲解。
- 英文术语必须写成 "English term（中文解释）" 的形式。
- 如果你发现自己开始用英文解释，请立刻改回中文。

讲解目标：
1. 不是总结，不是复习计划，不是列重点。你要像老师上课一样，把这一部分涉及的知识从零讲明白。
2. 如果课件是英文，讲解主体用中文，但必须保留关键英文专业词汇，例如 "stereochemistry（立体化学）" 这种形式。
3. 这一部分里出现的定义、概念、例题、图示含义、公式或推理关系，只要课件文本里能看出来，都要解释。
4. 不要输出一大坨文字。请拆成多个自然小节，每个小节有标题，正文 2-6 句话。
5. 小节之间要像老师讲课一样逐步推进：先直觉，再概念，再细节，再例子/图示含义。
6. 中英术语表只放在最后 terms 字段。正文中也要自然保留英文专业词。
7. 输出必须是合法 JSON，不要 Markdown，不要代码块。
8. 正文 body 可以使用 Markdown 和 LaTeX：用列表、加粗、短段落、行内公式 $...$、块级公式 $$...$$ 来排版。
9. 每个 blocks 项必须有 pageNumber，表示它对应 PDF 的起始页。

JSON 字段必须严格匹配：
{
  "partId": string,
  "title": string,
  "blocks": [{"id": string, "heading": string, "body": string, "pageNumber": number}],
  "terms": [{"english": string, "chinese": string, "explanation": string}]
}

当前资料总数：${session.files.length}
当前文件：${part.fileName}
当前讲解部分：${part.title}
这一部分范围说明：${part.description}
页码范围：${part.pageStart}-${part.pageEnd}

完整课件文本：
${trimText(part.sourceText, maxLessonCharacters)}`;
}

function validatePartLesson(result: PartLesson) {
  if (
    typeof result.partId !== "string" ||
    typeof result.title !== "string" ||
    !Array.isArray(result.blocks) ||
    !Array.isArray(result.terms)
  ) {
    throw new Error("模型返回的数据结构不正确。");
  }
}

function buildLocalLesson(part: CoursePart): PartLesson {
  return {
    partId: part.id,
    title: part.title,
    blocks: [
      {
        id: crypto.randomUUID(),
        heading: "为什么现在看到的是占位讲解",
        pageNumber: part.pageStart,
        body: "当前使用本地占位模式，还没有真正调用大模型。真实 API Key 生效后，这里会根据这个目录部分和完整课件文本生成详细讲解。\n\n如果课件里有公式，也会用类似 $E = mc^2$ 或 $$\\Delta G = \\Delta H - T\\Delta S$$ 的形式排版。",
      },
      {
        id: crypto.randomUUID(),
        heading: "正式模式会怎么讲",
        pageNumber: part.pageStart,
        body: "AI 会把课件内容拆成自然小节，用中文从零讲清楚，同时保留英文专业词汇。它不会只总结，也不会把步骤和例子硬拆成单独模块，而是把它们融入老师式讲解里。",
      },
    ],
    terms: [
      {
        english: "Lecture",
        chinese: "课件",
        explanation: "指当前上传的课程资料。",
      },
      {
        english: "Part",
        chinese: "讲解部分",
        explanation: "由 AI 根据课件语义目录生成，而不是按固定字数硬切。",
      },
    ],
  };
}

function findBlockInLessons(partId: string, blockId: string, lesson: PartLesson | undefined) {
  if (!lesson || lesson.partId !== partId) {
    return null;
  }

  return lesson.blocks.find((block) => block.id === blockId) ?? null;
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    provider: "deepseek",
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model,
    usingPlaceholderKey: isPlaceholderApiKey(),
  });
});

app.get("/api/history", async (_request, response) => {
  try {
    response.json(await listHistoryItems());
  } catch (error) {
    const message = error instanceof Error ? error.message : "历史记录读取失败。";
    response.status(500).json({ message });
  }
});

app.delete("/api/history/:sessionId", async (request, response) => {
  try {
    await deleteSessionHistory(request.params.sessionId);
    response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "历史记录删除失败。";
    response.status(500).json({ message });
  }
});

app.get("/api/sessions/:sessionId", async (request, response) => {
  const session = await loadSession(request.params.sessionId);

  if (!session) {
    response.status(404).json({ message: "没有找到这个学习会话，请重新上传资料。" });
    return;
  }

  response.json(session);
});

app.get("/api/sessions/:sessionId/state", async (request, response) => {
  try {
    const session = await loadSession(request.params.sessionId);

    if (!session) {
      response.status(404).json({ message: "没有找到这个学习会话，请重新上传资料。" });
      return;
    }

    const state: SessionLearningState = {
      progress: await readLearningProgress(session.id),
      generatedPartIds: await listGeneratedPartIds(session),
      followUpsByBlock: await readAllFollowUps(session.id),
    };

    response.json(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : "学习状态读取失败。";
    response.status(500).json({ message });
  }
});

app.put("/api/sessions/:sessionId/progress", async (request, response) => {
  try {
    const session = await loadSession(request.params.sessionId);

    if (!session) {
      response.status(404).json({ message: "没有找到这个学习会话，请重新上传资料。" });
      return;
    }

    const body = request.body as Partial<LearningProgress>;
    const part = session.parts.find((item) => item.id === body.partId);
    const file = session.files.find((item) => item.id === body.fileId);

    if (!part || !file || part.fileId !== file.id) {
      response.status(400).json({ message: "学习进度位置无效。" });
      return;
    }

    const progress: LearningProgress = {
      sessionId: session.id,
      partId: part.id,
      fileId: file.id,
      pdfPage: Math.max(1, Math.floor(body.pdfPage ?? part.pageStart)),
      lessonMode: normalizeLessonMode(body.lessonMode),
      lessonScrollTop: Math.max(0, Math.floor(body.lessonScrollTop ?? 0)),
      updatedAt: new Date().toISOString(),
    };

    await writeLearningProgress(session.id, progress);
    response.json(progress);
  } catch (error) {
    const message = error instanceof Error ? error.message : "学习进度保存失败。";
    response.status(500).json({ message });
  }
});

app.post("/api/materials", upload.array("materials", 20), async (request, response) => {
  try {
    const files = request.files as Express.Multer.File[] | undefined;

    if (!files || files.length === 0) {
      response.status(400).json({ message: "请至少上传一份课程资料。" });
      return;
    }

    const session = await createCourseSession(files);
    response.json(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "资料读取失败。";
    response.status(500).json({ message });
  }
});

app.get("/api/files/:sessionId/:fileId", (request, response) => {
  const { sessionId, fileId } = request.params;
  const serve = async () => {
    const session = await loadSession(sessionId);
    const filesById = session ? await loadSessionFiles(session) : null;
    const file = filesById?.get(fileId);

    if (!file) {
      response.status(404).send("File not found");
      return;
    }

    response.setHeader("Content-Type", file.mimeType);
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    response.send(file.buffer);
  };

  serve().catch((error) => {
    const message = error instanceof Error ? error.message : "文件读取失败。";
    response.status(500).send(message);
  });
});

app.post("/api/explain-part", async (request, response) => {
  try {
    const { sessionId, partId } = request.body as {
      sessionId?: string;
      partId?: string;
    };

    if (!sessionId || !partId) {
      response.status(400).json({ message: "缺少 sessionId 或 partId。" });
      return;
    }

    const session = await loadSession(sessionId);
    const part = session?.parts.find((item) => item.id === partId);

    if (!session || !part) {
      response.status(404).json({ message: "没有找到对应的讲解部分，请重新上传资料。" });
      return;
    }

    const cachedLesson = await readCachedLesson(sessionId, part.id);

    if (cachedLesson) {
      response.json(cachedLesson);
      return;
    }

    if (isPlaceholderApiKey()) {
      const lesson = buildLocalLesson(part);
      await writeCachedLesson(sessionId, lesson);
      response.json(lesson);
      return;
    }

    const openai = createOpenAIClient();
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "你是一个大学课程老师，负责把课件完整、详细、从零讲清楚。必须用中文解释，英文只保留专业术语、公式、代码和路径。你必须返回合法 JSON，不能返回 Markdown。JSON 字符串里的反斜杠必须正确转义，例如 LaTeX 的 \\frac 要写成 \\\\frac。",
        },
        {
          role: "user",
          content: buildLessonPrompt(part, session),
        },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content;

    if (!content) {
      throw new Error("模型没有返回内容。");
    }

    const result = parseJsonObject<PartLesson>(content);
    result.partId = part.id;
    result.blocks = result.blocks.map((block) => ({
      ...block,
      id: block.id || crypto.randomUUID(),
      pageNumber: Math.min(Math.max(part.pageStart, Math.floor(block.pageNumber || part.pageStart)), part.pageEnd),
    }));
    validatePartLesson(result);
    await writeCachedLesson(sessionId, result);
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "这一部分讲解生成失败。";
    response.status(500).json({ message });
  }
});

app.post("/api/ask-block", async (request, response) => {
  try {
    const { sessionId, partId, blockId, blockHeading, blockBody, question } =
      request.body as {
      sessionId?: string;
      partId?: string;
      blockId?: string;
      blockHeading?: string;
      blockBody?: string;
      question?: string;
    };

    if (!sessionId || !partId || !blockId || !question?.trim()) {
      response.status(400).json({ message: "缺少追问参数。" });
      return;
    }

    const session = await loadSession(sessionId);
    const part = session?.parts.find((item) => item.id === partId);

    if (!session || !part) {
      response.status(404).json({ message: "没有找到对应的讲解部分，请重新上传资料。" });
      return;
    }

    if (isPlaceholderApiKey()) {
      const answer = {
        question: question.trim(),
        answer:
          "这是本地占位回答。真实 API Key 生效后，我会结合当前知识点、课件原文和你的问题继续用中文解释，并保留必要英文术语。",
        createdAt: new Date().toISOString(),
      } satisfies FollowUpAnswer;
      await appendCachedFollowUp(sessionId, blockId, answer);
      response.json(answer);
      return;
    }

    const openai = createOpenAIClient();
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "你是大学课程老师，正在回答学生对某个讲解小节的追问。回答要具体、清楚。除英文专业术语、公式、代码、路径外，所有解释必须使用中文，不允许整段英文讲解。英文术语请写成 English term（中文解释）的形式。可以使用 Markdown 和 LaTeX。你必须返回合法 JSON；JSON 字符串里的反斜杠必须正确转义，例如 LaTeX 的 \\frac 要写成 \\\\frac。",
        },
        {
          role: "user",
          content: `当前文件：${part.fileName}
当前讲解部分：${part.title}
页码范围：${part.pageStart}-${part.pageEnd}
学生正在追问的小节：${blockHeading ?? "未提供"}
这个小节原讲解：
${blockBody ?? "未提供"}

课件原文：
${trimText(part.sourceText, 18000)}

学生追问：
${question}

请回答这个追问。不要泛泛而谈，尽量结合课件原文。
语言要求：解释必须使用中文；英文只用于专业术语、公式、代码或原文必要引用；不要输出整段英文。
JSON 要求：必须返回合法 JSON。如果 answer 里包含 LaTeX 或反斜杠，反斜杠必须写成双反斜杠，不能出现 \i、\(、\V 这类非法 JSON 转义。
输出 JSON：
{"answer": string}`,
        },
      ],
      temperature: 0.35,
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content;

    if (!content) {
      throw new Error("模型没有返回内容。");
    }

    const answer = {
      ...parseJsonObject<FollowUpAnswer>(content),
      question: question.trim(),
      createdAt: new Date().toISOString(),
    };
    await appendCachedFollowUp(sessionId, blockId, answer);
    response.json(answer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "追问失败。";
    response.status(500).json({ message });
  }
});

const httpServer = app.listen(port, () => {
  console.log(`CourseMate API server running at http://localhost:${port}`);
});

httpServer.keepAliveTimeout = 65_000;
