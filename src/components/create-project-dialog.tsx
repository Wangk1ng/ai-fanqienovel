"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Sparkles, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { useAlertDialog } from "@/hooks/use-alert-dialog";

interface TaskStatus {
  taskId: string;
  status: "pending" | "running" | "completed" | "failed";
  currentStep: string;
  stepProgress: number;
  completedChapters: number;
  targetChapters: number;
  genre?: string;
  title?: string;
  projectId?: string;
  errorMessage?: string;
}

interface CreateProjectDialogProps {
  onSuccess?: () => void;
}

export function CreateProjectDialog({ onSuccess }: CreateProjectDialogProps) {
  const { alert } = useAlertDialog();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [hasAiConfig, setHasAiConfig] = useState<boolean | null>(null);

  const [firstBatchChapters, setFirstBatchChapters] = useState(15);
  const [wordCount, setWordCount] = useState(1000);
  const [projectCount, setProjectCount] = useState(1);
  const [threadCount, setThreadCount] = useState(3);

  const [tasks, setTasks] = useState<TaskStatus[]>([]);

  useEffect(() => {
    if (open) {
      fetch("/api/user/settings")
        .then((res) => res.json())
        .then((data) => {
          const s = data.settings;
          setHasAiConfig(!!(s?.aiApiKey || s?.aiProvider));
        })
        .catch(() => setHasAiConfig(false));
    }
  }, [open]);

  const pollTaskStatus = useCallback(async (taskId: string): Promise<TaskStatus | null> => {
    try {
      const response = await fetch(`/api/tasks/status?taskId=${taskId}`);
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }, []);

  const handleCreate = async () => {
    if (firstBatchChapters < 5 || firstBatchChapters > 50) {
      alert("首批章节数必须在 5-50 之间", "warning");
      return;
    }
    if (wordCount < 500 || wordCount > 5000) {
      alert("每章字数必须在 500-5000 之间", "warning");
      return;
    }
    if (projectCount < 1 || projectCount > 100) {
      alert("项目数必须在 1-100 之间", "warning");
      return;
    }
    if (threadCount < 1 || threadCount > 10) {
      alert("并发线程数必须在 1-10 之间", "warning");
      return;
    }

    setIsCreating(true);
    setTasks([]);

    try {
      let taskIndex = 0;
      const results: TaskStatus[] = [];
      const lock = new Set<number>();

      const createTask = async (): Promise<void> => {
        while (true) {
          if (lock.size >= threadCount) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          
          const currentIndex = taskIndex++;
          if (currentIndex >= projectCount) break;
          
          lock.add(currentIndex);
          
          try {
            const response = await fetch("/api/projects/batch-create", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                firstBatchChapters,
                wordCount,
              }),
            });

            if (!response.ok) {
              const data = await response.json().catch(() => ({}));
              throw new Error(data.error || "创建失败");
            }

            const data = await response.json();
            results[currentIndex] = {
              taskId: data.taskId,
              status: "pending",
              currentStep: "等待开始",
              stepProgress: 0,
              completedChapters: 0,
              targetChapters: 100,
            };
          } catch (error) {
            results[currentIndex] = {
              taskId: `failed_${currentIndex}`,
              status: "failed",
              currentStep: "创建失败",
              stepProgress: 0,
              completedChapters: 0,
              targetChapters: 100,
              errorMessage: error instanceof Error ? error.message : "创建失败",
            };
          } finally {
            lock.delete(currentIndex);
          }
          
          setTasks([...results].filter(Boolean));
        }
      };

      const workers = [];
      for (let i = 0; i < threadCount; i++) {
        workers.push(createTask());
      }
      
      await Promise.all(workers);

    } catch (error) {
      alert(error instanceof Error ? error.message : "创建失败", "error");
      setIsCreating(false);
    }
  };

  useEffect(() => {
    if (tasks.length === 0) return;

    const runningTasks = tasks.filter((t) => t.status === "pending" || t.status === "running");
    if (runningTasks.length === 0) {
      setIsCreating(false);
      const hasCompleted = tasks.some((t) => t.status === "completed");
      if (hasCompleted) {
        onSuccess?.();
        router.refresh();
      }
      return;
    }

    const interval = setInterval(async () => {
      const updatedTasks: TaskStatus[] = [];
      let hasChanges = false;

      for (const task of tasks) {
        if (task.status === "completed" || task.status === "failed") {
          updatedTasks.push(task);
          continue;
        }

        const updated = await pollTaskStatus(task.taskId);
        if (updated) {
          updatedTasks.push(updated);
          hasChanges = true;
        } else {
          updatedTasks.push(task);
        }
      }

      if (hasChanges) {
        setTasks(updatedTasks);
      }

      const stillRunning = updatedTasks.some((t) => t.status === "pending" || t.status === "running");
      if (!stillRunning) {
        clearInterval(interval);
        setIsCreating(false);
        const hasCompleted = updatedTasks.some((t) => t.status === "completed");
        if (hasCompleted) {
          onSuccess?.();
          router.refresh();
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [tasks, pollTaskStatus, onSuccess, router]);

  const resetAll = () => {
    setTasks([]);
    setIsCreating(false);
  };

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const failedCount = tasks.filter((t) => t.status === "failed").length;
  const progress = tasks.length > 0 ? ((completedCount + failedCount) / tasks.length) * 100 : 0;
  const overallProgress = tasks.length > 0
    ? Math.round(tasks.reduce((sum, t) => sum + t.stepProgress, 0) / tasks.length)
    : 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetAll(); }}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          创建新项目
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>一键全自动创建小说</DialogTitle>
          <DialogDescription>
            AI 自动生成类型、创作需求、大纲和所有章节内容
          </DialogDescription>
        </DialogHeader>

        {hasAiConfig === false && (
          <div className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg text-sm">
            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-yellow-800 dark:text-yellow-200">
                尚未配置 AI 模型，请先前往
                <a href="/settings" className="underline font-medium mx-1">用户设置</a>
                配置 AI 服务
              </p>
            </div>
          </div>
        )}

        {tasks.length === 0 && (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="projectCount">项目数量</Label>
                <Input
                  id="projectCount"
                  type="number"
                  min={1}
                  max={100}
                  value={projectCount}
                  onChange={(e) => setProjectCount(Number(e.target.value))}
                  disabled={isCreating}
                />
                <p className="text-xs text-muted-foreground">1-100 个项目</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="firstBatchChapters">首批章节</Label>
                <Input
                  id="firstBatchChapters"
                  type="number"
                  min={5}
                  max={50}
                  value={firstBatchChapters}
                  onChange={(e) => setFirstBatchChapters(Number(e.target.value))}
                  disabled={isCreating}
                />
                <p className="text-xs text-muted-foreground">投稿测试</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="wordCount">每章字数</Label>
                <Input
                  id="wordCount"
                  type="number"
                  min={500}
                  max={5000}
                  step={100}
                  value={wordCount}
                  onChange={(e) => setWordCount(Number(e.target.value))}
                  disabled={isCreating}
                />
                <p className="text-xs text-muted-foreground">默认1000字</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="threadCount">并发线程</Label>
                <Input
                  id="threadCount"
                  type="number"
                  min={1}
                  max={10}
                  value={threadCount}
                  onChange={(e) => setThreadCount(Number(e.target.value))}
                  disabled={isCreating}
                />
                <p className="text-xs text-muted-foreground">同时运行数</p>
              </div>
            </div>

            <div className="rounded-lg border p-3 bg-muted/30">
              <h4 className="text-sm font-medium mb-2">全自动流程：</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>1. AI 自动生成热门小说类型和创作需求</li>
                <li>2. 自动创建项目并生成核心设定</li>
                <li>3. 自动批量生成角色体系</li>
                <li>4. 自动生成完整大纲（100章规模）</li>
                <li>5. 首批生成 {firstBatchChapters} 章，过签后续写</li>
              </ul>
            </div>
          </div>
        )}

        {tasks.length > 0 && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>整体进度</span>
                <span>{overallProgress}% ({completedCount}/{tasks.length})</span>
              </div>
              <Progress value={overallProgress} className="h-3" />
            </div>

            <div className="space-y-2 max-h-[250px] overflow-y-auto">
              {tasks.map((task, index) => (
                <div
                  key={task.taskId}
                  className="flex items-center gap-2 p-2 rounded border text-sm"
                >
                  {task.status === "pending" && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                  )}
                  {task.status === "running" && (
                    <Loader2 className="h-4 w-4 animate-spin text-blue-500 shrink-0" />
                  )}
                  {task.status === "completed" && (
                    <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                  )}
                  {task.status === "failed" && (
                    <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                  )}
                  <span className="flex-1 truncate">
                    {task.title || `项目 ${index + 1}`}
                  </span>
                  {task.status === "running" && (
                    <span className="text-xs text-blue-500">{task.stepProgress}%</span>
                  )}
                  {task.status === "completed" && (
                    <span className="text-xs text-green-500">
                      {task.completedChapters}/{task.targetChapters}章
                    </span>
                  )}
                  {task.status === "failed" && task.errorMessage && (
                    <span className="text-xs text-red-500 truncate max-w-[150px]">
                      {task.errorMessage}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {failedCount > 0 && (
              <div className="text-sm text-muted-foreground text-center">
                成功: {completedCount} | 失败: {failedCount}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {tasks.length === 0 && (
            <>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={isCreating}>
                取消
              </Button>
              <Button
                onClick={handleCreate}
                disabled={isCreating || hasAiConfig === false}
              >
                {isCreating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    创建中...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    开始创建 {projectCount} 个项目
                  </>
                )}
              </Button>
            </>
          )}

          {tasks.length > 0 && (
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                关闭
              </Button>
              <Button
                onClick={resetAll}
                disabled={tasks.some((t) => t.status === "pending" || t.status === "running")}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                继续创建
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
