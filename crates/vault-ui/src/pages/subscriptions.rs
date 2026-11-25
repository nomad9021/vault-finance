//! Subscriptions: port of apps/desktop/src/screens/shell/SubscriptionsPage.tsx.
//!
//! Recurring charges the server detected in the ledger. Rows can be promoted
//! to a tracked bill, marked "Not a subscription" (undoable from the Hidden
//! list) or opened in Transactions.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::subscriptions::{Subscription, SubscriptionListResponse};
use wasm_bindgen::JsValue;

use crate::fmt;
use crate::host::{use_host, HostCtx};
use crate::ui::{Button, EmptyState, MetricCard, Panel, PanelLink, Spinner, Tag};

/// State shared by every row: which row is busy, the last error, and a
/// counter that refetches the list (React's `reloadSubs()`).
#[derive(Clone, Copy)]
struct Actions {
    tracking: RwSignal<Option<String>>,
    error: RwSignal<Option<String>>,
    reload: RwSignal<u32>,
    /// Lives here, not in `Loaded`, so a refetch doesn't collapse the list.
    show_hidden: RwSignal<bool>,
}

impl Actions {
    fn busy(self, id: &str) -> Signal<bool> {
        let id = id.to_string();
        Signal::derive(move || self.tracking.with(|t| t.as_deref() == Some(id.as_str())))
    }

    /// Promote a detected charge into a tracked bill.
    fn track_as_bill(self, host: HostCtx, sub: &Subscription) {
        let body = sub.bill_request();
        self.run(
            sub.id.clone(),
            "Couldn't track that as a bill.",
            async move {
                let body = serde_wasm_bindgen::to_value(&body).map_err(|e| e.to_string())?;
                host.call::<IgnoredAny>("createBill", &[body])
                    .await
                    .map(|_| ())
            },
        );
    }

    fn set_dismissed(self, host: HostCtx, sub: &Subscription, dismissed: bool) {
        let id = sub.id.clone();
        let name = sub.merchant_name.clone();
        let fut_id = id.clone();
        self.run(id, "Couldn't update that subscription.", async move {
            let id = JsValue::from_str(&fut_id);
            if dismissed {
                host.call::<IgnoredAny>("dismissSubscription", &[id, JsValue::from_str(&name)])
                    .await
            } else {
                host.call::<IgnoredAny>("restoreSubscription", &[id]).await
            }
            .map(|_| ())
        });
    }

    fn run(
        self,
        id: String,
        fallback: &'static str,
        fut: impl std::future::Future<Output = Result<(), String>> + 'static,
    ) {
        self.tracking.set(Some(id));
        self.error.set(None);
        spawn_local(async move {
            match fut.await {
                Ok(()) => self.reload.update(|v| *v += 1),
                Err(e) => self
                    .error
                    .set(Some(if e.is_empty() { fallback.into() } else { e })),
            }
            self.tracking.set(None);
        });
    }
}

#[component]
pub fn SubscriptionsPage() -> impl IntoView {
    let host = use_host();
    let version = host.data_version;
    let actions = Actions {
        tracking: RwSignal::new(None),
        error: RwSignal::new(None),
        reload: RwSignal::new(0),
        show_hidden: RwSignal::new(false),
    };
    let data = LocalResource::new(move || {
        version.track();
        actions.reload.track();
        let host = use_host();
        async move {
            host.call::<SubscriptionListResponse>("subscriptions", &[])
                .await
        }
    });

    move || {
        match data.get() {
        None => view! { <Spinner label="Scanning for recurring charges" /> }.into_any(),
        Some(Err(e)) => view! {
            <div class="panel"><EmptyState icon="alert" title="Couldn't load subscriptions" body=e /></div>
        }
        .into_any(),
        Some(Ok(r)) => view! { <Loaded data=r actions=actions /> }.into_any(),
    }
    }
}

