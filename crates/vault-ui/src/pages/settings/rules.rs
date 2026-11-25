//! `CategorizationRulesSection`: explicit keyword → category rules for local
//! auto-categorization. These run alongside history-learning (which needs no
//! config); both are local and never involve the AI assistant.

use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::categories::CategoryListResponse;
use vault_core::categorize::{CreateRuleRequest, RuleListResponse};

use crate::host::{use_host, HostCtx};
use crate::ui::{Button, Card, Field, Select, SelectOption};

#[component]
pub fn CategorizationRulesSection() -> impl IntoView {
    let host = use_host();
    let data_version = host.data_version;
    let version = RwSignal::new(0_u32);
    let rule_data = LocalResource::new(move || {
        data_version.track();
        version.track();
        let host = use_host();
        async move {
            host.call::<RuleListResponse>("categorizationRules", &[])
                .await
        }
    });
    let cat_data = LocalResource::new(move || {
        data_version.track();
        let host = use_host();
        async move { host.call::<CategoryListResponse>("categories", &[]).await }
    });
    let rules = move || {
        rule_data
            .get()
            .and_then(Result::ok)
            .map(|r| r.rules)
            .unwrap_or_default()
    };
    let categories = Signal::derive(move || {
        cat_data
            .get()
            .and_then(Result::ok)
            .map(|r| r.categories)
            .unwrap_or_default()
    });
    let cat_name = move |id: &str| {
        categories.with(|c| {
            c.iter()
                .find(|c| c.id == id)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| "Unknown".into())
        })
    };

    let keyword = RwSignal::new(String::new());
    let category_id = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let add = {
        let host = host.clone();
        move || {
            let kw = keyword.get_untracked().trim().to_string();
            let cid = category_id.get_untracked();
            if kw.is_empty() || cid.is_empty() {
                return;
            }
            let host = host.clone();
            busy.set(true);
            error.set(None);
            spawn_local(async move {
                let body = CreateRuleRequest {
                    keyword: kw,
                    category_id: cid,
                    priority: None,
                };
                match host
                    .call::<IgnoredAny>("createCategorizationRule", &[HostCtx::arg(&body)])
                    .await
                {
                    Ok(_) => {
                        keyword.try_set(String::new());
                        category_id.try_set(String::new());
                        version.try_update(|v| *v += 1);
                    }
                    Err(_) => {
                        error.try_set(Some("Couldn't add that rule.".into()));
                    }
                }
                busy.try_set(false);
            });
        }
    };
    let remove = {
        let host = host.clone();
        move |id: String| {
            let host = host.clone();
            spawn_local(async move {
                let _ = host
                    .call::<IgnoredAny>("deleteCategorizationRule", &[id.into()])
                    .await;
                version.try_update(|v| *v += 1);
            });
        }
    };

    let options = Signal::derive(move || {
        let mut o = vec![SelectOption::new("", "Choose…")];
        o.extend(
            categories
                .get()
                .into_iter()
                .map(|c| SelectOption::new(c.id, c.name)),
        );
        o
    });

    view! {
        <Card kicker="Categorization" title="Auto-categorization rules">
            <p class="card-meta">
                "When a transaction’s merchant name contains a keyword, file it under the chosen category — applied on CSV import and when you press “Auto-categorize” on the Transactions page. Entirely local; the AI assistant is never involved. Beyond these rules, the app also learns from how you’ve categorized transactions before."
            </p>

            <div style="margin: 12px 0px">
                {move || {
                    let rules = rules();
                    if rules.is_empty() {
                        view! {
                            <p class="card-meta">"No keyword rules yet — history-learning still works without them."</p>
                        }.into_any()
                    } else {
                        rules.into_iter().map(|r| {
                            let remove = remove.clone();
                            let id = r.id.clone();
                            view! {
                                <div style="display: flex; align-items: center; gap: 10px; padding: 7px 0px; border-top: 1px solid var(--color-divider)">
                                    <span style="font-weight: 600; font-size: var(--text-sm)">{format!("“{}”", r.keyword)}</span>
                                    <span style="color: var(--content-tertiary); font-size: var(--text-sm)">
                                        {format!("→ {}", cat_name(&r.category_id))}
                                    </span>
                                    <div style="margin-left: auto">
                                        <Button variant="ghost" on_click=move || remove(id.clone())>"Delete"</Button>
                                    </div>
                                </div>
                            }
                        }).collect_view().into_any()
                    }
                }}
            </div>

            <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end">
                <div style="flex: 2; min-width: 150px">
                    <Field label="Keyword in merchant name" value=keyword placeholder="e.g. Starbucks" />
                </div>
                <div style="flex: 1; min-width: 150px">
                    <Select label="Category" value=category_id options=options />
                </div>
                <Button variant="primary" on_click=add
                    disabled=Signal::derive(move || busy.get() || keyword.with(|k| k.trim().is_empty()) || category_id.with(String::is_empty))>
                    "Add rule"
                </Button>
            </div>
            {move || error.get().map(|e| view! {
                <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative); margin-top: 8px">{e}</div>
            })}
        </Card>
    }
}
