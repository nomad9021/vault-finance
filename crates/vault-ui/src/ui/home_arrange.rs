//! `useHomeArrange` (apps/desktop/src/lib/homeArrange.ts), first step: a
//! focused card moves with the arrow keys in edit mode. Hold-to-edit and
//! dragging come next. The order logic is `vault_core::home`.

use std::rc::Rc;

use leptos::html;
use leptos::prelude::*;
use send_wrapper::SendWrapper;
use vault_core::home::{arrow_step, step_order};
use wasm_bindgen::JsCast;

struct Inner {
    grid: NodeRef<html::Div>,
    ids: Signal<Vec<String>>,
    editing: Signal<bool>,
    on_commit: Callback<Vec<String>>,
}

#[derive(Clone)]
pub struct HomeArrange {
    pub drag_id: RwSignal<Option<String>>,
    inner: SendWrapper<Rc<Inner>>,
}

impl HomeArrange {
    pub fn new(
        grid: NodeRef<html::Div>,
        ids: Signal<Vec<String>>,
        editing: Signal<bool>,
        _on_start_editing: Callback<()>,
        on_commit: Callback<Vec<String>>,
    ) -> Self {
        HomeArrange {
            drag_id: RwSignal::new(None),
            inner: SendWrapper::new(Rc::new(Inner {
                grid,
                ids,
                editing,
                on_commit,
            })),
        }
    }

    pub fn order(&self) -> Vec<String> {
        self.inner.ids.get()
    }

    pub fn on_pointer_down(&self, _id: &str, _e: &web_sys::PointerEvent) {}

    pub fn on_context_menu(&self, _e: &web_sys::MouseEvent) {}

    pub fn on_key_down(&self, id: &str, e: &web_sys::KeyboardEvent) {
        if !self.inner.editing.get_untracked() || e.target() != e.current_target() {
            return;
        }
        let step = arrow_step(&e.key());
        if step == 0 {
            return;
        }
        e.prevent_default();
        let Some(next) = step_order(&self.inner.ids.get_untracked(), id, step) else {
            return;
        };
        self.inner.on_commit.run(next);
        let grid = self.inner.grid;
        let id = id.to_string();
        request_animation_frame(move || {
            let el = grid
                .get_untracked()
                .and_then(|g| {
                    g.query_selector(&format!("[data-arrange-id=\"{id}\"]"))
                        .ok()
                        .flatten()
                })
                .and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok());
            if let Some(el) = el {
                let _ = el.focus();
            }
        });
    }
}
