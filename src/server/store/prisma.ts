// PostgreSQL store via Prisma. Selected with STORAGE_DRIVER=prisma.
// Settings and account cash live in app_settings (JSON values); everything
// else maps 1:1 to its table.

import { DEFAULT_SETTINGS } from "@/lib/constants";
import type {
  AppSettings,
  AuditEventRecord,
  FillRecord,
  LiveOrderIntent,
  PaperOrder,
  PositionRecord,
  SignalResult,
  TerminalMode,
} from "@/lib/types";
import type {
  AccountState,
  AuditFilter,
  PortfolioSnapshotRecord,
  Store,
} from "./types";

type PrismaClientT = import("@prisma/client").PrismaClient;

export class PrismaStore implements Store {
  constructor(private prisma: PrismaClientT) {}

  static async create(): Promise<PrismaStore> {
    const { PrismaClient } = await import("@prisma/client");
    return new PrismaStore(new PrismaClient());
  }

  private async getJsonSetting<T>(key: string): Promise<T | undefined> {
    const row = await this.prisma.appSetting.findFirst({
      where: { key, userId: null },
    });
    return row ? (row.value as T) : undefined;
  }

  private async setJsonSetting(key: string, value: unknown): Promise<void> {
    const row = await this.prisma.appSetting.findFirst({
      where: { key, userId: null },
    });
    if (row) {
      await this.prisma.appSetting.update({
        where: { id: row.id },
        data: { value: value as object },
      });
    } else {
      await this.prisma.appSetting.create({
        data: { key, value: value as object },
      });
    }
  }

  async getSettings(): Promise<AppSettings> {
    const stored = await this.getJsonSetting<Partial<AppSettings>>("app_settings");
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  async patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const stored =
      (await this.getJsonSetting<Partial<AppSettings>>("app_settings")) ?? {};
    const next = { ...stored, ...patch };
    await this.setJsonSetting("app_settings", next);
    return { ...DEFAULT_SETTINGS, ...next };
  }

  // ── orders ────────────────────────────────────────────────────────────────

  private orderToDb(o: PaperOrder) {
    return {
      mode: o.mode,
      conditionId: o.conditionId ?? null,
      tokenId: o.tokenId,
      outcome: o.outcome ?? null,
      marketTitle: o.marketTitle ?? null,
      category: o.category ?? null,
      side: o.side,
      orderType: o.orderType,
      price: o.price,
      size: o.size,
      filledSize: o.filledSize,
      avgFillPrice: o.avgFillPrice ?? null,
      status: o.status,
      signalId: o.signalId ?? null,
      reason: o.reason ?? null,
      expiresAt: o.expiresAt ? new Date(o.expiresAt) : null,
    };
  }

  private orderFromDb(r: {
    id: string;
    mode: string;
    conditionId: string | null;
    tokenId: string;
    outcome: string | null;
    marketTitle: string | null;
    category: string | null;
    side: string;
    orderType: string;
    price: number;
    size: number;
    filledSize: number;
    avgFillPrice: number | null;
    status: string;
    signalId: string | null;
    reason: string | null;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date | null;
  }): PaperOrder {
    return {
      id: r.id,
      mode: r.mode as PaperOrder["mode"],
      conditionId: r.conditionId ?? undefined,
      tokenId: r.tokenId,
      outcome: r.outcome ?? undefined,
      marketTitle: r.marketTitle ?? undefined,
      category: r.category ?? undefined,
      side: r.side as PaperOrder["side"],
      orderType: r.orderType as PaperOrder["orderType"],
      price: r.price,
      size: r.size,
      filledSize: r.filledSize,
      avgFillPrice: r.avgFillPrice ?? undefined,
      status: r.status as PaperOrder["status"],
      signalId: r.signalId ?? undefined,
      reason: r.reason ?? undefined,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
      expiresAt: r.expiresAt?.getTime(),
    };
  }

  async createOrder(order: PaperOrder): Promise<PaperOrder> {
    await this.prisma.paperOrder.create({
      data: { id: order.id, createdAt: new Date(order.createdAt), ...this.orderToDb(order) },
    });
    return order;
  }

  async updateOrder(order: PaperOrder): Promise<PaperOrder> {
    await this.prisma.paperOrder.update({
      where: { id: order.id },
      data: this.orderToDb(order),
    });
    return order;
  }

  async getOrder(id: string): Promise<PaperOrder | undefined> {
    const r = await this.prisma.paperOrder.findUnique({ where: { id } });
    return r ? this.orderFromDb(r) : undefined;
  }

