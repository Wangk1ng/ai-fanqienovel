import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateObject, generateText, resolveAIConfig } from "@/lib/ai";
import { buildSettingsPrompt, buildRefineSettingsKeywordsPrompt } from "@/lib/prompts";
import { buildCharacterPlanPrompt } from "@/lib/prompts";
import { buildOutlinePrompt } from "@/lib/prompts";
import { buildChapterSystemPrompt, buildChapterUserPrompt } from "@/lib/prompts";
import { settingsSchema, characterPlanSchema, outlineSchema, chapterSchema, projectGenerateSchema } from "@/lib/schemas";
import { generateObjectFromMessages, inferModelContextLimit } from "@/lib/ai";
import { buildChapterContext, contextToConversationMessages } from "@/lib/context-manager";
import { z } from "zod";

const batchCreateSchema = z.object({
  targetChapters: z.number().min(10).max(10000).optional(),
  wordCount: z.number().min(1000).max(5000).optional(),
});

const HOT_GENRES = [
  "都市", "玄幻", "言情", "穿越", "系统", "末世", "星际", "娱乐圈",
  "甜宠", "虐恋", "总裁", "军婚", "马甲", "大佬", "医妃", "空间",
  "种田", "科举", "病娇", "团宠", "双洁", "快穿", "年代", "星际恋",
];

const EXCLUDED_NAMES = ["林", "晚", "骁", "王", "沈", "烬", "砚", "舟"];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry<T>(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  baseDelay = 30000
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return await response.json();
      }
      
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error || `HTTP ${response.status}`;
      
      if (response.status >= 500 || response.status === 429) {
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          logger.info(`API 请求失败，${delay/1000}秒后重试 (${attempt + 1}/${maxRetries})`, { errorMessage });
          await sleep(delay);
          continue;
        }
      }
      
      throw new Error(errorMessage);
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      const delay = baseDelay * Math.pow(2, attempt);
      logger.info(`请求异常，${delay/1000}秒后重试 (${attempt + 1}/${maxRetries})`, { error });
      await sleep(delay);
    }
  }
  throw new Error("达到最大重试次数");
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

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    const body = await req.json();
    const { targetChapters = 50, wordCount = 2300 } = batchCreateSchema.parse(body);

    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    if (!user) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }

    const aiConfig = resolveAIConfig(null, user);

    logger.info("开始自动生成项目", { userId: session.user.id });

    // 1. 随机选择热门类型并生成创作需求
    const randomGenre = HOT_GENRES[Math.floor(Math.random() * HOT_GENRES.length)];
    
    let generatedData: {
      titles?: Array<{ title: string; reason?: string }>;
      description?: string;
      refinedRequirements?: string;
      usedRequirements?: string;
    };

    try {
      generatedData = await fetchWithRetry(
        "/api/projects/generate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            genre: randomGenre,
            requirements: `从以下热门类型中随机选择创作一个吸引人且大胆的脑洞：${HOT_GENRES.join("、")}。角色姓名不要带有：${EXCLUDED_NAMES.join("、")}`,
            enableRefineRequirements: true,
          }),
        },
        3,
        30000
      );
    } catch (error) {
      logger.error("生成创作方案失败", { error });
      return NextResponse.json({ error: "生成创作方案失败，请重试" }, { status: 500 });
    }

    const title = generatedData.titles?.[0]?.title || `${randomGenre}小说`;
    const description = generatedData.description || "";

    // 2. 创建项目
    const project = await prisma.project.create({
      data: {
        title,
        genre: randomGenre,
        description,
        userId: session.user.id,
      },
    });

    logger.info("项目创建成功", { projectId: project.id, title });

    // 3. 生成核心设定
    try {
      await fetchWithRetry(
        `/api/projects/${project.id}/settings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keywords: generatedData.refinedRequirements || generatedData.usedRequirements || "",
            enableRefineKeywords: true,
          }),
        },
        3,
        30000
      );
    } catch (error) {
      logger.error("生成核心设定失败", { projectId: project.id, error });
      await prisma.project.delete({ where: { id: project.id } });
      return NextResponse.json({ error: "生成核心设定失败" }, { status: 500 });
    }

    // 4. 批量生成角色
    try {
      await fetchWithRetry(
        `/api/projects/${project.id}/characters/batch-generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            characterCount: 8,
            clearExisting: false,
          }),
        },
        3,
        30000
      );
    } catch (error) {
      logger.warn("生成角色失败，继续执行", { projectId: project.id, error });
    }

    // 5. 生成大纲
    let outlineData: { outline?: { structure: any[]; plotPoints?: any[] } };
    try {
      outlineData = await fetchWithRetry(
        `/api/projects/${project.id}/outline`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetChapters }),
        },
        3,
        45000
      );
    } catch (error) {
      logger.error("生成大纲失败", { projectId: project.id, error });
      await prisma.project.delete({ where: { id: project.id } });
      return NextResponse.json({ error: "生成大纲失败" }, { status: 500 });
    }

    const outline = outlineData.outline;
    if (!outline?.structure || outline.structure.length === 0) {
      logger.error("大纲结构为空", { projectId: project.id });
      await prisma.project.delete({ where: { id: project.id } });
      return NextResponse.json({ error: "生成大纲结构为空" }, { status: 500 });
    }

    // 6. 生成章节
    const acts = outline.structure;
    let chapterIndex = 0;
    const maxRetries = 2;

    for (const act of acts) {
      if (!act.chapterRange) continue;
      
      const rangeMatch = act.chapterRange.match(/第(\d+)-(\d+)章/);
      if (!rangeMatch) continue;

      const startChapter = parseInt(rangeMatch[1]);
      const endChapter = parseInt(rangeMatch[2]);

      for (let chapterNumber = startChapter; chapterNumber <= endChapter; chapterNumber++) {
        chapterIndex++;
        
        let success = false;
        for (let retry = 0; retry <= maxRetries; retry++) {
          try {
            const chapterResponse = await fetch(`/api/projects/${project.id}/chapters`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                actNumber: act.actNumber,
                chapterNumber,
                wordCount,
                versionCount: 1,
                autoSelectBest: false,
                scoreThreshold: 70,
              }),
            });

            if (chapterResponse.ok) {
              success = true;
              break;
            }

            const errorData = await chapterResponse.json().catch(() => ({}));
            const errorMsg = errorData.error || `HTTP ${chapterResponse.status}`;
            
            if (chapterResponse.status >= 500 || chapterResponse.status === 429) {
              if (retry < maxRetries) {
                const delay = 60000 * Math.pow(2, retry);
                logger.info(`生成章节 ${chapterNumber} 失败，${delay/1000}秒后重试`, { retry });
                await sleep(delay);
                continue;
              }
            }
            
            throw new Error(errorMsg);
          } catch (error) {
            if (retry === maxRetries) {
              logger.error(`生成章节 ${chapterNumber} 最终失败`, { error });
            }
          }
        }
      }
    }

    logger.info("项目创建完成", { projectId: project.id, title, chapterCount: chapterIndex });

    return NextResponse.json({
      projectId: project.id,
      title: project.title,
      genre: randomGenre,
      chapterCount: chapterIndex,
    });
  } catch (error) {
    logger.error("批量创建项目失败", { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建失败" },
      { status: 500 }
    );
  }
}
