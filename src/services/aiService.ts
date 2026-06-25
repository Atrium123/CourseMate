import type {
  CourseSession,
  FollowUpAnswer,
  HistoryItem,
  LearningProgress,
  PartLesson,
  SessionLearningState,
} from "../types";

export async function createMaterialSession(files: File[]): Promise<CourseSession> {
  const formData = new FormData();

  files.forEach((file) => {
    formData.append("materials", file);
  });

  const response = await fetch("/api/materials", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? "资料读取失败，请稍后重试。");
  }

  return response.json() as Promise<CourseSession>;
}

export async function getMaterialSession(sessionId: string): Promise<CourseSession> {
  const response = await fetch(`/api/sessions/${sessionId}`);

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? "没有找到这个学习会话，请重新上传资料。");
  }

  return response.json() as Promise<CourseSession>;
}

export async function explainPart(sessionId: string, partId: string): Promise<PartLesson> {
  const response = await fetch("/api/explain-part", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId, partId }),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? "这一部分讲解生成失败，请稍后重试。");
  }

  return response.json() as Promise<PartLesson>;
}

export async function askAboutLessonBlock(input: {
  sessionId: string;
  partId: string;
  blockId: string;
  blockHeading: string;
  blockBody: string;
  question: string;
}): Promise<FollowUpAnswer> {
  const response = await fetch("/api/ask-block", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? "追问失败，请稍后重试。");
  }

  return response.json() as Promise<FollowUpAnswer>;
}

export async function listHistory(): Promise<HistoryItem[]> {
  const response = await fetch("/api/history");

  if (!response.ok) {
    throw new Error("历史记录读取失败。");
  }

  return response.json() as Promise<HistoryItem[]>;
}

export async function deleteHistory(sessionId: string): Promise<void> {
  const response = await fetch(`/api/history/${sessionId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? "历史记录删除失败。");
  }
}

export async function getSessionLearningState(sessionId: string): Promise<SessionLearningState> {
  const response = await fetch(`/api/sessions/${sessionId}/state`);

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? "学习状态读取失败。");
  }

  return response.json() as Promise<SessionLearningState>;
}

export async function saveLearningProgress(progress: LearningProgress): Promise<void> {
  const response = await fetch(`/api/sessions/${progress.sessionId}/progress`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(progress),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? "学习进度保存失败。");
  }
}
