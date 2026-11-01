import {
  AI_BASE_URL_EXAMPLES,
  AI_LEVEL_HINTS,
  AI_LEVEL_LABELS,
  AI_LEVELS,
  AI_MODEL_SUGGESTIONS,
  AI_PROVIDER_LABELS,
  AI_QUALITY_LABELS,
  AI_QUALITY_LEVELS,
  AiProvider,
  BANK_PROVIDER_LABELS,
  BankProvider,
  CLOUD_PROVIDERS,
  LOCAL_PROVIDERS,
  type AiStatus,
  type AiTestResponse,
  type BankStatus,
  type DeviceApprovalSettings,
  type DeviceKey,
  type DeviceSession,
  type EmailConnectionStatus,
  type InviteMemberResponse,
  mailServerFor,
  type PendingApproval,
  type TrustedDevice,
  type MemberListResponse,
  type UpdateStatusResponse,
  ApiRequestError,
  passwordProblem,
  type PlaidEnv,
} from "@vault/shared";
import { THEMES, THEME_LABELS } from "@vault/design-tokens";
import { Avatar, Button, Card, Dialog, Field, Segmented, Select, Spinner, Tabs, Tag } from "@vault/ui";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  getPrivateNetwork,
  PRIVATE_NETWORKS,
  type PrivateNetworkId,
  setPrivateNetwork,
  usesTailscaleClient,
} from "../../lib/privateNetwork.js";
import { REVIEW_SLIDE_LABELS, type ReviewPrefs } from "../../lib/reviewPrefs.js";
import { runChecks, type UiCheck } from "../../lib/startupChecks.js";
import { useCheckActions } from "../../lib/useCheckActions.js";
import { useData } from "../../lib/useData.js";
import { APP_VERSION, deviceKeySecret, useApp } from "../../state/store.js";
import { StatusList } from "../StatusList.js";
import { ApproveDialog, describeRequest } from "./DeviceApprovalPrompt.js";
import { TailscaleControl } from "../TailscaleControl.js";

type SettingsTab = "general" | "money" | "ai" | "security" | "connection" | "members" | "admin";

const SETTINGS_TABS: ReadonlyArray<{ value: SettingsTab; label: string; ownerOnly?: boolean }> = [
  { value: "general", label: "General" },
  { value: "money", label: "Money" },
  { value: "ai", label: "AI" },
  { value: "security", label: "Security" },
  { value: "connection", label: "Connection" },
  { value: "members", label: "Members", ownerOnly: true },
  { value: "admin", label: "Server & admin", ownerOnly: true },
];
const SETTINGS_TAB_KEY = "settings-tab";

/**
 * Settings, in tabs. Invited members only see what's theirs to change; the
 * server, updates, system checks, members and the admin console live in
 * owner-only tabs. The last tab is remembered on this device.
 */
