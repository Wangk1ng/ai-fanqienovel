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
import { Plus, Sparkles, Loader2, CheckCircle2, XCircle, AlertTriangle, X } from "lucide-react";
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

  const [targetChapters, setTargetChapters] = useState(15);
  const [wordCount, setWordCount] = useState(1000);

  const [task, setTask] = useState<TaskStatus | null>(null);
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

  const pollTaskStatus = useCallback(async (taskId: string) => {
    try {
      const response = await fetch(`/api/tasks/status?taskId=${taskId}`);
      if (!response.ok) return null;
      const data = await response.json();
      return data as TaskStatus;
    } catch {
      return null;
    }
  }, []);

  const handleCreate = async () => {
    if (targetChapters < 10 || targetChapters > 1000) {
      alert("章节数必须在 10-1000 之间", "warning");
      return;
    }
    if (wordCount < 500 || wordCount > 5000) {
      alert("每章字数必须在 500-5000 之间", "warning");
      return;
    }

    setIsCreating(true);

    try {
      const response = await fetch("/api/projects/batch-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetChapters,
          wordCount,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "创建失败");
      }

      const data = await response.json();
      const newTask: TaskStatus = {
        taskId: data.taskId,
        status: "pending",
        currentStep: "等待开始",
        stepProgress: 0,
        completedChapters: 0,
        targetChapters,
      };
      
      setTask(newTask);
      setTasks((prev) => [newTask, ...prev]);

    } catch (error) {
      alert(error instanceof Error ? error.message : "创建失败", "error");
      setIsCreating(false);
    }
  };

  useEffect(() => {
    if (!task || task.status === "completed" || task.status === "failed") {
      if (task?.status === "completed") {
        setIsCreating(false);
        onSuccess?.();
        router.refresh();
      }
      return;
    }

    const interval = setInterval(async () => {
      const updatedTask = await pollTaskStatus(task.taskId);
      if (updatedTask) {
        setTask(updatedTask);
        setTasks((prev) =>
          prev.map((t) => (t.taskId === task.taskId ? updatedTask : t))
        );

        if (updatedTask.status === "completed" || updatedTask.status === "failed") {
          clearInterval(interval);
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [task, pollTaskStatus, onSuccess, router]);

  const resetAll = () => {
    setTask(null);
    setTasks([]);
    setIsCreating(false);
  };

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

        {!task && (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="targetChapters">目标章节数</Label>
                <Input
                  id="targetChapters"
                  type="number"
                  min={10}
                  max={1000}
                  value={targetChapters}
                  onChange={(e) => setTargetChapters(Number(e.target.value))}
                  disabled={isCreating}
                />
                <p className="text-xs text-muted-foreground">默认 15 章</p>
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
                <p className="text-xs text-muted-foreground">默认 1000 字</p>
              </div>
            </div>

            <div className="rounded-lg border p-3 bg-muted/30">
              <h4 className="text-sm font-medium mb-2">全自动流程：</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>1. AI 自动生成热门小说类型和创作需求</li>
                <li>2. 自动创建项目并生成核心设定</li>
                <li>3. 自动批量生成角色体系</li>
                <li>4. 自动生成大纲结构</li>
                <li>5. 自动生成所有章节内容</li>
              </ul>
            </div>
          </div>
        )}

        {task && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>{task.currentStep}</span>
                <span>{task.stepProgress}%</span>
              </div>
              <Progress value={task.stepProgress} className="h-3" />
            </div>

            {task.genre && (
              <div className="text-sm">
                <span className="text-muted-foreground">类型：</span>
                <span className="font-medium">{task.genre}</span>
              </div>
            )}

            {task.title && (
              <div className="text-sm">
                <span className="text-muted-foreground">标题：</span>
                <span className="font-medium">{task.title}</span>
              </div>
            )}

            <div className="text-sm">
              <span className="text-muted-foreground">章节进度：</span>
              <span className="font-medium">
                {task.completedChapters} / {task.targetChapters}
              </span>
            </div>

            {task.status === "failed" && task.errorMessage && (
              <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">
                {task.errorMessage}
              </div>
            )}

            {task.projectId && task.status === "completed" && (
              <div className="p-3 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg">
                <p className="text-sm text-green-600 dark:text-green-400 font-medium">
                  项目创建成功！
                </p>
                <a
                  href={`/projects/${task.projectId}`}
                  className="text-sm text-green-600 dark:text-green-400 underline"
                >
                  查看项目
                </a>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {!task && (
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
                    开始创建
                  </>
                )}
              </Button>
            </>
          )}

          {task && task.status === "running" && (
            <Button variant="outline" onClick={() => { resetAll(); }}>
              关闭
            </Button>
          )}

          {task && task.status === "completed" && (
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                关闭
              </Button>
              <Button onClick={resetAll}>
                <Sparkles className="mr-2 h-4 w-4" />
                继续创建
              </Button>
            </>
          )}

          {task && task.status === "failed" && (
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                关闭
              </Button>
              <Button onClick={resetAll}>
                重试
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
