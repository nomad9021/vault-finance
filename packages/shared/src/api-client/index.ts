import { z } from "zod";
import { ApiError as ApiErrorSchema, type ErrorCode } from "../schemas/common.js";
import {
  CreateDeviceKeyResponse,
  DeviceApprovalSettings,
  DeviceApprovalStatusResponse,
  DeviceKeyListResponse,
  LoginResponse,
  PendingApprovalListResponse,
  TrustedDeviceListResponse,
  ProfilesResponse,
  SessionListResponse,
  TokenPair,
  TotpSetupResponse,
  TotpStatusResponse,
  type CreateDeviceKeyRequest,
  type DeviceApprovalStatusRequest,
  type DeviceIdentity,
  type DeviceKeyLoginRequest,
  type LoginByIdRequest,
  type LoginRequest,
} from "../schemas/auth.js";
import { Household } from "../schemas/household.js";
import { SetupStatusResponse, type SetupCompleteRequest } from "../schemas/setup.js";
import { User, UserPreferences, type UpdateMeRequest } from "../schemas/user.js";
import { VersionResponse } from "../schemas/version.js";
import { Bucket, BucketListResponse, type CreateBucketRequest, type MoveBucketMoneyRequest, type UpdateBucketRequest } from "../schemas/buckets.js";
import { TaxEstimateSchema, TaxPlacesResponse, TaxProfileResponse, type TaxProfileInput } from "../schemas/taxes.js";
import { ServerStatusResponse, StatusDetailsResponse } from "../schemas/status.js";
import { UpdateStatusResponse } from "../schemas/updates.js";
import {
  MemberListResponse,
  Member,
  InvitePreviewResponse,
  type CreateMemberRequest,
  type InviteMemberRequest,
} from "../schemas/members.js";
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
  BudgetPlan,
  type CreateBudgetRequest,
  type UpdateBudgetPlanRequest,
  type UpdateBudgetRequest,
} from "../schemas/budgets.js";
import {
  AiModelsResponse,
  AiTestResponse,
  type AiTestRequest,
  AiHostStatus,
  AiStatus,
  ChatStreamLine,
  ConversationDetail,
  ConversationListResponse,
  type ChatRequest,
  type UpdateAiSettingsRequest,
} from "../schemas/ai.js";
import {
  AiActionRecord,
  AiMemoryResponse,
  type AiActionClientResult,
} from "../schemas/ai-actions.js";
import { CashflowSummaryResponse, SankeyResponse, TrendsResponse } from "../schemas/cashflow.js";
import {
  AutocategorizeResponse,
  CategorizationRule,
  RuleListResponse,
  type CreateRuleRequest,
} from "../schemas/categorize.js";
import {
  BankStatus,
  BankSyncResponse,
  type UpdateBankSettingsRequest,
  BankLinkStartResponse,
  BankLinkStatus,
  type BankLinkStartRequest,
} from "../schemas/bank.js";
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
import {
  Bill,
  BillListResponse,
  type CreateBillRequest,
  type UpdateBillRequest,
} from "../schemas/bills.js";
import {
  GivingFund,
  GivingListResponse,
  type CreateGivingFundRequest,
  type UpdateGivingFundRequest,
} from "../schemas/giving.js";
import { SubscriptionListResponse } from "../schemas/subscriptions.js";
import { InsightListResponse } from "../schemas/insights.js";
import { DebtPlan, type UpdateDebtPlanRequest } from "../schemas/debts.js";
import {
  MonthlyReport,
  PeriodReview,
  YearlyReport,
  type ReviewPeriod,
} from "../schemas/reports.js";

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
/** The part of AbortSignal the client uses (this package doesn't load DOM types). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
}

export type StreamFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
  onChunk: (chunk: string) => void,
  /** Aborting stops the stream and drops the connection (the server stops too). */
  signal?: AbortSignalLike,
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
  /**
   * This install's device identity for the server, attached to sign-in and
   * refresh so the server can require the device to be approved (ADR-0009).
   */
  getDeviceIdentity?: () => DeviceIdentity | null;
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
          { refreshToken: tokens.refreshToken, ...(this.opts.getDeviceIdentity?.() ?? {}) },
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
  updateStatus() {
    return this.request(UpdateStatusResponse, "GET", "/updates/status");
  }
  /** Owner: ask GitHub for the latest release now instead of waiting for the daily check. */
  checkServerUpdate() {
    return this.request(UpdateStatusResponse, "POST", "/updates/check");
  }
  /** Owner: have the host's update agent install the latest release. */
  startServerUpdate() {
    return this.request(UpdateStatusResponse, "POST", "/updates/apply");
  }
  /** Public component health (database, storage) for the startup screen. */
  serverStatus() {
    return this.request(ServerStatusResponse, "GET", "/status", undefined, { auth: false });
  }
  /** Signed-in health checks: AI provider, bank sync, server update. */
  statusDetails() {
    return this.request(StatusDetailsResponse, "GET", "/status/details");
  }

  // ── Household ──
  household() {
    return this.request(Household, "GET", "/household");
  }
  renameHousehold(name: string) {
    return this.request(Household, "PATCH", "/household", { name });
  }

  // ── Household members ──
  members() {
    return this.request(MemberListResponse, "GET", "/members");
  }
  inviteMember(body: InviteMemberRequest) {
    return this.request(
      z.object({ inviteUrl: z.string() }),
      "POST",
      "/members/invite",
      body,
    );
  }
  createMember(body: CreateMemberRequest) {
    return this.request(Member, "POST", "/members", body);
  }
  removeMember(id: string) {
    return this.request(z.undefined(), "DELETE", `/members/${id}`);
  }
  invitePreview(token: string) {
    return this.request(
      InvitePreviewResponse,
      "GET",
      `/members/invite/${encodeURIComponent(token)}`,
      undefined,
      { auth: false },
    );
  }
  acceptInvite(token: string, password: string) {
    return this.request(
      z.undefined(),
      "POST",
      `/members/invite/${encodeURIComponent(token)}/accept`,
      { password },
      { auth: false },
    );
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
    const result = await this.request(
      LoginResponse,
      "POST",
      "/auth/login",
      { ...body, ...(this.opts.getDeviceIdentity?.() ?? {}) },
      { auth: false },
    );
    this.opts.setTokens({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    return result;
  }
  /** Biometric sign-in: the device key is only sent after a local OS check. */
  async loginWithDeviceKey(body: DeviceKeyLoginRequest) {
    const result = await this.request(
      LoginResponse,
      "POST",
      "/auth/login/device-key",
      { ...body, ...(this.opts.getDeviceIdentity?.() ?? {}) },
      { auth: false },
    );
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
  /** Your own name, colour and picture (avatarImage: null removes it). */
  updateMe(body: UpdateMeRequest) {
    return this.request(User, "PATCH", "/me", body);
  }
  preferences() {
    return this.request(UserPreferences, "GET", "/me/preferences");
  }
  savePreferences(body: UserPreferences) {
    return this.request(UserPreferences, "PUT", "/me/preferences", body);
  }
  sessions() {
    return this.request(SessionListResponse, "GET", "/auth/sessions");
  }
  revokeSession(id: string) {
    return this.request(z.undefined(), "DELETE", `/auth/sessions/${id}`);
  }

  // ── Device approval (ADR-0009) ──
  /** Polled by a device waiting for approval; stores the session once approved. */
  async deviceApprovalStatus(body: DeviceApprovalStatusRequest) {
    const result = await this.request(DeviceApprovalStatusResponse, "POST", "/auth/device-approval/status", body, {
      auth: false,
    });
    if (result.status === "approved") {
      this.opts.setTokens({ accessToken: result.login.accessToken, refreshToken: result.login.refreshToken });
    }
    return result;
  }
  pendingApprovals() {
    return this.request(PendingApprovalListResponse, "GET", "/devices/approvals");
  }
  approveDevice(id: string, code: string) {
    return this.request(z.undefined(), "POST", `/devices/approvals/${id}/approve`, { code });
  }
  denyDevice(id: string) {
    return this.request(z.undefined(), "POST", `/devices/approvals/${id}/deny`, {});
  }
  trustedDevices() {
    return this.request(TrustedDeviceListResponse, "GET", "/devices");
  }
  revokeTrustedDevice(id: string) {
    return this.request(z.undefined(), "DELETE", `/devices/${id}`);
  }
  deviceApprovalSettings() {
    return this.request(DeviceApprovalSettings, "GET", "/devices/approval-settings");
  }
  updateDeviceApprovalSettings(body: DeviceApprovalSettings) {
    return this.request(DeviceApprovalSettings, "PUT", "/devices/approval-settings", body);
  }

  // ── Device keys (biometric sign-in) ──
  deviceKeys() {
    return this.request(DeviceKeyListResponse, "GET", "/auth/device-keys");
  }
  createDeviceKey(body: CreateDeviceKeyRequest) {
    return this.request(CreateDeviceKeyResponse, "POST", "/auth/device-keys", body);
  }
  revokeDeviceKey(id: string) {
    return this.request(z.undefined(), "DELETE", `/auth/device-keys/${id}`);
  }

  // ── Two-factor auth ──
  totpStatus() {
    return this.request(TotpStatusResponse, "GET", "/auth/2fa/status");
  }
  totpSetup() {
    return this.request(TotpSetupResponse, "POST", "/auth/2fa/setup");
  }
  totpEnable(code: string) {
    return this.request(z.undefined(), "POST", "/auth/2fa/enable", { code });
  }
  totpDisable(password: string) {
    return this.request(z.undefined(), "POST", "/auth/2fa/disable", { password });
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
  moveCategory(id: string, direction: "up" | "down") {
    return this.request(CategoryListResponse, "POST", `/categories/${id}/move`, { direction });
  }

  // ── Auto-categorization (local rules) ──
  categorizationRules() {
    return this.request(RuleListResponse, "GET", "/categorization-rules");
  }
  createCategorizationRule(body: CreateRuleRequest) {
    return this.request(CategorizationRule, "POST", "/categorization-rules", body);
  }
  deleteCategorizationRule(id: string) {
    return this.request(z.undefined(), "DELETE", `/categorization-rules/${id}`);
  }
  autocategorize() {
    return this.request(AutocategorizeResponse, "POST", "/transactions/autocategorize");
  }

  // ── Bank linking (optional) ──
  bankStatus() {
    return this.request(BankStatus, "GET", "/bank/status");
  }
  updateBankSettings(body: UpdateBankSettingsRequest) {
    return this.request(BankStatus, "PATCH", "/bank/settings", body);
  }
  bankConnect() {
    return this.request(BankSyncResponse, "POST", "/bank/connect");
  }
  /** Start Plaid Hosted Link; open the returned URL in the browser. */
  bankLinkStart(body: BankLinkStartRequest = {}) {
    return this.request(BankLinkStartResponse, "POST", "/bank/link", body);
  }
  bankLinkStatus(sessionId: string) {
    return this.request(BankLinkStatus, "GET", `/bank/link/${encodeURIComponent(sessionId)}`);
  }
  bankSync(connectionId: string) {
    return this.request(BankSyncResponse, "POST", `/bank/connections/${connectionId}/sync`);
  }
  bankDisconnect(connectionId: string) {
    return this.request(z.undefined(), "DELETE", `/bank/connections/${connectionId}`);
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
  aiModels() {
    return this.request(AiModelsResponse, "GET", "/ai/models");
  }
  /** Is the separate AI server on, asleep, or starting? */
  aiHost() {
    return this.request(AiHostStatus, "GET", "/ai/host");
  }
  /** Switch the AI server's VM on (needs a Proxmox token on the Vault server). */
  startAiHost() {
    return this.request(AiHostStatus, "POST", "/ai/host/start");
  }
  updateAiSettings(body: UpdateAiSettingsRequest) {
    return this.request(AiStatus, "POST", "/ai/settings", body);
  }
  /** Try an AI provider configuration without saving it. */
  testAiConnection(body: AiTestRequest) {
    return this.request(AiTestResponse, "POST", "/ai/test", body);
  }
  taxProfile() {
    return this.request(TaxProfileResponse, "GET", "/tax-profile");
  }
  saveTaxProfile(body: TaxProfileInput) {
    return this.request(TaxProfileResponse, "PUT", "/tax-profile", body);
  }
  /** What-if estimate for any profile; nothing is saved. */
  estimateTax(body: TaxProfileInput) {
    return this.request(TaxEstimateSchema, "POST", "/tax/estimate", body);
  }
  taxPlaces() {
    return this.request(TaxPlacesResponse, "GET", "/tax/places");
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
  /** Carry out a change the assistant proposed (server-side kinds). */
  approveAiAction(id: string) {
    return this.request(AiActionRecord, "POST", `/ai/actions/${id}/approve`, {});
  }
  rejectAiAction(id: string) {
    return this.request(AiActionRecord, "POST", `/ai/actions/${id}/reject`, {});
  }
  /** Record the outcome of a change the app applied itself (theme, review prefs). */
  reportAiAction(id: string, result: AiActionClientResult) {
    return this.request(AiActionRecord, "POST", `/ai/actions/${id}/result`, result);
  }
  /** The assistant's long-term memory for the signed-in user (append-only). */
  aiMemory() {
    return this.request(AiMemoryResponse, "GET", "/ai/memory");
  }

  /**
   * Streaming chat (ADR-0005). Parses NDJSON lines from raw chunks — a chunk
   * may contain several lines or a partial one, so a carry buffer reassembles
   * them. Calls onToken per token; resolves with the conversation id once the
   * server sends its terminal line. `events` receives the changes the
   * assistant proposed and any notes it saved to memory.
   */
  async chat(
    body: ChatRequest,
    onToken: (token: string) => void,
    events: {
      onActions?: (actions: AiActionRecord[]) => void;
      onRemembered?: (notes: string[]) => void;
      /** The model started reasoning before its answer (AI level High). */
      onThinking?: () => void;
      /** What the assistant is looking up right now (agent steps). */
      onStatus?: (status: string) => void;
      /** Stop button: abort to end the reply where it is. */
      signal?: AbortSignalLike;
    } = {},
  ): Promise<{ conversationId: string; stopped?: boolean }> {
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
    let startedId: string | null = null;
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
      if ("started" in data) startedId = data.conversationId;
      else if ("token" in data) onToken(data.token);
      else if ("thinking" in data) events.onThinking?.();
      else if ("status" in data) events.onStatus?.(data.status);
      else if ("actions" in data) events.onActions?.(data.actions);
      else if ("remembered" in data) events.onRemembered?.(data.remembered);
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
        events.signal,
      ));
    } catch (err) {
      if (events.signal?.aborted && startedId) return { conversationId: startedId, stopped: true };
      this.noteConnection("offline");
      throw new ApiConnectionError(err);
    }
    this.noteConnection("online");
    if (buffer) handleLine(buffer);
    if (events.signal?.aborted && !result) {
      if (startedId) return { conversationId: startedId, stopped: true };
      throw new ApiRequestError("INTERNAL", 499, "Stopped before the reply began.");
    }

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
  trends(months = 6) {
    return this.request(TrendsResponse, "GET", `/cashflow/trends?months=${months}`);
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
  buckets() {
    return this.request(BucketListResponse, "GET", "/buckets");
  }
  createBucket(body: CreateBucketRequest) {
    return this.request(Bucket, "POST", "/buckets", body);
  }
  updateBucket(id: string, body: UpdateBucketRequest) {
    return this.request(Bucket, "PATCH", `/buckets/${id}`, body);
  }
  deleteBucket(id: string) {
    return this.request(z.undefined(), "DELETE", `/buckets/${id}`);
  }
  moveBucketMoney(body: MoveBucketMoneyRequest) {
    return this.request(z.object({ ok: z.boolean() }), "POST", "/buckets/move", body);
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

  // ── Bills ──
  bills() {
    return this.request(BillListResponse, "GET", "/bills");
  }
  createBill(body: CreateBillRequest) {
    return this.request(Bill, "POST", "/bills", body);
  }
  updateBill(id: string, body: UpdateBillRequest) {
    return this.request(Bill, "PATCH", `/bills/${id}`, body);
  }
  contributeBill(id: string, deltaCents: number) {
    return this.request(Bill, "POST", `/bills/${id}/contribute`, { deltaCents });
  }
  deleteBill(id: string) {
    return this.request(z.undefined(), "DELETE", `/bills/${id}`);
  }

  // ── Giving & gift funds ──
  giving() {
    return this.request(GivingListResponse, "GET", "/giving");
  }
  createGivingFund(body: CreateGivingFundRequest) {
    return this.request(GivingFund, "POST", "/giving", body);
  }
  updateGivingFund(id: string, body: UpdateGivingFundRequest) {
    return this.request(GivingFund, "PATCH", `/giving/${id}`, body);
  }
  contributeGivingFund(id: string, deltaCents: number) {
    return this.request(GivingFund, "POST", `/giving/${id}/contribute`, { deltaCents });
  }
  deleteGivingFund(id: string) {
    return this.request(z.undefined(), "DELETE", `/giving/${id}`);
  }

  // ── Detected subscriptions ──
  subscriptions() {
    return this.request(SubscriptionListResponse, "GET", "/subscriptions");
  }

  // ── Insights ──
  insights() {
    return this.request(InsightListResponse, "GET", "/insights");
  }

  // ── Debt plan ──
  debtPlan() {
    return this.request(DebtPlan, "GET", "/debt-plan");
  }
  updateDebtPlan(body: UpdateDebtPlanRequest) {
    return this.request(DebtPlan, "PUT", "/debt-plan", body);
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
  /** Weekly or monthly finance review (the presenter's data). */
  periodReview(period: ReviewPeriod, start?: string) {
    return this.request(
      PeriodReview,
      "GET",
      `/reports/review?period=${period}${start ? `&start=${start}` : ""}`,
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
  budgetPlan() {
    return this.request(BudgetPlan, "GET", "/budget-plan");
  }
  updateBudgetPlan(body: UpdateBudgetPlanRequest) {
    return this.request(BudgetPlan, "PUT", "/budget-plan", body);
  }
}
