//! `<StatusList>` from apps/desktop/src/screens/StatusList.tsx: the
//! health-check rows of the startup screen and Settings → System status.

use leptos::prelude::*;
use vault_core::startup_checks::{CheckAction, UiCheck, UiLevel};

use super::{Button, Icon, Spinner};

fn look(level: UiLevel) -> Option<(&'static str, &'static str, &'static str)> {
    match level {
        UiLevel::Ok => Some(("check", "var(--color-positive)", "OK")),
        UiLevel::Warn => Some(("alert", "var(--color-warning)", "Needs attention")),
        UiLevel::Error => Some(("alert", "var(--color-negative)", "Problem")),
        UiLevel::Off => Some(("minus", "var(--content-tertiary)", "Off")),
        UiLevel::Pending => None,
    }
}

/// `ACTION_LABEL`.
pub fn action_label(a: CheckAction) -> &'static str {
    match a {
        CheckAction::TailscaleUp => "Turn on Tailscale",
        CheckAction::TailscaleLogin => "Sign in to Tailscale",
        CheckAction::TailscaleInstall => "Get Tailscale",
        CheckAction::ChangeServer => "Change server",
        CheckAction::UpdateApp => "Check for app update",
    }
}

#[component]
pub fn StatusList(
    #[prop(into)] checks: Signal<Vec<UiCheck>>,
    #[prop(optional)] on_action: Option<Callback<CheckAction>>,
    #[prop(optional, into)] busy_action: Signal<Option<CheckAction>>,
    #[prop(optional)] hide_actions: &'static [CheckAction],
) -> impl IntoView {
    view! {
        <ul style="list-style: none; margin: 0px; padding: 0px; display: grid; gap: 2px" aria-live="polite">
            <For each=move || checks.get() key=|c| (c.id.clone(), format!("{c:?}")) let:c>
                {
                    let bad = matches!(c.level, UiLevel::Error | UiLevel::Warn);
                    let bg = match c.level {
                        UiLevel::Error => "var(--color-negative-soft)",
                        UiLevel::Warn => "var(--color-warning-soft)",
                        _ => "transparent",
                    };
                    let lk = look(c.level);
                    let show_action = c.action.filter(|a| {
                        on_action.is_some()
                            && !hide_actions.contains(a)
                            && (bad || *a == CheckAction::TailscaleUp)
                    });
                    let label = c.label.clone();
                    let pending_label = format!("Checking {label}");
                    view! {
                        <li style=format!("display: grid; grid-template-columns: 22px 1fr; gap: 10px; padding: 9px 10px; border-radius: var(--radius-md); background: {bg}; animation: fadeUp .25s both")>
                            <span style=format!("{}display: grid; place-items: center; height: 20px", lk.map(|l| format!("color: {}; ", l.1)).unwrap_or_default())>
                                {match lk {
                                    Some((icon, _, word)) => view! {
                                        <Icon name=icon size=16 />
                                        <span class="sr-only">{word}</span>
                                    }.into_any(),
                                    None => view! { <Spinner label=pending_label /> }.into_any(),
                                }}
                            </span>
                            <div style="min-width: 0px">
                                <div style="display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap">
                                    <span style="font-weight: 600; font-size: var(--text-sm)">{label}</span>
                                    {c.detail.clone().filter(|d| !d.is_empty()).map(|d| view! {
                                        <span style="font-size: var(--text-sm); color: var(--content-secondary)">{d}</span>
                                    })}
                                </div>
                                {c.hint.clone().filter(|h| !h.is_empty() && bad).map(|h| view! {
                                    <div style="font-size: var(--text-xs); color: var(--content-secondary); margin-top: 3px; line-height: 1.5">{h}</div>
                                })}
                                {show_action.map(|a| view! {
                                    <div style="margin-top: 6px">
                                        <Button variant=if c.level == UiLevel::Error { "primary" } else { "secondary" }
                                            on_click=move || { if let Some(f) = on_action { f.run(a) } }
                                            disabled=Signal::derive(move || busy_action.get().is_some())>
                                            {move || if busy_action.get() == Some(a) {
                                                view! { <Spinner label="Working" /> }.into_any()
                                            } else {
                                                action_label(a).into_any()
                                            }}
                                        </Button>
                                    </div>
                                })}
                            </div>
                        </li>
                    }
                }
            </For>
        </ul>
    }
}
