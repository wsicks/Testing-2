// Default store: in-memory with write-through JSON persistence under .data/.
// Zero-setup — paper trading survives dev-server restarts without a database.

import fs from "node:fs";
import path from "node:path";
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

interface Data {
  settings: Partial<AppSettings>;
  orders: PaperOrder[];
  intents: LiveOrderIntent[];
  fills: FillRecord[];
  positions: PositionRecord[];
  signals: SignalResult[];
  audit: AuditEventRecord[];
  accounts: Record<string, AccountState>;
  portfolioSnapshots: PortfolioSnapshotRecord[];
}

const EMPTY: Data = {
  settings: {},
  orders: [],
  intents: [],
  fills: [],
  positions: [],
  signals: [],
  audit: [],
  accounts: {},
  portfolioSnapshots: [],
};

const CAPS = { fills: 5000, signals: 1500, audit: 5000, portfolioSnapshots: 5000 };

export class MemoryStore implements Store {
  private data: Data;
  private file: string | null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(persistFile: string | null = defaultFile()) {
    this.file = persistFile;
    this.data = this.load();
  }

  private load(): Data {
    if (this.file) {
      try {
        const raw = fs.readFileSync(this.file, "utf8");
        return { ...structuredClone(EMPTY), ...JSON.parse(raw) };
      } catch {
        /* first boot or unreadable file */
      }
    }
    return structuredClone(EMPTY);
  }

