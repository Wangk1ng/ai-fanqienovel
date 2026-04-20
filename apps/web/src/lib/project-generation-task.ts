type TaskStatus = "pending" | "running" | "completed" | "failed";

export type ProjectGenerationTask = {
  id: string;
  userId: string;
  projectId: string;
  status: TaskStatus;
  currentStep: number;
  totalSteps: number;
  currentStepName: string;
  currentChapter: number;
  totalChapters: number;
  successCount: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

declare global {
  var __projectGenerationTasks: Map<string, ProjectGenerationTask> | undefined;
}

function getTaskMap() {
  if (!global.__projectGenerationTasks) {
    global.__projectGenerationTasks = new Map<string, ProjectGenerationTask>();
  }
  return global.__projectGenerationTasks;
}

function pruneOldTasks() {
  const now = Date.now();
  const map = getTaskMap();
  for (const [id, task] of map.entries()) {
    if (now - task.updatedAt > 24 * 60 * 60 * 1000) {
      map.delete(id);
    }
  }
}

export function createProjectGenerationTask(params: {
  id: string;
  userId: string;
  projectId: string;
  totalSteps: number;
  totalChapters: number;
}): ProjectGenerationTask {
  pruneOldTasks();
  const task: ProjectGenerationTask = {
    id: params.id,
    userId: params.userId,
    projectId: params.projectId,
    status: "pending",
    currentStep: 0,
    totalSteps: params.totalSteps,
    currentStepName: "等待开始",
    currentChapter: 0,
    totalChapters: params.totalChapters,
    successCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  getTaskMap().set(task.id, task);
  return task;
}

export function getProjectGenerationTask(taskId: string): ProjectGenerationTask | null {
  pruneOldTasks();
  return getTaskMap().get(taskId) || null;
}

export function updateProjectGenerationTask(
  taskId: string,
  patch: Partial<ProjectGenerationTask>
): ProjectGenerationTask | null {
  const map = getTaskMap();
  const task = map.get(taskId);
  if (!task) return null;
  const next = {
    ...task,
    ...patch,
    updatedAt: Date.now(),
  };
  map.set(taskId, next);
  return next;
}