  async listOrders(mode?: string, status?: string[]): Promise<PaperOrder[]> {
    const rows = await this.prisma.paperOrder.findMany({
      where: {
        ...(mode ? { mode } : {}),
        ...(status ? { status: { in: status } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return rows.map((r) => this.orderFromDb(r));
  }

  // ── live intents ──────────────────────────────────────────────────────────

  async createIntent(intent: LiveOrderIntent): Promise<LiveOrderIntent> {
    await this.prisma.liveOrderIntent.create({
      data: {
        id: intent.id,
        conditionId: intent.conditionId ?? null,
        tokenId: intent.tokenId,
        outcome: intent.outcome ?? null,
        marketTitle: intent.marketTitle ?? null,
        side: intent.side,
        orderType: intent.orderType,
        price: intent.price,
        size: intent.size,
        filledSize: intent.filledSize,
        status: intent.status,
        confirmationText: intent.confirmationText ?? null,
        approvedAt: intent.approvedAt ? new Date(intent.approvedAt) : null,
        clobOrderId: intent.clobOrderId ?? null,
        error: intent.error ?? null,
        createdAt: new Date(intent.createdAt),
        expiresAt: intent.expiresAt ? new Date(intent.expiresAt) : null,
      },
    });
    return intent;
  }

  async updateIntent(intent: LiveOrderIntent): Promise<LiveOrderIntent> {
    await this.prisma.liveOrderIntent.update({
      where: { id: intent.id },
      data: {
        status: intent.status,
        filledSize: intent.filledSize,
        confirmationText: intent.confirmationText ?? null,
        approvedAt: intent.approvedAt ? new Date(intent.approvedAt) : null,
        clobOrderId: intent.clobOrderId ?? null,
        error: intent.error ?? null,
      },
    });
    return intent;
  }

  private intentFromDb(r: {
    id: string;
    conditionId: string | null;
    tokenId: string;
    outcome: string | null;
    marketTitle: string | null;
    side: string;
    orderType: string;
    price: number;
    size: number;
    filledSize: number;
    status: string;
    confirmationText: string | null;
    approvedAt: Date | null;
    clobOrderId: string | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date | null;
  }): LiveOrderIntent {
    return {
      id: r.id,
      conditionId: r.conditionId ?? undefined,
      tokenId: r.tokenId,
      outcome: r.outcome ?? undefined,
      marketTitle: r.marketTitle ?? undefined,
      side: r.side as LiveOrderIntent["side"],
      orderType: r.orderType as LiveOrderIntent["orderType"],
      price: r.price,
      size: r.size,
      filledSize: r.filledSize,
      status: r.status as LiveOrderIntent["status"],
      confirmationText: r.confirmationText ?? undefined,
      approvedAt: r.approvedAt?.getTime(),
      clobOrderId: r.clobOrderId ?? undefined,
      error: r.error ?? undefined,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
      expiresAt: r.expiresAt?.getTime(),
    };
  }

  async getIntent(id: string): Promise<LiveOrderIntent | undefined> {
    const r = await this.prisma.liveOrderIntent.findUnique({ where: { id } });
    return r ? this.intentFromDb(r) : undefined;
  }

  async listIntents(status?: string[]): Promise<LiveOrderIntent[]> {
    const rows = await this.prisma.liveOrderIntent.findMany({
      where: status ? { status: { in: status } } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((r) => this.intentFromDb(r));
  }

  // ── fills ─────────────────────────────────────────────────────────────────

  async addFills(fills: FillRecord[]): Promise<void> {
    if (!fills.length) return;
    await this.prisma.fill.createMany({
      data: fills.map((f) => ({
        id: f.id,
        orderId: f.orderId ?? null,
        intentId: f.intentId ?? null,
        mode: f.mode,
        tokenId: f.tokenId,
        conditionId: f.conditionId ?? null,
        outcome: f.outcome ?? null,
        marketTitle: f.marketTitle ?? null,
        category: f.category ?? null,
        side: f.side,
        price: f.price,
        size: f.size,
        fee: f.fee,
        realizedPnlDelta: f.realizedPnlDelta ?? null,
        ts: new Date(f.ts),
      })),
    });
  }

  async listFills(mode?: string, sinceTs?: number): Promise<FillRecord[]> {
    const rows = await this.prisma.fill.findMany({
      where: {
        ...(mode ? { mode } : {}),
        ...(sinceTs ? { ts: { gte: new Date(sinceTs) } } : {}),
      },
      orderBy: { ts: "desc" },
      take: 2000,
    });
    return rows.map((r) => ({
      id: r.id,
      orderId: r.orderId ?? undefined,
      intentId: r.intentId ?? undefined,
      mode: r.mode as FillRecord["mode"],
      tokenId: r.tokenId,
      outcome: r.outcome ?? undefined,
      marketTitle: r.marketTitle ?? undefined,
      category: r.category ?? undefined,
      conditionId: r.conditionId ?? undefined,
      side: r.side as FillRecord["side"],
      price: r.price,
      size: r.size,
      fee: r.fee,
      ts: r.ts.getTime(),
      realizedPnlDelta: r.realizedPnlDelta ?? undefined,
    }));
  }

  // ── positions ─────────────────────────────────────────────────────────────

  async getPosition(tokenId: string, mode: string): Promise<PositionRecord | undefined> {
    const r = await this.prisma.position.findUnique({
      where: { tokenId_mode: { tokenId, mode } },
    });
    if (!r) return undefined;
    return {
      tokenId: r.tokenId,
      mode: r.mode as TerminalMode,
      conditionId: r.conditionId ?? undefined,
      outcome: r.outcome ?? undefined,
      marketTitle: r.marketTitle ?? undefined,
      category: r.category ?? undefined,
      size: r.size,
      avgPrice: r.avgPrice,
      realizedPnl: r.realizedPnl,
      updatedAt: r.updatedAt.getTime(),
    };
  }

  async upsertPosition(pos: PositionRecord): Promise<void> {
    const data = {
      mode: pos.mode,
      conditionId: pos.conditionId ?? null,
      outcome: pos.outcome ?? null,
      marketTitle: pos.marketTitle ?? null,
      category: pos.category ?? null,
      size: pos.size,
      avgPrice: pos.avgPrice,
      realizedPnl: pos.realizedPnl,
    };
    await this.prisma.position.upsert({
      where: { tokenId_mode: { tokenId: pos.tokenId, mode: pos.mode } },
      create: { tokenId: pos.tokenId, ...data },
      update: data,
    });
  }

  async listPositions(mode?: string): Promise<PositionRecord[]> {
    const rows = await this.prisma.position.findMany({
      where: mode ? { mode } : {},
    });
    return rows.map((r) => ({
      tokenId: r.tokenId,
      mode: r.mode as TerminalMode,
      conditionId: r.conditionId ?? undefined,
      outcome: r.outcome ?? undefined,
      marketTitle: r.marketTitle ?? undefined,
      category: r.category ?? undefined,
      size: r.size,
      avgPrice: r.avgPrice,
      realizedPnl: r.realizedPnl,
      updatedAt: r.updatedAt.getTime(),
    }));
  }

  // ── account cash (app_settings JSON) ──────────────────────────────────────

  async getAccount(mode: TerminalMode): Promise<AccountState> {
    const acct = await this.getJsonSetting<AccountState>(`account:${mode}`);
    if (acct) return acct;
    const settings = await this.getSettings();
    const cash = mode === "live" ? 0 : settings.paperStartingCash;
    const fresh = { cash, startingCash: cash };
    await this.setJsonSetting(`account:${mode}`, fresh);
    return fresh;
  }

  async adjustCash(mode: TerminalMode, delta: number): Promise<AccountState> {
    const acct = await this.getAccount(mode);
    acct.cash = Number((acct.cash + delta).toFixed(6));
    await this.setJsonSetting(`account:${mode}`, acct);
    return acct;
  }

  // ── signals ───────────────────────────────────────────────────────────────

  async addSignals(signals: SignalResult[]): Promise<void> {
    for (const s of signals) {
      await this.prisma.signal.create({
        data: {
          id: s.id,
          strategy: s.strategy,
          conditionId: s.conditionId ?? null,
          tokenId: s.tokenId ?? null,
          direction: s.direction,
          score: s.score,
          status: s.status,
          summary: JSON.stringify({
            summary: s.summary,
            strategyLabel: s.strategyLabel,
            marketQuestion: s.marketQuestion,
            category: s.category,
            meta: s.meta,
          }),
          createdAt: new Date(s.createdAt),
          expiresAt: s.expiresAt ? new Date(s.expiresAt) : null,
          checks: {
            create: s.checks.map((c) => ({
              name: c.name,
              passed: c.passed,
              value: c.value ?? null,
              threshold: c.threshold ?? null,
              detail: c.detail,
            })),
          },
        },
      });
    }
  }

  async listSignals(filter?: {
    strategy?: string;
    status?: string;
    conditionId?: string;
    limit?: number;
  }): Promise<SignalResult[]> {
    const rows = await this.prisma.signal.findMany({
      where: {
        ...(filter?.strategy ? { strategy: filter.strategy } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.conditionId ? { conditionId: filter.conditionId } : {}),
      },
      include: { checks: true },
      orderBy: { createdAt: "desc" },
      take: filter?.limit ?? 200,
    });
    return rows.map((r) => {
      let extra: {
        summary?: string;
        strategyLabel?: string;
        marketQuestion?: string;
        category?: string;
        meta?: Record<string, unknown>;
      } = {};
      try {
        extra = JSON.parse(r.summary ?? "{}");
      } catch {
        extra = { summary: r.summary ?? "" };
      }
      return {
        id: r.id,
        strategy: r.strategy,
        strategyLabel: extra.strategyLabel ?? r.strategy,
        conditionId: r.conditionId ?? undefined,
        tokenId: r.tokenId ?? undefined,
        marketQuestion: extra.marketQuestion,
        category: extra.category,
        direction: (r.direction ?? "NEUTRAL") as SignalResult["direction"],
        score: r.score,
        status: r.status as SignalResult["status"],
        summary: extra.summary ?? "",
        checks: r.checks.map((c) => ({
          name: c.name,
          passed: c.passed,
          value: c.value ?? undefined,
          threshold: c.threshold ?? undefined,
          detail: c.detail ?? "",
        })),
        createdAt: r.createdAt.getTime(),
        expiresAt: r.expiresAt?.getTime(),
        meta: extra.meta,
      } satisfies SignalResult;
    });
  }

  async updateSignalStatus(id: string, status: SignalResult["status"]): Promise<void> {
    await this.prisma.signal.update({ where: { id }, data: { status } });
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  async addAudit(evt: AuditEventRecord): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        id: evt.id,
        ts: new Date(evt.ts),
        actor: evt.actor,
        type: evt.type,
        severity: evt.severity,
        message: evt.message,
        data: (evt.data ?? undefined) as object | undefined,
      },
    });
  }

  async listAudit(filter?: AuditFilter): Promise<AuditEventRecord[]> {
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        ...(filter?.type ? { type: filter.type } : {}),
        ...(filter?.actor ? { actor: filter.actor } : {}),
        ...(filter?.severity ? { severity: filter.severity } : {}),
        ...(filter?.q
          ? { message: { contains: filter.q, mode: "insensitive" } }
          : {}),
      },
      orderBy: { ts: "desc" },
      take: filter?.limit ?? 200,
    });
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts.getTime(),
      actor: r.actor as AuditEventRecord["actor"],
      type: r.type,
      severity: r.severity as AuditEventRecord["severity"],
      message: r.message,
      data: (r.data ?? undefined) as Record<string, unknown> | undefined,
    }));
  }

  // ── portfolio snapshots ───────────────────────────────────────────────────

  async addPortfolioSnapshot(s: PortfolioSnapshotRecord): Promise<void> {
    await this.prisma.portfolioSnapshot.create({
      data: {
        id: s.id,
        ts: new Date(s.ts),
        mode: s.mode,
        totalValue: s.totalValue,
        cash: s.cash,
        exposure: s.exposure,
        realizedPnl: s.realizedPnl,
        unrealizedPnl: s.unrealizedPnl,
        dailyPnl: s.dailyPnl,
        drawdown: s.drawdown,
      },
    });
  }

  async listPortfolioSnapshots(
    mode: TerminalMode,
    limit = 500,
  ): Promise<PortfolioSnapshotRecord[]> {
    const rows = await this.prisma.portfolioSnapshot.findMany({
      where: { mode },
      orderBy: { ts: "desc" },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      id: r.id,
      ts: r.ts.getTime(),
      mode: r.mode as TerminalMode,
      totalValue: r.totalValue,
      cash: r.cash,
      exposure: r.exposure,
      realizedPnl: r.realizedPnl,
      unrealizedPnl: r.unrealizedPnl,
      dailyPnl: r.dailyPnl,
      drawdown: r.drawdown,
    }));
  }

  async resetMode(mode: TerminalMode): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.paperOrder.deleteMany({ where: { mode } }),
      this.prisma.position.deleteMany({ where: { mode } }),
      this.prisma.portfolioSnapshot.deleteMany({ where: { mode } }),
      this.prisma.fill.deleteMany({ where: { mode } }),
      this.prisma.appSetting.deleteMany({ where: { key: `account:${mode}` } }),
    ]);
  }
}
