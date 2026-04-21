import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { startTokenControlledGeneration } from "@/lib/background-task";

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    logger.info("手动触发 token 控制模式", { userId: session.user.id });

    startTokenControlledGeneration(session.user.id);

    return NextResponse.json({ success: true, message: "Token 控制模式已启动" });
  } catch (error) {
    logger.error("启动 token 控制模式失败", { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "启动失败" },
      { status: 500 }
    );
  }
}
