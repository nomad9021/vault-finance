//! `<SankeyArranger>` (apps/desktop/src/screens/shell/SankeyArranger.tsx):
//! edit the Sankey where it's drawn. The category tree behind it as a list
//! you drag to rearrange: drop on a row's top or bottom edge to place it
//! before or after, on its middle to tuck it inside. Rename, recolour, add
//! and delete in place; every change redraws the diagrams.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::time::Duration;

use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use send_wrapper::SendWrapper;
use vault_core::categories::{
    arranger_zone, can_drop, children_of, reorder, Category, CategoryKind, CategoryListResponse,
    CreateCategoryRequest, DropZone, UpdateCategoryRequest,
};
use wasm_bindgen::JsValue;

use super::drag_sort::DragSort;
use super::{Button, Icon, Spinner};
use crate::host::{use_host, CallError, HostCtx};

const COLORS: [&str; 8] = [
    "#7c5cff", "#5b8def", "#3ecf8e", "#f5a623", "#ec6a9c", "#43cfc0", "#d8b23c", "#b47ef0",
];

type Work = Pin<Box<dyn Future<Output = Result<(), CallError>>>>;

#[derive(Clone)]
struct Ctx {
    host: HostCtx,
    cats: RwSignal<Option<Vec<Category>>>,
    busy: RwSignal<bool>,
    error: RwSignal<Option<String>>,
    on_changed: Option<Callback<()>>,
    recolor_timer: SendWrapper<Rc<RefCell<Option<TimeoutHandle>>>>,
}

async fn ignore<T: serde::de::DeserializeOwned>(
    f: impl Future<Output = Result<T, CallError>>,
) -> Result<(), CallError> {
    f.await.map(|_| ())
}

impl Ctx {
    fn all(&self) -> Vec<Category> {
        self.cats.get_untracked().unwrap_or_default()
    }

    async fn reload(&self) {
        if let Ok(r) = self
            .host
            .call::<CategoryListResponse>("categories", &[])
            .await
        {
            self.cats.set(Some(r.categories));
        }
    }

    fn run(&self, work: Work, failure: &'static str) {
        let me = self.clone();
        me.busy.set(true);
        me.error.set(None);
        spawn_local(async move {
            if let Err(e) = work.await {
                me.error.set(Some(if e.is_error && !e.message.is_empty() {
                    e.message
                } else {
                    failure.to_string()
                }));
            }
            me.reload().await;
            me.busy.set(false);
            if let Some(f) = me.on_changed {
                f.run(());
            }
            me.host.refresh_data();
        });
    }

    fn update(&self, id: &str, body: UpdateCategoryRequest) -> Work {
        let host = self.host.clone();
        let id = id.to_string();
        Box::pin(async move {
            ignore(host.try_call::<serde::de::IgnoredAny>(
                "updateCategory",
                &[JsValue::from_str(&id), HostCtx::arg(&body)],
            ))
            .await
        })
    }

    fn reorder_categories(
        host: &HostCtx,
        order: Vec<String>,
    ) -> impl Future<Output = Result<(), CallError>> + use<> {
        let host = host.clone();
        async move {
            ignore(
                host.try_call::<serde::de::IgnoredAny>(
                    "reorderCategories",
                    &[HostCtx::arg(&order)],
                ),
            )
            .await
        }
    }

    /// Back to the top level, at the end.
    fn to_top(&self, id: &str) {
        let all = self.all();
        let Some(d) = all.iter().find(|c| c.id == id).cloned() else {
            return;
        };
        let host = self.host.clone();
        let mut order: Vec<String> = children_of(&all, None, d.kind)
            .into_iter()
            .map(|c| c.id.clone())
            .filter(|x| *x != d.id)
            .collect();
        order.push(d.id.clone());
        let unparent = d.parent_category_id.is_some().then(|| {
            self.update(
                &d.id,
                UpdateCategoryRequest {
                    parent_category_id: Some(None),
                    ..Default::default()
                },
            )
        });
        self.run(
            Box::pin(async move {
                if let Some(w) = unparent {
                    w.await?;
                }
                Ctx::reorder_categories(&host, order).await
            }),
            "Couldn't move that category.",
        );
    }

