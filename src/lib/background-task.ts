import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { generateObject, generateText, resolveAIConfig } from "@/lib/ai";
import { buildRefineRequirementsPrompt, buildProjectPrompt } from "@/lib/prompts";
import { projectGenerateSchema } from "@/lib/schemas";
import { z } from "zod";

const HOT_GENRES = [
  "都市", "玄幻", "言情", "穿越", "系统", "末世", "星际", "娱乐圈",
  "甜宠", "虐恋", "总裁", "军婚", "马甲", "大佬", "医妃", "空间",
  "种田", "科举", "病娇", "团宠", "双洁", "快穿", "年代", "星际恋",
];

const EXCLUDED_NAMES = ["林", "晚", "骁", "王", "沈", "烬", "砚", "舟"];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function generateSettings(projectId: string, keywords: string, aiConfig: any) {
  const refinedPrompt = `你是一位资深的网络小说世界观架构师。用户想为小说生成核心设定，但他输入的关键词可能很简短、零碎甚至混杂。请先准确理解其意图，再把这些关键词升级为可直接用于创作的"设定需求说明"。

关键词：${keywords}

请输出优化后的设定需求（纯文本，不要 JSON，不要 markdown），包含以下要素：
1. 世界观：故事发生的世界是什么样的
2. 核心冲突：主要矛盾和驱动力
3. 力量体系：如果有特殊能力或系统，描述其规则
4. 主要势力：故事中的主要组织或派系

要求：
- 保留关键词中的所有关键信息
- 对模糊部分进行合理补充
- 风格要符合网络小说的常见套路`;

  const refinedKeywords = await generateWithRetry(async () => {
    return generateText(refinedPrompt, { ...aiConfig, temperature: 0.7 });
  }, 3, 30000);

  const settingsPrompt = `你是一位资深的网络小说世界观架构师。请根据以下设定需求，为小说生成核心设定。

设定需求：
${refinedKeywords}

请严格按照以下 JSON 格式输出（不要包含 markdown 代码块标记）：
{
  "worldView": "世界观描述（100-200字）",
  "coreConflict": "核心冲突描述（50-100字）",
  "powerSystem": "力量体系描述（可选，50-100字）",
  "factions": [{"name": "势力名称", "description": "势力描述", "alignment": "善/中立/恶"}],
  "specialRules": ["特殊规则1", "特殊规则2"]
}`;

  const parsed = await generateWithRetry(async () => {
    return generateObject(settingsPrompt, z.object({
      worldView: z.string(),
      coreConflict: z.string(),
      powerSystem: z.string().optional(),
      factions: z.array(z.object({
        name: z.string(),
        description: z.string(),
        alignment: z.string(),
      })),
      specialRules: z.array(z.string()),
    }), { ...aiConfig, temperature: 0.7 });
  }, 3, 30000);

  await prisma.projectSettings.create({
    data: {
      projectId,
      worldView: parsed.worldView,
      coreConflict: parsed.coreConflict,
      powerSystem: parsed.powerSystem || "",
      factions: parsed.factions,
      specialRules: parsed.specialRules,
    },
  });
}

async function generateCharacters(projectId: string, aiConfig: any) {
  const existingCharacters = await prisma.character.findMany({
    where: { projectId },
    select: { name: true, role: true, personality: true, background: true },
  });

  const prompt = `你是一位资深的网络小说角色设计师。请为一个 ${existingCharacters.length > 0 ? "已有角色的" : "新建的"}网络小说生成角色体系。

${existingCharacters.length > 0 ? "已有角色：" : ""}
${existingCharacters.map(c => `- ${c.name}（${c.role}）：${c.personality.join("、")}`).join("\n")}

请生成 8 个角色，严格按照以下 JSON 格式输出（不要包含 markdown 代码块标记）：
{
  "characters": [
    {
      "name": "角色姓名",
      "role": "protagonist/antagonist/supporting",
      "age": 25,
      "gender": "男/女",
      "appearance": "外貌描述（50-100字）",
      "personality": ["性格特点1", "性格特点2"],
      "background": "角色背景故事（100-150字）",
      "motivation": "角色动机（20-50字）",
      "strengths": ["优势1", "优势2"],
      "weaknesses": ["劣势1", "劣势2"]
    }
  ]
}

要求：
1. 主角要有成长空间，配角要有记忆点
2. 主角和反派要有明确的冲突动机
3. 主角需要至少3个配角形成有效互动
4. 人物关系要有戏剧张力`;

  const parsed = await generateWithRetry(async () => {
    return generateObject(prompt, z.object({
      characters: z.array(z.object({
        name: z.string(),
        role: z.string(),
        age: z.number().optional(),
        gender: z.string(),
        appearance: z.string().optional(),
        personality: z.array(z.string()),
        background: z.string(),
        motivation: z.string().optional(),
        strengths: z.array(z.string()),
        weaknesses: z.array(z.string()),
      })),
    }), { ...aiConfig, temperature: 0.8 });
  }, 3, 30000);

  for (const char of parsed.characters) {
    await prisma.character.create({
      data: {
        projectId,
        name: char.name,
        role: char.role,
        age: char.age,
        gender: char.gender,
        appearance: char.appearance || "",
        personality: char.personality,
        background: char.background,
        motivation: char.motivation || "",
        strengths: char.strengths,
        weaknesses: char.weaknesses,
      },
    });
  }
}

