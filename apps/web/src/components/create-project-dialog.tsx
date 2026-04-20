"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Sparkles, RefreshCw, AlertTriangle } from "lucide-react";
import { useAlertDialog } from "@/hooks/use-alert-dialog";

const GENRES = [
  "玄幻", "仙侠", "都市", "科幻", "历史",
  "悬疑", "言情", "武侠", "奇幻", "军事",
] as const;

const manualSchema = z.object({
  title: z.string().min(1, "项目标题不能为空").max(100, "标题最多100个字符"),
  genre: z.string().min(1, "请选择小说类型"),
  description: z.string().optional(),
});

type ManualInput = z.infer<typeof manualSchema>;

type TitleOption = {
  title: string;
  reason: string;
};

interface CreateProjectDialogProps {
  onSuccess?: () => void;
}

export function CreateProjectDialog({ onSuccess }: CreateProjectDialogProps) {
  const { alert } = useAlertDialog();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [tab, setTab] = useState<string>("ai");

  // AI 模式状态
  const [aiGenre, setAiGenre] = useState("");
  const [aiRequirements, setAiRequirements] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [titleOptions, setTitleOptions] = useState<TitleOption[]>([]);
  const [selectedTitleIndex, setSelectedTitleIndex] = useState<number>(-1);
  const [generatedDescription, setGeneratedDescription] = useState("");
  const [refinedRequirements, setRefinedRequirements] = useState("");
  const [enableRefineRequirements, setEnableRefineRequirements] = useState(true);
  const [aiStep, setAiStep] = useState<"input" | "select">("input");
  const [hasAiConfig, setHasAiConfig] = useState<boolean | null>(null);

  // 一键生成状态
  const [enableQuickGenerate, setEnableQuickGenerate] = useState(false);
  const [quickGenerateKeywords, setQuickGenerateKeywords] = useState("");
  const [quickGenerateChapters, setQuickGenerateChapters] = useState(100);
  const [quickGenerateWordCount, setQuickGenerateWordCount] = useState(2300);
  const [isQuickGenerating, setIsQuickGenerating] = useState(false);
  const [quickGenerateTaskId, setQuickGenerateTaskId] = useState<string | null>(null);
  const [quickGenerateProgress, setQuickGenerateProgress] = useState<{
    currentStep: number;
    totalSteps: number;
    currentStepName: string;
    currentChapter: number;
    totalChapters: number;
    successCount: number;
    status: string;
  } | null>(null);
  const [quickGenerateResult, setQuickGenerateResult] = useState<{
    projectId: string;
    status: string;
    message: string;
  } | null>(null);

  // 检查用户是否配置了 AI
  useEffect(() => {
    if (open && tab === "ai") {
      fetch("/api/user/settings")
        .then((res) => res.json())
        .then((data) => {
          const s = data.settings;
          setHasAiConfig(!!(s?.aiApiKey || s?.aiProvider));
        })
        .catch(() => setHasAiConfig(false));
    }
  }, [open, tab]);

  // 手动模式表单
  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<ManualInput>({
    resolver: zodResolver(manualSchema),
  });

  const resetAll = () => {
    reset();
    setAiGenre("");
    setAiRequirements("");
    setTitleOptions([]);
    setSelectedTitleIndex(-1);
    setGeneratedDescription("");
    setRefinedRequirements("");
    setEnableRefineRequirements(true);
    setAiStep("input");
    setTab("ai");
    setEnableQuickGenerate(false);
    setQuickGenerateKeywords("");
    setQuickGenerateChapters(100);
    setQuickGenerateWordCount(2300);
    setQuickGenerateTaskId(null);
    setQuickGenerateProgress(null);
    setQuickGenerateResult(null);
  };

  // 轮询一键生成进度
  useEffect(() => {
    if (!quickGenerateTaskId) return;

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/projects/quick-generate/status?taskId=${encodeURIComponent(quickGenerateTaskId)}`);
        if (!res.ok) return;
        const data = await res.json();
        const task = data.task;

        setQuickGenerateProgress({
          currentStep: task.currentStep,
          totalSteps: task.totalSteps,
          currentStepName: task.currentStepName,
          currentChapter: task.currentChapter,
          totalChapters: task.totalChapters,
          successCount: task.successCount,
          status: task.status,
        });

        if (task.status === "completed") {
          clearInterval(pollInterval);
          setIsQuickGenerating(false);
          setQuickGenerateResult({
            projectId: task.projectId,
            status: "completed",
            message: `生成完成！已成功生成 ${task.successCount} 个章节`,
          });
        } else if (task.status === "failed") {
          clearInterval(pollInterval);
          setIsQuickGenerating(false);
          setQuickGenerateResult({
            projectId: task.projectId,
            status: "failed",
            message: task.error || "生成失败",
          });
        }
      } catch (err) {
        console.error("获取进度失败:", err);
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [quickGenerateTaskId]);

  // 手动创建
  const onManualSubmit = async (data: ManualInput) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "创建失败");
      }

      setOpen(false);
      resetAll();
      onSuccess?.();
      router.refresh();
    } catch (error) {
      console.error("创建项目失败:", error);
      alert(error instanceof Error ? error.message : "创建失败", "error");
    } finally {
      setIsLoading(false);
    }
  };

  // AI 生成标题和简介
  const handleAiGenerate = async () => {
    if (!aiGenre) {
      alert("请选择小说类型", "warning");
      return;
    }
    if (!aiRequirements.trim()) {
      alert("请输入创作需求", "warning");
      return;
    }

    setIsGenerating(true);
    try {
      const response = await fetch("/api/projects/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          genre: aiGenre,
          requirements: aiRequirements,
          enableRefineRequirements,
        }),
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "生成失败");
      }

      const data = await response.json();
      setTitleOptions(data.titles || []);
      setGeneratedDescription(data.description || "");
      setRefinedRequirements(data.refinedRequirements || "");
      setSelectedTitleIndex(-1);
      setAiStep("select");
    } catch (error) {
      console.error("AI 生成失败:", error);
      alert(error instanceof Error ? error.message : "生成失败，请重试", "error");
    } finally {
      setIsGenerating(false);
    }
  };

  // AI 模式确认创建
  const handleAiCreate = async () => {
    if (selectedTitleIndex < 0) {
      alert("请选择一个标题", "warning");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: titleOptions[selectedTitleIndex].title,
          genre: aiGenre,
          description: generatedDescription,
        }),
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "创建失败");
      }

      const data = await response.json();
      const projectId = data.project.id;

      setOpen(false);
      resetAll();
      onSuccess?.();
      router.refresh();

      // 如果启用了一键生成，立即开始
      if (enableQuickGenerate) {
        startQuickGenerate(projectId);
      }
    } catch (error) {
      console.error("创建项目失败:", error);
      alert(error instanceof Error ? error.message : "创建失败", "error");
    } finally {
      setIsLoading(false);
    }
  };

  // 开始一键生成
  const startQuickGenerate = async (projectId: string) => {
    setIsQuickGenerating(true);
    setQuickGenerateProgress({
      currentStep: 0,
      totalSteps: 3 + quickGenerateChapters,
      currentStepName: "等待开始",
      currentChapter: 0,
      totalChapters: quickGenerateChapters,
      successCount: 0,
      status: "pending",
    });

    try {
      const response = await fetch(`/api/projects/${projectId}/quick-generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          genre: aiGenre,
          requirements: refinedRequirements || aiRequirements,
          enableRefineRequirements,
          titleOption: titleOptions[selectedTitleIndex],
          generatedDescription,
          keywords: quickGenerateKeywords,
          enableRefineKeywords: true,
          targetChapters: quickGenerateChapters,
          characterCount: 8,
          wordCount: quickGenerateWordCount,
          autoGenerateChapters: true,
        }),
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "一键生成启动失败");
      }

      const data = await response.json();
      setQuickGenerateTaskId(data.taskId);
    } catch (error) {
      console.error("一键生成启动失败:", error);
      setIsQuickGenerating(false);
      alert(error instanceof Error ? error.message : "一键生成启动失败", "error");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetAll(); }}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          创建新项目
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>创建新项目</DialogTitle>
          <DialogDescription>
            选择手动填写或让 AI 帮你生成标题和简介
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="ai">
              <Sparkles className="mr-2 h-4 w-4" />
              AI 创建
            </TabsTrigger>
            <TabsTrigger value="manual">手动创建</TabsTrigger>
          </TabsList>

          {/* AI 创建 */}
          <TabsContent value="ai" className="space-y-4 mt-4">
            {hasAiConfig === false && (
              <div className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg text-sm">
                <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-yellow-800 dark:text-yellow-200">
                    尚未配置 AI 模型，请先前往
                    <Link href="/settings" className="underline font-medium mx-1">用户设置</Link>
                    配置 AI 服务
                  </p>
                </div>
              </div>
            )}
            {aiStep === "input" && (
              <>
                <div className="space-y-2">
                  <Label>小说类型</Label>
                  <Select value={aiGenre} onValueChange={setAiGenre}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择类型" />
                    </SelectTrigger>
                    <SelectContent>
                      {GENRES.map((genre) => (
                        <SelectItem key={genre} value={genre}>
                          {genre}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>创作需求</Label>
                  <Textarea
                    value={aiRequirements}
                    onChange={(e) => setAiRequirements(e.target.value)}
                    placeholder={"描述你想写的小说，例如：\n主角重生回到高中时代，利用前世记忆在商业和感情上逆袭翻盘，同时揭开前世死因的真相..."}
                    rows={5}
                    disabled={isGenerating}
                  />
                  <p className="text-xs text-muted-foreground">
                    描述越详细，AI 生成的标题和简介越精准
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-md border p-3">
                  <Checkbox
                    id="enable-refine-requirements"
                    checked={enableRefineRequirements}
                    onCheckedChange={(checked) => setEnableRefineRequirements(checked === true)}
                    disabled={isGenerating}
                  />
                  <Label htmlFor="enable-refine-requirements" className="cursor-pointer text-sm">
                    优化创作需求（更完整但会更慢）
                  </Label>
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setOpen(false)}
                    disabled={isGenerating}
                  >
                    取消
                  </Button>
                  <Button
                    onClick={handleAiGenerate}
                    disabled={isGenerating || !aiGenre || !aiRequirements.trim()}
                  >
                    {isGenerating ? (
                      <>
                        <Sparkles className="mr-2 h-4 w-4 animate-pulse" />
                        生成中...
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-2 h-4 w-4" />
                        生成标题和简介
                      </>
                    )}
                  </Button>
                </DialogFooter>
              </>
            )}

            {aiStep === "select" && (
              <>
                {refinedRequirements && (
                  <div className="space-y-2">
                    <Label>AI 理解的创作方案</Label>
                    <div className="p-3 bg-muted rounded-lg text-sm whitespace-pre-wrap max-h-[150px] overflow-y-auto">
                      {refinedRequirements}
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <Label>选择标题</Label>
                  <div className="space-y-2">
                    {titleOptions.map((option, index) => (
                      <div
                        key={index}
                        className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                          selectedTitleIndex === index
                            ? "border-primary bg-primary/5"
                            : "hover:bg-accent"
                        }`}
                        onClick={() => setSelectedTitleIndex(index)}
                      >
                        <p className="font-semibold">{option.title}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {option.reason}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>生成的简介</Label>
                  <Textarea
                    value={generatedDescription}
                    onChange={(e) => setGeneratedDescription(e.target.value)}
                    rows={6}
                  />
                  <p className="text-xs text-muted-foreground">
                    可以直接编辑修改简介内容
                  </p>
                </div>

                {/* 一键生成选项 */}
                <div className="border rounded-lg p-4 space-y-4">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="enable-quick-generate"
                      checked={enableQuickGenerate}
                      onCheckedChange={(checked) => setEnableQuickGenerate(checked === true)}
                      disabled={isLoading || isQuickGenerating}
                    />
                    <Label htmlFor="enable-quick-generate" className="cursor-pointer font-medium">
                      启用一键全自动生成
                    </Label>
                  </div>

                  {enableQuickGenerate && (
                    <div className="space-y-3 pl-6 border-l-2 border-muted">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">目标章节数</Label>
                          <Input
                            type="number"
                            min={10}
                            max={1000}
                            value={quickGenerateChapters}
                            onChange={(e) => setQuickGenerateChapters(Number(e.target.value))}
                            disabled={isQuickGenerating}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">每章字数</Label>
                          <Input
                            type="number"
                            min={1000}
                            max={5000}
                            step={100}
                            value={quickGenerateWordCount}
                            onChange={(e) => setQuickGenerateWordCount(Number(e.target.value))}
                            disabled={isQuickGenerating}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">设定关键词（可选）</Label>
                        <Input
                          placeholder="如：修仙、废柴逆袭、宗门争斗..."
                          value={quickGenerateKeywords}
                          onChange={(e) => setQuickGenerateKeywords(e.target.value)}
                          disabled={isQuickGenerating}
                        />
                        <p className="text-xs text-muted-foreground">
                          提供关键词可让核心设定更精准
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* 进度显示 */}
                {isQuickGenerating && quickGenerateProgress && (
                  <div className="border rounded-lg p-4 bg-muted/50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">
                        {quickGenerateProgress.currentStepName}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {quickGenerateProgress.status === "running" ? "进行中" : quickGenerateProgress.status}
                      </span>
                    </div>
                    <div className="w-full bg-secondary rounded-full h-2 mb-2">
                      <div
                        className="bg-primary rounded-full h-2 transition-all"
                        style={{
                          width: `${(quickGenerateProgress.currentStep / quickGenerateProgress.totalSteps) * 100}%`,
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>步骤 {quickGenerateProgress.currentStep} / {quickGenerateProgress.totalSteps}</span>
                      {quickGenerateProgress.currentChapter > 0 && (
                        <span>
                          第 {quickGenerateProgress.currentChapter} 章 ({quickGenerateProgress.successCount} 已完成)
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* 生成结果 */}
                {quickGenerateResult && (
                  <div className={`border rounded-lg p-4 ${quickGenerateResult.status === "completed" ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
                    <p className={`text-sm font-medium ${quickGenerateResult.status === "completed" ? "text-green-700" : "text-red-700"}`}>
                      {quickGenerateResult.message}
                    </p>
                    {quickGenerateResult.projectId && (
                      <Button asChild variant="link" className="mt-2 h-auto p-0">
                        <Link href={`/projects/${quickGenerateResult.projectId}`}>
                          打开项目查看
                        </Link>
                      </Button>
                    )}
                  </div>
                )}

                <DialogFooter className="flex justify-between sm:justify-between">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setAiStep("input");
                      setTitleOptions([]);
                      setSelectedTitleIndex(-1);
                      setGeneratedDescription("");
                    }}
                    disabled={isLoading || isGenerating || isQuickGenerating}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    重新生成
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setOpen(false)}
                      disabled={isLoading || isQuickGenerating}
                    >
                      取消
                    </Button>
                    <Button
                      onClick={handleAiCreate}
                      disabled={isLoading || selectedTitleIndex < 0 || isQuickGenerating}
                    >
                      {isLoading ? "创建中..." : enableQuickGenerate ? "创建并一键生成" : "确认创建"}
                    </Button>
                  </div>
                </DialogFooter>
              </>
            )}
          </TabsContent>

          {/* 手动创建 */}
          <TabsContent value="manual" className="mt-4">
            <form onSubmit={handleSubmit(onManualSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">项目标题</Label>
                <Input
                  {...register("title")}
                  id="title"
                  placeholder="输入小说标题"
                  disabled={isLoading}
                />
                {errors.title && (
                  <p className="text-sm text-destructive">{errors.title.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="genre">小说类型</Label>
                <Select onValueChange={(value) => setValue("genre", value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择类型" />
                  </SelectTrigger>
                  <SelectContent>
                    {GENRES.map((genre) => (
                      <SelectItem key={genre} value={genre}>
                        {genre}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.genre && (
                  <p className="text-sm text-destructive">{errors.genre.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">简介（可选）</Label>
                <Textarea
                  {...register("description")}
                  id="description"
                  placeholder="简单描述你的小说构想..."
                  rows={3}
                  disabled={isLoading}
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={isLoading}
                >
                  取消
                </Button>
                <Button type="submit" disabled={isLoading}>
                  {isLoading ? "创建中..." : "创建"}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