    fn do_move(&self, drag_id: &str, target_id: &str, zone: DropZone) {
        let all = self.all();
        let (Some(d), Some(t)) = (
            all.iter().find(|c| c.id == drag_id).cloned(),
            all.iter().find(|c| c.id == target_id).cloned(),
        ) else {
            return;
        };
        let parent = if zone == DropZone::Inside {
            Some(t.id.clone())
        } else {
            t.parent_category_id.clone()
        };
        let reparent = (d.parent_category_id != parent).then(|| {
            self.update(
                &d.id,
                UpdateCategoryRequest {
                    parent_category_id: Some(parent.clone()),
                    ..Default::default()
                },
            )
        });
        let mut siblings: Vec<String> = children_of(&all, parent.as_deref(), d.kind)
            .into_iter()
            .map(|c| c.id.clone())
            .filter(|id| *id != d.id)
            .collect();
        siblings.push(d.id.clone());
        let order = match zone {
            DropZone::Inside => siblings,
            z => reorder(&siblings, &d.id, &t.id, z == DropZone::After),
        };
        let host = self.host.clone();
        self.run(
            Box::pin(async move {
                if let Some(w) = reparent {
                    w.await?;
                }
                if order.len() > 1 {
                    Ctx::reorder_categories(&host, order).await?;
                }
                Ok(())
            }),
            "Couldn't move that category.",
        );
    }

    fn add(&self, parent: Option<String>, kind: CategoryKind) {
        let all = self.all();
        let color = parent
            .as_deref()
            .and_then(|p| all.iter().find(|c| c.id == p))
            .map(|c| c.color.clone())
            .unwrap_or_else(|| COLORS[all.len() % COLORS.len()].to_string());
        let body = CreateCategoryRequest {
            name: if kind == CategoryKind::Income {
                "New income"
            } else {
                "New category"
            }
            .into(),
            color,
            parent_category_id: parent,
            kind,
        };
        let host = self.host.clone();
        self.run(
            Box::pin(async move {
                ignore(
                    host.try_call::<serde::de::IgnoredAny>(
                        "createCategory",
                        &[HostCtx::arg(&body)],
                    ),
                )
                .await
            }),
            "Couldn't add a category.",
        );
    }

    fn recolor(&self, id: String, color: String) {
        if let Some(t) = self.recolor_timer.borrow_mut().take() {
            t.clear();
        }
        let me = self.clone();
        let handle = set_timeout_with_handle(
            move || {
                let w = me.update(
                    &id,
                    UpdateCategoryRequest {
                        color: Some(color),
                        ..Default::default()
                    },
                );
                me.run(w, "Couldn't change the colour.");
            },
            Duration::from_millis(300),
        )
        .ok();
        *self.recolor_timer.borrow_mut() = handle;
    }

    fn delete(&self, id: &str) {
        let host = self.host.clone();
        let id = id.to_string();
        self.run(
            Box::pin(async move {
                ignore(
                    host.try_call::<serde::de::IgnoredAny>(
                        "deleteCategory",
                        &[JsValue::from_str(&id)],
                    ),
                )
                .await
            }),
            "That category is in use (transactions or budgets) — move those first.",
        );
    }
}