  private persist(): void {
    if (!this.file) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file!), { recursive: true });
        fs.writeFileSync(this.file!, JSON.stringify(this.data));
      } catch {
        /* persistence is best-effort */
      }
    }, 400);
  }

  async getSettings(): Promise<AppSettings> {
    return { ...DEFAULT_SETTINGS, ...this.data.settings };
  }

  async patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.data.settings = { ...this.data.settings, ...patch };
    this.persist();
    return this.getSettings();
  }

  async createOrder(order: PaperOrder): Promise<PaperOrder> {
    this.data.orders.unshift(order);
    this.persist();
    return order;
  }

  async updateOrder(order: PaperOrder): Promise<PaperOrder> {
    const i = this.data.orders.findIndex((o) => o.id === order.id);
    if (i >= 0) this.data.orders[i] = order;
    this.persist();
    return order;
  }

  async getOrder(id: string): Promise<PaperOrder | undefined> {
    return this.data.orders.find((o) => o.id === id);
  }

  async listOrders(mode?: string, status?: string[]): Promise<PaperOrder[]> {
    return this.data.orders.filter(
      (o) =>
        (!mode || o.mode === mode) && (!status || status.includes(o.status)),
    );
  }

  async createIntent(intent: LiveOrderIntent): Promise<LiveOrderIntent> {
    this.data.intents.unshift(intent);
    this.persist();
    return intent;
  }

  async updateIntent(intent: LiveOrderIntent): Promise<LiveOrderIntent> {
    const i = this.data.intents.findIndex((o) => o.id === intent.id);
    if (i >= 0) this.data.intents[i] = intent;
    this.persist();
    return intent;
  }

  async getIntent(id: string): Promise<LiveOrderIntent | undefined> {
    return this.data.intents.find((o) => o.id === id);
  }

  async listIntents(status?: string[]): Promise<LiveOrderIntent[]> {
    return this.data.intents.filter((o) => !status || status.includes(o.status));
  }

  async addFills(fills: FillRecord[]): Promise<void> {
    this.data.fills.unshift(...fills);
    if (this.data.fills.length > CAPS.fills)
      this.data.fills.length = CAPS.fills;
    this.persist();
  }

  async listFills(mode?: string, sinceTs?: number): Promise<FillRecord[]> {
    return this.data.fills.filter(
      (f) => (!mode || f.mode === mode) && (!sinceTs || f.ts >= sinceTs),
    );
  }

  async getPosition(tokenId: string, mode: string): Promise<PositionRecord | undefined> {
    return this.data.positions.find(
      (p) => p.tokenId === tokenId && p.mode === mode,
    );
  }

  async upsertPosition(pos: PositionRecord): Promise<void> {
    const i = this.data.positions.findIndex(
      (p) => p.tokenId === pos.tokenId && p.mode === pos.mode,
    );
    if (i >= 0) this.data.positions[i] = pos;
    else this.data.positions.push(pos);
    this.persist();
  }

  async listPositions(mode?: string): Promise<PositionRecord[]> {
    return this.data.positions.filter((p) => !mode || p.mode === mode);
  }

  async getAccount(mode: TerminalMode): Promise<AccountState> {
    if (!this.data.accounts[mode]) {
      const settings = await this.getSettings();
      const cash = mode === "live" ? 0 : settings.paperStartingCash;
      this.data.accounts[mode] = { cash, startingCash: cash };
      this.persist();
    }
    return this.data.accounts[mode];
  }

  async adjustCash(mode: TerminalMode, delta: number): Promise<AccountState> {
    const acct = await this.getAccount(mode);
    acct.cash = Number((acct.cash + delta).toFixed(6));
    this.persist();
    return acct;
  }

  async addSignals(signals: SignalResult[]): Promise<void> {
    this.data.signals.unshift(...signals);
    if (this.data.signals.length > CAPS.signals)
      this.data.signals.length = CAPS.signals;
    this.persist();
  }

  async listSignals(filter?: {
    strategy?: string;
    status?: string;
    conditionId?: string;
    limit?: number;
  }): Promise<SignalResult[]> {
    let out = this.data.signals;
    if (filter?.strategy) out = out.filter((s) => s.strategy === filter.strategy);
    if (filter?.status) out = out.filter((s) => s.status === filter.status);
    if (filter?.conditionId)
      out = out.filter((s) => s.conditionId === filter.conditionId);
    return out.slice(0, filter?.limit ?? 200);
  }

  async updateSignalStatus(id: string, status: SignalResult["status"]): Promise<void> {
    const s = this.data.signals.find((x) => x.id === id);
    if (s) s.status = status;
    this.persist();
  }

  async addAudit(evt: AuditEventRecord): Promise<void> {
    this.data.audit.unshift(evt);
    if (this.data.audit.length > CAPS.audit) this.data.audit.length = CAPS.audit;
    this.persist();
  }

  async listAudit(filter?: AuditFilter): Promise<AuditEventRecord[]> {
    let out = this.data.audit;
    if (filter?.type) out = out.filter((e) => e.type === filter.type);
    if (filter?.actor) out = out.filter((e) => e.actor === filter.actor);
    if (filter?.severity) out = out.filter((e) => e.severity === filter.severity);
    if (filter?.q) {
      const q = filter.q.toLowerCase();
      out = out.filter((e) => e.message.toLowerCase().includes(q));
    }
    return out.slice(0, filter?.limit ?? 200);
  }

  async addPortfolioSnapshot(s: PortfolioSnapshotRecord): Promise<void> {
    this.data.portfolioSnapshots.push(s);
    if (this.data.portfolioSnapshots.length > CAPS.portfolioSnapshots)
      this.data.portfolioSnapshots.splice(
        0,
        this.data.portfolioSnapshots.length - CAPS.portfolioSnapshots,
      );
    this.persist();
  }

  async listPortfolioSnapshots(
    mode: TerminalMode,
    limit = 500,
  ): Promise<PortfolioSnapshotRecord[]> {
    return this.data.portfolioSnapshots
      .filter((s) => s.mode === mode)
      .slice(-limit);
  }

  async resetMode(mode: TerminalMode): Promise<void> {
    this.data.orders = this.data.orders.filter((o) => o.mode !== mode);
    this.data.fills = this.data.fills.filter((f) => f.mode !== mode);
    this.data.positions = this.data.positions.filter((p) => p.mode !== mode);
    this.data.portfolioSnapshots = this.data.portfolioSnapshots.filter(
      (s) => s.mode !== mode,
    );
    delete this.data.accounts[mode];
    this.persist();
  }
}

function defaultFile(): string | null {
  if (process.env.NODE_ENV === "test") return null;
  return path.join(process.cwd(), ".data", "polyquant-store.json");
}