async function generateOutline(projectId: string, targetChapters: number, aiConfig: any) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const settings = await prisma.projectSettings.findUnique({ where: { projectId } });
  const characters = await prisma.character.findMany({ where: { projectId } });

  if (!project || !settings) {
    throw new Error("项目或设置不存在");
  }

  const charDescriptions = characters.map(c => 
    `${c.name}（${c.role}）：${c.personality.join("、")}，${c.background.slice(0, 50)}`
  ).join("\n");

  // 生成大纲时使用较少章节数，避免 JSON 过大导致截断
  const outlineChapters = Math.min(targetChapters, 50);

  const prompt = `你是一位资深的网络小说大纲设计师。请为小说《${project.title}》生成完整的大纲。

类型：${project.genre}
简介：${project.description || "无"}

世界观：${settings.worldView}
核心冲突：${settings.coreConflict}
${settings.powerSystem ? `力量体系：${settings.powerSystem}` : ""}

角色体系：
${charDescriptions}

目标章节数：${outlineChapters}

请生成 ${outlineChapters} 章节的大纲，严格按照以下 JSON 格式输出：
{
  "structure": [
    {
      "actNumber": 1,
      "actName": "第一幕名称",
      "chapterRange": "第1-${Math.ceil(outlineChapters / 3)}章",
      "summary": "本幕概述（100-150字）",
      "plotPoints": ["关键情节点1", "关键情节点2"]
    }
  ],
  "plotPoints": [
    {
      "chapterNumber": 1,
      "title": "章节标题",
      "summary": "章节摘要（50-80字）",
      "keyEvents": ["关键事件1", "关键事件2"],
      "characters": ["涉及的角色名"]
    }
  ]
}

要求：
1. 大纲要有起承转合，情节要有起伏
2. 每幕要有明确的主题和目标
3. 章节之间要有逻辑递进关系`;

  const parsed = await generateWithRetry(async () => {
    return generateObject(prompt, z.object({
      structure: z.array(z.object({
        actNumber: z.number(),
        actName: z.string(),
        chapterRange: z.string(),
        summary: z.string(),
        plotPoints: z.array(z.string()),
      })),
      plotPoints: z.array(z.object({
        chapterNumber: z.number(),
        title: z.string(),
        summary: z.string(),
        keyEvents: z.array(z.string()),
        characters: z.array(z.string()),
      })),
    }), { ...aiConfig, temperature: 0.8 });
  }, 3, 45000);

  await prisma.outline.create({
    data: {
      projectId,
      structure: parsed.structure,
      plotPoints: parsed.plotPoints,
    },
  });

  for (const point of parsed.plotPoints) {
    const outline = await prisma.outline.findUnique({ where: { projectId } });
    if (outline) {
      await prisma.outlineItem.create({
        data: {
          outlineId: outline.id,
          chapterNumber: point.chapterNumber,
          title: point.title,
          summary: point.summary,
          keyEvents: point.keyEvents,
          characters: point.characters,
          order: point.chapterNumber,
        },
      });
    }
  }

  return parsed;
}

