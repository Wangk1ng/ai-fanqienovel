import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getProjectGenerationTask } from "@/lib/project-generation-task";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get("taskId");

    if (!taskId) {
      return NextResponse.json({ error: "缺少 taskId 参数" }, { status: 400 });
    }

    const task = getProjectGenerationTask(taskId);

    if (!task) {
      return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });
    }

    if (task.userId !== session.user.id) {
      return NextResponse.json({ error: "无权访问该任务" }, { status: 403 });
    }

    return NextResponse.json({ task });
  } catch (error) {
    return NextResponse.json({ error: "获取任务状态失败" }, { status: 500 });
  }
}
