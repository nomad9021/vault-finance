import { z } from "zod";
import { ApiError as ApiErrorSchema, type ErrorCode } from "../schemas/common.js";
import {
  LoginResponse,
  ProfilesResponse,
  SessionListResponse,
  TokenPair,
  type LoginByIdRequest,
  type LoginRequest,
} from "../schemas/auth.js";
import { SetupStatusResponse, type SetupCompleteRequest } from "../schemas/setup.js";
import { User } from "../schemas/user.js";
import { VersionResponse } from "../schemas/version.js";
import {
  Account,
  AccountListResponse,
  type CreateAccountRequest,
  type UpdateAccountRequest,
} from "../schemas/accounts.js";
import {
  Category,
  CategoryListResponse,
  type CreateCategoryRequest,
  type UpdateCategoryRequest,
} from "../schemas/categories.js";
import {
  ImportResponse,
  Transaction,
  TransactionListResponse,
  type CreateTransactionRequest,
  type TransactionListQuery,
  type UpdateTransactionRequest,
} from "../schemas/transactions.js";
import {
  Budget,
  BudgetListResponse,
  type CreateBudgetRequest,
  type UpdateBudgetRequest,
} from "../schemas/budgets.js";
import {
  AiStatus,
  ChatStreamLine,
  ConversationDetail,
  ConversationListResponse,
  type ChatRequest,
  type UpdateAiSettingsRequest,
} from "../schemas/ai.js";
import { CashflowSummaryResponse, SankeyResponse } from "../schemas/cashflow.js";
import {
  Holding,
  InvestmentsResponse,
  type CreateHoldingRequest,
  type UpdateHoldingRequest,
} from "../schemas/investments.js";
import {
  Goal,
  GoalListResponse,
  type CreateGoalRequest,
  type UpdateGoalRequest,
} from "../schemas/goals.js";
import { MonthlyReport, YearlyReport } from "../schemas/reports.js";

/**
 * Transport abstraction: the browser passes global fetch; the Tauri desktop
 * app passes a fetch-shaped wrapper around its Rust command that enforces
 * TOFU certificate pinning (ADR-0004). Keeping the client transport-agnostic
 * is also what lets the future iOS app reuse it unchanged.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/**
 * Streaming transport for the AI chat endpoint (ADR-0005). Delivers raw
 * response chunks as they arrive; resolves with the status once the stream
 * ends. Browser: fetch + ReadableStream reader. Tauri: Rust command pushing
 * chunks over an IPC channel (same pinned-TLS policy as FetchLike).
 */
export type StreamFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
  onChunk: (chunk: string) => void,
) => Promise<{ status: number }>;

/** Server answered with a structured error body. */
export class ApiRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Could not reach the server at all (offline, wrong address, TLS rejection). */
export class ApiConnectionError extends Error {
  constructor(readonly cause_: unknown) {
    super("Could not reach the server.");
    this.name = "ApiConnectionError";
  }
}

export type ConnectionStatus = "online" | "offline";

export interface ApiClientOptions {
  baseUrl: string;
  clientVersion: string;
  fetchImpl: FetchLike;
  /** Required for ApiClient.chat(); every other method works without it. */
  streamFetchImpl?: StreamFetchLike;
  getTokens: () => TokenPair | null;
  setTokens: (tokens: TokenPair | null) => void;
  /** Called when a refresh fails and the user must sign in again. */
  onAuthLost?: (reason: ErrorCode) => void;
  /** Called on every observed transition between reachable and unreachable. */
  onConnectionChange?: (status: ConnectionStatus) => void;
}

export class ApiClient {
  private refreshInFlight: Promise<boolean> | null = null;
  private lastStatus: ConnectionStatus | null = null;

