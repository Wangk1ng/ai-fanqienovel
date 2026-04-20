import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { generateObject, generateText, resolveAIConfig } from "@/lib/ai";
import { buildRefineRequirementsPrompt, buildProjectPrompt } from "@/lib/prompts";
import { projectGenerateSchema } from "@/lib/schemas";

const HOT_GENRES = [
  "都市", "玄幻", "言情", "穿越", "系统", "末世", "星际", "娱乐圈",
  "甜宠", "虐恋", "总裁", "军婚", "马甲", "大佬", "医妃", "空间",
  "种田", "科举", "病娇", "团宠", "双洁", "快穿", "年代", "星际恋",
];

const EXCLUDED_NAMES = ["林", "晚", "骁", "王", "沈", "烬", "砚", "舟"];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBaseUrl(): string {
  return process.env.NEXTAUTH_URL || "http://localhost:3000";
}

async function apiFetch(
  baseUrl: string,
  path: string,
  body: any,
  cookie: string,
  maxRetries = 3,
  baseDelay = 30000
): Promise<{ ok: boolean; data: any }> {
  const url = `${baseUrl}${path}`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: cookie,
        },
        body: JSON.stringify(body),
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        return { ok: true, data };
      }

      const errorMsg = data.error || `HTTP ${response.status}`;

      if (response.status >= 500 || response.status === 429) {
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          logger.info(`API ${path} 失败，${delay/1000}秒后重试 (${attempt + 1}/${maxRetries})`, { errorMsg });
          await sleep(delay);
          continue;
        }
      }

      throw new Error(errorMsg);
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      const delay = baseDelay * Math.pow(2, attempt);
      logger.info(`API ${path} 异常，${delay/1000}秒后重试 (${attempt + 1}/${maxRetries})`, { error });
      await sleep(delay);
    }
  }
  throw new Error("达到最大重试次数");
}

