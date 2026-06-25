import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  askAboutLessonBlock,
  createMaterialSession,
  deleteHistory,
  explainPart,
  getSessionLearningState,
  getMaterialSession,
  listHistory,
  saveLearningProgress,
} from "./services/aiService";
import type {
  CoursePart,
  CourseSession,
  FollowUpAnswer,
  HistoryItem,
  PartLesson,
} from "./types";
import "katex/dist/katex.min.css";

type AppPage = "upload" | "loading" | "learning";
type ThemeMode = "light" | "dark";

const acceptedFileTypes = ".pdf,.ppt,.pptx,.doc,.docx,.txt";
const themeStorageKey = "coursemate-theme-mode";
const logoPath = "/brand/coursemate-logo.png";

function getLessonKey(partId: string) {
  return partId;
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function getFileId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function formatHistoryTime(createdAt: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

function parseLearningPath(pathname: string) {
  const match = pathname.match(/^\/session\/([^/]+)\/file\/([^/]+)\/part\/([^/]+)$/);

  if (!match) {
    return null;
  }

  return {
    sessionId: match[1],
    fileId: match[2],
    partId: match[3],
  };
}

function pushPath(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

type NavigateOptions = {
  restoreScroll?: boolean;
  restorePdfPage?: number;
};

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lessonPanelRef = useRef<HTMLElement | null>(null);
  const lessonScrollTopRef = useRef(0);
  const saveProgressTimerRef = useRef<number | null>(null);
  const [routePath, setRoutePath] = useState(window.location.pathname);
  const [page, setPage] = useState<AppPage>("upload");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [courseSession, setCourseSession] = useState<CourseSession | null>(null);
  const [activePartId, setActivePartId] = useState<string | null>(null);
  const [lessonsByPart, setLessonsByPart] = useState<Record<string, PartLesson>>({});
  const [generatedPartIds, setGeneratedPartIds] = useState<Set<string>>(new Set());
  const [failedPartIds, setFailedPartIds] = useState<Set<string>>(new Set());
  const [isLessonLoading, setIsLessonLoading] = useState(false);
  const [prefetchingIds, setPrefetchingIds] = useState<Set<string>>(new Set());
  const [activePdfPage, setActivePdfPage] = useState(1);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [askOpenBlockId, setAskOpenBlockId] = useState<string | null>(null);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [answersByBlock, setAnswersByBlock] = useState<Record<string, FollowUpAnswer[]>>({});
  const [askingBlockIds, setAskingBlockIds] = useState<Set<string>>(new Set());
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    window.localStorage.getItem(themeStorageKey) === "dark" ? "dark" : "light",
  );
  const [isLogoWiggling, setIsLogoWiggling] = useState(false);
  const [error, setError] = useState("");

  const totalFileSize = useMemo(
    () => selectedFiles.reduce((sum, file) => sum + file.size, 0),
    [selectedFiles],
  );

  const activePart = useMemo(
    () => courseSession?.parts.find((part) => part.id === activePartId) ?? null,
    [activePartId, courseSession],
  );

  const activePartIndex = useMemo(
    () => courseSession?.parts.findIndex((part) => part.id === activePartId) ?? -1,
    [activePartId, courseSession],
  );

  const activeLessonKey = activePartId ? getLessonKey(activePartId) : "";
  const activeLesson = activeLessonKey ? lessonsByPart[activeLessonKey] : undefined;
  const activeFile = activePart
    ? courseSession?.files.find((file) => file.id === activePart.fileId)
    : null;
  const isPdfPreview = activeFile?.mimeType === "application/pdf" || activeFile?.name.endsWith(".pdf");
  const pdfPreviewUrl =
    isPdfPreview && activeFile ? `${activeFile.previewUrl}#page=${activePdfPage}` : "";
  const themeClass = themeMode === "dark" ? "theme-dark" : "";

  function toggleThemeMode() {
    setThemeMode((currentMode) => (currentMode === "dark" ? "light" : "dark"));
  }

  function renderThemeToggle() {
    return (
      <button
        className="theme-toggle"
        type="button"
        aria-label={themeMode === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
        onClick={toggleThemeMode}
      >
        {themeMode === "dark" ? "亮色模式" : "暗色模式"}
      </button>
    );
  }

  function renderBrand(subtitle: string) {
    return (
      <div className="brand-lockup">
        <button
          className={isLogoWiggling ? "brand-logo-button is-wiggling" : "brand-logo-button"}
          type="button"
          aria-label="Play CourseMate logo animation"
          onClick={() => setIsLogoWiggling(true)}
          onAnimationEnd={() => setIsLogoWiggling(false)}
        >
          <img className="brand-logo" src={logoPath} alt="CourseMate logo" />
        </button>
        <div className="brand-copy">
          <strong>CourseMate</strong>
          <span>{subtitle}</span>
        </div>
      </div>
    );
  }

  function getPartStatus(partId: string) {
    const lessonKey = getLessonKey(partId);

    if (lessonsByPart[lessonKey] || generatedPartIds.has(partId)) {
      return "done";
    }

    if (prefetchingIds.has(partId) || (partId === activePartId && isLessonLoading)) {
      return "loading";
    }

    if (failedPartIds.has(partId)) {
      return "failed";
    }

    return "pending";
  }

  async function refreshHistory() {
    setIsHistoryLoading(true);

    try {
      setHistoryItems(await listHistory());
    } catch {
      // History is helpful but should not block the upload flow.
    } finally {
      setIsHistoryLoading(false);
    }
  }

  async function loadLearningState(session: CourseSession) {
    const state = await getSessionLearningState(session.id);
    setGeneratedPartIds(new Set(state.generatedPartIds));
    setAnswersByBlock(state.followUpsByBlock);
    return state;
  }

  useEffect(() => {
    function handleRouteChange() {
      setRoutePath(window.location.pathname);
    }

    window.addEventListener("popstate", handleRouteChange);
    return () => window.removeEventListener("popstate", handleRouteChange);
  }, []);

  useEffect(() => {
    refreshHistory();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, themeMode);
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    if (!courseSession) {
      return;
    }

    let isCancelled = false;

    getSessionLearningState(courseSession.id)
      .then((state) => {
        if (!isCancelled) {
          setGeneratedPartIds(new Set(state.generatedPartIds));
          setAnswersByBlock(state.followUpsByBlock);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setGeneratedPartIds(new Set());
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [courseSession?.id]);

  useEffect(() => {
    const route = parseLearningPath(routePath);

    if (!route) {
      setPage("upload");
      return;
    }

    const targetRoute = route;

    async function loadSessionFromRoute() {
      setPage("loading");
      setError("");

      try {
        const session =
          courseSession?.id === targetRoute.sessionId
            ? courseSession
            : await getMaterialSession(targetRoute.sessionId);
        setCourseSession(session);
        setActivePartId(targetRoute.partId);
        setPage("learning");
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "会话恢复失败。");
        setPage("upload");
      }
    }

    loadSessionFromRoute();
  }, [routePath]);

  useEffect(() => {
    if (!courseSession || !activePartId || lessonsByPart[activeLessonKey]) {
      return;
    }

    let isCancelled = false;
    const sessionId = courseSession.id;
    const partId = activePartId;
    const lessonKey = activeLessonKey;

    async function loadLesson() {
      setIsLessonLoading(true);
      setError("");
      setFailedPartIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(partId);
        return nextIds;
      });

      try {
        const lesson = await explainPart(sessionId, partId);

        if (!isCancelled) {
          setLessonsByPart((currentLessons) => ({
            ...currentLessons,
            [lessonKey]: lesson,
          }));
          setGeneratedPartIds((currentIds) => new Set(currentIds).add(partId));
          const state = await getSessionLearningState(sessionId);
          setAnswersByBlock(state.followUpsByBlock);
          setGeneratedPartIds(new Set(state.generatedPartIds));
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setFailedPartIds((currentIds) => new Set(currentIds).add(partId));
          setError(caughtError instanceof Error ? caughtError.message : "讲解生成失败。");
        }
      } finally {
        if (!isCancelled) {
          setIsLessonLoading(false);
        }
      }
    }

    loadLesson();

    return () => {
      isCancelled = true;
    };
  }, [activeLessonKey, activePartId, courseSession, lessonsByPart]);

  useEffect(() => {
    if (!courseSession || !activePart) {
      return;
    }

    const activeFileParts = courseSession.parts.filter((part) => part.fileId === activePart.fileId);
    const indexInFile = activeFileParts.findIndex((part) => part.id === activePart.id);
    const nextParts = activeFileParts.slice(indexInFile + 1, indexInFile + 3);

    nextParts.forEach((part) => {
      const lessonKey = getLessonKey(part.id);

      if (lessonsByPart[lessonKey] || generatedPartIds.has(part.id) || prefetchingIds.has(part.id)) {
        return;
      }

      setPrefetchingIds((currentIds) => new Set(currentIds).add(part.id));
      setFailedPartIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(part.id);
        return nextIds;
      });

      explainPart(courseSession.id, part.id)
        .then((lesson) => {
          setLessonsByPart((currentLessons) => ({
            ...currentLessons,
            [lessonKey]: lesson,
          }));
          setGeneratedPartIds((currentIds) => new Set(currentIds).add(part.id));
        })
        .catch(() => {
          setFailedPartIds((currentIds) => new Set(currentIds).add(part.id));
        })
        .finally(() => {
          setPrefetchingIds((currentIds) => {
            const nextIds = new Set(currentIds);
            nextIds.delete(part.id);
            return nextIds;
          });
        });
    });
  }, [activePart, courseSession, generatedPartIds, lessonsByPart, prefetchingIds]);

  useEffect(() => {
    if (activePart && !lessonPanelRef.current) {
      setActivePdfPage(activePart.pageStart || 1);
      setFocusedBlockId(null);
      setAskOpenBlockId(null);
    }
  }, [activePart?.id]);

  useEffect(() => {
    if (!activeLesson || !lessonPanelRef.current) {
      return;
    }

    lessonPanelRef.current.scrollTop = lessonScrollTopRef.current;
  }, [activeLesson?.partId]);

  useEffect(() => {
    if (!courseSession || !activePart) {
      return;
    }

    if (saveProgressTimerRef.current) {
      window.clearTimeout(saveProgressTimerRef.current);
    }

    saveProgressTimerRef.current = window.setTimeout(() => {
      saveLearningProgress({
        sessionId: courseSession.id,
        partId: activePart.id,
        fileId: activePart.fileId,
        pdfPage: activePdfPage,
        lessonMode: "detailed",
        lessonScrollTop: lessonScrollTopRef.current,
        updatedAt: new Date().toISOString(),
      }).catch(() => {
        // Progress saving should stay quiet; the current page should not be interrupted.
      });
    }, 600);

    return () => {
      if (saveProgressTimerRef.current) {
        window.clearTimeout(saveProgressTimerRef.current);
      }
    };
  }, [activePdfPage, activePart?.id, courseSession?.id]);

  function navigateToPart(session: CourseSession, part: CoursePart, options: NavigateOptions = {}) {
    lessonScrollTopRef.current = options.restoreScroll ? lessonScrollTopRef.current : 0;
    setActivePdfPage(options.restorePdfPage ?? part.pageStart ?? 1);
    setFocusedBlockId(null);
    setAskOpenBlockId(null);

    if (lessonPanelRef.current) {
      lessonPanelRef.current.scrollTop = lessonScrollTopRef.current;
    }

    pushPath(`/session/${session.id}/file/${part.fileId}/part/${part.id}`);
  }

  function navigateToFile(fileId: string) {
    if (!courseSession) {
      return;
    }

    const targetPart = courseSession.parts.find((part) => part.fileId === fileId);

    if (targetPart) {
      navigateToPart(courseSession, targetPart);
    }
  }

  function retryPart(part: CoursePart) {
    const lessonKey = getLessonKey(part.id);
    setFailedPartIds((currentIds) => {
      const nextIds = new Set(currentIds);
      nextIds.delete(part.id);
      return nextIds;
    });
    setGeneratedPartIds((currentIds) => {
      const nextIds = new Set(currentIds);
      nextIds.delete(part.id);
      return nextIds;
    });
    setLessonsByPart((currentLessons) => {
      const nextLessons = { ...currentLessons };
      delete nextLessons[lessonKey];
      return nextLessons;
    });
    navigateToPart(courseSession!, part);
  }

  function addFiles(incomingFiles: File[]) {
    if (incomingFiles.length === 0) {
      return;
    }

    setSelectedFiles((currentFiles) => {
      const existingIds = new Set(currentFiles.map(getFileId));
      const newFiles = incomingFiles.filter((file) => !existingIds.has(getFileId(file)));
      return [...currentFiles, ...newFiles];
    });

    setCourseSession(null);
    setLessonsByPart({});
    setGeneratedPartIds(new Set());
    setFailedPartIds(new Set());
    setPrefetchingIds(new Set());
    setActivePartId(null);
    setError("");
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function handleFileDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingFiles(true);
  }

  function handleFileDragLeave(event: DragEvent<HTMLLabelElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDraggingFiles(false);
    }
  }

  function handleFileDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDraggingFiles(false);
    addFiles(Array.from(event.dataTransfer.files ?? []));
  }

  function removeFile(fileId: string) {
    setSelectedFiles((currentFiles) =>
      currentFiles.filter((file) => getFileId(file) !== fileId),
    );
    setCourseSession(null);
    setLessonsByPart({});
    setGeneratedPartIds(new Set());
    setFailedPartIds(new Set());
    setPrefetchingIds(new Set());
    setActivePartId(null);
    setError("");
  }

  function clearMaterials() {
    setSelectedFiles([]);
    setCourseSession(null);
    setLessonsByPart({});
    setGeneratedPartIds(new Set());
    setFailedPartIds(new Set());
    setPrefetchingIds(new Set());
    setActivePartId(null);
    setError("");
  }

  async function openHistoryItem(item: HistoryItem) {
    setError("");
    setPage("loading");
    setLessonsByPart({});
    setGeneratedPartIds(new Set());
    setFailedPartIds(new Set());
    setPrefetchingIds(new Set());
    setAnswersByBlock({});

    try {
      const session = await getMaterialSession(item.id);
      const state = await loadLearningState(session);
      const targetPart =
        session.parts.find((part) => part.id === state.progress?.partId) ?? session.parts[0];

      if (!targetPart) {
        throw new Error("这个历史记录里没有可学习的内容。");
      }

      lessonScrollTopRef.current = state.progress?.lessonScrollTop ?? 0;
      setCourseSession(session);
      navigateToPart(session, targetPart, {
        restorePdfPage: state.progress?.pdfPage ?? targetPart.pageStart,
        restoreScroll: true,
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "历史记录打开失败。");
      setPage("upload");
      refreshHistory();
    }
  }

  async function removeHistoryItem(itemId: string) {
    setError("");

    try {
      await deleteHistory(itemId);
      setHistoryItems((currentItems) => currentItems.filter((item) => item.id !== itemId));

      if (courseSession?.id === itemId) {
        setCourseSession(null);
        setLessonsByPart({});
        setGeneratedPartIds(new Set());
        setFailedPartIds(new Set());
        setActivePartId(null);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "历史记录删除失败。");
    }
  }

  async function handleStartLearning(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (selectedFiles.length === 0) {
      setError("请先上传至少一份课程资料。");
      return;
    }

    setError("");
    setPage("loading");
    setLessonsByPart({});
    setGeneratedPartIds(new Set());
    setFailedPartIds(new Set());
    setPrefetchingIds(new Set());

    try {
      const session = await createMaterialSession(selectedFiles);
      setCourseSession(session);
      const firstPart = session.parts[0];

      if (!firstPart) {
        throw new Error("没有从资料中生成可学习内容。");
      }

      refreshHistory();
      navigateToPart(session, firstPart);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "资料读取失败，请稍后重试。");
      setPage("upload");
    }
  }

  function returnToUpload() {
    pushPath("/");
    setError("");
  }

  function selectAdjacentPart(direction: -1 | 1) {
    if (!courseSession || activePartIndex < 0) {
      return;
    }

    const nextPart = courseSession.parts[activePartIndex + direction];

    if (nextPart) {
      navigateToPart(courseSession, nextPart);
      setError("");
    }
  }

  function renderRichText(text: string) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {text}
      </ReactMarkdown>
    );
  }

  function handleLessonScroll() {
    lessonScrollTopRef.current = lessonPanelRef.current?.scrollTop ?? 0;

    if (!courseSession || !activePart) {
      return;
    }

    if (saveProgressTimerRef.current) {
      window.clearTimeout(saveProgressTimerRef.current);
    }

    saveProgressTimerRef.current = window.setTimeout(() => {
      saveLearningProgress({
        sessionId: courseSession.id,
        partId: activePart.id,
        fileId: activePart.fileId,
        pdfPage: activePdfPage,
        lessonMode: "detailed",
        lessonScrollTop: lessonScrollTopRef.current,
        updatedAt: new Date().toISOString(),
      }).catch(() => {
        // Progress saving should stay quiet; the current page should not be interrupted.
      });
    }, 800);
  }

  function handleBlockClick(blockId: string, pageNumber: number) {
    setActivePdfPage(pageNumber);

    if (focusedBlockId === blockId) {
      setAskOpenBlockId((currentId) => (currentId === blockId ? null : blockId));
      return;
    }

    setFocusedBlockId(blockId);
    setAskOpenBlockId(null);
  }

  async function submitQuestion(blockId: string) {
    if (!courseSession || !activePart) {
      return;
    }

    const question = questionDrafts[blockId]?.trim();

    if (!question) {
      return;
    }

    setAskingBlockIds((currentIds) => new Set(currentIds).add(blockId));

    try {
      const answer = await askAboutLessonBlock({
        sessionId: courseSession.id,
        partId: activePart.id,
        blockId,
        blockHeading: activeLesson?.blocks.find((block) => block.id === blockId)?.heading ?? "",
        blockBody: activeLesson?.blocks.find((block) => block.id === blockId)?.body ?? "",
        question,
      });
      setAnswersByBlock((currentAnswers) => ({
        ...currentAnswers,
        [blockId]: [...(currentAnswers[blockId] ?? []), answer],
      }));
      setQuestionDrafts((currentDrafts) => ({
        ...currentDrafts,
        [blockId]: "",
      }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "追问失败。");
    } finally {
      setAskingBlockIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(blockId);
        return nextIds;
      });
    }
  }

  if (page === "loading") {
    return (
      <main className={`app-shell loading-shell ${themeClass}`}>
        <header className="topbar">
          {renderBrand(`${selectedFiles.length || courseSession?.files.length || 0} 份资料`)}
          {renderThemeToggle()}
        </header>
        <section className="loading-panel" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <h1>正在生成课件目录</h1>
          <p>正在读取资料，并根据课件结构生成可点击的讲解目录。</p>
        </section>
      </main>
    );
  }

  if (page === "learning" && courseSession && activePart) {
    return (
      <main className={`learning-app ${themeClass}`}>
        <header className="learning-topbar">
          {renderBrand(
            `${courseSession.files.length} 份资料 · ${courseSession.parts.length} 个讲解部分 · ${formatFileSize(
              courseSession.totalSize,
            )}`,
          )}

          <section className="learning-toolbar" aria-label="学习操作">
            <button
              type="button"
              onClick={() => selectAdjacentPart(-1)}
              disabled={activePartIndex <= 0}
            >
              ← 上一部分
            </button>

            <label className="file-switcher">
              <span>当前资料</span>
              <select
                value={activeFile?.id ?? ""}
                onChange={(event) => navigateToFile(event.target.value)}
              >
                {courseSession.files.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="generation-status">
              <span className={prefetchingIds.size > 0 ? "status-dot active" : "status-dot"} />
              <span>
                {prefetchingIds.size > 0
                  ? `后台生成 ${prefetchingIds.size} 个后续部分`
                  : "后续讲解会提前生成"}
              </span>
            </div>

            <button
              type="button"
              onClick={() => selectAdjacentPart(1)}
              disabled={activePartIndex >= courseSession.parts.length - 1}
            >
              下一部分 →
            </button>
          </section>

          <div className="topbar-actions">
            {renderThemeToggle()}
            <button className="secondary-button" type="button" onClick={returnToUpload}>
              返回上传
            </button>
          </div>

          <div className="learning-progress-track" aria-hidden="true">
            <span
              style={{
                width: `${Math.round(((activePartIndex + 1) / courseSession.parts.length) * 100)}%`,
              }}
            />
          </div>
        </header>

        <section className="reader-layout">
          <aside className="outline-panel">
            <h2>课件目录</h2>
            <div className="outline-list">
              {courseSession.files.map((file) => (
                <section key={file.id}>
                  <h3>{file.name}</h3>
                  {file.partIds.map((partId) => {
                    const part = courseSession.parts.find((item) => item.id === partId);

                    if (!part) {
                      return null;
                    }

                    const status = getPartStatus(part.id);

                    return (
                      <button
                        key={part.id}
                        className={part.id === activePart.id ? "active" : ""}
                        type="button"
                        onClick={() =>
                          status === "failed" ? retryPart(part) : navigateToPart(courseSession, part)
                        }
                      >
                        <span>{part.index + 1}</span>
                        <strong>{part.title}</strong>
                        <em className={`part-status ${status}`}>
                          {status === "done"
                            ? "已完成"
                            : status === "loading"
                              ? "生成中"
                              : status === "failed"
                                ? "失败可重试"
                                : "未生成"}
                        </em>
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
          </aside>

          <section className="reader-main">
            <section className="section-controls">
              <div className="active-part-title">
                <div>
                  <strong>{activePart.title}</strong>
                  <span>{activePart.description}</span>
                </div>
                <small>
                  {activePartIndex + 1} / {courseSession.parts.length} · PDF 第 {activePart.pageStart}
                  {activePart.pageEnd !== activePart.pageStart ? `-${activePart.pageEnd}` : ""} 页
                </small>
              </div>
            </section>

            {error ? <p className="error-message learning-error">{error}</p> : null}

            <section className="split-reader">
              <article className="source-panel">
                <div className="panel-header">
                  <span>{isPdfPreview ? "PDF 原文件" : "课件文本"}</span>
                  <strong>{activePart.fileName}</strong>
                </div>
                {isPdfPreview && activeFile ? (
                  <iframe
                    key={`${activeFile.id}-${activePdfPage}`}
                    className="pdf-frame"
                    src={pdfPreviewUrl}
                    title={activePart.fileName}
                  />
                ) : (
                  <>
                    <h1>{activePart.title}</h1>
                    <pre>{activePart.sourceText}</pre>
                  </>
                )}
              </article>

              <article className="lesson-panel" ref={lessonPanelRef} onScroll={handleLessonScroll}>
                <div className="panel-header">
                  <span />
                  <strong>
                    {activePartIndex + 1} / {courseSession.parts.length}
                  </strong>
                </div>

                {isLessonLoading && !activeLesson ? (
                  <div className="lesson-loading">
                    <div className="small-spinner" aria-hidden="true" />
                    <p>正在生成这一部分的详细讲解...</p>
                  </div>
                ) : null}

                {activeLesson ? (
                  <div className="lesson-content">
                    <h1>{activeLesson.title}</h1>
                    {activeLesson.blocks.map((block) => (
                      <section
                        key={block.id}
                        className={`lesson-block ${focusedBlockId === block.id ? "focused" : ""}`}
                        onClick={() => handleBlockClick(block.id, block.pageNumber)}
                      >
                        <h2>{block.heading}</h2>
                        <div className="rich-text">{renderRichText(block.body)}</div>
                        <div className="block-actions">
                          <span>对应 PDF 第 {block.pageNumber} 页</span>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setAskOpenBlockId((currentId) =>
                                currentId === block.id ? null : block.id,
                              );
                              setFocusedBlockId(block.id);
                              setActivePdfPage(block.pageNumber);
                            }}
                          >
                            追问这一点
                          </button>
                        </div>
                        {answersByBlock[block.id]?.map((answer, index) => (
                          <article key={`${block.id}-answer-${index}`} className="follow-up-answer">
                            {answer.question ? (
                              <p className="follow-up-question">追问：{answer.question}</p>
                            ) : null}
                            <strong>补充解释</strong>
                            <div className="rich-text">{renderRichText(answer.answer)}</div>
                          </article>
                        ))}
                        {askOpenBlockId === block.id ? (
                          <form
                            className="ask-box"
                            onClick={(event) => event.stopPropagation()}
                            onSubmit={(event) => {
                              event.preventDefault();
                              submitQuestion(block.id);
                            }}
                          >
                            <textarea
                              value={questionDrafts[block.id] ?? ""}
                              onChange={(event) =>
                                setQuestionDrafts((currentDrafts) => ({
                                  ...currentDrafts,
                                  [block.id]: event.target.value,
                                }))
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.shiftKey) {
                                  event.preventDefault();
                                  if (!askingBlockIds.has(block.id)) {
                                    submitQuestion(block.id);
                                  }
                                }
                              }}
                              placeholder="哪里没看懂？可以继续问这个知识点。"
                            />
                            <button type="submit" disabled={askingBlockIds.has(block.id)}>
                              {askingBlockIds.has(block.id) ? "回答中..." : "发送追问"}
                            </button>
                          </form>
                        ) : null}
                      </section>
                    ))}

                    {activeLesson.terms.length > 0 ? (
                      <section className="terms-section">
                        <h2>术语对照</h2>
                        <div className="term-list">
                          {activeLesson.terms.map((term) => (
                            <article key={`${term.english}-${term.chinese}`}>
                              <strong>
                                {term.english} <span>{term.chinese}</span>
                              </strong>
                              <p>{term.explanation}</p>
                            </article>
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </div>
                ) : null}
              </article>
            </section>
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell upload-shell ${themeClass}`}>
      <header className="topbar">
        {renderBrand("AI 课件老师")}
        {renderThemeToggle()}
      </header>

      <form className="upload-card" onSubmit={handleStartLearning}>
        <div className="upload-card-header">
          <h1>上传课程资料</h1>
          <p>上传后会先生成课件目录，再按目录逐部分完整讲解。</p>
        </div>

        <label
          className={isDraggingFiles ? "file-drop drag-over" : "file-drop"}
          htmlFor="material-upload"
          onDragOver={handleFileDragOver}
          onDragLeave={handleFileDragLeave}
          onDrop={handleFileDrop}
        >
          <input
            ref={fileInputRef}
            id="material-upload"
            type="file"
            accept={acceptedFileTypes}
            multiple
            onChange={handleFileChange}
          />
          <span className="file-drop-title">添加资料</span>
          <span className="file-drop-meta">选择一个或多个文件，之后仍可继续追加。</span>
        </label>

        <section className="file-queue" aria-label="已上传资料">
          <div className="file-queue-header">
            <div>
              <h2>资料列表</h2>
              <p>
                {selectedFiles.length} 份资料 · {formatFileSize(totalFileSize)}
              </p>
            </div>
            {selectedFiles.length > 0 ? (
              <button type="button" onClick={clearMaterials}>
                清空
              </button>
            ) : null}
          </div>

          {selectedFiles.length > 0 ? (
            <ul className="file-list">
              {selectedFiles.map((file) => {
                const fileId = getFileId(file);
                return (
                  <li key={fileId}>
                    <div>
                      <span>{file.name}</span>
                      <small>{formatFileSize(file.size)}</small>
                    </div>
                    <button type="button" onClick={() => removeFile(fileId)}>
                      删除
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="empty-files">还没有添加资料</div>
          )}
        </section>

        {error ? <p className="error-message">{error}</p> : null}

        <button className="primary-button" type="submit" disabled={selectedFiles.length === 0}>
          生成课件目录
        </button>
      </form>

      <section className="history-card" aria-label="历史记录">
        <div className="history-header">
          <div>
            <h2>历史记录</h2>
            <p>已经生成过的内容会保存在本地，重新打开不会重复消耗 token。</p>
          </div>
          <button type="button" onClick={refreshHistory} disabled={isHistoryLoading}>
            {isHistoryLoading ? "刷新中" : "刷新"}
          </button>
        </div>

        {historyItems.length > 0 ? (
          <div className="history-list">
            {historyItems.map((item) => (
              <article
                key={item.id}
                className="history-item"
                role="button"
                tabIndex={0}
                onClick={() => openHistoryItem(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openHistoryItem(item);
                  }
                }}
              >
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {formatHistoryTime(item.createdAt)} · {item.fileCount} 份资料 ·{" "}
                    {item.partCount} 个讲解部分 · {formatFileSize(item.totalSize)}
                  </span>
                </div>
                <button
                  className="history-delete"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    removeHistoryItem(item.id);
                  }}
                >
                  删除
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-history">
            {isHistoryLoading ? "正在读取历史记录..." : "还没有历史记录"}
          </div>
        )}
      </section>
    </main>
  );
}
