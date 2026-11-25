//! Mirrors packages/shared/src/schemas/ai.ts: providers, quality tiers and
//! levels, AI status, chat conversations and the NDJSON chat stream.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::ai_actions::AiActionRecord;
use crate::serde_util::OrderedMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProvider {
    Ollama,
    LocalOpenai,
    Openai,
    Anthropic,
}

impl AiProvider {
    pub const ALL: [AiProvider; 4] = [
        Self::Ollama,
        Self::LocalOpenai,
        Self::Openai,
        Self::Anthropic,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ollama => "ollama",
            Self::LocalOpenai => "local_openai",
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
        }
    }
    /// `AI_PROVIDER_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Ollama => "Ollama (local)",
            Self::LocalOpenai => "Other local AI (OpenAI-compatible)",
            Self::Openai => "OpenAI",
            Self::Anthropic => "Anthropic (Claude)",
        }
    }
    /// `LOCAL_PROVIDERS`: runs on hardware you control and needs a base URL.
    pub fn is_local(self) -> bool {
        matches!(self, Self::Ollama | Self::LocalOpenai)
    }
    /// `CLOUD_PROVIDERS`: sends financial context off your server.
    pub fn is_cloud(self) -> bool {
        matches!(self, Self::Openai | Self::Anthropic)
    }
    /// `AI_BASE_URL_EXAMPLES`.
    pub fn base_url_example(self) -> Option<&'static str> {
        match self {
            Self::Ollama => Some("http://ollama:11434"),
            Self::LocalOpenai => Some("http://192.168.1.50:1234/v1"),
            _ => None,
        }
    }
    /// `AI_MODEL_SUGGESTIONS`.
    pub fn model_suggestions(self) -> &'static [&'static str] {
        match self {
            Self::Ollama => &["llama3.1:8b", "llama3.2:3b", "qwen2.5:7b", "mistral:7b"],
            Self::LocalOpenai => &[],
            Self::Openai => &["gpt-4o-mini", "gpt-4o", "o4-mini"],
            Self::Anthropic => &["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
        }
    }
}

/// Quality tiers, low → high.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiQuality {
    Low,
    Normal,
    High,
    Ultra,
}

impl AiQuality {
    pub const LEVELS: [AiQuality; 4] = [Self::Low, Self::Normal, Self::High, Self::Ultra];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Normal => "normal",
            Self::High => "high",
            Self::Ultra => "ultra",
        }
    }
    /// `AI_QUALITY_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Low => "Low",
            Self::Normal => "Medium",
            Self::High => "High",
            Self::Ultra => "Ultra",
        }
    }
}

/// The AI level a person picks in the assistant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiLevel {
    Low,
    #[default]
    Medium,
    High,
}

