import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface TokenStats {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  periodStart: Date;
  periodEnd: Date;
  remainingTokens: number;
  remainingPercent: number;
}

export interface TokenConfig {
  enabled: boolean;
  tokenThreshold: number;
  models: string[];
  currentModelIndex: number;
}

function getBeijingTime(): Date {
  const now = new Date();
  const beijingOffset = 8 * 60; // 北京时间 UTC+8
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + (beijingOffset * 60000));
}

function getCurrentPeriod(): { start: Date; end: Date } {
  const beijingNow = getBeijingTime();
  const utc8Hours = 8 * 60 * 60 * 1000;
  
  let todayNoon = new Date(beijingNow);
  todayNoon.setHours(12, 0, 0, 0);
  
  if (beijingNow.getTime() < todayNoon.getTime()) {
    todayNoon = new Date(todayNoon.getTime() - 24 * 60 * 60 * 1000);
  }
  
  const periodStart = new Date(todayNoon.getTime() - utc8Hours);
  const periodEnd = new Date(todayNoon.getTime() + 24 * 60 * 60 * 1000 - utc8Hours);
  
  return { start: periodStart, end: periodEnd };
}

export async function getTokenSettings(userId: string): Promise<TokenConfig> {
  let settings = await prisma.tokenSettings.findUnique({
    where: { userId },
  });

  if (!settings) {
    settings = await prisma.tokenSettings.create({
      data: { userId },
    });
  }

  const models = settings.models 
    ? settings.models.split(",").map(m => m.trim()).filter(Boolean)
    : [];

  return {
    enabled: settings.enabled,
    tokenThreshold: settings.tokenThreshold,
    models,
    currentModelIndex: settings.currentModelIndex,
  };
}

export async function updateTokenSettings(
  userId: string,
  updates: {
    enabled?: boolean;
    tokenThreshold?: number;
    models?: string;
  }
): Promise<void> {
  await prisma.tokenSettings.upsert({
    where: { userId },
    update: updates,
    create: { userId, ...updates },
  });
}

export async function getTokenStats(userId: string): Promise<TokenStats> {
  const { start, end } = getCurrentPeriod();
  
  const result = await prisma.tokenUsage.aggregate({
    where: {
      userId,
      periodStart: { gte: start },
      periodEnd: { lt: end },
    },
    _sum: {
      totalTokens: true,
      promptTokens: true,
      completionTokens: true,
      cost: true,
    },
  });

  const totalTokens = result._sum.totalTokens || 0;
  const settings = await getTokenSettings(userId);
  const remainingTokens = Math.max(0, settings.tokenThreshold - totalTokens);
  const remainingPercent = settings.tokenThreshold > 0 
    ? (remainingTokens / settings.tokenThreshold) * 100 
    : 0;

  return {
    totalTokens,
    promptTokens: result._sum.promptTokens || 0,
    completionTokens: result._sum.completionTokens || 0,
    cost: result._sum.cost || 0,
    periodStart: start,
    periodEnd: end,
    remainingTokens,
    remainingPercent,
  };
}

export async function recordTokenUsage(
  userId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cost: number = 0
): Promise<void> {
  const { start, end } = getCurrentPeriod();
  
  await prisma.tokenUsage.create({
    data: {
      userId,
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cost,
      periodStart: start,
      periodEnd: end,
    },
  });

  logger.info("记录token使用", { userId, model, promptTokens, completionTokens, cost });
}

export async function checkAndResetIfNeeded(userId: string): Promise<boolean> {
  const settings = await prisma.tokenSettings.findUnique({
    where: { userId },
  });

  if (!settings) return false;

  const { start, end } = getCurrentPeriod();
  const lastReset = new Date(settings.lastResetAt);
  
  if (lastReset < start) {
    await prisma.tokenSettings.update({
      where: { userId },
      data: { 
        lastResetAt: start,
        currentModelIndex: 0,
      },
    });

    logger.info("Token周期重置", { userId, newPeriodStart: start });
    return true;
  }

  return false;
}

export async function shouldSwitchModel(userId: string): Promise<boolean> {
  const stats = await getTokenStats(userId);
  const settings = await getTokenSettings(userId);
  
  if (!settings.enabled) return false;
  
  return stats.totalTokens >= settings.tokenThreshold;
}

export async function getNextModel(userId: string): Promise<{ model: string; index: number } | null> {
  const settings = await getTokenSettings(userId);
  
  if (!settings.enabled || settings.models.length === 0) {
    return null;
  }

  const nextIndex = (settings.currentModelIndex + 1) % settings.models.length;
  const nextModel = settings.models[nextIndex];

  await prisma.tokenSettings.update({
    where: { userId },
    data: { currentModelIndex: nextIndex },
  });

  logger.info("切换到下一个模型", { 
    userId, 
    previousIndex: settings.currentModelIndex, 
    newIndex: nextIndex, 
    model: nextModel 
  });

  return { model: nextModel, index: nextIndex };
}

export async function isTokenExhausted(userId: string): Promise<boolean> {
  const settings = await getTokenSettings(userId);
  
  if (!settings.enabled) return false;

  const stats = await getTokenStats(userId);
  return stats.totalTokens >= settings.tokenThreshold;
}

export async function getCurrentModel(userId: string): Promise<string | null> {
  const settings = await getTokenSettings(userId);
  
  if (!settings.enabled || settings.models.length === 0) {
    return null;
  }

  return settings.models[settings.currentModelIndex] || null;
}