export function SettingsPage({ initialTab }: { initialTab?: string } = {}) {
  const user = useApp((s) => s.user);
  const platform = useApp((s) => s.platform);
  const isOwner = user?.role === "owner";
  const tabs = SETTINGS_TABS.filter((t) => isOwner || !t.ownerOnly);
  const valid = (t: string | null | undefined): t is SettingsTab => !!t && tabs.some((x) => x.value === t);
  const [tab, setTab] = useState<SettingsTab>(valid(initialTab) ? initialTab : "general");

  useEffect(() => {
    if (valid(initialTab)) return;
    void platform.loadValue(SETTINGS_TAB_KEY).then((t) => {
      if (valid(t)) setTab(t);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, initialTab]);

  const choose = (t: SettingsTab) => {
    setTab(t);
    void platform.saveValue(SETTINGS_TAB_KEY, t);
  };

  return (
    <div className="page" style={{ maxWidth: 780 }}>
      <Tabs items={tabs} value={tab} onChange={choose} aria-label="Settings sections" />
      {tab === "general" && (
        <>
          <ProfileSection />
          <AppearanceSection />
          <ReviewSection />
          <HouseholdSection />
          <UpdatesSection />
        </>
      )}
      {tab === "money" && (
        <>
          <CategoryTreeSection />
          <CategorizationRulesSection />
          <BankSection />
        </>
      )}
      {tab === "ai" && (
        <>
          <AiSection />
          <AiMemorySection />
        </>
      )}
      {tab === "security" && (
        <>
          <AutoLockSection />
          <BiometricSection />
          <PasswordSection />
          <TwoFactorSection />
          <TrustedDevicesSection />
          <SessionsSection />
        </>
      )}
      {tab === "connection" && (
        <>
          <ServerSection />
          <NetworkSection />
        </>
      )}
      {tab === "members" && isOwner && <MembersSection />}
      {tab === "admin" && isOwner && (
        <>
          <SystemStatusSection />
          <ServerUpdateSection />
          <AdminLaunchRow />
        </>
      )}
    </div>
  );
}

const PROFILE_COLORS = ["#9184d9", "#6f8ef2", "#43cfc0", "#3ecf8e", "#d8b23c", "#f08a4b", "#ec6a9c", "#8a94a6"];

/** Square-crop and shrink a picture to 256×256 JPEG in the app, so uploads stay small. */
async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Your name, colour and profile picture — shown in the header, on the login screen and to your household. */
function ProfileSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const [name, setName] = useState(user?.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => setName(user?.displayName ?? ""), [user?.displayName]);
  if (!user) return null;

  const update = async (body: Parameters<typeof client.updateMe>[0]) => {
    setBusy(true);
    setError(null);
    try {
      const next = await client.updateMe(body);
      useApp.setState({ user: next });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save your profile.");
    } finally {
      setBusy(false);
    }
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      await update({ avatarImage: await toAvatarDataUrl(file) });
    } catch {
      setError("That file couldn't be read as a picture.");
    }
  };

  return (
    <Card kicker="You" title="Your profile">
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <Avatar name={user.displayName} color={user.avatarColor} image={user.avatarImage ?? null} size={72} />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button variant="secondary" icon="upload" onClick={() => fileRef.current?.click()} disabled={busy}>
              {user.avatarImage ? "Change photo" : "Add a photo"}
            </Button>
            {user.avatarImage && (
              <Button variant="ghost" onClick={() => void update({ avatarImage: null })} disabled={busy}>
                Remove photo
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={(e) => {
                void pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 6 }} role="radiogroup" aria-label="Profile colour">
            {PROFILE_COLORS.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={user.avatarColor === c}
                aria-label={`Colour ${c}`}
                onClick={() => void update({ avatarColor: c })}
                disabled={busy}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: c,
                  cursor: "pointer",
                  border: user.avatarColor === c ? "2px solid var(--color-text)" : "2px solid transparent",
                  boxShadow: "0 0 0 1px var(--color-divider)",
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <form
        style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== user.displayName) void update({ displayName: name.trim() });
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <Field label="Display name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </div>
        <Button type="submit" variant="secondary" disabled={busy || !name.trim() || name.trim() === user.displayName}>
          Save name
        </Button>
      </form>
      {error && (
        <p role="alert" style={{ color: "var(--color-negative)", fontSize: "var(--text-sm)" }}>
          {error}
        </p>
      )}
    </Card>
  );
}

function UpdatesSection() {
  const platform = useApp((s) => s.platform);
  // Same state as the header's update button — checking in one updates both.
  const state = useApp((s) => s.appUpdate);
  const check = useApp((s) => s.checkAppUpdate);
  const install = useApp((s) => s.installAppUpdate);

  // Browser dev mode has no updater — hide the card entirely.
  if (platform.kind !== "tauri") return null;

  return (
    <Card kicker="Application" title={`Updates — v${APP_VERSION}`}>
      <p className="card-body">
        Updates are downloaded from the project's GitHub releases and
        signature-checked before install — the only network request this app
        ever makes outside your own server. You can also update from the
        download button next to your avatar.
      </p>
      {state.phase === "available" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Tag variant="accent">v{state.version} available</Tag>
          <Button variant="primary" onClick={() => void install()}>
            Install & restart
          </Button>
        </div>
      ) : state.phase === "installing" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Spinner label="Installing update" />
          <span style={{ fontSize: "var(--text-sm)" }}>
            Downloading… {Math.round(state.progress * 100)}%
          </span>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Button
            variant="secondary"
            onClick={() => void check()}
            disabled={state.phase === "checking"}
          >
            {state.phase === "checking" ? <Spinner label="Checking" /> : "Check for updates"}
          </Button>
          {state.phase === "none" && (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--content-tertiary)" }}>
              You're on the latest version.
            </span>
          )}
          {state.phase === "error" && (
            <span role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
              {state.message}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

const codeStyle: CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  background: "var(--color-neutral-900)",
  padding: "1px 6px",
  borderRadius: 6,
};

/**
 * Server version + in-app updating. The owner can check now and, when the
 * host has the update agent (installers/server/enable-app-updates.sh), update
 * the server from here; we then poll until it comes back on the new version.
 * Members only see the card when an update is out.
 */
function ServerUpdateSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const isOwner = user?.role === "owner";
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [busy, setBusy] = useState<"check" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Set while the server is down mid-update (requests fail until it's back).
  const [restarting, setRestarting] = useState(false);
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);
  const startedFrom = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await client.updateStatus();
      setStatus(next);
      setRestarting(false);
      if (startedFrom.current && next.currentVersion !== startedFrom.current) {
        setUpdatedTo(next.currentVersion);
        startedFrom.current = null;
      } else if (next.selfUpdate?.state === "failed" || next.selfUpdate?.state === "succeeded") {
        startedFrom.current = null; // finished without a version change: show the agent's message
      }
    } catch {
      if (startedFrom.current) setRestarting(true);
      else setStatus(null);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const self = status?.selfUpdate ?? null;
  const inProgress =
    restarting || self?.state === "requested" || self?.state === "running" || startedFrom.current !== null;

  useEffect(() => {
    if (!inProgress) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [inProgress, load]);

  const checkNow = async () => {
    setBusy("check");
    setError(null);
    try {
      setStatus(await client.checkServerUpdate());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't check for updates.");
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    setConfirming(false);
    setBusy("start");
    setError(null);
    setUpdatedTo(null);
    try {
      const current = status?.currentVersion ?? null;
      setStatus(await client.startServerUpdate());
      startedFrom.current = current;
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't start the update.");
    } finally {
      setBusy(null);
    }
  };

  if (!status) return null;
  if (!isOwner && !status.updateAvailable) return null;

  const progressText = restarting
    ? "The server is restarting on the new version…"
    : self?.state === "requested"
      ? "Waiting for the server to start the update…"
      : (self?.message ?? "Updating…");

  return (
    <Card kicker="Server" title={`Server update — v${status.currentVersion}`}>
      {updatedTo ? (
        <p className="card-body">
          <Tag variant="positive">Updated</Tag> Your server is now on <strong>v{updatedTo}</strong>.
        </p>
      ) : status.updateAvailable ? (
        <p className="card-body">
          <strong>v{status.latestVersion}</strong> has been released. Your server is running{" "}
          <strong>v{status.currentVersion}</strong>.
        </p>
      ) : (
        <p className="card-body">
          Your server is on the latest version
          {status.checkedAt ? ` (checked ${new Date(status.checkedAt).toLocaleString()})` : ""}.
        </p>
      )}

      {inProgress ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Spinner label="Updating server" />
          <span style={{ fontSize: "var(--text-sm)" }}>{progressText}</span>
        </div>
      ) : status.operatorManaged ? (
        <p className="card-body">This server is managed by an administrator — they'll roll out the update.</p>
      ) : !isOwner ? (
        <p className="card-body">The household owner can install it from their Settings.</p>
      ) : (
        <>
          {self?.state === "failed" && self.message && (
            <p role="alert" className="card-body" style={{ color: "var(--color-negative)" }}>
              {self.message}
            </p>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {status.updateAvailable && self && (
              <Button variant="primary" onClick={() => setConfirming(true)} disabled={busy !== null}>
                {busy === "start" ? (
                  <Spinner label="Starting" />
                ) : self.state === "failed" ? (
                  "Try again"
                ) : (
                  `Update server to v${status.latestVersion}`
                )}
              </Button>
            )}
            <Button variant="secondary" onClick={() => void checkNow()} disabled={busy !== null}>
              {busy === "check" ? <Spinner label="Checking" /> : "Check now"}
            </Button>
          </div>
          {status.updateAvailable && !self && (
            <p className="card-body">
              To update, run <code style={codeStyle}>vault-update</code> on the machine hosting your server. To
              update from here instead, run <code style={codeStyle}>installers/server/enable-app-updates.sh</code>{" "}
              there once.
            </p>
          )}
        </>
      )}

      {error && (
        <p role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
          {error}
        </p>
      )}
      {status.notesUrl && status.updateAvailable && (
        <p className="card-meta">
          Release notes: <span style={{ userSelect: "all" }}>{status.notesUrl}</span>
        </p>
      )}

      <Dialog
        open={confirming}
        title={`Update the server to v${status.latestVersion}?`}
        onClose={() => setConfirming(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void start()}>
              Update server
            </Button>
          </>
        }
      >
        The server downloads the new version and restarts, which usually takes a minute or two. Everyone using
        Vault Finance is disconnected briefly and reconnects on their own. Your data isn't touched.
      </Dialog>
    </Card>
  );
}

/**
 * The household's own name. Everyone on this server already shares one
 * household; this names it. Members see it, only the owner can change it.
 */
function HouseholdSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const householdName = useApp((s) => s.householdName);
  const setHouseholdName = useApp((s) => s.setHouseholdName);
  const [draft, setDraft] = useState(householdName ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(householdName ?? ""), [householdName]);

  const owner = user?.role === "owner";
  const dirty = draft.trim() !== (householdName ?? "") && draft.trim().length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const h = await client.renameHousehold(draft.trim());
      setHouseholdName(h.name);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the name.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card kicker="Household" title={householdName ?? "Your household"}>
      <p className="card-body">
        Everyone who signs in to this server is part of the same household and
        shares its accounts. Its name appears on the sign-in screen and in the
        sidebar{owner ? "" : " — the household owner can change it"}.
      </p>
      {owner && (
        <form
          style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", maxWidth: 460 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !busy) void save();
          }}
        >
          <div style={{ flex: 1, minWidth: 220 }}>
            <Field
              label="Household name"
              value={draft}
              maxLength={60}
              placeholder="e.g. The Carters"
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <Button variant="primary" type="submit" disabled={!dirty || busy}>
            {busy ? <Spinner label="Saving" /> : "Save"}
          </Button>
        </form>
      )}
      {saved && !dirty && (
        <p className="card-meta" style={{ color: "var(--color-positive)" }}>Saved.</p>
      )}
      {error && (
        <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}
    </Card>
  );
}

/**
 * Household members. Only the owner (the household's "sub-admin") sees this;
 * members are hidden from it entirely.
 */
function MembersSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const [data, setData] = useState<MemberListResponse | null>(null);
  const platform = useApp((s) => s.platform);
  const [mode, setMode] = useState<"none" | "connect" | "invite" | "create">("none");
  const [form, setForm] = useState({ displayName: "", email: "", tempPassword: "" });
  const [emailStatus, setEmailStatus] = useState<EmailConnectionStatus | null>(null);
  const [connect, setConnect] = useState({ email: "", password: "", host: "", port: "587" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteResult, setInviteResult] = useState<(InviteMemberResponse & { to: string }) | null>(null);
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null);

  const reload = useCallback(() => {
    client
      .members()
      .then(setData)
      .catch(() => setData(null));
    client
      .emailConnection()
      .then(setEmailStatus)
      .catch(() => setEmailStatus(null));
  }, [client]);
  useEffect(reload, [reload]);

  if (user?.role !== "owner") return null;

  const canSendEmail = Boolean(emailStatus?.connected || emailStatus?.serverMailAvailable);
  const connectDomain = connect.email.trim().toLowerCase().split("@")[1] ?? "";
  const isGmail = connectDomain === "gmail.com" || connectDomain === "googlemail.com";
  const needsMailServer = connect.email.includes("@") && !mailServerFor(connect.email);

  const startInvite = () => {
    setError(null);
    if (canSendEmail) {
      setMode("invite");
    } else {
      setConnect({ email: user.email ?? "", password: "", host: "", port: "587" });
      setMode("connect");
    }
  };

  const openInBrowser = (url: string) => {
    if (platform.openExternal) void platform.openExternal(url);
    else window.open(url, "_blank", "noopener");
  };

  const disconnect = async () => {
    setError(null);
    try {
      setEmailStatus(await client.disconnectEmail());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't disconnect your email.");
    }
  };

  const reset = () => {
    setMode("none");
    setForm({ displayName: "", email: "", tempPassword: "" });
    setConnect({ email: "", password: "", host: "", port: "587" });
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "connect") {
        const port = Number(connect.port);
        setEmailStatus(
          await client.connectEmail({
            email: connect.email.trim(),
            password: connect.password,
            ...(needsMailServer
              ? { host: connect.host.trim(), port: Number.isInteger(port) ? port : 587 }
              : {}),
          }),
        );
        // Connected: go straight on to the thing they came here to do.
        setConnect({ email: "", password: "", host: "", port: "587" });
        setMode("invite");
        setBusy(false);
        return;
      }
      if (mode === "invite") {
        const to = form.email.trim();
        const result = await client.inviteMember({ email: to, serverUrl: client.baseUrl });
        setInviteResult({ ...result, to });
      } else {
        await client.createMember({
          displayName: form.displayName.trim(),
          email: form.email.trim(),
          tempPassword: form.tempPassword,
        });
      }
      reset();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    await client.removeMember(removing.id).catch(() => {});
    setRemoving(null);
    reload();
  };

  return (
    <Card kicker="Household" title="Family members">
      <p className="card-body">
        Everyone here shares the same accounts and transactions. Invite people by
        email, or create an account with a temporary password you hand to them.
      </p>

      {emailStatus?.connected && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 8,
            fontSize: "var(--text-sm)",
          }}
        >
          <span>Invites send from {emailStatus.fromEmail}</span>
          <Button variant="ghost" onClick={() => void disconnect()}>
            Disconnect email
          </Button>
        </div>
      )}

      {data === null ? (
        <Spinner label="Loading members" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id}>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <Avatar name={m.displayName} color={m.avatarColor ?? "#9184d9"} image={m.avatarImage ?? null} size={26} />
                    {m.displayName}
                  </span>
                </td>
                <td>{m.email}</td>
                <td style={{ textTransform: "capitalize" }}>{m.role}</td>
                <td style={{ textAlign: "right" }}>
                  {m.role !== "owner" && m.id !== user.id && (
                    <Button
                      variant="ghost"
                      onClick={() => setRemoving({ id: m.id, label: m.displayName })}
                    >
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {data.invites.map((i) => (
              <tr key={i.id} style={{ opacity: 0.7 }}>
                <td>{i.displayName}</td>
                <td>{i.email}</td>
                <td>
                  <Tag>invite pending</Tag>
                </td>
                <td style={{ textAlign: "right" }}>
                  <Button
                    variant="ghost"
                    onClick={() => setRemoving({ id: i.id, label: `the invite for ${i.email}` })}
                  >
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {mode === "none" ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <Button variant="secondary" onClick={startInvite}>
            Invite by email
          </Button>
          <Button variant="ghost" onClick={() => setMode("create")}>
            Add with temporary password
          </Button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10, marginTop: 12, maxWidth: 360 }}>
          {mode === "connect" && (
            <>
              <p className="card-body" style={{ margin: 0 }}>
                Connect your email once, and invites will come from your address. Use an app
                password, not your normal password. It's stored encrypted on your server.
              </p>
              <Field
                label="Your email"
                type="email"
                value={connect.email}
                onChange={(e) => setConnect({ ...connect, email: e.target.value })}
                autoFocus
              />
              {isGmail && (
                <div>
                  <Button
                    variant="ghost"
                    onClick={() => openInBrowser("https://myaccount.google.com/apppasswords")}
                  >
                    Create a Google app password
                  </Button>
                  <p className="card-body" style={{ margin: "4px 0 0" }}>
                    Google requires 2-Step Verification to be on first.
                  </p>
                </div>
              )}
              <Field
                label="App password"
                type="password"
                autoComplete="off"
                value={connect.password}
                onChange={(e) => setConnect({ ...connect, password: e.target.value })}
              />
              {needsMailServer && (
                <>
                  <Field
                    label="Mail server"
                    placeholder="smtp.example.com"
                    hint="Your email provider lists this in its help pages. Outlook and Hotmail may not allow app-password sign-in."
                    value={connect.host}
                    onChange={(e) => setConnect({ ...connect, host: e.target.value })}
                  />
                  <Field
                    label="Port"
                    inputMode="numeric"
                    value={connect.port}
                    onChange={(e) => setConnect({ ...connect, port: e.target.value })}
                  />
                </>
              )}
            </>
          )}
          {mode === "create" && (
            <Field
              label="Name"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              autoFocus
            />
          )}
          {mode !== "connect" && (
            <Field
              label={mode === "invite" ? "Their email" : "Email"}
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              autoFocus={mode === "invite"}
            />
          )}
          {mode === "create" && (
            <Field
              label="Temporary password (min 12 characters)"
              type="text"
              value={form.tempPassword}
              onChange={(e) => setForm({ ...form, tempPassword: e.target.value })}
            />
          )}
          {error && (
            <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" onClick={() => void submit()} disabled={busy}>
              {busy ? (
                <Spinner label="Working" />
              ) : mode === "connect" ? (
                "Connect email"
              ) : mode === "invite" ? (
                "Send invite"
              ) : (
                "Create account"
              )}
            </Button>
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={inviteResult !== null}
        title={inviteResult?.emailed ? "Invite sent" : "Invite not emailed"}
        onClose={() => setInviteResult(null)}
        actions={
          <Button variant="primary" onClick={() => setInviteResult(null)}>
            Done
          </Button>
        }
      >
        {inviteResult?.emailed ? (
          <>
            Sent to {inviteResult.to}
            {inviteResult.sentFrom ? ` from ${inviteResult.sentFrom}` : ""}. It can take a minute to
            arrive, so ask them to check spam too. They'll need to be on the same home Wi-Fi or
            private network (VPN) as this server to open it. You can also share this one-time link:
          </>
        ) : (
          <>
            {inviteResult?.emailProblem ?? "The email couldn't be sent."} The invite is still
            valid, so you can share this one-time link yourself:
          </>
        )}
        <div
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: "var(--text-xs)",
            wordBreak: "break-all",
            marginTop: 8,
            userSelect: "all",
          }}
        >
          {inviteResult?.inviteUrl}
        </div>
      </Dialog>

      <Dialog
        open={removing !== null}
        title="Remove access?"
        onClose={() => setRemoving(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void remove()}>
              Remove
            </Button>
          </>
        }
      >
        {removing?.label} will lose access immediately. Shared data stays.
      </Dialog>
    </Card>
  );
}

/**
 * Discreet, owner-only entry point to the hosting admin console. Opens a
 * separate OS window (see screens/admin) — nothing admin-related renders in the
 * normal shell. Hidden unless the platform exposes an admin console at all.
 */
function AdminLaunchRow() {
  const user = useApp((s) => s.user);
  const platform = useApp((s) => s.platform);
  if (user?.role !== "owner" || !platform.openAdminConsole) return null;
  return (
    <div style={{ marginTop: 24, textAlign: "center" }}>
      <button
        onClick={() => void platform.openAdminConsole?.()}
        style={{
          background: "none",
          border: 0,
          color: "var(--content-tertiary)",
          font: "inherit",
          fontSize: "var(--text-xs)",
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        Server administration…
      </button>
    </div>
  );
}

const STRUCTURE_COLORS = [
  "#7c5cff",
  "#5b8def",
  "#3ecf8e",
  "#e0a458",
  "#c96f9c",
  "#4db6d0",
  "#8b7cf0",
  "#5fbf8f",
];

type TreeCat = {
  id: string;
  name: string;
  color: string;
  parentCategoryId: string | null;
  sortOrder: number;
  kind: "income" | "expense";
  isSystem: boolean;
};

const treeIconBtn: CSSProperties = {
  border: 0,
  background: "none",
  cursor: "pointer",
  color: "var(--content-tertiary)",
  font: "inherit",
  fontSize: "var(--text-md)",
  lineHeight: 1,
  padding: "0 2px",
};

function CategoryTreeNode({
  cat,
  childrenOf,
  onAdd,
  onRename,
  onRecolor,
  onRemove,
  onMove,
  onDragStartNode,
  onDropOnNode,
  isFirst,
  isLast,
  busy,
}: {
  cat: TreeCat;
  childrenOf: (id: string | null) => TreeCat[];
  onAdd: (parentId: string | null) => void;
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: "up" | "down") => void;
  onDragStartNode: (id: string) => void;
  onDropOnNode: (targetId: string | null) => void;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
}) {
  const kids = childrenOf(cat.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cat.name);
  const [over, setOver] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <div
        draggable={!editing}
        onDragStart={(e) => {
          e.stopPropagation();
          onDragStartNode(cat.id);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          onDropOnNode(cat.id);
        }}
        title="Drag onto another category to move it there"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 9px",
          border: over ? "1px solid var(--color-accent)" : "1px solid var(--color-divider)",
          borderRadius: "var(--radius-md)",
          background: over
            ? "color-mix(in srgb, var(--color-accent) 12%, var(--color-surface))"
            : "var(--color-surface)",
          whiteSpace: "nowrap",
          boxShadow: "var(--shadow-sm)",
          cursor: "grab",
        }}
      >
        {/* The swatch is the colour control. A category's colour is what paints
            its ribbon in both Sankey diagrams and its bar in Budgets, so this
            is where the shape *and* the palette of those charts is set. */}
        <label
          title={`Colour for ${cat.name} — used in the cash-flow and budget diagrams`}
          style={{
            width: 14,
            height: 14,
            borderRadius: "var(--radius-sm)",
            background: cat.color,
            flex: "0 0 auto",
            cursor: "pointer",
            position: "relative",
            boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--color-text) 25%, transparent)",
          }}
        >
          <input
            type="color"
            value={cat.color}
            onChange={(e) => onRecolor(cat.id, e.target.value)}
            style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }}
          />
        </label>
        {editing ? (
          <input
            autoFocus
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (draft.trim() && draft.trim() !== cat.name) onRename(cat.id, draft.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setDraft(cat.name);
                setEditing(false);
              }
            }}
            style={{ width: 150, padding: "2px 6px", fontSize: "var(--text-sm)" }}
          />
        ) : (
          <button
            onClick={() => {
              setDraft(cat.name);
              setEditing(true);
            }}
            title="Rename"
            style={{
              background: "none",
              border: 0,
              font: "inherit",
              fontWeight: 600,
              fontSize: "var(--text-sm)",
              cursor: "text",
              color: "var(--color-text)",
            }}
          >
            {cat.name}
          </button>
        )}
        {cat.isSystem && <Tag>system</Tag>}
        <button
          title="Move up"
          disabled={isFirst}
          onClick={() => onMove(cat.id, "up")}
          style={{ ...treeIconBtn, opacity: isFirst ? 0.25 : 1, cursor: isFirst ? "default" : "pointer" }}
        >
          ▲
        </button>
        <button
          title="Move down"
          disabled={isLast}
          onClick={() => onMove(cat.id, "down")}
          style={{ ...treeIconBtn, opacity: isLast ? 0.25 : 1, cursor: isLast ? "default" : "pointer" }}
        >
          ▼
        </button>
        <button title="Add branch" onClick={() => onAdd(cat.id)} style={treeIconBtn}>
          ＋
        </button>
        {!cat.isSystem && (
          <button
            title="Delete"
            disabled={busy}
            onClick={() => onRemove(cat.id)}
            style={{ ...treeIconBtn, color: "var(--color-negative)" }}
          >
            ×
          </button>
        )}
      </div>
      {kids.length > 0 && (
        <>
          <div
            style={{ width: 20, height: 1, background: "var(--color-divider)", flex: "0 0 auto" }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              borderLeft: "1px solid var(--color-divider)",
            }}
          >
            {kids.map((k, i) => (
              <div key={k.id} style={{ display: "flex", alignItems: "center" }}>
                <div
                  style={{ width: 14, height: 1, background: "var(--color-divider)", flex: "0 0 auto" }}
                />
                <CategoryTreeNode
                  cat={k}
                  childrenOf={childrenOf}
                  onAdd={onAdd}
                  onRename={onRename}
                  onRecolor={onRecolor}
                  onRemove={onRemove}
                  onMove={onMove}
                  onDragStartNode={onDragStartNode}
                  onDropOnNode={onDropOnNode}
                  isFirst={i === 0}
                  isLast={i === kids.length - 1}
                  busy={busy}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Interactive tree editor for the category hierarchy — the structure that
 * shapes the cash-flow Sankey. It grows to the right: a category's sub-branches
 * sit to its right, connected by lines. Click a name to rename, ＋ to add a
 * branch, × to delete.
 */
function CategoryTreeSection() {
  const client = useApp((s) => s.client);
  const { data, reload } = useData(() => client.categories(), [client]);
  // Spending tree = expense categories only; income sources are managed on the
  // Income page.
  const categories = (data?.categories ?? []).filter(
    (c) => (c as TreeCat).kind !== "income",
  ) as TreeCat[];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const childrenOf = (id: string | null) =>
    categories
      .filter((c) => (c.parentCategoryId ?? null) === id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const addChild = async (parentId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await client.createCategory({
        name: "New category",
        color: STRUCTURE_COLORS[categories.length % STRUCTURE_COLORS.length]!,
        parentCategoryId: parentId,
      });
      await reload();
    } catch {
      setError("Couldn't add the branch.");
    } finally {
      setBusy(false);
    }
  };
  const rename = async (id: string, name: string) => {
    await client.updateCategory(id, { name }).catch(() => setError("Couldn't rename."));
    await reload();
  };
  // Native colour inputs fire on every drag of the picker, so debounce the
  // write and only reload once the user settles on a colour.
  const recolorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recolor = (id: string, color: string) => {
    if (recolorTimer.current) clearTimeout(recolorTimer.current);
    recolorTimer.current = setTimeout(() => {
      void client
        .updateCategory(id, { color })
        .then(() => reload())
        .catch(() => setError("Couldn't change the colour."));
    }, 250);
  };
  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.deleteCategory(id);
      await reload();
    } catch {
      setError(
        "That category is in use (transactions or budgets) or is a system default — reassign those first.",
      );
    } finally {
      setBusy(false);
    }
  };
  const move = async (id: string, direction: "up" | "down") => {
    setError(null);
    await client.moveCategory(id, direction).catch(() => setError("Couldn't reorder that category."));
    await reload();
  };

  // Drag-to-reparent. dragId is held in a ref (survives re-renders during drag).
  const dragId = useRef<string | null>(null);
  const isDescendant = (targetId: string, ancestorId: string): boolean => {
    let cur = categories.find((c) => c.id === targetId);
    while (cur?.parentCategoryId) {
      if (cur.parentCategoryId === ancestorId) return true;
      cur = categories.find((c) => c.id === cur!.parentCategoryId);
    }
    return false;
  };
  const onDropOn = async (targetId: string | null) => {
    const src = dragId.current;
    dragId.current = null;
    if (!src || src === targetId) return;
    // Can't move a node under itself or one of its own descendants.
    if (targetId && isDescendant(targetId, src)) {
      setError("Can't move a category under one of its own branches.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.updateCategory(src, { parentCategoryId: targetId });
      await reload();
    } catch {
      setError("Couldn't move that category.");
    } finally {
      setBusy(false);
    }
  };

  const roots = childrenOf(null);
  return (
    <Card kicker="Categories" title="Category tree">
      <p className="card-meta">
        The one place to shape both the cash-flow and budget-planner Sankeys. The tree grows to the
        right — a category’s sub-branches sit to its right. Click a name to rename, ▲▼ to reorder
        among siblings, ＋ to add a branch, × to delete, and drag a node onto another to move it (or
        onto “Top level” to un-nest it).
      </p>
      <div style={{ overflowX: "auto", padding: "10px 2px" }}>
        {roots.length === 0 ? (
          <p className="card-meta">No categories yet — add one below.</p>
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: "max-content" }}
          >
            {roots.map((c, i) => (
              <CategoryTreeNode
                key={c.id}
                cat={c}
                childrenOf={childrenOf}
                onAdd={addChild}
                onRename={rename}
                onRecolor={recolor}
                onRemove={remove}
                onMove={move}
                onDragStartNode={(id) => (dragId.current = id)}
                onDropOnNode={onDropOn}
                isFirst={i === 0}
                isLast={i === roots.length - 1}
                busy={busy}
              />
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <Button variant="secondary" onClick={() => void addChild(null)}>
          ＋ Add top-level category
        </Button>
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onDropOn(null);
          }}
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--content-tertiary)",
            border: "1px dashed var(--color-divider)",
            borderRadius: "var(--radius-md)",
            padding: "6px 12px",
          }}
        >
          ↳ Drop here for “Top level”
        </div>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}
    </Card>
  );
}

