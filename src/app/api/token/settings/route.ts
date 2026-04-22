import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { getTokenSettings, updateTokenSettings, getTokenStats } from "@/lib/token-manager";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    const settings = await getTokenSettings(session.user.id);
    const stats = await getTokenStats(session.user.id);

    return NextResponse.json({
      settings: {
        ...settings,
        models: settings.models.join(","),
      },
      stats,
    });
  } catch (error) {
    logger.error("获取 token 设置失败", { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取失败" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    const body = await req.json();
    const { enabled, tokenThreshold, models } = body;

    await updateTokenSettings(session.user.id, {
      enabled,
      tokenThreshold: tokenThreshold ? parseInt(tokenThreshold) : undefined,
      models,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("更新 token 设置失败", { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "更新失败" },
      { status: 500 }
    );
  }
}