#[component]
pub fn SankeyArranger(#[prop(optional)] on_changed: Option<Callback<()>>) -> impl IntoView {
    let host = use_host();
    let ctx = Ctx {
        host: host.clone(),
        cats: RwSignal::new(None),
        busy: RwSignal::new(false),
        error: RwSignal::new(None),
        on_changed,
        recolor_timer: SendWrapper::new(Rc::new(RefCell::new(None))),
    };
    // Load, and again whenever the assistant (or another page) changes data.
    let data_version = host.data_version;
    {
        let ctx = ctx.clone();
        Effect::new(move |_| {
            data_version.track();
            let ctx = ctx.clone();
            spawn_local(async move { ctx.reload().await });
        });
    }
    let editing = RwSignal::new(None::<String>);
    let confirm_delete = RwSignal::new(None::<String>);

    let dnd = {
        let (c1, c2) = (ctx.clone(), ctx.clone());
        DragSort::new(
            |rect, _x, y, _id| arranger_zone(rect.top(), rect.bottom(), y),
            move |drag, target, zone| can_drop(&c1.all(), drag, target, zone),
            move |drag, target, zone| {
                if let Some(_kind) = target.strip_prefix("top:") {
                    c2.to_top(&drag);
                } else {
                    c2.do_move(&drag, &target, zone);
                }
            },
        )
    };

    let group = {
        let (ctx, dnd) = (ctx.clone(), dnd.clone());
        move |kind: CategoryKind| {
            let (ctx2, dnd2) = (ctx.clone(), dnd.clone());
            let list = move || {
                let all = ctx2.cats.get().unwrap_or_default();
                rows(&ctx2, &dnd2, &all, None, kind, 0, editing, confirm_delete)
            };
            let top_drop = {
                let (ctx, dnd) = (ctx.clone(), dnd.clone());
                move || {
                    let dragged = dnd.drag.with(|d| d.as_ref().map(|(id, _)| id.clone()))?;
                    let all = ctx.cats.get_untracked().unwrap_or_default();
                    let d = all.iter().find(|c| c.id == dragged)?;
                    if d.kind != kind || d.parent_category_id.is_none() {
                        return None;
                    }
                    let id = format!("top:{}", kind.as_str());
                    let (dragging, zone) = (dnd.dragging(id.clone()), dnd.drop_zone(id.clone()));
                    let style = dnd.item_style(id.clone(), String::new());
                    // Dropping here takes a category back to the top level.
                    Some(view! {
                        <div class="arr-top-drop" data-drop-id=id
                            data-dragging=dragging data-drop=zone style=style>
                            "Drop here to make it a main "
                            {if kind == CategoryKind::Income { "income source" } else { "category" }}
                        </div>
                    })
                }
            };
            let ctx3 = ctx.clone();
            view! {
                <div class="arr-group">
                    <div class="row-between">
                        <div class="eyebrow">{if kind == CategoryKind::Income { "Money in" } else { "Spending" }}</div>
                        <Button variant="ghost" size="sm" icon="plus" disabled=ctx.busy
                            on_click=move || ctx3.add(None, kind)>
                            "Add"
                        </Button>
                    </div>
                    <div class="arr-list">{list}</div>
                    {top_drop}
                </div>
            }
        }
    };

    let busy = ctx.busy;
    let error = ctx.error;
    let cats = ctx.cats;
    view! {
        <div class="arranger">
            <div class="row-between" style="margin-bottom: var(--space-2)">
                <div class="t-xs t-tertiary">
                    "Drag ⋮⋮ to move: drop on a row's edge to place it, on its middle to put it inside. Tap a name to rename."
                </div>
                {move || busy.get().then(|| view! { <Spinner label="Saving" /> })}
            </div>
            {move || if cats.with(Option::is_none) {
                view! { <Spinner label="Loading categories" /> }.into_any()
            } else {
                view! { {group(CategoryKind::Expense)} {group(CategoryKind::Income)} }.into_any()
            }}
            {move || error.get().map(|e| view! {
                <div role="alert" class="t-sm" style="color: var(--color-negative); margin-top: 8px">{e}</div>
            })}
        </div>
    }
}

#[allow(clippy::too_many_arguments)]
fn rows(
    ctx: &Ctx,
    dnd: &DragSort,
    all: &[Category],
    parent: Option<&str>,
    kind: CategoryKind,
    depth: u32,
    editing: RwSignal<Option<String>>,
    confirm_delete: RwSignal<Option<String>>,
) -> Vec<AnyView> {
    children_of(all, parent, kind)
        .into_iter()
        .flat_map(|c| {
            let mut out = vec![row(ctx, dnd, c, depth, editing, confirm_delete)];
            out.extend(rows(
                ctx,
                dnd,
                all,
                Some(&c.id),
                kind,
                depth + 1,
                editing,
                confirm_delete,
            ));
            out
        })
        .collect()
}

