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

export interface AccountState {
  cash: number;
  startingCash: number;
}

export interface PortfolioSnapshotRecord {
  id: string;
  ts: number;
  mode: TerminalMode;
  totalValue: number;
  cash: number;
  exposure: number;
  realizedPnl: number;
  unrealizedPnl: number;
  dailyPnl: number;
  drawdown: number;
}

export interface AuditFilter {
  type?: string;
  actor?: string;
  severity?: string;
  q?: string;
  limit?: number;
}

export interface Store {
  // settings
  getSettings(): Promise<AppSettings>;
  patchSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  // paper/demo orders
  createOrder(order: PaperOrder): Promise<PaperOrder>;
  updateOrder(order: PaperOrder): Promise<PaperOrder>;
  getOrder(id: string): Promise<PaperOrder | undefined>;
  listOrders(mode?: string, status?: string[]): Promise<PaperOrder[]>;

  // live order intents
  createIntent(intent: LiveOrderIntent): Promise<LiveOrderIntent>;
  updateIntent(intent: LiveOrderIntent): Promise<LiveOrderIntent>;
  getIntent(id: string): Promise<LiveOrderIntent | undefined>;
  listIntents(status?: string[]): Promise<LiveOrderIntent[]>;

  // fills
  addFills(fills: FillRecord[]): Promise<void>;
  listFills(mode?: string, sinceTs?: number): Promise<FillRecord[]>;

  // positions
  getPosition(tokenId: string, mode: string): Promise<PositionRecord | undefined>;
  upsertPosition(pos: PositionRecord): Promise<void>;
  listPositions(mode?: string): Promise<PositionRecord[]>;

  // account cash
  getAccount(mode: TerminalMode): Promise<AccountState>;
  adjustCash(mode: TerminalMode, delta: number): Promise<AccountState>;

  // signals
  addSignals(signals: SignalResult[]): Promise<void>;
  listSignals(filter?: {
    strategy?: string;
    status?: string;
    conditionId?: string;
    limit?: number;
  }): Promise<SignalResult[]>;
  updateSignalStatus(id: string, status: SignalResult["status"]): Promise<void>;

  // audit
  addAudit(evt: AuditEventRecord): Promise<void>;
  listAudit(filter?: AuditFilter): Promise<AuditEventRecord[]>;

  // portfolio snapshots
  addPortfolioSnapshot(s: PortfolioSnapshotRecord): Promise<void>;
  listPortfolioSnapshots(mode: TerminalMode, limit?: number): Promise<PortfolioSnapshotRecord[]>;

  // maintenance
  resetMode(mode: TerminalMode): Promise<void>;
}
