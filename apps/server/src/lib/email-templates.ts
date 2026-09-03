import type { MailMessage } from "./mailer.js";

/**
 * Plain, inline-styled email bodies. Deliberately minimal — no external CSS,
 * no images, no tracking. Each function returns everything `Mailer.send` needs
 * except the recipient address.
 */

type Body = Omit<MailMessage, "to">;

const BRAND = "Vault Finance";

function layout(headline: string, paragraphs: string[], cta?: { label: string; url: string }): string {
  const p = paragraphs
    .map(
      (t) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1f2430">${t}</p>`,
    )
    .join("");
  const button = cta
    ? `<p style="margin:24px 0 0"><a href="${escapeAttr(cta.url)}" style="display:inline-block;background:#7c5cff;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:11px 20px;border-radius:8px">${escapeHtml(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f4f7;padding:32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;padding:32px">
<tr><td>
<p style="margin:0 0 24px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7c5cff">${BRAND}</p>
<h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;color:#111">${escapeHtml(headline)}</h1>
${p}${button}
</td></tr></table>
<p style="margin:20px 0 0;font-size:12px;color:#9aa0ad">You're receiving this because your address is on a ${BRAND} account. This mailbox is not monitored.</p>
</td></tr></table></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
function textFrom(lines: string[]): string {
  return `${BRAND}\n\n${lines.join("\n\n")}\n`;
}

export function welcomeHousehold(input: {
  displayName?: string;
  connectUrl: string;
  surveyUrl?: string | undefined;
}): Body {
  const hi = input.displayName ? `Hi ${input.displayName}, ` : "";
  const lines = [
    `${hi}your ${BRAND} server is ready. 🎉`,
    `Open the desktop app, choose "Connect to a server", and enter:`,
    input.connectUrl,
    `On first connect you'll confirm the server's certificate once, then create your owner account.`,
  ];
  if (input.surveyUrl) {
    lines.push(
      `When you've had a chance to try it, we'd love your feedback — it takes about two minutes: ${input.surveyUrl}`,
    );
  }
  return {
    subject: `Your ${BRAND} server is ready`,
    text: textFrom(lines),
    html: layout(
      `Your ${BRAND} server is ready 🎉`,
      [
        `${hi}your server is up and running.`,
        `Open the desktop app, choose <strong>Connect to a server</strong>, and enter <strong>${escapeHtml(input.connectUrl)}</strong>. You'll confirm the certificate once, then create your owner account.`,
        ...(input.surveyUrl
          ? [`When you've had a chance to try it, we'd love your feedback — it takes about two minutes.`]
          : []),
      ],
      input.surveyUrl ? { label: "Take the 2-minute survey", url: input.surveyUrl } : undefined,
    ),
  };
}

export function householdConfirmed(input: { displayName?: string; connectUrl?: string | undefined }): Body {
  const hi = input.displayName ? `${input.displayName}, ` : "";
  const lines = [
    `${hi}your household is all set up. 🎉`,
    `Your owner account is active and your data lives entirely on your own server.`,
    `You can now invite family members from Settings → Family members.`,
  ];
  return {
    subject: `Your ${BRAND} household is set up`,
    text: textFrom(lines),
    html: layout(
      `You're all set 🎉`,
      [
        `${hi}your household is set up and your owner account is active.`,
        `Everything stays on your own server. When you're ready, invite family members from <strong>Settings → Family members</strong>.`,
      ],
      input.connectUrl ? { label: "Open Vault Finance", url: input.connectUrl } : undefined,
    ),
  };
}

export function updateAvailable(input: {
  currentVersion: string;
  latestVersion: string;
  notesUrl?: string | undefined;
  operatorManaged: boolean;
}): Body {
  const how = input.operatorManaged
    ? `This server is managed by your administrator — no action is needed from you. They'll roll out the update.`
    : `To update, run this on the machine hosting your server:\n\n    vault-update\n\n(That pulls the new image and restarts the stack. Your data is untouched.)`;
  const lines = [
    `${BRAND} ${input.latestVersion} is available. You're on ${input.currentVersion}.`,
    how,
    ...(input.notesUrl ? [`Release notes: ${input.notesUrl}`] : []),
  ];
  return {
    subject: `${BRAND} ${input.latestVersion} is available`,
    text: textFrom(lines),
    html: layout(
      `${BRAND} ${escapeHtml(input.latestVersion)} is available`,
      [
        `You're currently on <strong>${escapeHtml(input.currentVersion)}</strong>.`,
        input.operatorManaged
          ? `This server is managed by your administrator — they'll roll out the update, nothing is needed from you.`
          : `On the machine hosting your server, run:</p><pre style="margin:0 0 16px;background:#f4f4f7;border-radius:8px;padding:12px;font-size:14px">vault-update</pre><p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1f2430">That pulls the new image and restarts the stack. Your data is untouched.`,
      ],
      input.notesUrl ? { label: "Read the release notes", url: input.notesUrl } : undefined,
    ),
  };
}

export function memberInvite(input: {
  inviterName: string;
  inviteUrl: string;
  expiresAt: Date;
}): Body {
  const expires = input.expiresAt.toUTCString();
  const lines = [
    `${input.inviterName} invited you to join their ${BRAND} household.`,
    `Open this link to set your password and finish creating your account:`,
    input.inviteUrl,
    `The link expires ${expires}.`,
  ];
  return {
    subject: `${input.inviterName} invited you to ${BRAND}`,
    text: textFrom(lines),
    html: layout(
      `You've been invited to ${BRAND}`,
      [
        `<strong>${escapeHtml(input.inviterName)}</strong> invited you to join their household.`,
        `Use the button below to set your password and finish creating your account. The link expires ${escapeHtml(expires)}.`,
      ],
      { label: "Accept the invitation", url: input.inviteUrl },
    ),
  };
}

export function memberAdded(input: {
  displayName: string;
  inviterName: string;
  connectUrl?: string | undefined;
}): Body {
  const lines = [
    `${input.displayName}, ${input.inviterName} created a ${BRAND} account for you.`,
    `Ask ${input.inviterName} for your temporary password, then sign in and change it from Settings.`,
    ...(input.connectUrl ? [`Server address: ${input.connectUrl}`] : []),
  ];
  return {
    subject: `Your ${BRAND} account is ready`,
    text: textFrom(lines),
    html: layout(
      `Your ${BRAND} account is ready`,
      [
        `<strong>${escapeHtml(input.inviterName)}</strong> created an account for you.`,
        `Ask them for your temporary password, then sign in and change it from <strong>Settings</strong>.`,
        ...(input.connectUrl ? [`Server address: <strong>${escapeHtml(input.connectUrl)}</strong>`] : []),
      ],
      input.connectUrl ? { label: "Open Vault Finance", url: input.connectUrl } : undefined,
    ),
  };
}