impl AiLevel {
    pub const ALL: [AiLevel; 3] = [Self::Low, Self::Medium, Self::High];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
    /// `AI_LEVEL_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Low => "Low",
            Self::Medium => "Medium",
            Self::High => "High",
        }
    }
    /// `AI_LEVEL_HINTS`.
    pub fn hint(self) -> &'static str {
        match self {
            Self::Low => "Quickest replies, for simple questions.",
            Self::Medium => "Good answers at a good speed.",
            Self::High => {
                "Thinks it through first. Slower, best for planning and tricky questions."
            }
        }
    }
    /// `AI_LEVEL_QUALITY`.
    pub fn quality(self) -> AiQuality {
        match self {
            Self::Low => AiQuality::Low,
            Self::Medium => AiQuality::Normal,
            Self::High => AiQuality::High,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiPriority {
    Realtime,
    Interactive,
    Normal,
    Background,
    Batch,
}

/// The features that ask for a tier and a queue priority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiFeature {
    Categorize,
    Reports,
    Chat,
}

impl AiFeature {
    /// `AI_FEATURE_QUALITY`.
    pub fn quality(self) -> AiQuality {
        match self {
            Self::Categorize => AiQuality::Normal,
            Self::Reports => AiQuality::High,
            Self::Chat => AiQuality::Normal,
        }
    }
    /// `AI_FEATURE_PRIORITY`.
    pub fn priority(self) -> AiPriority {
        match self {
            Self::Categorize => AiPriority::Background,
            Self::Reports => AiPriority::Normal,
            Self::Chat => AiPriority::Interactive,
        }
    }
}

/// Live AI status. The key itself is never returned, only `has_api_key`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub enabled: bool,
    pub configured: bool,
    pub reachable: bool,
    pub provider: AiProvider,
    pub model: String,
    /// Empty for cloud providers.
    pub base_url: String,
    pub has_api_key: bool,
    pub available_models: Vec<String>,
    /// Quality tier → model (free-form keys).
    pub quality_models: OrderedMap<String>,
    pub show_model_names: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// True for addresses that never leave your own networks: loopback, private
/// LAN ranges, Tailscale (100.64.0.0/10, *.ts.net), and single-label or
/// .local/.lan/.home/.internal names.
pub fn is_private_host(hostname: &str) -> bool {
    let lower = hostname.to_lowercase();
    let h = lower.strip_prefix('[').unwrap_or(&lower);
    let h = h.strip_suffix(']').unwrap_or(h);
    if !h.contains('.') && !h.contains(':') {
        return true;
    }
    if [
        ".local",
        ".lan",
        ".home",
        ".internal",
        ".home.arpa",
        ".ts.net",
    ]
    .iter()
    .any(|s| h.ends_with(s))
    {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() == 4
        && parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
    {
        let a: u32 = parts[0].parse().unwrap_or(0);
        let b: u32 = parts[1].parse().unwrap_or(0);
        return a == 127
            || a == 10
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 100 && (64..=127).contains(&b))
            || (a == 169 && b == 254);
    }
    let hb = h.as_bytes();
    let hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
    // /^f[cd][0-9a-f]{2}:/ (unique local) and /^fe[89ab][0-9a-f]:/ (link local).
    let ula = hb.len() >= 5
        && hb[0] == b'f'
        && matches!(hb[1], b'c' | b'd')
        && hex(hb[2])
        && hex(hb[3])
        && hb[4] == b':';
    let link = hb.len() >= 5
        && hb[0] == b'f'
        && hb[1] == b'e'
        && matches!(hb[2], b'8' | b'9' | b'a' | b'b')
        && hex(hb[3])
        && hb[4] == b':';
    h == "::1" || ula || link
}

/// Financial context must never cross the internet unencrypted: true for an
/// `http://` URL whose host isn't private.
pub fn plain_http_to_public_host(base_url: Option<&str>) -> bool {
    let raw = crate::serde_util::js_trim(base_url.unwrap_or(""));
    if raw.len() < 7 || !raw[..7].eq_ignore_ascii_case("http://") {
        return false;
    }
    let rest = &raw[7..];
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // `replace(/^[^@]*@/, "")`: drop everything up to the first "@".
    let host = match authority.find('@') {
        Some(i) => &authority[i + 1..],
        None => authority,
    };
    let hostname = if host.starts_with('[') {
        // `host.slice(0, host.indexOf("]") + 1)`: no "]" gives "".
        match host.find(']') {
            Some(i) => &host[..=i],
            None => "",
        }
    } else {
        // `replace(/:\d*$/, "")`.
        let trimmed = host.trim_end_matches(|c: char| c.is_ascii_digit());
        trimmed.strip_suffix(':').unwrap_or(host)
    };
    !hostname.is_empty() && !is_private_host(hostname)
}

pub const PUBLIC_HTTP_MESSAGE: &str = "An AI server on the internet must use https:// — plain http:// would send your financial data unencrypted. http:// is fine on your own network or Tailscale.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiHostPower {
    On,
    Off,
    Starting,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiQueue {
    pub active: i64,
    pub waiting: i64,
}

/// Power state of a separate AI server, shown at the top of the assistant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiHostStatus {
    pub applies: bool,
    pub power: AiHostPower,
    pub can_start: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue: Option<AiQueue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// "Test connection" without saving. Omit `api_key` to reuse the stored key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestRequest {
    pub provider: AiProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

impl AiTestRequest {
    /// The schema's refine.
    pub fn problem(&self) -> Option<&'static str> {
        plain_http_to_public_host(self.base_url.as_deref()).then_some(PUBLIC_HTTP_MESSAGE)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestResponse {
    pub ok: bool,
    pub models: Vec<String>,
    pub latency_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiModelsResponse {
    pub models: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAiSettingsRequest {
    pub enabled: bool,
    pub provider: AiProvider,
    pub model: String,
    /// Omit to keep the stored key; "" clears it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality_models: Option<OrderedMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_model_names: Option<bool>,
}

impl UpdateAiSettingsRequest {
    /// The schema's two refines, in order.
    pub fn problem(&self) -> Option<&'static str> {
        let base = crate::serde_util::js_trim(self.base_url.as_deref().unwrap_or(""));
        // /^https?:\/\/\S+$/
        let after = base
            .strip_prefix("http://")
            .or_else(|| base.strip_prefix("https://"));
        let url_ok = after.is_some_and(|r| !r.is_empty() && !r.chars().any(char::is_whitespace));
        if self.provider.is_local() && !url_ok {
            return Some("A local AI server needs a base URL starting with http:// or https://, e.g. http://ollama:11434");
        }
        plain_http_to_public_host(self.base_url.as_deref()).then_some(PUBLIC_HTTP_MESSAGE)
    }
}

/// A user message's text without attached files, and the files' names
/// (`splitUserMessage`, over `FILE_BLOCK_RE`).
pub fn split_user_message(content: &str) -> (String, Vec<String>) {
    const OPEN: &str = "<vault-file name=\"";
    const CLOSE: &str = "</vault-file>";
    let mut files = Vec::new();
    let mut text = String::new();
    let mut copied = 0; // end of the last match
    let mut search = 0;
    while let Some(rel) = content[search..].find(OPEN) {
        let tag = search + rel;
        let name_start = tag + OPEN.len();
        let matched = content[name_start..].find('"').and_then(|q| {
            let name_end = name_start + q;
            let gt = name_end + 1 + content[name_end + 1..].find('>')?;
            let close = gt + 1 + content[gt + 1..].find(CLOSE)?;
            Some((name_end, close + CLOSE.len()))
        });
        let Some((name_end, end)) = matched else {
            search = name_start;
            continue;
        };
        // `\n*` before the tag belongs to the match.
        let start = copied + content[copied..tag].trim_end_matches('\n').len();
        files.push(content[name_start..name_end].to_string());
        text.push_str(&content[copied..start]);
        copied = end;
        search = end;
    }
    text.push_str(&content[copied..]);
    (crate::serde_util::js_trim(&text).to_string(), files)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: String,
    pub created_at: String,
    /// Changes this reply proposed (assistant messages only).
    #[serde(default)]
    pub actions: Vec<AiActionRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationListResponse {
    pub conversations: Vec<Conversation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetail {
    pub id: String,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<AiMessage>,
}

/// A spreadsheet attached to a chat message, as CSV text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatAttachment {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<ChatAttachment>,
    /// Apply proposed changes straight away.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_apply: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<AiLevel>,
}

/// The JSON literal `true` (zod `z.literal(true)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct True;

impl Serialize for True {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if bool::deserialize(d)? {
            Ok(True)
        } else {
            Err(serde::de::Error::custom("expected true"))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamError {
    pub code: String,
    pub message: String,
}

/// One NDJSON line of the chat stream (ADR-0005), tried in the schema's order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatStreamLine {
    /// First line: the conversation this reply belongs to.
    Started {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        started: True,
    },
    /// The next piece of assistant text.
    Token { token: String },
    /// The model is reasoning before it answers.
    Thinking { thinking: True },
    /// What the assistant is looking up ("Checking transactions…").
    Status { status: String },
    /// Proposed (or auto-applied) changes, before done.
    Actions { actions: Vec<AiActionRecord> },
    /// Notes added to the assistant's memory.
    Remembered { remembered: Vec<String> },
    /// Final line.
    Done {
        done: True,
        #[serde(rename = "conversationId")]
        conversation_id: String,
    },
    /// Terminal failure mid-stream.
    Error { error: StreamError },
}

// ── The open conversation (apps/desktop/src/state/chat.ts) ──

/// One message of the conversation the Assistant page and the chat bubble
/// share (`ChatMessage` in state/chat.ts, which stays in JS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: MessageRole,
    pub text: String,
    #[serde(default)]
    pub pending: bool,
    /// The model is reasoning before it answers (AI level High).
    #[serde(default)]
    pub thinking: bool,
    /// What it's looking up right now.
    #[serde(default)]
    pub status: Option<String>,
    /// Changes this reply proposed.
    #[serde(default)]
    pub actions: Vec<AiActionRecord>,
    /// Notes it saved to the assistant's memory.
    #[serde(default)]
    pub remembered: Vec<String>,
    /// The user pressed Stop on this reply.
    #[serde(default)]
    pub stopped: bool,
    /// Spreadsheets attached to this (user) message, by name.
    #[serde(default)]
    pub files: Vec<String>,
}

impl ChatMessage {
    /// The reply as shown: `stripAssistantBlocks(m.text)`.
    pub fn shown_text(&self) -> String {
        crate::ai_actions::strip_assistant_blocks(&self.text)
    }

    /// Still waiting for the first visible text (the "···" / status line).
    pub fn waiting(&self) -> bool {
        self.pending && self.shown_text().is_empty()
    }

    /// Changes still waiting for Approve / Decline.
    pub fn pending_actions(&self) -> usize {
        self.actions
            .iter()
            .filter(|a| a.status == crate::ai_actions::AiActionStatus::Pending)
            .count()
    }
}

impl crate::ai_actions::AiActionStatus {
    /// ChatView's `STATUS_LABEL`.
    pub fn label(self) -> &'static str {
        use crate::ai_actions::AiActionStatus::*;
        match self {
            Pending => "Waiting for you",
            Applied => "Done",
            Rejected => "Declined",
            Failed => "Didn't work",
        }
    }
}

impl AiStatus {
    /// The assistant can't answer: off, not set up, or unreachable.
    pub fn offline(&self) -> bool {
        !self.enabled || !self.configured || !self.reachable
    }
}

impl AiHostStatus {
    /// AiHostBar's line of text.
    pub fn bar_text(&self) -> String {
        let queued = self.queue.map(|q| q.active + q.waiting).unwrap_or(0);
        match self.power {
            AiHostPower::On => match self.queue {
                Some(q) if queued > 0 => {
                    format!("AI server on · {} running, {} waiting", q.active, q.waiting)
                }
                _ => "AI server on".into(),
            },
            AiHostPower::Starting => "AI server starting — usually under a minute".into(),
            AiHostPower::Off if self.can_start => "AI server is asleep".into(),
            AiHostPower::Off => "AI server is off — switch it on, then come back".into(),
            AiHostPower::Unknown => self
                .message
                .clone()
                .unwrap_or_else(|| "Can't tell whether the AI server is on".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chat_messages() {
        let m: Vec<ChatMessage> = serde_json::from_str(
            r#"[{"role":"user","text":"Import this","files":["budget.xlsx"]},
                {"role":"assistant","text":"","pending":true,"status":"Checking budgets…"},
                {"role":"assistant","text":"Here you go.<vault-action>{\"type\":\"set_budget\"","pending":true,
                 "actions":[{"id":"3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f","conversationId":"0f1e2d3c-4b5a-4968-8776-655443322110",
                   "messageId":null,"action":{"type":"set_budget","category":"Dining","amount":250},
                   "summary":"Set the monthly budget for \"Dining\" to $250","client":false,"status":"pending",
                   "error":null,"createdAt":"2026-11-24T17:00:04.000Z"}],"remembered":["Paid biweekly"],"stopped":true}]"#,
        )
        .unwrap();
        assert_eq!(m[0].files, ["budget.xlsx"]);
        assert!(m[1].waiting());
        assert_eq!(m[1].status.as_deref(), Some("Checking budgets…"));
        assert_eq!(m[2].shown_text(), "Here you go.");
        assert!(!m[2].waiting() && m[2].stopped);
        assert_eq!(m[2].pending_actions(), 1);
        assert_eq!(m[2].actions[0].status.label(), "Waiting for you");
    }

    #[test]
    fn host_bar_text() {
        let mut h: AiHostStatus = serde_json::from_str(
            r#"{"applies":true,"power":"on","canStart":true,"queue":{"active":0,"waiting":0}}"#,
        )
        .unwrap();
        assert_eq!(h.bar_text(), "AI server on");
        h.queue = Some(AiQueue {
            active: 1,
            waiting: 2,
        });
        assert_eq!(h.bar_text(), "AI server on · 1 running, 2 waiting");
        h.power = AiHostPower::Off;
        assert_eq!(h.bar_text(), "AI server is asleep");
        h.can_start = false;
        assert_eq!(
            h.bar_text(),
            "AI server is off — switch it on, then come back"
        );
        h.power = AiHostPower::Unknown;
        assert_eq!(h.bar_text(), "Can't tell whether the AI server is on");
        h.message = Some("Wake-on-LAN isn't set up".into());
        assert_eq!(h.bar_text(), "Wake-on-LAN isn't set up");
    }

    #[test]
    fn parses_ai_status() {
        let s: AiStatus = serde_json::from_str(
            r#"{"enabled":true,"configured":true,"reachable":false,"provider":"local_openai","model":"qwen2.5:14b",
                "baseUrl":"http://100.70.0.5:8000/v1","hasApiKey":false,"availableModels":["qwen2.5:14b","llama3.1:8b"],
                "qualityModels":{"low":"llama3.1:8b","normal":"qwen2.5:14b","high":"qwen2.5:32b"},"showModelNames":false,
                "error":"The AI server didn't answer.","hint":"Is the AI machine switched on?"}"#,
        )
        .unwrap();
        assert_eq!(s.provider, AiProvider::LocalOpenai);
        assert!(s.provider.is_local() && !s.provider.is_cloud());
        assert_eq!(
            s.quality_models.keys().collect::<Vec<_>>(),
            ["low", "normal", "high"]
        );
        let h: AiHostStatus = serde_json::from_str(
            r#"{"applies":true,"power":"starting","canStart":true,"queue":{"active":1,"waiting":3}}"#,
        )
        .unwrap();
        assert_eq!(
            h.queue,
            Some(AiQueue {
                active: 1,
                waiting: 3
            })
        );
        assert_eq!(AiLevel::default().quality(), AiQuality::Normal);
        assert_eq!(AiQuality::Normal.label(), "Medium");
        assert_eq!(AiFeature::Chat.priority(), AiPriority::Interactive);
    }

    #[test]
    fn parses_conversations_and_the_stream() {
        let c: ConversationDetail = serde_json::from_str(
            r#"{"id":"0f1e2d3c-4b5a-4968-8776-655443322110","title":"Dining budget","createdAt":"2026-11-24T17:00:00.000Z",
                "updatedAt":"2026-11-24T17:01:30.000Z","messages":[
                 {"id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","role":"user","content":"Set dining to $250",
                  "createdAt":"2026-11-24T17:00:00.000Z"},
                 {"id":"2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e","role":"assistant","content":"Done.",
                  "createdAt":"2026-11-24T17:00:04.000Z","actions":[]}]}"#,
        )
        .unwrap();
        assert_eq!(c.messages[0].role, MessageRole::User);
        assert!(c.messages[0].actions.is_empty());
        let lines: Vec<ChatStreamLine> = [
            r#"{"conversationId":"0f1e2d3c-4b5a-4968-8776-655443322110","started":true}"#,
            r#"{"thinking":true}"#,
            r#"{"status":"Checking transactions…"}"#,
            r#"{"token":"Done"}"#,
            r#"{"remembered":["Paid biweekly on Fridays"]}"#,
            r#"{"done":true,"conversationId":"0f1e2d3c-4b5a-4968-8776-655443322110"}"#,
            r#"{"error":{"code":"AI_UNAVAILABLE","message":"The AI server stopped answering."}}"#,
        ]
        .iter()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
        assert!(matches!(lines[0], ChatStreamLine::Started { .. }));
        assert_eq!(lines[1], ChatStreamLine::Thinking { thinking: True });
        assert!(matches!(lines[2], ChatStreamLine::Status { .. }));
        assert_eq!(
            lines[3],
            ChatStreamLine::Token {
                token: "Done".into()
            }
        );
        assert!(matches!(lines[5], ChatStreamLine::Done { .. }));
        assert!(matches!(lines[6], ChatStreamLine::Error { .. }));
        assert!(serde_json::from_str::<ChatStreamLine>(r#"{"thinking":false}"#).is_err());
        let body = ChatRequest {
            message: "hi".into(),
            level: Some(AiLevel::High),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"message":"hi","level":"high"}"#
        );
    }

    #[test]
    fn private_hosts_and_plain_http() {
        for h in [
            "ollama",
            "localhost",
            "gpu.lan",
            "box.tail1234.ts.net",
            "10.0.0.4",
            "172.20.1.1",
            "192.168.1.50",
            "100.70.0.5",
            "169.254.1.1",
            "127.0.0.1",
            "[::1]",
            "fd12:3456::1",
            "fe80::1",
        ] {
            assert!(is_private_host(h), "{h}");
        }
        for h in [
            "8.8.8.8",
            "172.32.0.1",
            "100.12.0.1",
            "ai.example.com",
            "2001:db8::1",
        ] {
            assert!(!is_private_host(h), "{h}");
        }
        assert!(plain_http_to_public_host(Some(
            "http://ai.example.com:8000/v1"
        )));
        assert!(plain_http_to_public_host(Some(" HTTP://user:pw@8.8.8.8/x")));
        assert!(!plain_http_to_public_host(Some("https://ai.example.com")));
        assert!(!plain_http_to_public_host(Some(
            "http://192.168.1.50:1234/v1"
        )));
        assert!(!plain_http_to_public_host(Some("http://[::1]:11434")));
        assert!(!plain_http_to_public_host(None));
        let local = UpdateAiSettingsRequest {
            enabled: true,
            provider: AiProvider::Ollama,
            model: "llama3.1:8b".into(),
            api_key: None,
            base_url: Some("ollama:11434".into()),
            quality_models: None,
            show_model_names: None,
        };
        assert!(local
            .problem()
            .unwrap()
            .starts_with("A local AI server needs a base URL"));
        let public = UpdateAiSettingsRequest {
            base_url: Some("http://ai.example.com".into()),
            ..local.clone()
        };
        assert_eq!(public.problem(), Some(PUBLIC_HTTP_MESSAGE));
        let fine = UpdateAiSettingsRequest {
            base_url: Some("http://ollama:11434".into()),
            ..local
        };
        assert_eq!(fine.problem(), None);
    }

    #[test]
    fn splits_attached_files_out_of_a_message() {
        let (text, files) = split_user_message(
            "Import this budget please\n\n<vault-file name=\"budget 2026.csv\" rows=\"12\">Category,Amount\nDining,250\n</vault-file>",
        );
        assert_eq!(text, "Import this budget please");
        assert_eq!(files, ["budget 2026.csv"]);
        let (text, files) = split_user_message(
            "<vault-file name=\"a.csv\">x</vault-file>\nand\n<vault-file name=\"\">y</vault-file>",
        );
        assert_eq!(text, "and");
        assert_eq!(files, ["a.csv", ""]);
        assert_eq!(
            split_user_message("  plain  "),
            ("plain".to_string(), vec![])
        );
        // An unclosed block isn't a file.
        assert_eq!(
            split_user_message("<vault-file name=\"a\">x").1,
            Vec::<String>::new()
        );
    }
}
