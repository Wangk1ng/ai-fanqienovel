import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startGenerationTask } from "@/lib/background-task";
import { z } from "zod";

const batchCreateSchema = z.object({
  targetChapters: z.number().min(10).max(10000).optional().default(15),
  wordCount: z.number().min(1000).max(5000).optional().default(1000),
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    const body = await req.json();
    const { targetChapters = 15, wordCount = 1000 } = batchCreateSchema.parse(body);

    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    if (!user) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }

    logger.info("创建批量生成任务", { userId: session.user.id, targetChapters, wordCount });

    const task = await prisma.generationTask.create({
      data: {
        userId: session.user.id,
        status: "pending",
        currentStep: "等待开始",
        stepProgress: 0,
        totalSteps: 5,
        targetChapters,
        wordCount,
        completedChapters: 0,
      },
    });

    startGenerationTask(task.id);

    return NextResponse.json({
      taskId: task.id,
      status: "pending",
      message: "任务已创建，正在后台执行",
    });
  } catch (error) {
    logger.error("创建任务失败", { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建失败" },
      { status: 500 }
    );
  }
}
