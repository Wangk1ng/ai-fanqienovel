#!/usr/bin/env node

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const CHECK_INTERVAL = 10 * 60 * 1000;

async function getTokenStats(userId) {
  const now = new Date();
  const utc8Hours = 8 * 60 * 60 * 1000;
  
  let todayNoon = new Date(now);
  todayNoon.setHours(12, 0, 0, 0);
  
  if (now.getTime() < todayNoon.getTime()) {
    todayNoon = new Date(todayNoon.getTime() - 24 * 60 * 60 * 1000);
  }
  
  const periodStart = new Date(todayNoon.getTime() - utc8Hours);
  const periodEnd = new Date(todayNoon.getTime() + 24 * 60 * 60 * 1000 - utc8Hours);

  const settings = await prisma.tokenSettings.findUnique({ where: { userId } });
  const result = await prisma.tokenUsage.aggregate({
    where: {
      userId,
      periodStart: { gte: periodStart },
      periodEnd: { lt: periodEnd },
    },
    _sum: { totalTokens: true },
  });

  const totalTokens = result._sum.totalTokens || 0;
  const threshold = settings?.tokenThreshold || 5000000;

  return {
    totalTokens,
    remainingTokens: Math.max(0, threshold - totalTokens),
    threshold,
    settings,
  };
}

async function checkAndStartTasks() {
  try {
    const activeTasks = await prisma.generationTask.findMany({
      where: {
        status: { in: ["pending", "running"] },
      },
      select: { userId: true },
      distinct: ["userId"],
    });

    if (activeTasks.length === 0) {
      const usersWithTokenControl = await prisma.tokenSettings.findMany({
        where: { enabled: true },
        select: { userId: true },
      });

      if (usersWithTokenControl.length > 0) {
        console.log(`[${new Date().toISOString()}] 检查 ${usersWithTokenControl.length} 个用户的 token 控制`);

        for (const { userId } of usersWithTokenControl) {
          const stats = await getTokenStats(userId);
          if (stats.remainingTokens > 0) {
            console.log(`[${new Date().toISOString()}] 用户 ${userId} 还有 ${stats.remainingTokens} token，将启动后台任务`);
            
            const { startTokenControlledGeneration } = require("/workspace/src/lib/background-task");
            startTokenControlledGeneration(userId);
          } else {
            console.log(`[${new Date().toISOString()}] 用户 ${userId} token 已用尽`);
          }
        }
      }
    } else {
      console.log(`[${new Date().toISOString()}] 有 ${activeTasks.length} 个活动任务在运行`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 检查任务失败:`, error);
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Token Monitor 启动`);
  
  while (true) {
    await checkAndStartTasks();
    await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
  }
}

main().catch(console.error);