fn row(
    ctx: &Ctx,
    dnd: &DragSort,
    c: &Category,
    depth: u32,
    editing: RwSignal<Option<String>>,
    confirm_delete: RwSignal<Option<String>>,
) -> AnyView {
    let id = c.id.clone();
    let busy = ctx.busy;
    let grip_down = {
        let (dnd, id) = (dnd.clone(), id.clone());
        move |e: web_sys::PointerEvent| dnd.on_handle_down(&id, &e)
    };
    let recolor = {
        let (ctx, id) = (ctx.clone(), id.clone());
        move |e: web_sys::Event| ctx.recolor(id.clone(), event_target_value(&e))
    };
    let name_cell = {
        let (ctx, c) = (ctx.clone(), c.clone());
        move || {
            if editing.with(|e| e.as_deref() == Some(c.id.as_str())) {
                let input = NodeRef::<html::Input>::new();
                Effect::new(move |_| {
                    if let Some(el) = input.get() {
                        let _ = el.focus();
                    }
                });
                // Escape leaves without renaming, even if removing the
                // input fires a blur.
                let cancelled = SendWrapper::new(Rc::new(Cell::new(false)));
                let blur = {
                    let (ctx, c, cancelled) = (ctx.clone(), c.clone(), cancelled.clone());
                    move |e: web_sys::FocusEvent| {
                        if cancelled.get() {
                            return;
                        }
                        let name = event_target_value(&e).trim().to_string();
                        editing.set(None);
                        if !name.is_empty() && name != c.name {
                            let w = ctx.update(
                                &c.id,
                                UpdateCategoryRequest {
                                    name: Some(name),
                                    ..Default::default()
                                },
                            );
                            ctx.run(w, "Couldn't rename that.");
                        }
                    }
                };
                let key = move |e: web_sys::KeyboardEvent| match e.key().as_str() {
                    "Enter" => {
                        if let Some(el) = input.get_untracked() {
                            let _ = el.blur();
                        }
                    }
                    "Escape" => {
                        cancelled.set(true);
                        editing.set(None);
                    }
                    _ => {}
                };
                view! {
                    <input node_ref=input class="input arr-name-input" value=c.name.clone() maxlength="60"
                        aria-label="Category name" on:blur=blur on:keydown=key />
                }
                .into_any()
            } else {
                let id = c.id.clone();
                view! {
                    <button type="button" class="arr-name truncate" title="Rename"
                        on:click=move |_| editing.set(Some(id.clone()))>
                        {c.name.clone()}
                    </button>
                }
                .into_any()
            }
        }
    };
    let add = {
        let (ctx, id, kind) = (ctx.clone(), id.clone(), c.kind);
        move |_| ctx.add(Some(id.clone()), kind)
    };
    let delete_cell = {
        let (ctx, c) = (ctx.clone(), c.clone());
        move || {
            if confirm_delete.with(|d| d.as_deref() == Some(c.id.as_str())) {
                let (ctx, id) = (ctx.clone(), c.id.clone());
                view! {
                    <button type="button" class="panel-link" style="color: var(--color-negative)"
                        on:click=move |_| {
                            confirm_delete.set(None);
                            ctx.delete(&id);
                        }>
                        "Delete?"
                    </button>
                }
                .into_any()
            } else {
                let (id, system) = (c.id.clone(), c.is_system);
                view! {
                    <button type="button" class="arr-btn" aria-label=format!("Delete {}", c.name) title="Delete"
                        disabled=move || busy.get() || system
                        on:click=move |_| confirm_delete.set(Some(id.clone()))>
                        <Icon name="trash" size=14 />
                    </button>
                }
                .into_any()
            }
        }
    };
    let padding = format!("padding-left: {}px", 6 + depth * 20);
    view! {
        <div class="arr-row" data-drop-id=id.clone() data-dragging=dnd.dragging(id.clone())
            data-drop=dnd.drop_zone(id.clone()) style=dnd.item_style(id.clone(), padding)>
            <span class="arr-grip" aria-label=format!("Drag {}", c.name) role="button" tabindex="-1"
                style=dnd.handle_style(id.clone()) on:pointerdown=grip_down>
                <span aria-hidden="true">"⋮⋮"</span>
            </span>
            <label class="arr-swatch" style=format!("background: {}", c.color) title="Change colour">
                <input type="color" prop:value=c.color.clone() aria-label=format!("Colour of {}", c.name)
                    on:input=recolor />
            </label>
            {name_cell}
            <button type="button" class="arr-btn" aria-label=format!("Add a category inside {}", c.name)
                title="Add inside" disabled=move || busy.get() on:click=add>
                <Icon name="plus" size=14 />
            </button>
            {delete_cell}
        </div>
    }
    .into_any()
}