async function generateChapter(
  projectId: string,
  actNumber: number,
  chapterNumber: number,
  wordCount: number,
  aiConfig: any
) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const settings = await prisma.projectSettings.findUnique({ where: { projectId } });
  const characters = await prisma.character.findMany({ where: { projectId } });
  const outline = await prisma.outline.findUnique({ where: { projectId } });
  const outlineItem = await prisma.outlineItem.findFirst({
    where: { outlineId: outline?.id, chapterNumber },
  });

  if (!project || !settings) {
    throw new Error("项目或设置不存在");
  }
  
  const previousChapter = await prisma.chapter.findFirst({
    where: { projectId, chapterNumber: chapterNumber - 1 },
    orderBy: { chapterNumber: "desc" },
  });
  
  const charDescriptions = characters.map(c => 
    `${c.name}：${c.background.slice(0, 80)}`
  ).join("\n");

  const prompt = `你是一位专业的网络小说作家。请根据以下信息，为小说《${project.title}》生成第 ${chapterNumber} 章的内容。

类型：${project.genre}
世界观：${settings.worldView}
核心冲突：${settings.coreConflict}
${settings.powerSystem ? `力量体系：${settings.powerSystem}` : ""}

角色体系：
${charDescriptions}

${outlineItem ? `章节概要：${outlineItem.summary}\n关键情节点：${outlineItem.keyEvents.join("、")}` : ""}

${previousChapter ? `【上一章结尾】${previousChapter.content?.slice(-500) || ""}` : ""}

目标字数：${wordCount}+ 字

请直接输出章节内容，不要包含任何 JSON 或其他格式标记。`;

  const content = await generateWithRetry(async () => {
    return generateText(prompt, { ...aiConfig, temperature: 0.8 });
  }, 3, 60000);

  await prisma.chapter.create({
    data: {
      projectId,
      chapterNumber,
      title: outlineItem?.title || `第${chapterNumber}章`,
      content,
      summary: outlineItem?.summary || "",
      wordCount: content.length,
      status: "completed",
    },
  });
}

export async function executeGenerationTask(taskId: string) {
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

  const { targetChapters, firstBatchChapters, wordCount } = task;
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
      await generateSettings(project.id, refinedRequirements, aiConfig);
      logger.info("核心设定生成成功");
    } catch (error) {
      logger.error("生成核心设定失败", { projectId: project.id, error });
      await updateTask(taskId, { status: "failed", errorMessage: "生成核心设定失败" });
      return;
    }

    await updateTask(taskId, { currentStep: "生成角色", stepProgress: 40 });

    try {
      await generateCharacters(project.id, aiConfig);
      logger.info("角色生成成功");
    } catch (error) {
      logger.warn("生成角色失败，继续执行", { projectId: project.id, error });
    }

    await updateTask(taskId, { currentStep: "生成大纲", stepProgress: 50 });

    let outlineData;
    try {
      outlineData = await generateOutline(project.id, targetChapters, aiConfig);
    } catch (error) {
      logger.error("生成大纲失败", { projectId: project.id, error });
      await updateTask(taskId, { status: "failed", errorMessage: "生成大纲失败" });
      return;
    }

    const outline = outlineData.structure;
    if (!outline || outline.length === 0) {
      logger.error("大纲结构为空", { projectId: project.id });
      await updateTask(taskId, { status: "failed", errorMessage: "生成大纲结构为空" });
      return;
    }

    await updateTask(taskId, { currentStep: "生成章节", stepProgress: 55 });

    let completedChapters = 0;

    for (const act of outline) {
      if (!act.chapterRange) continue;

      const rangeMatch = act.chapterRange.match(/第(\d+)-(\d+)章/);
      if (!rangeMatch) continue;

      const startChapter = parseInt(rangeMatch[1]);
      const endChapter = parseInt(rangeMatch[2]);

      for (let chapterNumber = startChapter; chapterNumber <= endChapter; chapterNumber++) {
        if (completedChapters >= firstBatchChapters) {
          logger.info("首批章节生成完成", { completedChapters, firstBatchChapters });
          break;
        }
        
        completedChapters++;

        const progress = Math.floor(55 + (completedChapters / firstBatchChapters) * 40);
        await updateTask(taskId, {
          currentStep: `生成章节 ${chapterNumber}/${firstBatchChapters}`,
          stepProgress: progress,
          completedChapters
        });

        let success = false;
        for (let retry = 0; retry <= 2; retry++) {
          try {
            await generateChapter(project.id, act.actNumber, chapterNumber, wordCount, aiConfig);
            success = true;
            break;
          } catch (error) {
            if (retry === 2) {
              logger.error(`生成章节 ${chapterNumber} 最终失败`, { error });
            } else {
              const delay = 60000 * Math.pow(2, retry);
              logger.info(`生成章节 ${chapterNumber} 失败，${delay / 1000}秒后重试`, { retry });
              await sleep(delay);
            }
          }
        }
      }
      if (completedChapters >= firstBatchChapters) {
        break;
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