/**
 * Manage explicit keyword → category rules for local auto-categorization. These
 * run alongside history-learning (which needs no config); both are local and
 * never involve the AI assistant.
 */
function CategorizationRulesSection() {
  const client = useApp((s) => s.client);
  const { data: ruleData, reload } = useData(() => client.categorizationRules(), [client]);
  const { data: catData } = useData(() => client.categories(), [client]);
  const rules = ruleData?.rules ?? [];
  const categories = catData?.categories ?? [];
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? "Unknown";

  const [keyword, setKeyword] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!keyword.trim() || !categoryId) return;
    setBusy(true);
    setError(null);
    try {
      await client.createCategorizationRule({ keyword: keyword.trim(), categoryId });
      setKeyword("");
      setCategoryId("");
      await reload();
    } catch {
      setError("Couldn't add that rule.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    await client.deleteCategorizationRule(id).catch(() => {});
    await reload();
  };

  return (
    <Card kicker="Categorization" title="Auto-categorization rules">
      <p className="card-meta">
        When a transaction’s merchant name contains a keyword, file it under the chosen category —
        applied on CSV import and when you press “Auto-categorize” on the Transactions page. Entirely
        local; the AI assistant is never involved. Beyond these rules, the app also learns from how
        you’ve categorized transactions before.
      </p>

      <div style={{ margin: "12px 0" }}>
        {rules.length === 0 ? (
          <p className="card-meta">No keyword rules yet — history-learning still works without them.</p>
        ) : (
          rules.map((r) => (
            <div
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 0",
                borderTop: "1px solid var(--color-divider)",
              }}
            >
              <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>“{r.keyword}”</span>
              <span style={{ color: "var(--content-tertiary)", fontSize: "var(--text-sm)" }}>
                → {catName(r.categoryId)}
              </span>
              <div style={{ marginLeft: "auto" }}>
                <Button variant="ghost" onClick={() => remove(r.id)}>
                  Delete
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: 2, minWidth: 150 }}>
          <Field
            label="Keyword in merchant name"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="e.g. Starbucks"
          />
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          <Select label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="primary" onClick={add} disabled={busy || !keyword.trim() || !categoryId}>
          Add rule
        </Button>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}
    </Card>
  );
}

function AiSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const refreshAiEnabled = useApp((s) => s.refreshAiEnabled);
  const { data: status, reload } = useData<AiStatus>(() => client.aiStatus(), [client]);

  const [provider, setProvider] = useState<AiProvider>("ollama");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [qualityModels, setQualityModels] = useState<Record<string, string>>({});
  const [showModelNames, setShowModelNames] = useState(false);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<AiTestResponse | null>(null);

  // Seed the form from server state until the user starts editing.
  useEffect(() => {
    if (status && !dirty) {
      setProvider(status.provider);
      setModel(status.model);
      setBaseUrl(status.baseUrl);
      setEnabled(status.enabled);
      setQualityModels(status.qualityModels ?? {});
      setShowModelNames(status.showModelNames);
      setInstalledModels(status.availableModels);
      setApiKey(""); // never populated — the key is write-only
    }
  }, [status, dirty]);

  const isOwner = user?.role === "owner";
  const touch = () => setDirty(true);
  const isCloud = CLOUD_PROVIDERS.has(provider);
  const isLocal = LOCAL_PROVIDERS.has(provider);

  /**
   * Test what's in the form (not what's saved) — the server reaches out to the
   * address, so this also proves the Vault server can see a separate AI machine.
   */
  const testConnection = async () => {
    setRefreshing(true);
    setError(null);
    setTest(null);
    try {
      const r = await client.testAiConnection({
        provider,
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setTest(r);
      if (r.ok) {
        setInstalledModels(r.models);
        if (r.models.length === 0) {
          setError(
            provider === "ollama"
              ? "Connected, but no models are installed. On the AI machine run e.g. “ollama pull llama3.2:3b”."
              : "Connected, but the server has no model loaded yet.",
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't run the connection test.");
    } finally {
      setRefreshing(false);
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // For Ollama the concrete "model" is derived from the quality map (Normal
      // tier is the sensible default the provider config falls back to).
      const resolvedModel = isLocal
        ? qualityModels.normal || installedModels[0] || model || "llama3.2:3b"
        : model;
      await client.updateAiSettings({
        enabled,
        provider,
        model: resolvedModel.trim(),
        // Only send the key when the user typed one — blank leaves the stored
        // key untouched (they can clear it with the button below).
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        baseUrl: baseUrl.trim(),
        ...(isLocal ? { qualityModels } : {}),
        showModelNames,
      });
      setApiKey("");
      setDirty(false);
      reload();
      await refreshAiEnabled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save AI settings.");
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    try {
      await client.updateAiSettings({ enabled, provider, model: model.trim(), apiKey: "", baseUrl: baseUrl.trim() });
      setApiKey("");
      setDirty(false);
      reload();
      await refreshAiEnabled();
    } finally {
      setBusy(false);
    }
  };

  const statusLine = (s: AiStatus): string => {
    if (!s.enabled) return "Off";
    if (!s.configured) return "Needs configuration";
    if (s.reachable) {
      return s.availableModels.length > 0
        ? `Connected — ${s.availableModels.length} model${s.availableModels.length === 1 ? "" : "s"} available`
        : "Connected";
    }
    return "Unreachable";
  };

  return (
    <Card kicker="AI assistant" title="AI assistant (optional)">
      {status === null ? (
        <Spinner label="Checking AI status" />
      ) : (
        <>
          <p className="card-body">
            Off by default. Turn it on and connect a provider to get spending
            explanations, forecasts, and monthly summaries. The server talks to
            the provider — the desktop app never holds your key.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: !status.enabled
                  ? "var(--color-neutral-600)"
                  : status.configured && status.reachable
                    ? "var(--color-positive)"
                    : "var(--color-negative)",
              }}
            />
            <span style={{ fontSize: "var(--text-sm)" }}>{statusLine(status)}</span>
            {status.enabled && status.configured && (
              <Button variant="ghost" onClick={reload} style={{ marginLeft: "auto" }}>
                Check again
              </Button>
            )}
          </div>
          {status.enabled && status.configured && !status.reachable && status.error && (
            <div className="card-meta" style={{ lineHeight: 1.5 }}>
              <strong>{status.error}</strong> {status.hint}
            </div>
          )}

          {!isOwner ? (
            <p className="card-meta">Only the owner can change AI settings.</p>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Select
                    label="Provider"
                    value={provider}
                    onChange={(e) => {
                      const next = e.target.value as AiProvider;
                      setProvider(next);
                      // Reset per-provider fields to that provider's default.
                      setModel(AI_MODEL_SUGGESTIONS[next][0] ?? "");
                      const example = AI_BASE_URL_EXAMPLES[next];
                      const isExample = Object.values(AI_BASE_URL_EXAMPLES).includes(baseUrl.trim());
                      if (example && (!baseUrl.trim() || isExample)) setBaseUrl(example);
                      setApiKey("");
                      setTest(null);
                      touch();
                    }}
                  >
                    {AiProvider.options.map((p) => (
                      <option key={p} value={p}>
                        {AI_PROVIDER_LABELS[p]}
                      </option>
                    ))}
                  </Select>
                </div>
                {isCloud && (
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <Field
                      label="Model"
                      value={model}
                      list="ai-model-suggestions"
                      onChange={(e) => {
                        setModel(e.target.value);
                        touch();
                      }}
                      placeholder={AI_MODEL_SUGGESTIONS[provider][0]}
                    />
                    <datalist id="ai-model-suggestions">
                      {AI_MODEL_SUGGESTIONS[provider].map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </div>
                )}
              </div>

              {isLocal ? (
                <>
                  <Field
                    label={provider === "ollama" ? "Ollama address" : "AI server address"}
                    value={baseUrl}
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      setTest(null);
                      touch();
                    }}
                    placeholder={AI_BASE_URL_EXAMPLES[provider]}
                    spellCheck={false}
                    hint={
                      provider === "ollama"
                        ? "“http://ollama:11434” is the Ollama bundled with your server. For Ollama on another computer (e.g. a PC with a GPU), use its LAN or Tailscale address, like http://192.168.1.50:11434 — and on that computer set OLLAMA_HOST=0.0.0.0 so it accepts connections from the network."
                        : "LM Studio, llama.cpp (llama-server), vLLM, LocalAI, Jan and similar. The address usually ends in /v1, like http://192.168.1.50:1234/v1. Make sure the server listens on the network, not only on localhost."
                    }
                  />
                  <Field
                    label="Access token (optional)"
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      touch();
                    }}
                    placeholder={
                      status.hasApiKey && status.provider === provider
                        ? "•••••••• (saved — leave blank to keep)"
                        : "Only if your AI server asks for one"
                    }
                    hint="For an AI server behind a login or reverse proxy. Stored on your Vault server only."
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <Button variant="secondary" onClick={() => void testConnection()} disabled={refreshing || !baseUrl.trim()}>
                      {refreshing ? <Spinner label="Testing" /> : "Test connection"}
                    </Button>
                    {test?.ok && (
                      <span style={{ fontSize: "var(--text-sm)", color: "var(--color-positive)" }}>
                        Connected · {test.models.length} model{test.models.length === 1 ? "" : "s"} · {test.latencyMs} ms
                      </span>
                    )}
                  </div>
                  {test && !test.ok && (
                    <div
                      role="alert"
                      style={{
                        fontSize: "var(--text-sm)",
                        lineHeight: 1.55,
                        padding: "10px 12px",
                        borderRadius: "var(--radius-md)",
                        background: "var(--color-negative-soft)",
                      }}
                    >
                      <strong>{test.error}</strong>
                      {test.hint && <div style={{ marginTop: 4 }}>{test.hint}</div>}
                    </div>
                  )}
                </>
              ) : (
                <Field
                  label={`${AI_PROVIDER_LABELS[provider]} API key`}
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    touch();
                  }}
                  placeholder={
                    status.hasApiKey && status.provider === provider
                      ? "•••••••• (saved — leave blank to keep)"
                      : "sk-…"
                  }
                  hint={
                    status.hasApiKey && status.provider === provider ? (
                      <>
                        A key is saved.{" "}
                        <button
                          type="button"
                          onClick={() => void clearKey()}
                          style={{
                            background: "none",
                            border: 0,
                            padding: 0,
                            color: "var(--color-accent)",
                            cursor: "pointer",
                            font: "inherit",
                          }}
                        >
                          Remove it
                        </button>
                        .
                      </>
                    ) : (
                      "Stored on your server, never on this device."
                    )
                  }
                />
              )}

              {isLocal && (
                <div style={{ marginTop: 4 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    <span style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>Model quality levels</span>
                    <Button
                      variant="ghost"
                      onClick={() => void testConnection()}
                      disabled={refreshing || !baseUrl.trim()}
                    >
                      {refreshing ? "Refreshing…" : "Refresh installed models"}
                    </Button>
                  </div>
                  <p className="card-meta" style={{ marginTop: 2 }}>
                    Assign an installed model to each quality tier — the app requests a tier and you
                    decide which model runs it. The assistant's AI level picker uses Low, Medium and
                    High; categorizing uses Medium and monthly report summaries use High.
                  </p>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: 10,
                      marginTop: 8,
                    }}
                  >
                    {AI_QUALITY_LEVELS.map((level) => {
                      const val = qualityModels[level] ?? "";
                      const missing = val !== "" && !installedModels.includes(val);
                      return (
                        <div key={level}>
                          <Select
                            label={
                              showModelNames && val
                                ? `${AI_QUALITY_LABELS[level]} (${val})`
                                : AI_QUALITY_LABELS[level]
                            }
                            value={val}
                            onChange={(e) => {
                              const m = e.target.value;
                              setQualityModels((prev) => ({ ...prev, [level]: m }));
                              touch();
                            }}
                          >
                            <option value="">Not set</option>
                            {installedModels.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                            {missing && <option value={val}>{val} (not installed)</option>}
                          </Select>
                          {missing && (
                            <div
                              style={{ fontSize: "var(--text-xs)", color: "var(--color-negative)", marginTop: 3 }}
                            >
                              Not installed — pull it or pick another.
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <label className="radio" style={{ fontSize: "var(--text-sm)", marginTop: 10 }}>
                    <input
                      type="checkbox"
                      checked={showModelNames}
                      onChange={(e) => {
                        setShowModelNames(e.target.checked);
                        touch();
                      }}
                    />
                    <span className="dot" style={{ borderRadius: "var(--radius-sm)" }} />
                    Show technical model names
                  </label>
                </div>
              )}

              {isCloud && (
                <div
                  role="note"
                  style={{
                    fontSize: "var(--text-sm)",
                    lineHeight: 1.6,
                    padding: "10px 12px",
                    borderRadius: "var(--radius-md)",
                    background: "color-mix(in srgb, var(--color-negative) 10%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--color-negative) 35%, transparent)",
                  }}
                >
                  <strong>Heads up:</strong> {AI_PROVIDER_LABELS[provider]} is a cloud
                  service. When you ask a question, a summary of your accounts,
                  spending, and budgets is sent to {AI_PROVIDER_LABELS[provider]} under
                  your API key. Choose Ollama to keep everything on your own hardware.
                </div>
              )}

              <label className="radio" style={{ fontSize: "var(--text-sm)" }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => {
                    setEnabled(e.target.checked);
                    touch();
                  }}
                />
                <span className="dot" style={{ borderRadius: "var(--radius-sm)" }} />
                Enable the AI assistant
              </label>

              {error && (
                <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
                  {error}
                </div>
              )}
              <div>
                <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy}>
                  {busy ? <Spinner label="Saving" /> : "Save & test"}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Optional bank linking (ADR-0007). Off by default. The "mock" provider is
 * fully local; "plaid" routes data through Plaid under the owner's own keys —
 * the privacy tradeoff the banner spells out before it's enabled.
 */
function BankSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const { data: status, reload } = useData<BankStatus>(() => client.bankStatus(), [client]);

  const platform = useApp((s) => s.platform);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<BankProvider>("mock");
  const [plaidEnv, setPlaidEnv] = useState<PlaidEnv>("sandbox");
  // An open Plaid sign-in: the app polls until the person finishes in the browser.
  const [linking, setLinking] = useState<{ sessionId: string; url: string; reconnect: boolean } | null>(null);
  const [plaidClientId, setPlaidClientId] = useState("");
  const [plaidSecret, setPlaidSecret] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (status && !dirty) {
      setEnabled(status.enabled);
      setProvider(status.provider);
      setPlaidEnv(status.plaidEnv);
      setPlaidClientId("");
      setPlaidSecret("");
    }
  }, [status, dirty]);

  const isOwner = user?.role === "owner";
  const touch = () => setDirty(true);
  const isPlaid = provider === "plaid";

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await client.updateBankSettings({
        enabled,
        provider,
        ...(provider === "plaid" ? { plaidEnv } : {}),
        ...(plaidClientId.trim() ? { plaidClientId: plaidClientId.trim() } : {}),
        ...(plaidSecret.trim() ? { plaidSecret: plaidSecret.trim() } : {}),
      });
      setPlaidSecret("");
      setDirty(false);
      await reload();
      setMessage("Saved.");
    } catch {
      setError("Couldn't save bank settings.");
    } finally {
      setBusy(false);
    }
  };

  const openInBrowser = (url: string) => {
    if (platform.openExternal) void platform.openExternal(url);
    else window.open(url, "_blank", "noopener");
  };

  /** Plaid: open its sign-in page in the browser, then wait for the result. */
  const linkBank = async (connectionId?: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await client.bankLinkStart(connectionId ? { connectionId } : {});
      setLinking({ sessionId: r.sessionId, url: r.url, reconnect: Boolean(connectionId) });
      openInBrowser(r.url);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't start Plaid. Check your Plaid keys and environment.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!linking) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await client.bankLinkStatus(linking.sessionId);
        if (stopped) return;
        if (r.status === "waiting") {
          timer = setTimeout(poll, 3_000);
          return;
        }
        setLinking(null);
        if (r.status === "connected" || r.status === "reconnected") {
          const parts = r.results.map(
            (x) => `${x.institutionName}: ${x.accountsLinked} account${x.accountsLinked === 1 ? "" : "s"}, ${x.imported} transactions`,
          );
          setMessage(
            (r.status === "reconnected" ? "Reconnected. " : "Connected. ") +
              parts.join("; ") +
              (r.message ? ` (${r.message})` : "") +
              ". Older history can take a few minutes to arrive; it comes in with the next sync.",
          );
          await reload();
        } else if (r.status === "exited") {
          setError(r.message ?? "Plaid was closed before a bank was connected.");
        } else {
          setError(r.message ?? "The sign-in session ended. Press Link a bank to try again.");
        }
      } catch {
        if (!stopped) timer = setTimeout(poll, 5_000);
      }
    };
    timer = setTimeout(poll, 3_000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [linking, client, reload]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await client.bankConnect();
      setMessage(
        `Connected ${r.institutionName}: ${r.accountsLinked} accounts, ${r.imported} transactions imported.`,
      );
      await reload();
    } catch {
      setError("Connect failed — make sure the provider is enabled and configured.");
    } finally {
      setBusy(false);
    }
  };

  const sync = async (id: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await client.bankSync(id);
      setMessage(`Synced: ${r.imported} new, ${r.skippedDuplicates} already imported.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Sync failed.");
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (id: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await client.bankDisconnect(id);
      await reload();
      setMessage("Disconnected. The imported accounts and history were kept.");
    } catch {
      setError("Disconnect failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card kicker="Bank linking" title="Connected banks (optional)">
      <p className="card-body">
        Off by default. Pull accounts and transactions automatically instead of importing CSVs.
        Imported transactions run through your local categorization rules.
      </p>

      {!isOwner ? (
        <p className="card-meta">Only the owner can change bank settings.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <Select
                label="Provider"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as BankProvider);
                  touch();
                }}
              >
                {BankProvider.options.map((p) => (
                  <option key={p} value={p}>
                    {BANK_PROVIDER_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {isPlaid && (
            <div
              role="note"
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--text-sm)",
                lineHeight: 1.5,
                background: "color-mix(in srgb, var(--color-negative) 10%, var(--color-surface))",
                border: "1px solid color-mix(in srgb, var(--color-negative) 30%, transparent)",
              }}
            >
              <strong>Heads up — this sends data off your server.</strong> With Plaid, your bank
              login and transactions flow through Plaid's cloud under your own API keys. That breaks
              the app's otherwise-local guarantee. The Sandbox provider keeps everything on your
              machine.
            </div>
          )}

          {isPlaid && (
            <div style={{ marginTop: 12, maxWidth: 360 }}>
              <Select
                label="Plaid environment"
                value={plaidEnv}
                onChange={(e) => {
                  setPlaidEnv(e.target.value as PlaidEnv);
                  touch();
                }}
              >
                <option value="sandbox">Sandbox: Plaid's test banks</option>
                <option value="production">Production: your real banks</option>
              </Select>
              <p className="card-meta" style={{ marginTop: 6 }}>
                {plaidEnv === "sandbox"
                  ? "Use your Sandbox keys. At the bank sign-in, use user_good / pass_good."
                  : "Use your Production keys. Plaid must have approved your account for Production."}
              </p>
            </div>
          )}

          {isPlaid && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <Field
                  label="Plaid client ID"
                  value={plaidClientId}
                  onChange={(e) => {
                    setPlaidClientId(e.target.value);
                    touch();
                  }}
                  placeholder={status?.hasPlaidCredentials ? "•••• (saved)" : "client_id"}
                />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <Field
                  label="Plaid secret"
                  type="password"
                  value={plaidSecret}
                  onChange={(e) => {
                    setPlaidSecret(e.target.value);
                    touch();
                  }}
                  placeholder={status?.hasPlaidCredentials ? "•••• (saved — blank keeps it)" : "secret"}
                />
              </div>
            </div>
          )}

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 12,
              fontSize: "var(--text-base)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                touch();
              }}
            />
            Enable bank linking
          </label>

          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
              Save
            </Button>
            {status?.enabled && status?.configured && !dirty && (
              status.provider === "plaid" ? (
                <Button variant="secondary" onClick={() => void linkBank()} disabled={busy || linking !== null}>
                  Link a bank
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => void connect()} disabled={busy}>
                  Connect a sandbox bank
                </Button>
              )
            )}
          </div>

          {linking && (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-divider)",
                fontSize: "var(--text-sm)",
              }}
            >
              <Spinner label="Waiting for Plaid" />
              <span style={{ flex: 1, minWidth: 200 }}>
                {linking.reconnect ? "Sign in to your bank again" : "Finish connecting your bank"} in the browser window
                that opened. This updates on its own when you're done.
              </span>
              <Button variant="ghost" onClick={() => openInBrowser(linking.url)}>
                Open again
              </Button>
              <Button variant="ghost" onClick={() => setLinking(null)}>
                Cancel
              </Button>
            </div>
          )}

          {message && (
            <div role="status" style={{ fontSize: "var(--text-sm)", color: "var(--content-secondary)", marginTop: 8 }}>
              {message}
            </div>
          )}
          {error && (
            <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)", marginTop: 8 }}>
              {error}
            </div>
          )}

          {status && status.connections.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {status.connections.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 0",
                    borderTop: "1px solid var(--color-divider)",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>{c.institutionName}</div>
                    {c.needsReconnect && (
                      <div className="warn" style={{ fontSize: "var(--text-xs)", fontWeight: 600 }}>
                        Needs you to sign in to the bank again
                      </div>
                    )}
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)" }}>
                      {c.accountCount} account{c.accountCount === 1 ? "" : "s"} ·{" "}
                      {c.lastSyncedAt
                        ? `synced ${new Date(c.lastSyncedAt).toLocaleString()}`
                        : "never synced"}
                    </div>
                  </div>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    {c.needsReconnect ? (
                      <Button variant="primary" onClick={() => void linkBank(c.id)} disabled={busy || linking !== null}>
                        Reconnect
                      </Button>
                    ) : (
                      <Button variant="secondary" onClick={() => void sync(c.id)} disabled={busy}>
                        Sync
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => void disconnect(c.id)} disabled={busy}>
                      Disconnect
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** Settings → System status: the startup checks, on demand. */
function SystemStatusSection() {
  const platform = useApp((s) => s.platform);
  const client = useApp((s) => s.client);
  const address = useApp((s) => s.serverAddress);
  const keychainOk = useApp((s) => s.keychainOk);
  const [checks, setChecks] = useState<UiCheck[]>([]);
  const [running, setRunning] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const run = useCallback(async () => {
    if (!address) return;
    setRunning(true);
    try {
      const outcome = await runChecks(
        {
          platform,
          client,
          address,
          appVersion: APP_VERSION,
          keychainOk,
          hasSession: true,
          alternateAddress: useApp.getState().alternateAddress,
          onRoute: useApp.getState().setActiveAddress,
        },
        setChecks,
      );
      setChecks(outcome.checks);
      setCheckedAt(new Date());
    } finally {
      setRunning(false);
    }
  }, [platform, client, address, keychainOk]);
  const actions = useCheckActions(() => void run());

  useEffect(() => {
    void run();
  }, [run]);

  const problems = checks.filter((c) => c.level === "error" || c.level === "warn").length;
  return (
    <Card kicker="Health" title="System status">
      <p className="card-body">
        {running
          ? "Checking…"
          : problems === 0
            ? "Everything is working."
            : `${problems} thing${problems === 1 ? "" : "s"} need${problems === 1 ? "s" : ""} attention.`}
      </p>
      <StatusList
        checks={checks}
        onAction={(a) => void actions.run(a)}
        busyAction={actions.busy}
        hideActions={["change-server"]}
      />
      {actions.message && (
        <div role="status" style={{ fontSize: "var(--text-sm)", color: "var(--content-secondary)", marginTop: 8 }}>
          {actions.message}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <Button variant="secondary" onClick={() => void run()} disabled={running}>
          {running ? <Spinner label="Checking" /> : "Run checks again"}
        </Button>
        {checkedAt && <span className="card-meta">Last checked {checkedAt.toLocaleTimeString()}</span>}
      </div>
    </Card>
  );
}

/** Settings → Network: which private network this computer uses to reach the server from anywhere. */
function NetworkSection() {
  const platform = useApp((s) => s.platform);
  const refreshTailscale = useApp((s) => s.refreshTailscale);
  const [network, setNetwork] = useState<PrivateNetworkId>(getPrivateNetwork);
  const info = PRIVATE_NETWORKS[network];
  const managed = usesTailscaleClient(network);

  const choose = (id: PrivateNetworkId) => {
    setPrivateNetwork(id);
    setNetwork(id);
    void refreshTailscale();
  };

  return (
    <Card kicker="Network" title="Private network">
      <p className="card-body">
        A private network lets this computer reach your Vault server securely when you're away from
        home, without opening ports to the internet. It's fine for it to be off at home.
      </p>
      <div style={{ display: "grid", gap: 10, maxWidth: 360, marginBottom: 12 }}>
        <Select
          label="What do you use?"
          value={network}
          onChange={(e) => choose(e.target.value as PrivateNetworkId)}
        >
          {(Object.keys(PRIVATE_NETWORKS) as PrivateNetworkId[]).map((id) => (
            <option key={id} value={id}>
              {PRIVATE_NETWORKS[id].label}
            </option>
          ))}
        </Select>
      </div>
      {network === "headscale" && (
        <p className="card-body">
          Headscale uses the Tailscale app. Join your server once in a terminal with{" "}
          <code>tailscale up --login-server=https://your-headscale-address</code>, then control it here.
        </p>
      )}
      {managed && <TailscaleControl key={network} />}
      {!managed && network !== "none" && (
        <p className="card-body">
          Turn it on from {network === "other" ? "your VPN's" : `the ${info.label}`} app when you're away
          from home, then connect using the server's address on that network (Settings → Connection).
        </p>
      )}
      {!managed && info.url && (
        <Button
          variant="ghost"
          onClick={() => {
            if (platform.openExternal) void platform.openExternal(info.url!);
            else window.open(info.url, "_blank", "noopener");
          }}
        >
          Get {info.label}
        </Button>
      )}
    </Card>
  );
}

function AppearanceSection() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  return (
    <Card kicker="Appearance" title="Theme">
      <p className="card-body">
        Automatic follows your system's light/dark preference.
      </p>
      <Segmented
        aria-label="Theme"
        options={THEMES.map((t) => ({ value: t, label: THEME_LABELS[t].split(" ")[0]! }))}
        value={theme}
        onChange={(t) => void setTheme(t)}
      />
    </Card>
  );
}

/**
 * What the assistant may change on its own, and what it has remembered. The
 * memory is an append-only file on the server that's never deleted — not
 * even with the chats — so this is read-only by design.
 */
function AiMemorySection() {
  const client = useApp((s) => s.client);
  const aiVisible = useApp((s) => s.aiVisible);
  const autoApply = useApp((s) => s.aiAutoApply);
  const setAutoApply = useApp((s) => s.setAiAutoApply);
  const level = useApp((s) => s.aiLevel);
  const setLevel = useApp((s) => s.setAiLevel);
  const { data, loading } = useData(() => (aiVisible ? client.aiMemory() : Promise.resolve(null)), [client, aiVisible]);
  if (!aiVisible) return null;
  const notes = data?.notes ?? [];
  return (
    <Card kicker="AI assistant" title="Changes & memory">
      <p className="card-body">
        The assistant can reorganise categories, add auto-categorization rules, set budgets
        and planned income, rename the household, and change the theme and finance review
        settings. It can't touch security, members, bank links or AI settings.
      </p>
      <div className="field">
        <label>AI level on this device</label>
        <Segmented
          aria-label="AI level"
          options={AI_LEVELS.map((l) => ({ value: l, label: AI_LEVEL_LABELS[l] }))}
          value={level}
          onChange={(v) => void setLevel(v)}
        />
        <p className="card-meta" style={{ margin: "4px 0 0" }}>{AI_LEVEL_HINTS[level]}</p>
      </div>
      <div className="field">
        <label>When it wants to change something</label>
        <Segmented
          aria-label="When the assistant wants to change something"
          options={[
            { value: "ask", label: "Ask me first" },
            { value: "auto", label: "Auto — just do it" },
          ]}
          value={autoApply ? "auto" : "ask"}
          onChange={(v) => void setAutoApply(v === "auto")}
        />
      </div>
      <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginTop: 6 }}>
        What it remembers about you {notes.length > 0 && <Tag>{notes.length}</Tag>}
      </div>
      <p className="card-meta" style={{ marginTop: 0 }}>
        Kept permanently in an encrypted file on your server (included in backups), even if
        you delete every chat.
      </p>
      {loading && !data ? (
        <Spinner label="Loading memory" />
      ) : notes.length === 0 ? (
        <p className="card-meta">Nothing yet — it saves lasting facts and preferences as you chat.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", maxHeight: 280, overflow: "auto" }}>
          {[...notes].reverse().map((n, i) => (
            <div
              key={`${n.at}:${i}`}
              style={{
                display: "flex",
                gap: 10,
                padding: "7px 2px",
                borderTop: "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
                fontSize: "var(--text-sm)",
              }}
            >
              <span style={{ flex: 1 }}>{n.text}</span>
              <span style={{ color: "var(--content-tertiary)", fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}>
                {new Date(n.at).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Finance reviews: which slides the weekly / monthly presenter shows, their
 * order, and how it plays. Saved on this device, like the theme.
 */
function ReviewSection() {
  const prefs = useApp((s) => s.reviewPrefs);
  const setPrefs = useApp((s) => s.setReviewPrefs);
  const update = (patch: Partial<ReviewPrefs>) => void setPrefs({ ...prefs, ...patch });
  const move = (i: number, by: number) => {
    const slides = [...prefs.slides];
    const j = i + by;
    if (j < 0 || j >= slides.length) return;
    [slides[i], slides[j]] = [slides[j]!, slides[i]!];
    update({ slides });
  };
  const toggle = (i: number) =>
    update({ slides: prefs.slides.map((s, k) => (k === i ? { ...s, enabled: !s.enabled } : s)) });

  return (
    <Card kicker="Finance reviews" title="Weekly & monthly reviews">
      <p className="card-body">
        Present a review from Reports. Pick what it shows and in what order — slides with
        nothing to show for a period (no budgets, no AI summary) are skipped.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-end" }}>
        <div className="field">
          <label>Default review</label>
          <Segmented
            aria-label="Default review"
            options={[
              { value: "week", label: "Weekly" },
              { value: "month", label: "Monthly" },
            ]}
            value={prefs.defaultPeriod}
            onChange={(defaultPeriod) => update({ defaultPeriod })}
          />
        </div>
        <div className="field">
          <label>Weeks start on</label>
          <Segmented
            aria-label="Weeks start on"
            options={[
              { value: "monday", label: "Monday" },
              { value: "sunday", label: "Sunday" },
            ]}
            value={prefs.weekStartsOn}
            onChange={(weekStartsOn) => update({ weekStartsOn })}
          />
        </div>
        <Select
          label="Auto-advance"
          value={String(prefs.autoAdvanceSeconds)}
          onChange={(e) => update({ autoAdvanceSeconds: Number(e.target.value) })}
        >
          <option value="0">Off — I'll click through</option>
          <option value="8">Every 8 seconds</option>
          <option value="15">Every 15 seconds</option>
          <option value="30">Every 30 seconds</option>
          <option value="60">Every minute</option>
        </Select>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--text-sm)" }}>
        <input type="checkbox" checked={prefs.compare} onChange={(e) => update({ compare: e.target.checked })} />
        Compare with the previous week / month
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--text-sm)" }}>
        <input
          type="checkbox"
          checked={prefs.startFullscreen}
          onChange={(e) => update({ startFullscreen: e.target.checked })}
        />
        "Present" opens in full screen
      </label>

      <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginTop: 6 }}>Slides</div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {prefs.slides.map((s, i) => {
          const meta = REVIEW_SLIDE_LABELS[s.id];
          return (
            <div
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 2px",
                borderTop: "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
                opacity: s.enabled ? 1 : 0.55,
              }}
            >
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={() => toggle(i)}
                aria-label={`Show ${meta.title}`}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>{meta.title}</div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)" }}>{meta.hint}</div>
              </div>
              <button
                title="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                style={{ ...treeIconBtn, opacity: i === 0 ? 0.25 : 1, cursor: i === 0 ? "default" : "pointer" }}
              >
                ▲
              </button>
              <button
                title="Move down"
                disabled={i === prefs.slides.length - 1}
                onClick={() => move(i, 1)}
                style={{
                  ...treeIconBtn,
                  opacity: i === prefs.slides.length - 1 ? 0.25 : 1,
                  cursor: i === prefs.slides.length - 1 ? "default" : "pointer",
                }}
              >
                ▼
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * TOTP two-factor authentication. Off by default. Setup shows the secret + an
 * otpauth URI for an authenticator app; a confirmed code turns it on. Disabling
 * requires the account password (re-auth).
 */
/**
 * Windows Hello / Touch ID / fingerprint sign-in for this device. Turning it
 * on stores a server-issued device key in the OS keychain; the app then locks
 * on launch and only releases the key after the OS confirms it's you.
 */
/** When this device locks itself (per device; unlocking uses biometrics or the password). */
function AutoLockSection() {
  const minutes = useApp((s) => s.autoLockMinutes);
  const setMinutes = useApp((s) => s.setAutoLockMinutes);
  const lock = useApp((s) => s.lock);
  return (
    <Card kicker="Security" title="Auto-lock">
      <p className="card-body">
        Vault Finance locks every time it opens, when this computer sleeps or its screen locks, and after
        you've been away for the time below. Closing the window quits the app completely.
      </p>
      <Select label="Lock after I've been idle for" value={String(minutes)} onChange={(e) => void setMinutes(Number(e.target.value))}>
        {[1, 2, 5, 10, 15, 30, 60].map((m) => (
          <option key={m} value={m}>
            {m} minute{m > 1 ? "s" : ""}
          </option>
        ))}
        <option value="0">Never (still locks on sleep, screen lock and restart)</option>
      </Select>
      <div>
        <Button variant="secondary" icon="lock" onClick={() => lock()}>
          Lock now (Ctrl+L)
        </Button>
      </div>
    </Card>
  );
}

function BiometricSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const platform = useApp((s) => s.platform);
  const serverAddress = useApp((s) => s.serverAddress);
  const biometric = useApp((s) => s.biometric);
  const enrolledIds = useApp((s) => s.biometricUserIds);
  const enableBiometric = useApp((s) => s.enableBiometric);
  const disableBiometric = useApp((s) => s.disableBiometric);

  const [keys, setKeys] = useState<DeviceKey[] | null>(null);
  const [thisDeviceKeyId, setThisDeviceKeyId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<DeviceKey | null>(null);

  const enrolled = !!user && enrolledIds.includes(user.id);
  const label = biometric?.label ?? "Biometric sign-in";

  const reload = useCallback(() => {
    client
      .deviceKeys()
      .then((r) => setKeys(r.keys))
      .catch(() => setKeys([]));
    if (serverAddress && user) {
      platform
        .getSecret(deviceKeySecret(serverAddress, user.id))
        .then((raw) => setThisDeviceKeyId(raw ? ((JSON.parse(raw) as { id?: string }).id ?? null) : null))
        .catch(() => setThisDeviceKeyId(null));
    }
  }, [client, platform, serverAddress, user]);
  useEffect(reload, [reload, enrolled]);

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await enableBiometric();
      if (!r.ok && r.reason !== "cancelled") {
        setError(r.message ?? (r.reason === "failed" ? `${label} didn't recognize you.` : `${label} isn't available.`));
      }
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
      reload();
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setError(null);
    await disableBiometric();
    setBusy(false);
    reload();
  };

  const revoke = async (key: DeviceKey) => {
    if (key.id === thisDeviceKeyId) {
      await disableBiometric();
    } else {
      await client.revokeDeviceKey(key.id).catch(() => {});
    }
    setRevoking(null);
    reload();
  };

  const icon = label === "Windows Hello" ? "user" : "fingerprint";
  const otherDevices = (keys ?? []).filter((k) => k.id !== thisDeviceKeyId);

  return (
    <Card kicker="Security" title={`Sign in with ${label}`}>
      <p className="card-body">
        Unlock Vault Finance on this computer with{" "}
        {label === "Windows Hello"
          ? "Windows Hello — your face, fingerprint or PIN"
          : label === "Touch ID"
            ? "Touch ID"
            : "your fingerprint reader"}{" "}
        instead of typing your password. The app asks for it every time it
        opens. Your biometric data never leaves this device — the server only
        sees a sign-in key it can revoke.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: "50%", background: enrolled ? "var(--color-positive)" : "var(--color-neutral-600)" }}
        />
        <span style={{ fontSize: "var(--text-sm)" }}>
          {enrolled
            ? "On for this device"
            : biometric && !biometric.available
              ? "Not available on this device"
              : "Off"}
        </span>
        <div style={{ marginLeft: "auto" }}>
          {enrolled ? (
            <Button variant="ghost" onClick={() => void turnOff()} disabled={busy}>
              Turn off
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={icon}
              onClick={() => void turnOn()}
              disabled={busy || !biometric?.available}
            >
              {busy ? <Spinner label="Waiting" /> : "Turn on"}
            </Button>
          )}
        </div>
      </div>
      {biometric && !biometric.available && biometric.reason && (
        <p className="card-meta">{biometric.reason}</p>
      )}
      {busy && label === "Fingerprint" && (
        <div className="row card-meta" style={{ gap: 8 }}>
          Touch the fingerprint reader…
          <Button variant="ghost" onClick={() => void platform.biometricCancel()}>
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}

      {otherDevices.length > 0 && (
        <>
          <div className="eyebrow" style={{ marginTop: 16, marginBottom: 4 }}>
            Other devices that can sign in as you with biometrics
          </div>
          <table className="table">
            <tbody>
              {otherDevices.map((k) => (
                <tr key={k.id}>
                  <td>{k.deviceName}</td>
                  <td style={{ textTransform: "capitalize" }}>{k.platform}</td>
                  <td>{k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : "Never used"}</td>
                  <td style={{ textAlign: "right" }}>
                    <Button variant="ghost" onClick={() => setRevoking(k)}>
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <Dialog
        open={revoking !== null}
        title="Revoke biometric sign-in?"
        onClose={() => setRevoking(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => revoking && void revoke(revoking)}>
              Revoke
            </Button>
          </>
        }
      >
        “{revoking?.deviceName}” will need your password next time. It stays
        signed in until then — revoke its session below too if it's lost.
      </Dialog>
    </Card>
  );
}

function PasswordSection() {
  const client = useApp((s) => s.client);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const problem = next ? passwordProblem(next) : null;
  const mismatch = confirm.length > 0 && confirm !== next;
  const close = () => {
    setOpen(false);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.changePassword({ currentPassword: current, newPassword: next });
      close();
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.code === "INVALID_CREDENTIALS"
          ? "Your current password isn't right."
          : err instanceof ApiRequestError
            ? err.message
            : "Couldn't change your password. Is the server reachable?",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card kicker="Security" title="Password">
      <p className="card-body">
        Changing your password signs out every other device and turns off their
        biometric sign-in, so anyone who knew the old one is locked out.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {done && (
          <span role="status" style={{ fontSize: "var(--text-sm)", color: "var(--color-positive)" }}>
            Password changed. Other devices were signed out.
          </span>
        )}
        <div style={{ marginLeft: "auto" }}>
          <Button variant="secondary" onClick={() => { setDone(false); setOpen(true); }}>
            Change password
          </Button>
        </div>
      </div>

      {open && (
        <Dialog
          open
          title="Change password"
          onClose={close}
          actions={
            <>
              <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => void save()}
                disabled={busy || !current || !next || Boolean(problem) || confirm !== next}
              >
                {busy ? <Spinner label="Saving" /> : "Change password"}
              </Button>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field
              label="Current password"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
            <Field
              label="New password"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              {...(problem ? { error: problem } : {})}
            />
            <Field
              label="Confirm new password"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              {...(mismatch ? { error: "The passwords don't match." } : {})}
            />
            {error && (
              <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>{error}</div>
            )}
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function TwoFactorSection() {
  const client = useApp((s) => s.client);
  const { data, reload } = useData(() => client.totpStatus(), [client]);
  const enabled = data?.enabled ?? false;

  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startSetup = async () => {
    setBusy(true);
    setError(null);
    setCode("");
    try {
      setSetup(await client.totpSetup());
    } catch {
      setError("Couldn't start setup. Is the server reachable?");
    } finally {
      setBusy(false);
    }
  };
  const confirmEnable = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.totpEnable(code.replace(/\s/g, ""));
      setSetup(null);
      reload();
    } catch {
      setError("That code isn't valid — enter the current one.");
    } finally {
      setBusy(false);
    }
  };
  const confirmDisable = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.totpDisable(password);
      setDisabling(false);
      setPassword("");
      reload();
    } catch {
      setError("That password isn't right.");
    } finally {
      setBusy(false);
    }
  };

  const groupedSecret = setup ? setup.secret.replace(/(.{4})/g, "$1 ").trim() : "";

  return (
    <Card kicker="Security" title="Two-factor authentication">
      <p className="card-body">
        Add a second step at sign-in: a rotating 6-digit code from an authenticator app
        (Google Authenticator, Authy, 1Password…), on top of your password.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: "50%", background: enabled ? "var(--color-positive)" : "var(--color-neutral-600)" }}
        />
        <span style={{ fontSize: "var(--text-sm)" }}>{enabled ? "On — a code is required to sign in" : "Off"}</span>
        <div style={{ marginLeft: "auto" }}>
          {enabled ? (
            <Button variant="ghost" onClick={() => { setDisabling(true); setError(null); setPassword(""); }}>
              Turn off
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void startSetup()} disabled={busy}>
              {busy ? <Spinner label="Starting" /> : "Set up"}
            </Button>
          )}
        </div>
      </div>
      {error && !setup && !disabling && (
        <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}

      {setup && (
        <Dialog
          open
          title="Set up two-factor authentication"
          onClose={() => setSetup(null)}
          actions={
            <>
              <Button variant="secondary" onClick={() => setSetup(null)} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={() => void confirmEnable()} disabled={busy || code.length < 6}>
                {busy ? <Spinner label="Enabling" /> : "Turn on"}
              </Button>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p className="card-body" style={{ margin: 0 }}>
              In your authenticator app, add an account by entering this key manually
              (or paste the setup link), then type the current 6-digit code below.
            </p>
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}>Setup key</div>
              <div
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: "var(--text-md)",
                  letterSpacing: "0.08em",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  background: "var(--color-neutral-900)",
                  border: "1px solid var(--color-divider)",
                  userSelect: "all",
                  wordBreak: "break-all",
                }}
              >
                {groupedSecret}
              </div>
            </div>
            <details>
              <summary style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)", cursor: "pointer" }}>
                Setup link (for apps that accept a pasted otpauth URI)
              </summary>
              <div style={{ fontFamily: "ui-monospace, monospace", fontSize: "var(--text-2xs)", wordBreak: "break-all", marginTop: 6, userSelect: "all", color: "var(--content-tertiary)" }}>
                {setup.otpauthUri}
              </div>
            </details>
            <Field
              label="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              maxLength={7}
              autoFocus
              placeholder="123456"
            />
            {error && (
              <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>{error}</div>
            )}
          </div>
        </Dialog>
      )}

      {disabling && (
        <Dialog
          open
          title="Turn off two-factor?"
          onClose={() => setDisabling(false)}
          actions={
            <>
              <Button variant="secondary" onClick={() => setDisabling(false)} disabled={busy}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => void confirmDisable()}
                disabled={busy || !password}
                style={{ background: "var(--color-negative)", borderColor: "var(--color-negative)", color: "#fff" }}
              >
                {busy ? <Spinner label="Disabling" /> : "Turn off"}
              </Button>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p className="card-body" style={{ margin: 0 }}>
              Enter your account password to disable two-factor authentication.
            </p>
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            {error && (
              <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>{error}</div>
            )}
          </div>
        </Dialog>
      )}
    </Card>
  );
}

const VIA_LABEL: Record<string, string> = {
  device: "approved from another device",
  console: "approved on the server",
  bootstrap: "first device",
  "existing-session": "already signed in at upgrade",
  "device-key": "biometric sign-in",
};

/**
 * Settings → Approved devices (ADR-0009): which devices may sign in, requests
 * waiting for approval, and (owner) how new devices can be approved.
 */
function TrustedDevicesSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const isOwner = user?.role === "owner";
  const [devices, setDevices] = useState<TrustedDevice[] | null>(null);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [methods, setMethods] = useState<DeviceApprovalSettings | null>(null);
  const [reviewing, setReviewing] = useState<PendingApproval | null>(null);
  const [revoking, setRevoking] = useState<TrustedDevice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    client.trustedDevices().then((r) => setDevices(r.devices)).catch(() => setDevices([]));
    client.pendingApprovals().then((r) => setPending(r.approvals)).catch(() => setPending([]));
    client.deviceApprovalSettings().then(setMethods).catch(() => setMethods(null));
  }, [client]);
  useEffect(reload, [reload]);

  const saveMethods = async (next: DeviceApprovalSettings) => {
    setError(null);
    try {
      setMethods(await client.updateDeviceApprovalSettings(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    }
  };

  const revoke = async (d: TrustedDevice) => {
    await client.revokeTrustedDevice(d.id).catch(() => {});
    setRevoking(null);
    if (d.current) await useApp.getState().signOut();
    else reload();
  };

  return (
    <Card kicker="Security" title="Approved devices">
      <p className="card-body">
        A password alone isn't enough to sign in: each new device has to be approved first —
        {methods?.trustedDevice !== false ? " from a device that's already approved (by typing the code it shows)" : ""}
        {methods?.trustedDevice !== false && methods?.serverConsole !== false ? " or" : ""}
        {methods?.serverConsole !== false ? " on the server with “vault approve <code>”" : ""}.
      </p>

      {pending.length > 0 && (
        <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Waiting for approval</div>
          {pending.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: "var(--radius-md)",
                background: "var(--color-warning-soft)",
              }}
            >
              <span style={{ fontSize: "var(--text-sm)", flex: 1 }}>{describeRequest(p)}</span>
              {methods?.trustedDevice !== false && (
                <Button variant="primary" onClick={() => setReviewing(p)}>
                  Review
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {devices === null ? (
        <Spinner label="Loading devices" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              {isOwner && <th>Person</th>}
              <th>Approved</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.deviceName}{" "}
                  {d.current && (
                    <Tag variant="accent" style={{ marginLeft: 6 }}>
                      this device
                    </Tag>
                  )}
                </td>
                {isOwner && <td>{d.userDisplayName}</td>}
                <td title={d.approvedVia ? VIA_LABEL[d.approvedVia] : undefined}>
                  {d.approvedAt ? new Date(d.approvedAt).toLocaleDateString() : "—"}
                </td>
                <td>{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "—"}</td>
                <td style={{ textAlign: "right" }}>
                  <Button variant="ghost" onClick={() => setRevoking(d)}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isOwner && methods && (
        <div style={{ marginTop: 14, display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>How new devices can be approved</div>
          <label className="radio" style={{ fontSize: "var(--text-sm)" }}>
            <input
              type="checkbox"
              checked={methods.trustedDevice}
              onChange={(e) => void saveMethods({ ...methods, trustedDevice: e.target.checked })}
            />
            <span className="dot" style={{ borderRadius: "var(--radius-sm)" }} />
            From a device that's already approved (type the code shown on the new device)
          </label>
          <label className="radio" style={{ fontSize: "var(--text-sm)" }}>
            <input
              type="checkbox"
              checked={methods.serverConsole}
              onChange={(e) => void saveMethods({ ...methods, serverConsole: e.target.checked })}
            />
            <span className="dot" style={{ borderRadius: "var(--radius-sm)" }} />
            On the server console (docker compose exec server vault approve &lt;code&gt;)
          </label>
          {error && (
            <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
              {error}
            </div>
          )}
        </div>
      )}

      <ApproveDialog
        request={reviewing}
        onDone={() => {
          setReviewing(null);
          reload();
        }}
      />
      <Dialog
        open={revoking !== null}
        title={revoking?.current ? "Remove this device?" : "Remove this device's approval?"}
        onClose={() => setRevoking(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => revoking && void revoke(revoking)}>
              Remove
            </Button>
          </>
        }
      >
        {revoking?.current
          ? "You'll be signed out here, and this device will need to be approved again to sign back in."
          : `${revoking?.deviceName ?? "It"} will be signed out and must be approved again before it can sign in.`}
      </Dialog>
    </Card>
  );
}

function SessionsSection() {
  const client = useApp((s) => s.client);
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [confirming, setConfirming] = useState<DeviceSession | null>(null);

  const reload = useCallback(() => {
    client
      .sessions()
      .then((r) => setSessions(r.sessions))
      .catch(() => setSessions([]));
  }, [client]);

  useEffect(reload, [reload]);

  const revoke = async (session: DeviceSession) => {
    await client.revokeSession(session.id).catch(() => {});
    setConfirming(null);
    reload();
  };

  return (
    <Card kicker="Security" title="Devices signed in to your account">
      {sessions === null ? (
        <Spinner label="Loading sessions" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Platform</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.deviceName}{" "}
                  {s.isCurrent && (
                    <Tag variant="accent" style={{ marginLeft: 6 }}>
                      this device
                    </Tag>
                  )}
                </td>
                <td style={{ textTransform: "capitalize" }}>{s.platform}</td>
                <td>{new Date(s.lastUsedAt).toLocaleString()}</td>
                <td style={{ textAlign: "right" }}>
                  {!s.isCurrent && (
                    <Button variant="ghost" onClick={() => setConfirming(s)}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Dialog
        open={confirming !== null}
        title="Revoke this device?"
        onClose={() => setConfirming(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => confirming && void revoke(confirming)}
            >
              Revoke access
            </Button>
          </>
        }
      >
        “{confirming?.deviceName}” will be signed out immediately and will need
        the account password to sign in again.
      </Dialog>
    </Card>
  );
}

/** The server's other address, so home and away both just work. */
function AlternateAddressControl() {
  const alternate = useApp((s) => s.alternateAddress);
  const active = useApp((s) => s.activeAddress);
  const save = useApp((s) => s.saveAlternateAddress);
  const remove = useApp((s) => s.removeAlternateAddress);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ address: string; fingerprint: string } | null>(null);

  const submit = async (raw: string, confirmed?: string) => {
    setBusy(true);
    setError(null);
    setConfirm(null);
    try {
      const result = await save(raw, confirmed);
      if (result.status === "error") setError(result.message);
      else if (result.status === "confirm") setConfirm(result);
      else setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that address.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
      <div style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Second address</div>
      <p className="card-meta" style={{ margin: 0 }}>
        Add your server's other address, like its home address and its VPN address. The app uses
        whichever one answers, so it works at home and away without changing anything.
      </p>
      {alternate ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "ui-monospace, monospace", fontSize: "var(--text-sm)" }}>{alternate}</span>
            <Button variant="ghost" onClick={() => void remove()}>
              Remove
            </Button>
          </div>
          <p className="card-meta" style={{ margin: 0 }}>
            Connected through {active}
          </p>
        </>
      ) : (
        <div style={{ display: "grid", gap: 8, maxWidth: 360 }}>
          <Field
            label="Other address"
            placeholder="https://100.64.0.5:8443"
            value={draft}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div>
            <Button variant="secondary" onClick={() => void submit(draft)} disabled={busy || !draft.trim()}>
              {busy ? <Spinner label="Checking" /> : "Add address"}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
          {error}
        </div>
      )}
      <Dialog
        open={confirm !== null}
        title="Trust this address?"
        onClose={() => setConfirm(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => confirm && void submit(confirm.address, confirm.fingerprint)}>
              The fingerprints match
            </Button>
          </>
        }
      >
        Only trust {confirm?.address} if this fingerprint matches the one your server shows:
        <div
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: "var(--text-xs)",
            wordBreak: "break-all",
            marginTop: 8,
            userSelect: "all",
          }}
        >
          {confirm?.fingerprint}
        </div>
      </Dialog>
    </div>
  );
}

function ServerSection() {
  const serverAddress = useApp((s) => s.serverAddress);
  const platform = useApp((s) => s.platform);
  const changeServer = useApp((s) => s.changeServer);
  const removeAlternateAddress = useApp((s) => s.removeAlternateAddress);
  const [confirmingChange, setConfirmingChange] = useState(false);

  const rePin = async () => {
    // The certificate changed, so the second address needs checking again too.
    await removeAlternateAddress();
    if (serverAddress) await platform.forgetPin(serverAddress);
    await changeServer();
  };

  return (
    <Card kicker="Server" title="Connection">
      <p className="card-body" style={{ fontFamily: "ui-monospace, monospace" }}>
        {serverAddress}
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="secondary" onClick={() => setConfirmingChange(true)}>
          Connect to a different server
        </Button>
        {platform.kind === "tauri" && (
          <Button variant="ghost" onClick={() => void rePin()}>
            Re-verify server identity
          </Button>
        )}
      </div>
      <p className="card-meta">
        Re-verify after rotating your server's TLS certificate — the stored
        fingerprint pin is cleared and confirmed again on the next connect.
      </p>
      <AlternateAddressControl />
      <Dialog
        open={confirmingChange}
        title="Disconnect from this server?"
        onClose={() => setConfirmingChange(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmingChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void changeServer()}>
              Disconnect
            </Button>
          </>
        }
      >
        You'll be signed out on this device and asked for a new server address.
        Nothing on the server is affected.
      </Dialog>
    </Card>
  );
}
