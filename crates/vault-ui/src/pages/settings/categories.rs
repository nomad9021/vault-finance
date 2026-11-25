//! `CategoryTreeSection` / `CategoryTreeNode`: the interactive tree editor
//! for the category hierarchy — the structure that shapes the cash-flow
//! Sankey. It grows to the right: a category's sub-branches sit to its
//! right, connected by lines. Click a name to rename, ＋ to add a branch, ×
//! to delete.

use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use serde::de::IgnoredAny;
use vault_core::categories::{
    is_within, sibling_order, Category, CategoryKind, CategoryListResponse, CreateCategoryRequest,
    UpdateCategoryRequest,
};

use crate::host::{use_host, HostCtx};
use crate::ui::{Button, Card, Tag};

const STRUCTURE_COLORS: [&str; 8] = [
    "#7c5cff", "#5b8def", "#3ecf8e", "#e0a458", "#c96f9c", "#4db6d0", "#8b7cf0", "#5fbf8f",
];

const TREE_ICON_BTN: &str = "border: 0px; background: none; cursor: pointer; color: var(--content-tertiary); font: inherit; font-size: var(--text-md); line-height: 1; padding: 0px 2px";

/// What a node can ask the section to do.
#[derive(Clone, Copy)]
struct Ops {
    add: Callback<Option<String>>,
    rename: Callback<(String, String)>,
    recolor: Callback<(String, String)>,
    remove: Callback<String>,
    reorder: Callback<(String, &'static str)>,
    drag_start: Callback<String>,
    drop_on: Callback<Option<String>>,
}

/// `childrenOf(id)`: a node's children in sibling order.
fn children_of(all: &[Category], id: Option<&str>) -> Vec<Category> {
    let mut v: Vec<Category> = all
        .iter()
        .filter(|c| c.parent_category_id.as_deref() == id)
        .cloned()
        .collect();
    v.sort_by(sibling_order);
    v
}

/// A node is rebuilt when anything it draws changes (React re-renders it).
fn node_key(c: &Category, first: bool, last: bool) -> String {
    format!(
        "{}|{}|{}|{}|{}|{first}|{last}",
        c.id, c.name, c.color, c.sort_order, c.is_system
    )
}

/// `kids` as (category, isFirst, isLast).
fn with_ends(kids: Vec<Category>) -> Vec<(Category, bool, bool)> {
    let n = kids.len();
    kids.into_iter()
        .enumerate()
        .map(|(i, c)| (c, i == 0, i + 1 == n))
        .collect()
}

#[component]
fn CategoryTreeNode(
    cat: Category,
    categories: Signal<Vec<Category>>,
    ops: Ops,
    is_first: bool,
    is_last: bool,
    busy: RwSignal<bool>,
) -> impl IntoView {
    let editing = RwSignal::new(false);
    let draft = RwSignal::new(cat.name.clone());
    let over = RwSignal::new(false);
    let input = NodeRef::<html::Input>::new();
    Effect::new(move || {
        if let Some(el) = input.get() {
            let _ = el.focus();
        }
    });
    let id = cat.id.clone();
    let kids = {
        let id = id.clone();
        Memo::new(move |_| categories.with(|all| with_ends(children_of(all, Some(&id)))))
    };
    let name = cat.name.clone();
    let color = cat.color.clone();

    let commit = {
        let (id, name) = (id.clone(), name.clone());
        move || {
            editing.set(false);
            let d = draft.get_untracked();
            let t = d.trim();
            if !t.is_empty() && t != name {
                ops.rename.run((id.clone(), t.to_string()));
            }
        }
    };

    let box_style = move || {
        let (border, bg) = if over.get() {
            (
                "1px solid var(--color-accent)",
                "color-mix(in srgb, var(--color-accent) 12%, var(--color-surface))",
            )
        } else {
            ("1px solid var(--color-divider)", "var(--color-surface)")
        };
        format!("display: flex; align-items: center; gap: 7px; padding: 6px 9px; border: {border}; border-radius: var(--radius-md); background: {bg}; white-space: nowrap; box-shadow: var(--shadow-sm); cursor: grab")
    };
    let arrow_style = |off: bool| {
        format!(
            "{TREE_ICON_BTN}; opacity: {}; cursor: {}",
            if off { "0.25" } else { "1" },
            if off { "default" } else { "pointer" }
        )
    };

    let (id_drag, id_drop, id_color, id_up, id_down, id_add, id_del) = (
        id.clone(),
        id.clone(),
        id.clone(),
        id.clone(),
        id.clone(),
        id.clone(),
        id.clone(),
    );
    let name_label = name.clone();
    let name_reset = name.clone();
    let name_edit = name.clone();

    view! {
        <div style="display: flex; align-items: center">
            <div draggable=move || if editing.get() { "false" } else { "true" }
                on:dragstart=move |e| {
                    e.stop_propagation();
                    ops.drag_start.run(id_drag.clone());
                }
                on:dragover=move |e| {
                    e.prevent_default();
                    over.set(true);
                }
                on:dragleave=move |_| over.set(false)
                on:drop=move |e| {
                    e.prevent_default();
                    e.stop_propagation();
                    over.set(false);
                    ops.drop_on.run(Some(id_drop.clone()));
                }
                title="Drag onto another category to move it there"
                style=box_style>
                // The swatch is the colour control. A category's colour is what
                // paints its ribbon in both Sankey diagrams and its bar in
                // Budgets, so this is where the shape *and* the palette of
                // those charts is set.
                <label title=format!("Colour for {name_label} — used in the cash-flow and budget diagrams")
                    style=format!("width: 14px; height: 14px; border-radius: var(--radius-sm); background: {color}; flex: 0 0 auto; cursor: pointer; position: relative; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-text) 25%, transparent)")>
                    <input type="color" prop:value=color.clone()
                        on:input=move |e| ops.recolor.run((id_color.clone(), event_target_value(&e)))
                        style="position: absolute; inset: 0px; opacity: 0; width: 100%; height: 100%; cursor: pointer" />
                </label>
                {move || if editing.get() {
                    let commit = commit.clone();
                    let name_reset = name_reset.clone();
                    view! {
                        <input node_ref=input class="input" prop:value=move || draft.get()
                            on:input=move |e| draft.set(event_target_value(&e))
                            on:blur=move |_| commit()
                            on:keydown=move |e| {
                                if e.key() == "Enter" {
                                    if let Some(el) = input.get_untracked() {
                                        let _ = el.blur();
                                    }
                                }
                                if e.key() == "Escape" {
                                    draft.set(name_reset.clone());
                                    editing.set(false);
                                }
                            }
                            style="width: 150px; padding: 2px 6px; font-size: var(--text-sm)" />
                    }.into_any()
                } else {
                    let name_edit = name_edit.clone();
                    view! {
                        <button on:click=move |_| {
                                draft.set(name_edit.clone());
                                editing.set(true);
                            }
                            title="Rename"
                            style="background: none; border: 0px; font: inherit; font-weight: 600; font-size: var(--text-sm); cursor: text; color: var(--color-text)">
                            {name_edit.clone()}
                        </button>
                    }.into_any()
                }}
                {cat.is_system.then(|| view! { <Tag>"system"</Tag> })}
                <button title="Move up" disabled=is_first on:click=move |_| ops.reorder.run((id_up.clone(), "up"))
                    style=arrow_style(is_first)>"▲"</button>
                <button title="Move down" disabled=is_last on:click=move |_| ops.reorder.run((id_down.clone(), "down"))
                    style=arrow_style(is_last)>"▼"</button>
                <button title="Add branch" on:click=move |_| ops.add.run(Some(id_add.clone())) style=TREE_ICON_BTN>"＋"</button>
                {(!cat.is_system).then(|| view! {
                    <button title="Delete" disabled=busy on:click=move |_| ops.remove.run(id_del.clone())
                        style=format!("{TREE_ICON_BTN}; color: var(--color-negative)")>"×"</button>
                })}
            </div>
            {move || (!kids.with(Vec::is_empty)).then(|| view! {
                <div style="width: 20px; height: 1px; background: var(--color-divider); flex: 0 0 auto"></div>
                <div style="display: flex; flex-direction: column; gap: 8px; border-left: 1px solid var(--color-divider)">
                    <For each=move || kids.get() key=|(c, f, l)| node_key(c, *f, *l)
                        children=move |(k, first, last)| view! {
                            <div style="display: flex; align-items: center">
                                <div style="width: 14px; height: 1px; background: var(--color-divider); flex: 0 0 auto"></div>
                                {view! {
                                    <CategoryTreeNode cat=k categories=categories ops=ops
                                        is_first=first is_last=last busy=busy />
                                }.into_any()}
                            </div>
                        } />
                </div>
            })}
        </div>
    }
}

#[component]
pub fn CategoryTreeSection() -> impl IntoView {
    let host = use_host();
    let data_version = host.data_version;
    let version = RwSignal::new(0_u32);
    let data = LocalResource::new(move || {
        data_version.track();
        version.track();
        let host = use_host();
        async move { host.call::<CategoryListResponse>("categories", &[]).await }
    });
    // Spending tree = expense categories only; income sources are managed on
    // the Income page.
    let categories = Signal::derive(move || {
        data.get()
            .and_then(Result::ok)
            .map(|r| r.categories)
            .unwrap_or_default()
            .into_iter()
            .filter(|c| c.kind != CategoryKind::Income)
            .collect::<Vec<_>>()
    });
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let reload = move || {
        version.try_update(|v| *v += 1);
    };
    let fail = move |msg: &str| {
        error.try_set(Some(msg.to_string()));
    };

    let update_category = {
        let host = host.clone();
        move |id: String, body: UpdateCategoryRequest| {
            let host = host.clone();
            async move {
                host.call::<IgnoredAny>("updateCategory", &[id.into(), HostCtx::arg(&body)])
                    .await
            }
        }
    };

    let add = {
        let host = host.clone();
        Callback::new(move |parent: Option<String>| {
            let host = host.clone();
            busy.set(true);
            error.set(None);
            let n = categories.with_untracked(Vec::len);
            let body = CreateCategoryRequest {
                name: "New category".into(),
                color: STRUCTURE_COLORS[n % STRUCTURE_COLORS.len()].into(),
                parent_category_id: parent,
                kind: CategoryKind::Expense,
            };
            spawn_local(async move {
                match host
                    .call::<IgnoredAny>("createCategory", &[HostCtx::arg(&body)])
                    .await
                {
                    Ok(_) => reload(),
                    Err(_) => fail("Couldn't add the branch."),
                }
                busy.try_set(false);
            });
        })
    };
    let rename = {
        let update_category = update_category.clone();
        Callback::new(move |(id, name): (String, String)| {
            let req = update_category(
                id,
                UpdateCategoryRequest {
                    name: Some(name),
                    ..Default::default()
                },
            );
            spawn_local(async move {
                if req.await.is_err() {
                    fail("Couldn't rename.");
                }
                reload();
            });
        })
    };
    // Native colour inputs fire on every drag of the picker, so debounce the
    // write and only reload once the user settles on a colour.
    let recolor_timer = StoredValue::new(None::<TimeoutHandle>);
    on_cleanup(move || {
        if let Some(t) = recolor_timer.try_get_value().flatten() {
            t.clear();
        }
    });
    let recolor = {
        let update_category = update_category.clone();
        Callback::new(move |(id, color): (String, String)| {
            if let Some(t) = recolor_timer.get_value() {
                t.clear();
            }
            let update_category = update_category.clone();
            let handle = set_timeout_with_handle(
                move || {
                    let req = update_category(
                        id,
                        UpdateCategoryRequest {
                            color: Some(color),
                            ..Default::default()
                        },
                    );
                    spawn_local(async move {
                        match req.await {
                            Ok(_) => reload(),
                            Err(_) => fail("Couldn't change the colour."),
                        }
                    });
                },
                std::time::Duration::from_millis(250),
            );
            recolor_timer.set_value(handle.ok());
        })
    };
    let remove = {
        let host = host.clone();
        Callback::new(move |id: String| {
            let host = host.clone();
            busy.set(true);
            error.set(None);
            spawn_local(async move {
                match host
                    .call::<IgnoredAny>("deleteCategory", &[id.into()])
                    .await
                {
                    Ok(_) => reload(),
                    Err(_) => fail("That category is in use (transactions or budgets) or is a system default — reassign those first."),
                }
                busy.try_set(false);
            });
        })
    };
    let reorder = {
        let host = host.clone();
        Callback::new(move |(id, direction): (String, &'static str)| {
            let host = host.clone();
            error.set(None);
            spawn_local(async move {
                if host
                    .call::<IgnoredAny>("moveCategory", &[id.into(), direction.into()])
                    .await
                    .is_err()
                {
                    fail("Couldn't reorder that category.");
                }
                reload();
            });
        })
    };

    // Drag-to-reparent: the id being dragged.
    let drag_id = StoredValue::new(None::<String>);
    let drop_on = {
        let update_category = update_category.clone();
        Callback::new(move |target: Option<String>| {
            let src = drag_id.get_value();
            drag_id.set_value(None);
            let Some(src) = src else { return };
            if Some(&src) == target.as_ref() {
                return;
            }
            // Can't move a node under itself or one of its own descendants.
            if let Some(t) = target.as_deref() {
                if categories.with_untracked(|all| is_within(all, Some(t), &src)) {
                    error.set(Some(
                        "Can't move a category under one of its own branches.".into(),
                    ));
                    return;
                }
            }
            busy.set(true);
            error.set(None);
            let req = update_category(
                src,
                UpdateCategoryRequest {
                    parent_category_id: Some(target),
                    ..Default::default()
                },
            );
            spawn_local(async move {
                match req.await {
                    Ok(_) => reload(),
                    Err(_) => fail("Couldn't move that category."),
                }
                busy.try_set(false);
            });
        })
    };
    let ops = Ops {
        add,
        rename,
        recolor,
        remove,
        reorder,
        drag_start: Callback::new(move |id: String| drag_id.set_value(Some(id))),
        drop_on,
    };

    let roots = Memo::new(move |_| categories.with(|all| with_ends(children_of(all, None))));

    view! {
        <Card kicker="Categories" title="Category tree">
            <p class="card-meta">
                "The one place to shape both the cash-flow and budget-planner Sankeys. The tree grows to the right — a category’s sub-branches sit to its right. Click a name to rename, ▲▼ to reorder among siblings, ＋ to add a branch, × to delete, and drag a node onto another to move it (or onto “Top level” to un-nest it)."
            </p>
            <div style="overflow-x: auto; padding: 10px 2px">
                {move || if roots.with(Vec::is_empty) {
                    view! { <p class="card-meta">"No categories yet — add one below."</p> }.into_any()
                } else {
                    view! {
                        <div style="display: flex; flex-direction: column; gap: 10px; min-width: max-content">
                            <For each=move || roots.get() key=|(c, f, l)| node_key(c, *f, *l)
                                children=move |(c, first, last)| view! {
                                    <CategoryTreeNode cat=c categories=categories ops=ops
                                        is_first=first is_last=last busy=busy />
                                } />
                        </div>
                    }.into_any()
                }}
            </div>
            <div style="display: flex; gap: 10px; align-items: center; margin-top: 8px; flex-wrap: wrap">
                <Button variant="secondary" on_click=move || ops.add.run(None)>"＋ Add top-level category"</Button>
                <div on:dragover=move |e| e.prevent_default()
                    on:drop=move |e| {
                        e.prevent_default();
                        ops.drop_on.run(None);
                    }
                    style="font-size: var(--text-xs); color: var(--content-tertiary); border: 1px dashed var(--color-divider); border-radius: var(--radius-md); padding: 6px 12px">
                    "↳ Drop here for “Top level”"
                </div>
            </div>
            {move || error.get().map(|e| view! {
                <div role="alert" style="font-size: var(--text-sm); color: var(--color-negative); margin-top: 8px">{e}</div>
            })}
        </Card>
    }
}