#[component]
fn Loaded(data: SubscriptionListResponse, actions: Actions) -> impl IntoView {
    let host = use_host();
    let show_hidden = actions.show_hidden;
    let active = data.active();
    let stale = data.stale();
    let increases = data.increase_count();
    let hidden = data.dismissed.clone();
    let tracked = data.tracked_as_bill_count;

    let body = if data.is_empty() {
        let host = host.clone();
        view! {
            <div class="panel">
                <EmptyState icon="refresh" title="No recurring charges detected"
                    body="This page reads your transaction history and looks for merchants that charge on a regular schedule. Import a few months of transactions and subscriptions will appear here on their own."
                    action=view! {
                        <Button variant="primary" on_click=move || host.navigate("transactions", &())>
                            "Go to Transactions"
                        </Button>
                    }.into_any() />
            </div>
        }
        .into_any()
    } else {
        let view_bills = (tracked > 0).then(|| {
            let host = host.clone();
            view! { <PanelLink on_click=move || host.navigate("bills", &())>"View bills"</PanelLink> }
                .into_any()
        });
        let rows = move |subs: Vec<Subscription>, hidden: bool| {
            view! {
                <div style="display: flex; flex-direction: column">
                    {subs.into_iter().map(|s| view! { <SubscriptionRow sub=s actions=actions hidden=hidden /> }).collect_view()}
                </div>
            }
        };
        let active_body = if active.is_empty() {
            view! { <p class="card-meta">"Nothing currently charging on a schedule."</p> }
                .into_any()
        } else {
            rows(active, false).into_any()
        };
        let stale_panel = (!stale.is_empty()).then(|| {
            view! {
                <Panel title="Possibly cancelled"
                    subtitle="These charged regularly, then stopped — worth confirming they're really gone">
                    {rows(stale, false)}
                </Panel>
            }
        });
        let hidden_panel = (!hidden.is_empty()).then(|| {
            let n = hidden.len();
            let toggle = view! {
                <button type="button" class="panel-link" on:click=move |_| show_hidden.update(|v| *v = !*v)>
                    {move || if show_hidden.get() { "Hide" } else { "Show" }}
                </button>
            }
            .into_any();
            view! {
                <Panel title="Not subscriptions" subtitle=format!("{n} hidden · left out of the totals") actions=Some(toggle)>
                    {move || show_hidden.get().then(|| rows(hidden.clone(), true))}
                </Panel>
            }
        });
        view! {
            <Panel title="Active subscriptions" subtitle=data.active_subtitle() actions=view_bills>
                {active_body}
            </Panel>
            {stale_panel}
            {hidden_panel}
        }
        .into_any()
    };

    let n_active = data.subscriptions.iter().filter(|s| !s.stale).count();
    view! {
        <div class="page">
            {move || actions.error.get().map(|e| view! {
                <div role="alert" class="panel" style="color: var(--color-negative)">{e}</div>
            })}
            <div class="page-head">
                <div class="grid" style="flex: 1; min-width: 0">
                    <div class="col-4"><MetricCard label="Recurring per month" value=fmt::cents_whole(data.monthly_total_cents) hint=format!("{n_active} active") /></div>
                    <div class="col-4"><MetricCard label="Per year" value=fmt::cents_whole(data.yearly_total_cents) hint="if nothing changes" /></div>
                    <div class="col-4"><MetricCard label="Price rises" value=increases.to_string() hint="since the previous charge" /></div>
                </div>
            </div>
            {body}
        </div>
    }
}

#[component]
fn SubscriptionRow(sub: Subscription, actions: Actions, hidden: bool) -> impl IntoView {
    let host = use_host();
    let busy = actions.busy(&sub.id);
    let filter = sub.filter();
    let buttons = if hidden {
        let (s, h) = (sub.clone(), host.clone());
        view! {
            <Button variant="secondary" size="sm" disabled=busy on_click=move || actions.set_dismissed(h.clone(), &s, false)>
                {move || if busy.get() { view! { <Spinner label="Restoring" /> }.into_any() } else { "It's a subscription".into_any() }}
            </Button>
        }
        .into_any()
    } else {
        let (t, d) = (sub.clone(), sub.clone());
        let (ht, hd) = (host.clone(), host.clone());
        view! {
            <Button variant="secondary" size="sm" disabled=busy on_click=move || actions.track_as_bill(ht.clone(), &t)>
                {move || if busy.get() { view! { <Spinner label="Working" /> }.into_any() } else { "Track as bill".into_any() }}
            </Button>
            <Button variant="ghost" size="sm" disabled=busy on_click=move || actions.set_dismissed(hd.clone(), &d, true)>
                "Not a subscription"
            </Button>
        }
        .into_any()
    };
    view! {
        <div class="row-div wrap-actions" style="display: flex; align-items: center; gap: 14px; padding: 12px 2px">
            <div style="flex: 1; min-width: 0">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                    <span style="font-weight: 600; font-size: var(--text-base)">{sub.merchant_name.clone()}</span>
                    {sub.stale.then(|| view! { <Tag variant="warning">"no recent charge"</Tag> })}
                    {sub.shown_increase().map(|c| view! { <Tag variant="negative">"up "{fmt::cents_whole(c)}</Tag> })}
                </div>
                <div style="font-size: var(--text-xs); color: var(--content-tertiary); margin-top: 2px">
                    {format!(
                        "{} · last charged {} · {} {}",
                        sub.cadence.as_str(),
                        fmt::short_date(&sub.last_charged_at),
                        if sub.stale { "was due" } else { "next" },
                        fmt::short_date(&sub.next_expected_at),
                    )}
                </div>
                <div style="font-size: var(--text-2xs); color: var(--content-tertiary); margin-top: 2px">
                    {format!("Based on {} charges · {}% regular", sub.occurrences, sub.regular_percent())}
                </div>
            </div>

            <div style="text-align: right; flex: none">
                <div class="num" style="font-weight: 600; font-size: var(--text-md)">{fmt::cents_whole(sub.amount_cents)}</div>
                <div style="font-size: var(--text-2xs); color: var(--content-tertiary)">{format!("{}/mo", fmt::cents_whole(sub.monthly_cents))}</div>
            </div>

            <div class="row-actions">
                {buttons}
                <Button variant="ghost" size="sm" icon_end="arrowRight" on_click=move || host.navigate("transactions", &filter)>
                    "Charges"
                </Button>
            </div>
        </div>
    }
}