  constructor(private readonly opts: ApiClientOptions) {}

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  private noteConnection(status: ConnectionStatus) {
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.opts.onConnectionChange?.(status);
    }
  }

  private async rawRequest(
    method: string,
    path: string,
    body: unknown,
    withAuth: boolean,
  ): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = {
      "x-client-version": this.opts.clientVersion,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (withAuth) {
      const tokens = this.opts.getTokens();
      if (tokens) headers["authorization"] = `Bearer ${tokens.accessToken}`;
    }

    let res;
    try {
      res = await this.opts.fetchImpl(`${this.opts.baseUrl}/api/v1${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      this.noteConnection("offline");
      throw new ApiConnectionError(err);
    }
    this.noteConnection("online");
    return { status: res.status, text: await res.text() };
  }

  /** Single-flight: concurrent 401s share one refresh call. */
  private refreshTokens(): Promise<boolean> {
    this.refreshInFlight ??= (async () => {
      try {
        const tokens = this.opts.getTokens();
        if (!tokens) return false;
        const res = await this.rawRequest(
          "POST",
          "/auth/refresh",
          { refreshToken: tokens.refreshToken },
          false,
        );
        if (res.status !== 200) {
          const code = this.parseErrorCode(res.text);
          this.opts.setTokens(null);
          this.opts.onAuthLost?.(code);
          return false;
        }
        this.opts.setTokens(TokenPair.parse(JSON.parse(res.text)));
        return true;
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private parseErrorCode(text: string): ErrorCode {
    try {
      return ApiErrorSchema.parse(JSON.parse(text)).error.code;
    } catch {
      return "INTERNAL";
    }
  }

  private async request<T>(
    schema: z.ZodType<T>,
    method: string,
    path: string,
    body?: unknown,
    { auth = true }: { auth?: boolean } = {},
  ): Promise<T> {
    let res = await this.rawRequest(method, path, body, auth);

    // TOKEN_EXPIRED is the normal case; TOKEN_INVALID is also worth one
    // refresh attempt — it happens when the server's signing key rotated
    // (e.g. its data volume was recreated) while our session row survived.
    if (res.status === 401 && auth) {
      const code = this.parseErrorCode(res.text);
      if (
        (code === "TOKEN_EXPIRED" || code === "TOKEN_INVALID") &&
        (await this.refreshTokens())
      ) {
        res = await this.rawRequest(method, path, body, auth);
      }
    }

    if (res.status >= 400) {
      const parsed = (() => {
        try {
          return ApiErrorSchema.parse(JSON.parse(res.text));
        } catch {
          return null;
        }
      })();
      throw new ApiRequestError(
        parsed?.error.code ?? "INTERNAL",
        res.status,
        parsed?.error.message ?? `Request failed with status ${res.status}.`,
        parsed?.error.fields,
      );
    }

    if (res.status === 204) return schema.parse(undefined);
    return schema.parse(JSON.parse(res.text));
  }

  // ── Meta ──
  version() {
    return this.request(VersionResponse, "GET", "/version", undefined, { auth: false });
  }

  // ── Setup ──
  setupStatus() {
    return this.request(SetupStatusResponse, "GET", "/setup/status", undefined, {
      auth: false,
    });
  }
  setupComplete(body: SetupCompleteRequest) {
    return this.request(z.object({ ok: z.boolean() }), "POST", "/setup/complete", body, {
      auth: false,
    });
  }

  // ── Auth ──
  profiles() {
    return this.request(ProfilesResponse, "GET", "/auth/profiles", undefined, {
      auth: false,
    });
  }
  async login(body: LoginRequest | LoginByIdRequest) {
    const result = await this.request(LoginResponse, "POST", "/auth/login", body, {
      auth: false,
    });
    this.opts.setTokens({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    return result;
  }
  async logout() {
    const tokens = this.opts.getTokens();
    if (tokens) {
      await this.request(z.undefined(), "POST", "/auth/logout", {
        refreshToken: tokens.refreshToken,
      }).catch(() => {}); // best-effort: local sign-out must succeed even if unreachable
    }
    this.opts.setTokens(null);
  }
  me() {
    return this.request(User, "GET", "/me");
  }
  sessions() {
    return this.request(SessionListResponse, "GET", "/auth/sessions");
  }
  revokeSession(id: string) {
    return this.request(z.undefined(), "DELETE", `/auth/sessions/${id}`);
  }

  // ── Accounts ──
  accounts(includeArchived = false) {
    return this.request(
      AccountListResponse,
      "GET",
      `/accounts${includeArchived ? "?archived=true" : ""}`,
    );
  }
  createAccount(body: CreateAccountRequest) {
    return this.request(Account, "POST", "/accounts", body);
  }
  updateAccount(id: string, body: UpdateAccountRequest) {
    return this.request(Account, "PATCH", `/accounts/${id}`, body);
  }
  deleteAccount(id: string) {
    return this.request(z.object({ archived: z.boolean() }), "DELETE", `/accounts/${id}`);
  }

  // ── Categories ──
  categories() {
    return this.request(CategoryListResponse, "GET", "/categories");
  }
  createCategory(body: CreateCategoryRequest) {
    return this.request(Category, "POST", "/categories", body);
  }
  updateCategory(id: string, body: UpdateCategoryRequest) {
    return this.request(Category, "PATCH", `/categories/${id}`, body);
  }
  deleteCategory(id: string) {
    return this.request(z.undefined(), "DELETE", `/categories/${id}`);
  }

  // ── Transactions ──
  transactions(query: Partial<TransactionListQuery> = {}) {
    // Hand-rolled query string: URLSearchParams is a DOM/Node global and this
    // package deliberately compiles against pure ES lib types.
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return this.request(
      TransactionListResponse,
      "GET",
      `/transactions${qs ? `?${qs}` : ""}`,
    );
  }
  createTransaction(body: CreateTransactionRequest) {
    return this.request(Transaction, "POST", "/transactions", body);
  }
  updateTransaction(id: string, body: UpdateTransactionRequest) {
    return this.request(Transaction, "PATCH", `/transactions/${id}`, body);
  }
  deleteTransaction(id: string) {
    return this.request(z.undefined(), "DELETE", `/transactions/${id}`);
  }
  importTransactions(accountId: string, csvText: string) {
    return this.request(ImportResponse, "POST", "/transactions/import", {
      accountId,
      csv: csvText,
    });
  }

  // ── AI ──
  aiStatus() {
    return this.request(AiStatus, "GET", "/ai/status");
  }
  updateAiSettings(body: UpdateAiSettingsRequest) {
    return this.request(AiStatus, "POST", "/ai/settings", body);
  }
  conversations() {
    return this.request(ConversationListResponse, "GET", "/ai/conversations");
  }
  conversation(id: string) {
    return this.request(ConversationDetail, "GET", `/ai/conversations/${id}`);
  }
  deleteConversation(id: string) {
    return this.request(z.undefined(), "DELETE", `/ai/conversations/${id}`);
  }

  /**
   * Streaming chat (ADR-0005). Parses NDJSON lines from raw chunks — a chunk
   * may contain several lines or a partial one, so a carry buffer reassembles
   * them. Calls onToken per token; resolves with the conversation id once the
   * server sends its terminal line.
   */
  async chat(
    body: ChatRequest,
    onToken: (token: string) => void,
  ): Promise<{ conversationId: string }> {
    const streamImpl = this.opts.streamFetchImpl;
    if (!streamImpl) throw new Error("streamFetchImpl not configured");

    const tokens = this.opts.getTokens();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-client-version": this.opts.clientVersion,
      ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
    };

    let buffer = "";
    let result: { conversationId: string } | null = null;
    let streamError: ApiRequestError | null = null;

    const handleLine = (line: string) => {
      if (!line.trim() || streamError) return;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        return; // torn or non-JSON line — ignore rather than kill the stream
      }
      const parsed = ChatStreamLine.safeParse(obj);
      if (!parsed.success) return;
      const data = parsed.data;
      if ("token" in data) onToken(data.token);
      else if ("done" in data) result = { conversationId: data.conversationId };
      else {
        streamError = new ApiRequestError(
          (data.error.code as ErrorCode) ?? "INTERNAL",
          502,
          data.error.message,
        );
      }
    };

    let status: number;
    try {
      ({ status } = await streamImpl(
        `${this.opts.baseUrl}/api/v1/ai/chat`,
        { method: "POST", headers, body: JSON.stringify(body) },
        (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // keep the trailing partial line
          for (const line of lines) handleLine(line);
        },
      ));
    } catch (err) {
      this.noteConnection("offline");
      throw new ApiConnectionError(err);
    }
    this.noteConnection("online");
    if (buffer) handleLine(buffer);

    if (streamError) throw streamError;
    if (status >= 400) {
      throw new ApiRequestError("INTERNAL", status, `Chat failed with status ${status}.`);
    }
    if (!result) {
      throw new ApiRequestError(
        "INTERNAL",
        502,
        "The response was interrupted before it finished.",
      );
    }
    return result;
  }

  // ── Cash flow ──
  cashflowSummary(months = 6) {
    return this.request(CashflowSummaryResponse, "GET", `/cashflow/summary?months=${months}`);
  }
  sankey(month?: string) {
    return this.request(
      SankeyResponse,
      "GET",
      `/cashflow/sankey${month ? `?month=${month}` : ""}`,
    );
  }

  // ── Investments ──
  investments() {
    return this.request(InvestmentsResponse, "GET", "/investments");
  }
  createHolding(accountId: string, body: CreateHoldingRequest) {
    return this.request(Holding, "POST", `/investments/${accountId}/holdings`, body);
  }
  updateHolding(id: string, body: UpdateHoldingRequest) {
    return this.request(Holding, "PATCH", `/holdings/${id}`, body);
  }
  deleteHolding(id: string) {
    return this.request(z.undefined(), "DELETE", `/holdings/${id}`);
  }

  // ── Goals ──
  goals() {
    return this.request(GoalListResponse, "GET", "/goals");
  }
  createGoal(body: CreateGoalRequest) {
    return this.request(Goal, "POST", "/goals", body);
  }
  updateGoal(id: string, body: UpdateGoalRequest) {
    return this.request(Goal, "PATCH", `/goals/${id}`, body);
  }
  deleteGoal(id: string) {
    return this.request(z.undefined(), "DELETE", `/goals/${id}`);
  }

  // ── Reports ──
  monthlyReport(month?: string) {
    return this.request(
      MonthlyReport,
      "GET",
      `/reports/monthly${month ? `?month=${month}` : ""}`,
    );
  }
  yearlyReport(year?: number) {
    return this.request(
      YearlyReport,
      "GET",
      `/reports/yearly${year ? `?year=${year}` : ""}`,
    );
  }
  /** Raw CSV text — the caller saves it (download in browser, dialog in Tauri). */
  async exportCsv(from?: string, to?: string): Promise<string> {
    const params = [
      "type=transactions",
      ...(from ? [`from=${from}`] : []),
      ...(to ? [`to=${to}`] : []),
    ].join("&");
    const tokens = this.opts.getTokens();
    const res = await this.opts.fetchImpl(
      `${this.opts.baseUrl}/api/v1/export/csv?${params}`,
      {
        method: "GET",
        headers: {
          "x-client-version": this.opts.clientVersion,
          ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
        },
      },
    );
    if (res.status >= 400) {
      throw new ApiRequestError("INTERNAL", res.status, "Export failed.");
    }
    return res.text();
  }

  // ── Budgets ──
  budgets(month?: string) {
    return this.request(
      BudgetListResponse,
      "GET",
      `/budgets${month ? `?month=${month}` : ""}`,
    );
  }
  createBudget(body: CreateBudgetRequest) {
    return this.request(Budget, "POST", "/budgets", body);
  }
  updateBudget(id: string, body: UpdateBudgetRequest) {
    return this.request(Budget, "PATCH", `/budgets/${id}`, body);
  }
  deleteBudget(id: string) {
    return this.request(z.undefined(), "DELETE", `/budgets/${id}`);
  }
}
