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