async function generateWithRetry<T>(
  generateFn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 30000
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await generateFn();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isRetryable =
        errorMsg.includes("429") ||
        errorMsg.includes("500") ||
        errorMsg.includes("rate limit") ||
        errorMsg.includes("timeout") ||
        errorMsg.includes("ECONNRESET");

      if (isRetryable && attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        logger.info(`AI 生成失败，${delay / 1000}秒后重试 (${attempt + 1}/${maxRetries})`, { errorMsg });
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
  throw new Error("达到最大重试次数");
}

async function updateTask(
  taskId: string,
  updates: {
    status?: string;
    currentStep?: string;
    stepProgress?: number;
    projectId?: string;
    genre?: string;
    title?: string;
    completedChapters?: number;
    errorMessage?: string;
  }
) {
  await prisma.generationTask.update({
    where: { id: taskId },
    data: {
      ...updates,
      updatedAt: new Date(),
    },
  });
}

export async function executeGenerationTask(taskId: string) {
  const baseUrl = getBaseUrl();
  
  const task = await prisma.generationTask.findUnique({
    where: { id: taskId },
  });

  if (!task) {
    logger.error("任务不存在", { taskId });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: task.userId },
  });

  if (!user) {
    await updateTask(taskId, { status: "failed", errorMessage: "用户不存在" });
    return;
  }

  const aiConfig = resolveAIConfig(null, user);
  
  const session = await prisma.session.findFirst({
    where: { userId: task.userId },
    orderBy: { createdAt: "desc" },
  });
  
  if (!session) {
    await updateTask(taskId, { status: "failed", errorMessage: "用户会话不存在" });
    return;
  }

  const cookie = `next-auth.session-token=${session.token}`;

  const { targetChapters, wordCount } = task;
  const randomGenre = HOT_GENRES[Math.floor(Math.random() * HOT_GENRES.length)];
  const requirementsPrompt = `从以下热门类型中随机选择创作一个吸引人且大胆的脑洞：${HOT_GENRES.join("、")}。角色姓名不要带有：${EXCLUDED_NAMES.join("、")}`;

  logger.info("开始执行生成任务", { taskId, randomGenre });

  try {
    await updateTask(taskId, { 
      status: "running", 
      currentStep: "生成创作需求",
      stepProgress: 5,
      genre: randomGenre 
    });

    let refinedRequirements = "";
    let title = "";
    let description = "";

    try {
      refinedRequirements = await generateWithRetry(async () => {
        const prompt = buildRefineRequirementsPrompt({ genre: randomGenre, requirements: requirementsPrompt });
        return generateText(prompt, { ...aiConfig, temperature: 0.7 });
      }, 3, 30000);
      logger.info("创作需求优化完成", { refinedLength: refinedRequirements.length });
    } catch (error) {
      logger.error("优化创作需求失败", { error });
      await updateTask(taskId, { status: "failed", errorMessage: "生成创作需求失败" });
      return;
    }

    try {
      const parsed = await generateWithRetry(async () => {
        const prompt = buildProjectPrompt({ genre: randomGenre, requirements: refinedRequirements });
        return generateObject(prompt, projectGenerateSchema, { ...aiConfig, temperature: 0.9 });
      }, 3, 30000);
      title = parsed.titles?.[0]?.title || `${randomGenre}小说_${Date.now()}`;
      description = parsed.description || "";
      logger.info("标题和简介生成成功", { title, descriptionLength: description.length });
    } catch (error) {
      logger.error("生成标题和简介失败", { error });
      title = `${randomGenre}小说_${Date.now()}`;
      description = "";
    }

    await updateTask(taskId, { 
      title,
      stepProgress: 15 
    });

    await updateTask(taskId, { 
      currentStep: "创建项目",
      stepProgress: 20 
    });

    const project = await prisma.project.create({
      data: {
        title,
        genre: randomGenre,
        description,
        userId: task.userId,
      },
    });

    logger.info("项目创建成功", { projectId: project.id, title });
    await updateTask(taskId, { projectId: project.id, stepProgress: 25 });

    await updateTask(taskId, { 
      currentStep: "生成核心设定",
      stepProgress: 30 
    });

    try {
      await apiFetch(baseUrl, `/api/projects/${project.id}/settings`, {
        keywords: refinedRequirements,
        enableRefineKeywords: true,
      }, cookie, 3, 30000);
      logger.info("核心设定生成成功");
    } catch (error) {
      logger.error("生成核心设定失败", { projectId: project.id, error });
      await updateTask(taskId, { status: "failed", errorMessage: "生成核心设定失败" });
      return;
    }

    await updateTask(taskId, { currentStep: "生成角色", stepProgress: 40 });

    try {
      await apiFetch(baseUrl, `/api/projects/${project.id}/characters/batch-generate`, {
        characterCount: 8,
        clearExisting: false,
      }, cookie, 3, 30000);
      logger.info("角色生成成功");
    } catch (error) {
      logger.warn("生成角色失败，继续执行", { projectId: project.id, error });
    }

    await updateTask(taskId, { currentStep: "生成大纲", stepProgress: 50 });

    let outlineData: { outline?: { structure: any[]; plotPoints?: any[] } } = {};
    try {
      const result = await apiFetch(baseUrl, `/api/projects/${project.id}/outline`, { targetChapters }, cookie, 3, 45000);
      outlineData = result.data;
    } catch (error) {
      logger.error("生成大纲失败", { projectId: project.id, error });
      await updateTask(taskId, { status: "failed", errorMessage: "生成大纲失败" });
      return;
    }

    const outline = outlineData.outline;
    if (!outline?.structure || outline.structure.length === 0) {
      logger.error("大纲结构为空", { projectId: project.id });
      await updateTask(taskId, { status: "failed", errorMessage: "生成大纲结构为空" });
      return;
    }

    await updateTask(taskId, { currentStep: "生成章节", stepProgress: 55 });

    const acts = outline.structure;
    const totalChapters = acts.reduce((sum: number, act: any) => {
      const rangeMatch = act.chapterRange?.match(/第(\d+)-(\d+)章/);
      if (!rangeMatch) return sum;
      return sum + (parseInt(rangeMatch[2]) - parseInt(rangeMatch[1]) + 1);
    }, 0);

    let completedChapters = 0;

    for (const act of acts) {
      if (!act.chapterRange) continue;

      const rangeMatch = act.chapterRange.match(/第(\d+)-(\d+)章/);
      if (!rangeMatch) continue;

      const startChapter = parseInt(rangeMatch[1]);
      const endChapter = parseInt(rangeMatch[2]);

      for (let chapterNumber = startChapter; chapterNumber <= endChapter; chapterNumber++) {
        completedChapters++;
        
        const progress = Math.floor(55 + (completedChapters / totalChapters) * 40);
        await updateTask(taskId, { 
          currentStep: `生成章节 ${chapterNumber}/${totalChapters}`,
          stepProgress: progress,
          completedChapters 
        });

        let success = false;
        for (let retry = 0; retry <= 2; retry++) {
          try {
            await apiFetch(
              baseUrl,
              `/api/projects/${project.id}/chapters`,
              {
                actNumber: act.actNumber,
                chapterNumber,
                wordCount,
                versionCount: 1,
                autoSelectBest: false,
                scoreThreshold: 70,
              },
              cookie,
              3,
              60000
            );
            success = true;
            break;
          } catch (error) {
            if (retry === 2) {
              logger.error(`生成章节 ${chapterNumber} 最终失败`, { error });
            } else {
              const delay = 60000 * Math.pow(2, retry);
              logger.info(`生成章节 ${chapterNumber} 失败，${delay/1000}秒后重试`, { retry });
              await sleep(delay);
            }
          }
        }
      }
    }

    logger.info("项目创建完成", { taskId, projectId: project.id, title, chapterCount: completedChapters });
    await updateTask(taskId, { 
      status: "completed", 
      currentStep: "完成",
      stepProgress: 100,
      completedChapters 
    });

  } catch (error) {
    logger.error("任务执行失败", { taskId, error });
    await updateTask(taskId, { 
      status: "failed", 
      errorMessage: error instanceof Error ? error.message : "未知错误" 
    });
  }
}

export async function startGenerationTask(taskId: string) {
  setImmediate(() => {
    executeGenerationTask(taskId).catch((error) => {
      logger.error("任务执行异常", { taskId, error });
    });
  });
}
