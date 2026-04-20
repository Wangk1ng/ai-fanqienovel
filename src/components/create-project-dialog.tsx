"use client";

import { useState, useEffect } from "react";
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

interface CreateProjectDialogProps {
  onSuccess?: () => void;
}

type ProjectStatus = {
  id: string;
  title: string;
  status: "pending" | "generating" | "completed" | "failed";
  error?: string;
};

export function CreateProjectDialog({ onSuccess }: CreateProjectDialogProps) {
  const { alert } = useAlertDialog();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [hasAiConfig, setHasAiConfig] = useState<boolean | null>(null);

  // 批量创建配置
  const [threadCount, setThreadCount] = useState(3);
  const [projectCount, setProjectCount] = useState(5);
  const [targetChapters, setTargetChapters] = useState(50);
  const [wordCount, setWordCount] = useState(2300);

  // 批量创建状态
  const [batchStatus, setBatchStatus] = useState<"idle" | "creating" | "completed">("idle");
  const [projects, setProjects] = useState<ProjectStatus[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);

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

  const resetAll = () => {
    setBatchStatus("idle");
    setProjects([]);
    setCurrentIndex(0);
    setCompletedCount(0);
    setFailedCount(0);
  };

  const handleBatchCreate = async () => {
    if (threadCount < 1 || threadCount > 10) {
      alert("线程数必须在 1-10 之间", "warning");
      return;
    }
    if (projectCount < 1 || projectCount > 50) {
      alert("项目数必须在 1-50 之间", "warning");
      return;
    }

    setIsCreating(true);
    setBatchStatus("creating");
    setProjects([]);
    setCompletedCount(0);
    setFailedCount(0);

    try {
      // 初始化项目列表
      const projectList: ProjectStatus[] = [];
      for (let i = 0; i < projectCount; i++) {
        projectList.push({
          id: `temp_${i}`,
          title: `项目 ${i + 1}`,
          status: "pending",
        });
      }
      setProjects(projectList);

      // 使用 Promise 控制并发
      let currentIdx = 0;
      const results: ProjectStatus[] = [];

      const createProjectWorker = async (): Promise<void> => {
        while (true) {
          const idx = currentIdx++;
          if (idx >= projectCount) break;

          setCurrentIndex(idx);

          // 更新状态为生成中
          setProjects((prev) => {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], status: "generating" };
            return updated;
          });

          try {
            // 调用批量创建API
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

            results[idx] = {
              id: data.projectId,
              title: data.title || `项目 ${idx + 1}`,
              status: "completed",
            };
          } catch (error) {
            results[idx] = {
              id: `failed_${idx}`,
              title: `项目 ${idx + 1}`,
              status: "failed",
              error: error instanceof Error ? error.message : "创建失败",
            };
          }

          // 更新单个项目的状态
          setProjects((prev) => {
            const updated = [...prev];
            updated[idx] = results[idx];
            return updated;
          });

          // 更新计数
          if (results[idx].status === "completed") {
            setCompletedCount((c) => c + 1);
          } else {
            setFailedCount((c) => c + 1);
          }
        }
      };

      // 启动指定数量的并发 worker
      const workers = [];
      for (let i = 0; i < threadCount; i++) {
        workers.push(createProjectWorker());
      }

      await Promise.all(workers);

      setBatchStatus("completed");
      setIsCreating(false);
      onSuccess?.();
      router.refresh();
    } catch (error) {
      console.error("批量创建失败:", error);
      alert(error instanceof Error ? error.message : "批量创建失败", "error");
      setIsCreating(false);
      setBatchStatus("idle");
    }
  };

  const progress = projectCount > 0 ? ((completedCount + failedCount) / projectCount) * 100 : 0;

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
          <DialogTitle>批量创建项目</DialogTitle>
          <DialogDescription>
            一键全自动批量创建小说项目，AI自动生成类型和创作需求
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

        {batchStatus === "idle" && (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="threadCount">并发线程数</Label>
                <Input
                  id="threadCount"
                  type="number"
                  min={1}
                  max={10}
                  value={threadCount}
                  onChange={(e) => setThreadCount(Number(e.target.value))}
                  disabled={isCreating}
                />
                <p className="text-xs text-muted-foreground">同时创建的项目数量 (1-10)</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="projectCount">项目数量</Label>
                <Input
                  id="projectCount"
                  type="number"
                  min={1}
                  max={50}
                  value={projectCount}
                  onChange={(e) => setProjectCount(Number(e.target.value))}
                  disabled={isCreating}
                />
                <p className="text-xs text-muted-foreground">要创建的项目总数 (1-50)</p>
              </div>
            </div>

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
                <p className="text-xs text-muted-foreground">每个项目的章节数</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="wordCount">每章字数</Label>
                <Input
                  id="wordCount"
                  type="number"
                  min={1000}
                  max={5000}
                  step={100}
                  value={wordCount}
                  onChange={(e) => setWordCount(Number(e.target.value))}
                  disabled={isCreating}
                />
                <p className="text-xs text-muted-foreground">每章目标字数</p>
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

        {batchStatus === "creating" && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>创建进度</span>
                <span>{completedCount + failedCount} / {projectCount}</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>

            <div className="space-y-2 max-h-[200px] overflow-y-auto">
              {projects.map((project, index) => (
                <div
                  key={project.id}
                  className="flex items-center gap-2 p-2 rounded border text-sm"
                >
                  {project.status === "pending" && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                  {project.status === "generating" && (
                    <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                  )}
                  {project.status === "completed" && (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  )}
                  {project.status === "failed" && (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  <span className="flex-1 truncate">
                    {project.title}
                    {project.status === "generating" && (
                      <span className="text-blue-500 ml-2">创建中...</span>
                    )}
                    {project.status === "failed" && project.error && (
                      <span className="text-red-500 ml-2 text-xs">{project.error}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {batchStatus === "completed" && (
          <div className="space-y-4 py-4">
            <div className="text-center">
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-2" />
              <h3 className="text-lg font-semibold">批量创建完成</h3>
              <p className="text-muted-foreground">
                成功: {completedCount} | 失败: {failedCount}
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {batchStatus === "idle" && (
            <>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={isCreating}>
                取消
              </Button>
              <Button onClick={handleBatchCreate} disabled={isCreating || hasAiConfig === false}>
                {isCreating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    创建中...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    开始批量创建
                  </>
                )}
              </Button>
            </>
          )}

          {batchStatus === "creating" && (
            <Button variant="outline" onClick={() => { resetAll(); }}>
              取消
            </Button>
          )}

          {batchStatus === "completed" && (
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                关闭
              </Button>
              <Button onClick={() => { resetAll(); }}>
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
