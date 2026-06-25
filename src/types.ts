export interface UploadedMaterial {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface CoursePart {
  id: string;
  fileId: string;
  fileName: string;
  title: string;
  description: string;
  index: number;
  pageStart: number;
  pageEnd: number;
  sourceText: string;
}

export interface CourseFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  previewUrl: string;
  partIds: string[];
}

export interface CourseSession {
  id: string;
  totalSize: number;
  createdAt: string;
  files: CourseFile[];
  parts: CoursePart[];
}

export interface BilingualTerm {
  english: string;
  chinese: string;
  explanation: string;
}

export interface LessonBlock {
  id: string;
  heading: string;
  body: string;
  pageNumber: number;
}

export interface PartLesson {
  partId: string;
  title: string;
  blocks: LessonBlock[];
  terms: BilingualTerm[];
}

export type LessonMode = "detailed";

export interface FollowUpAnswer {
  question?: string;
  answer: string;
  createdAt?: string;
}

export interface HistoryItem {
  id: string;
  title: string;
  createdAt: string;
  totalSize: number;
  fileCount: number;
  partCount: number;
}

export interface LearningProgress {
  sessionId: string;
  partId: string;
  fileId: string;
  pdfPage: number;
  lessonMode: LessonMode;
  lessonScrollTop: number;
  updatedAt: string;
}

export interface SessionLearningState {
  progress: LearningProgress | null;
  generatedPartIds: string[];
  followUpsByBlock: Record<string, FollowUpAnswer[]>;
}
