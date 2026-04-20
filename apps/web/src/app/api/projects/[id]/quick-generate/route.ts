import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateObject, generateText, resolveAIConfig } from "@/lib/ai";
import { buildRefineRequirementsPrompt, buildProjectPrompt } from "@/lib/prompts";
import { buildSettingsPrompt, buildRefineSettingsKeywordsPrompt } from "@/lib/prompts";
import { buildCharacterPlanPrompt } from "@/lib/prompts";
import { buildOutlinePrompt } from "@/lib/prompts";
import { buildChapterSystemPrompt, buildChapterUserPrompt } from "@/lib/prompts";
import { projectGenerateSchema, settingsSchema, characterPlanSchema, outlineSchema, chapterSchema } from "@/lib/schemas";
import { createProjectGenerationTask, updateProjectGenerationTask } from "@/lib/project-generation-task";
import { buildChapterContext, contextToConversationMessages, generateChapterSummary } from "@/lib/context-manager";
import { scoreChapter, shouldRewrite, selectBestVersion } from "@/lib/chapter-scorer";
import { z } from "zod";
import { generateObjectFromMessages, inferModelContextLimit } from "@/lib/ai";

const quickGenerateSchema = z.object({
  genre: z.string().min(1, "请选择小说类型"),
  requirements: z.string().min(1, "请输入创作需求"),
  enableRefineRequirements: z.boolean().optional().default(true),
  titleOption: z.object({
    title: z.string(),
    reason: z.string(),
  }).optional(),
  generatedDescription: z.string().optional(),
  keywords: z.string().optional(),
  enableRefineKeywords: z.boolean().optional().default(true),
  targetChapters: z.number().min(10).max(10000).optional(),
  characterCount: z.number().min(3).max(20).optional(),
  wordCount: z.number().min(1000).max(5000).optional(),
  autoGenerateChapters: z.boolean().optional().default(false),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    const { id: projectId } = await params;

    // 验证项目归属
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: session.user.id },
      include: { settings: true },
    });

    if (!project) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    // 检查项目是否已有核心设定
    if (project.settings) {
      return NextResponse.json({ error: "该项目已生成核心设定，无法使用一键生成" }, { status: 400 });
    }

    const body = await req.json();
    const {
      keywords,
      enableRefineKeywords,
      targetChapters,
      characterCount,
      wordCount,
      autoGenerateChapters,
    } = quickGenerateSchema.parse(body);

    // 获取用户配置以确定默认值
    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    const effectiveTargetChapters = targetChapters || user?.defaultTargetChapters || 100;
    const effectiveCharacterCount = characterCount || user?.defaultCharacterCount || 8;
    const effectiveWordCount = wordCount || user?.defaultWordCount || 2300;
    const effectiveAutoGenerateChapters = autoGenerateChapters ?? user?.autoGenerateChapters ?? false;

    // 计算总步骤数
    // 步骤1: 生成核心设定
    // 步骤2: 批量生成角色
    // 步骤3: 生成大纲
    // 步骤4+: 生成章节 (每个章节一步)
    const totalChapterSteps = effectiveAutoGenerateChapters ? effectiveTargetChapters : 0;
    const totalSteps = 3 + totalChapterSteps;

    // 创建任务
    const taskId = `pg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    createProjectGenerationTask({
      id: taskId,
      userId: session.user.id,
      projectId,
      totalSteps,
      totalChapters: effectiveTargetChapters,
    });

    // 启动后台执行
    executeGeneration({
      taskId,
      projectId,
      userId: session.user.id,
      keywords,
      enableRefineKeywords,
      effectiveTargetChapters,
      effectiveCharacterCount,
      effectiveWordCount,
      effectiveAutoGenerateChapters,
      totalSteps,
    });

    return NextResponse.json({
      taskId,
      projectId,
      message: "开始后台生成",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    logger.error("一键生成失败", { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "一键生成失败" },
      { status: 500 }
    );
  }
}

interface GenerationParams {
  taskId: string;
  projectId: string;
  userId: string;
  keywords?: string;
  enableRefineKeywords: boolean;
  effectiveTargetChapters: number;
  effectiveCharacterCount: number;
  effectiveWordCount: number;
  effectiveAutoGenerateChapters: boolean;
  totalSteps: number;
}

function normalizeAge(age: unknown): number | null {
  if (age === null || age === undefined || age === "") return null;
  if (typeof age === "number" && Number.isInteger(age)) return age;
  if (typeof age === "string") {
    const parsed = Number.parseInt(age, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

async function executeGeneration(params: GenerationParams) {
  const {
    taskId,
    projectId,
    userId,
    keywords,
    enableRefineKeywords,
    effectiveTargetChapters,
    effectiveCharacterCount,
    effectiveWordCount,
    effectiveAutoGenerateChapters,
    totalSteps,
  } = params;

  let currentStep = 0;

  try {
    updateProjectGenerationTask(taskId, { status: "running" });

    // ===== 步骤1: 生成核心设定 =====
    currentStep = 1;
    updateProjectGenerationTask(taskId, {
      currentStep,
      currentStepName: "生成核心设定",
    });

    const project = await prisma.project.findFirst({ where: { id: projectId } });
    if (!project) throw new Error("项目不存在");

    const aiConfig = resolveAIConfig(project, await prisma.user.findUnique({ where: { id: userId } }));

    let finalKeywords: string | undefined;
    if (keywords?.trim()) {
      if (enableRefineKeywords) {
        const refinePrompt = buildRefineSettingsKeywordsPrompt({
          title: project.title,
          genre: project.genre,
          description: project.description || undefined,
          keywords: keywords.trim(),
        });
        finalKeywords = await generateText(refinePrompt, { ...aiConfig, temperature: 0.7 });
      } else {
        finalKeywords = keywords.trim();
      }
    }

    const settingsPrompt = buildSettingsPrompt({
      title: project.title,
      genre: project.genre,
      description: project.description || undefined,
      keywords: finalKeywords,
    });

    const parsedSettings = await generateObject(settingsPrompt, settingsSchema, {
      ...aiConfig,
      temperature: 0.8,
    });

    await prisma.projectSettings.upsert({
      where: { projectId },
      update: {
        worldView: parsedSettings.worldView,
        coreConflict: parsedSettings.coreConflict,
        powerSystem: parsedSettings.powerSystem || "",
        factions: parsedSettings.factions || [],
        specialRules: parsedSettings.specialRules || [],
      },
      create: {
        projectId,
        worldView: parsedSettings.worldView,
        coreConflict: parsedSettings.coreConflict,
        powerSystem: parsedSettings.powerSystem || "",
        factions: parsedSettings.factions || [],
        specialRules: parsedSettings.specialRules || [],
      },
    });

    logger.info("一键生成：核心设定完成", { projectId });

    // ===== 步骤2: 批量生成角色 =====
    currentStep = 2;
    updateProjectGenerationTask(taskId, {
      currentStep,
      currentStepName: `生成角色 (${effectiveCharacterCount}个)`,
    });

    const existingCharacters = await prisma.character.findMany({
      where: { projectId },
      select: { name: true, role: true, personality: true, background: true },
    });

    const characterPrompt = buildCharacterPlanPrompt({
      title: project.title,
      genre: project.genre,
      worldView: parsedSettings.worldView,
      coreConflict: parsedSettings.coreConflict,
      characterCount: effectiveCharacterCount,
      existingCharacters,
    });

    const parsedCharacters = await generateObject(characterPrompt, characterPlanSchema, {
      ...aiConfig,
      temperature: 0.8,
    });

    await Promise.all(
      parsedCharacters.characters.map((char) =>
        prisma.character.create({
          data: {
            projectId,
            name: char.name,
            role: char.role,
            age: normalizeAge(char.age),
            gender: char.gender || null,
            appearance: char.appearance || null,
            personality: char.personality || [],
            background: char.background,
            motivation: char.motivation || null,
            strengths: char.strengths || [],
            weaknesses: char.weaknesses || [],
            relationships: parsedCharacters.relationships || [],
          },
        })
      )
    );

    logger.info("一键生成：角色生成完成", { projectId, count: parsedCharacters.characters.length });

    // ===== 步骤3: 生成大纲 =====
    currentStep = 3;
    updateProjectGenerationTask(taskId, {
      currentStep,
      currentStepName: `生成大纲 (${effectiveTargetChapters}章)`,
    });

    const characters = await prisma.character.findMany({
      where: { projectId },
      select: { name: true, role: true, personality: true, background: true },
      orderBy: { createdAt: "asc" },
      take: 30,
    });

    const outlinePrompt = buildOutlinePrompt({
      title: project.title,
      genre: project.genre,
      description: project.description || undefined,
      worldView: parsedSettings.worldView,
      coreConflict: parsedSettings.coreConflict,
      characters,
      targetChapters: effectiveTargetChapters,
    });

    const parsedOutline = await generateObject(outlinePrompt, outlineSchema, {
      ...aiConfig,
      temperature: 0.8,
    });

    const outline = await prisma.outline.upsert({
      where: { projectId },
      update: {
        structure: parsedOutline.acts || [],
        plotPoints: parsedOutline.plotPoints || [],
      },
      create: {
        projectId,
        structure: parsedOutline.acts || [],
        plotPoints: parsedOutline.plotPoints || [],
      },
    });

    await prisma.outlineItem.deleteMany({ where: { outlineId: outline.id } });

    if (parsedOutline.acts && parsedOutline.acts.length > 0) {
      let order = 0;
      for (const act of parsedOutline.acts) {
        if (act.plotSegments && act.plotSegments.length > 0) {
          await Promise.all(
            act.plotSegments.map((segment: any) =>
              prisma.outlineItem.create({
                data: {
                  outlineId: outline.id,
                  chapterNumber: act.actNumber,
                  title: segment.title,
                  summary: segment.summary,
                  keyEvents: segment.keyEvents || [],
                  characters: segment.characters || [],
                  order: order++,
                },
              })
            )
          );
        }
      }
    }

    logger.info("一键生成：大纲生成完成", { projectId });

    // ===== 步骤4+: 生成章节 =====
    if (effectiveAutoGenerateChapters && parsedOutline.acts) {
      let chapterIndex = 0;
      for (const act of parsedOutline.acts) {
        if (!act.chapterRange) continue;
        
        const rangeMatch = act.chapterRange.match(/第(\d+)-(\d+)章/);
        if (!rangeMatch) continue;

        const startChapter = parseInt(rangeMatch[1]);
        const endChapter = parseInt(rangeMatch[2]);

        for (let chapterNumber = startChapter; chapterNumber <= endChapter; chapterNumber++) {
          currentStep = 4 + chapterIndex;
          updateProjectGenerationTask(taskId, {
            currentStep,
            currentStepName: `生成第 ${chapterNumber} 章`,
            currentChapter: chapterNumber,
          });

          try {
            await generateSingleChapter({
              projectId,
              actNumber: act.actNumber,
              chapterNumber,
              wordCount: effectiveWordCount,
              aiConfig,
            });
            updateProjectGenerationTask(taskId, {
              successCount: chapterIndex + 1,
            });
          } catch (err) {
            logger.error(`生成第${chapterNumber}章失败`, { projectId, error: err });
          }

          chapterIndex++;
        }
      }
    }

    updateProjectGenerationTask(taskId, { status: "completed" });
    logger.info("一键生成：全部完成", { projectId });
  } catch (error) {
    logger.error("一键生成失败", { taskId, projectId, error });
    updateProjectGenerationTask(taskId, {
      status: "failed",
      error: error instanceof Error ? error.message : "生成失败",
    });
  }
}

interface GenerateChapterParams {
  projectId: string;
  actNumber: number;
  chapterNumber: number;
  wordCount: number;
  aiConfig: any;
}

async function generateSingleChapter(params: GenerateChapterParams) {
  const { projectId, actNumber, chapterNumber, wordCount, aiConfig } = params;

  const project = await prisma.project.findFirst({
    where: { id: projectId },
    include: { settings: true },
  });
  if (!project?.settings) throw new Error("项目设定不存在");

  const outline = await prisma.outline.findUnique({
    where: { projectId },
    include: { items: { orderBy: { order: "asc" } } },
  });
  if (!outline) throw new Error("大纲不存在");

  const acts = outline.structure as any[];
  const act = acts.find((a: any) => a.actNumber === actNumber);
  if (!act) throw new Error(`幕 ${actNumber} 不存在`);

  let chapterSummary = "";
  if (act.plotSegments && act.plotSegments.length > 0) {
    for (const segment of act.plotSegments) {
      if (segment.chapterRange) {
        const match = segment.chapterRange.match(/第(\d+)-(\d+)章/);
        if (match) {
          const start = parseInt(match[1]);
          const end = parseInt(match[2]);
          if (chapterNumber >= start && chapterNumber <= end) {
            chapterSummary = `${segment.title}\n${segment.summary}`;
            break;
          }
        }
      }
    }
  }
  if (!chapterSummary) {
    chapterSummary = act.description || act.summary || "";
  }

  const existingChapter = await prisma.chapter.findFirst({
    where: { projectId, chapterNumber },
    select: { id: true },
  });
  if (existingChapter) return;

  const characters = await prisma.character.findMany({
    where: { projectId },
    select: { name: true, role: true, personality: true, motivation: true, background: true },
    orderBy: { createdAt: "asc" },
    take: 40,
  });

  const context = await buildChapterContext({
    projectId,
    chapterNumber,
    maxTokens: 150000,
  });

  const historyMessages = contextToConversationMessages(context);

  const systemPrompt = buildChapterSystemPrompt({
    title: project.title,
    genre: project.genre,
    description: project.description || undefined,
    worldView: project.settings.worldView,
    coreConflict: project.settings.coreConflict,
    powerSystem: project.settings.powerSystem || undefined,
    outlineContext: chapterSummary,
    characters,
  });

  const userPrompt = buildChapterUserPrompt({
    chapterNumber,
    chapterGoal: chapterSummary,
    wordCount,
  });

  const parsed = await generateObjectFromMessages(
    [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user", content: userPrompt },
    ],
    chapterSchema,
    { ...aiConfig, temperature: 0.8 }
  );

  await prisma.chapter.create({
    data: {
      projectId,
      chapterNumber,
      title: parsed.title,
      content: parsed.content,
      wordCount: parsed.content.length,
      status: "draft",
    },
  });

  logger.info("章节生成成功", { projectId, chapterNumber });
}
