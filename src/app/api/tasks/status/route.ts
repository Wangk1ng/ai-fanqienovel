import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get("taskId");

    if (taskId) {
    const task = await prisma.generationTask.findUnique({
      where: { id: taskId },
    });

      if (!task) {
        return NextResponse.json({ error: "任务不存在" }, { status: 404 });
      }

      if (task.userId !== session.user.id) {
        return NextResponse.json({ error: "无权访问此任务" }, { status: 403 });
      }

      return NextResponse.json({
        taskId: task.id,
        status: task.status,
        currentStep: task.currentStep,
        stepProgress: task.stepProgress,
        totalSteps: task.totalSteps,
        targetChapters: task.targetChapters,
        wordCount: task.wordCount,
        completedChapters: task.completedChapters,
        genre: task.genre,
        title: task.title,
        projectId: task.projectId,
        errorMessage: task.errorMessage,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    }

    const tasks = await prisma.generationTask.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    return NextResponse.json({
      tasks: tasks.map((task) => ({
        taskId: task.id,
        status: task.status,
        currentStep: task.currentStep,
        stepProgress: task.stepProgress,
        totalSteps: task.totalSteps,
        targetChapters: task.targetChapters,
        wordCount: task.wordCount,
        completedChapters: task.completedChapters,
        genre: task.genre,
        title: task.title,
        projectId: task.projectId,
        errorMessage: task.errorMessage,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "查询失败" },
      { status: 500 }
    );
  }
}
