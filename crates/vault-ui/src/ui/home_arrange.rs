//! `useHomeArrange` (apps/desktop/src/lib/homeArrange.ts): home screen
//! arranging the iPhone way, for the phone and the computer alike.
//!
//! - Hold a card (about half a second, finger or mouse) and the home screen
//!   goes into edit mode with that card already picked up.
//! - In edit mode the whole card is the handle. A mouse drags as soon as it
//!   moves; a finger drags after a short hold, so a quick swipe still scrolls.
//! - While you drag, the other cards slide out of the way (FLIP) and the new
//!   order is saved when you let go.
//! - In edit mode, a focused card moves with the arrow keys.
//!
//! Elements inside a card marked `data-no-drag` stay ordinary buttons. The
//! order logic is `vault_core::home::{move_to, step_order}`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use leptos::html;
use leptos::prelude::*;
use send_wrapper::SendWrapper;
use vault_core::home::{arrow_step, jiggle_delay, move_to, step_order};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{DomRect, HtmlElement};

use super::drag_sort::{scroll_parent, set_user_select};
use super::listen::window_listener;

const HOLD_TO_EDIT_MS: u64 = 480;
const HOLD_TO_DRAG_TOUCH_MS: u64 = 160;
const MOUSE_SLOP: f64 = 4.0;
const TOUCH_SLOP: f64 = 8.0;
const SETTLE: &str = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";

struct Live {
    id: String,
    pointer_id: i32,
    touch: bool,
    x0: f64,
    y0: f64,
    x: f64,
    y: f64,
    started: bool,
    timer: Option<TimeoutHandle>,
    off_x: f64,
    off_y: f64,
    tx: f64,
    ty: f64,
    scroller: Option<HtmlElement>,
    /// Last card swapped with; ignored until the pointer moves onto another.
    last_swap: Option<String>,
}

struct Inner {
    grid: NodeRef<html::Div>,
    live: RefCell<Option<Live>>,
    raf: RefCell<Option<AnimationFrameRequestHandle>>,
    cleanup: RefCell<Option<Box<dyn FnOnce()>>>,
    ids: Signal<Vec<String>>,
    editing: Signal<bool>,
    on_start_editing: Callback<()>,
    on_commit: Callback<Vec<String>>,
}

#[derive(Clone)]
pub struct HomeArrange {
    /// The order while a drag is in progress (`None`: `ids`).
    order: RwSignal<Option<Vec<String>>>,
    pub drag_id: RwSignal<Option<String>>,
    inner: SendWrapper<Rc<Inner>>,
}

fn rect_map(els: &[(String, HtmlElement)]) -> HashMap<String, DomRect> {
    els.iter()
        .map(|(id, el)| (id.clone(), el.get_bounding_client_rect()))
        .collect()
}

fn set_style(el: &HtmlElement, prop: &str, v: &str) {
    let _ = el.style().set_property(prop, v);
}

impl HomeArrange {
    /// `grid` holds the cards (each with `data-arrange-id`).
    pub fn new(
        grid: NodeRef<html::Div>,
        ids: Signal<Vec<String>>,
        editing: Signal<bool>,
        on_start_editing: Callback<()>,
        on_commit: Callback<Vec<String>>,
    ) -> Self {
        let this = HomeArrange {
            order: RwSignal::new(None),
            drag_id: RwSignal::new(None),
            inner: SendWrapper::new(Rc::new(Inner {
                grid,
                live: RefCell::new(None),
                raf: RefCell::new(None),
                cleanup: RefCell::new(None),
                ids,
                editing,
                on_start_editing,
                on_commit,
            })),
        };
        // The jiggle is staggered by position, set on the element so a
        // re-render never clobbers a transform mid-drag.
        let me = SendWrapper::new(this.clone());
        Effect::new(move || {
            let order = me.order();
            let me = me.clone();
            request_animation_frame(move || {
                for (i, id) in order.iter().enumerate() {
                    if let Some(el) = me.el(id) {
                        set_style(&el, "--jiggle-delay", &jiggle_delay(i));
                    }
                }
            });
        });
        let me = SendWrapper::new(this.clone());
        on_cleanup(move || me.end(false));
        this
    }

    /// The cards in the order to draw them.
    pub fn order(&self) -> Vec<String> {
        self.order.get().unwrap_or_else(|| self.inner.ids.get())
    }

    fn shown(&self) -> Vec<String> {
        self.order
            .get_untracked()
            .unwrap_or_else(|| self.inner.ids.get_untracked())
    }

    fn els(&self) -> Vec<(String, HtmlElement)> {
        let Some(grid) = self.inner.grid.get_untracked() else {
            return vec![];
        };
        let Ok(list) = grid.query_selector_all("[data-arrange-id]") else {
            return vec![];
        };
        (0..list.length())
            .filter_map(|i| list.item(i)?.dyn_into::<HtmlElement>().ok())
            .filter_map(|el| Some((el.get_attribute("data-arrange-id")?, el)))
            .collect()
    }

    fn el(&self, id: &str) -> Option<HtmlElement> {
        self.els()
            .into_iter()
            .find(|(k, _)| k == id)
            .map(|(_, e)| e)
    }

    /// Put the picked-up card under the finger, wherever the grid placed it.
    fn follow(&self) {
        let mut live = self.inner.live.borrow_mut();
        let Some(s) = live.as_mut().filter(|s| s.started) else {
            return;
        };
        let Some(el) = self.el(&s.id) else { return };
        let r = el.get_bounding_client_rect();
        let left = r.left() - s.tx;
        let top = r.top() - s.ty;
        s.tx = s.x - s.off_x - left;
        s.ty = s.y - s.off_y - top;
        set_style(
            &el,
            "transform",
            &format!("translate({}px, {}px) scale(1.03)", s.tx, s.ty),
        );
    }

    /// FLIP: cards that moved in the grid glide from where they were. Runs
    /// once the new order is in the DOM.
    fn flip(&self, before: HashMap<String, DomRect>) {
        let me = self.clone();
        request_animation_frame(move || {
            let dragged = me.inner.live.borrow().as_ref().map(|s| s.id.clone());
            for (id, el) in me.els() {
                if Some(&id) == dragged.as_ref() {
                    continue;
                }
                let Some(was) = before.get(&id) else { continue };
                let now = el.get_bounding_client_rect();
                let (dx, dy) = (was.left() - now.left(), was.top() - now.top());
                if dx == 0.0 && dy == 0.0 {
                    continue;
                }
                set_style(&el, "transition", "none");
                set_style(&el, "transform", &format!("translate({dx}px, {dy}px)"));
                let _ = el.offset_width();
                set_style(&el, "transition", SETTLE);
                set_style(&el, "transform", "");
            }
            me.follow();
        });
    }

    fn move_card(&self, id: &str, target: usize) -> bool {
        let Some(next) = move_to(&self.shown(), id, target) else {
            return false;
        };
        let rects = rect_map(&self.els());
        self.order.set(Some(next));
        self.flip(rects);
        true
    }

    fn hit(&self) {
        let (id, x, y, last) = {
            let live = self.inner.live.borrow();
            let Some(s) = live.as_ref().filter(|s| s.started) else {
                return;
            };
            (s.id.clone(), s.x, s.y, s.last_swap.clone())
        };
        let target = document()
            .element_from_point(x as f32, y as f32)
            .and_then(|e| e.closest("[data-arrange-id]").ok().flatten())
            .and_then(|e| e.get_attribute("data-arrange-id"));
        let Some(target) = target else {
            // Over no card at all: the next card is a fresh swap.
            if let Some(s) = self.inner.live.borrow_mut().as_mut() {
                s.last_swap = None;
            }
            return;
        };
        if target == id {
            return;
        }
        if Some(&target) == last.as_ref() {
            return;
        }
        let Some(at) = self.shown().iter().position(|x| *x == target) else {
            return;
        };
        if self.move_card(&id, at) {
            if let Some(s) = self.inner.live.borrow_mut().as_mut() {
                s.last_swap = Some(target);
            }
        }
    }

    fn begin(&self) {
        {
            let mut live = self.inner.live.borrow_mut();
            let Some(s) = live.as_mut() else { return };
            let Some(el) = self.el(&s.id) else { return };
            let r = el.get_bounding_client_rect();
            s.started = true;
            s.off_x = s.x - r.left();
            s.off_y = s.y - r.top();
            s.tx = 0.0;
            s.ty = 0.0;
            set_style(&el, "transition", "none");
            self.drag_id.set(Some(s.id.clone()));
        }
        set_user_select("none");
        if let Some(body) = document().body() {
            let _ = body.style().set_property("-webkit-user-select", "none");
        }
        self.tick();
    }

    /// Scroll while held near the top or bottom edge.
    fn tick(&self) {
        let scrolled = {
            let live = self.inner.live.borrow();
            let Some(s) = live.as_ref().filter(|s| s.started) else {
                return;
            };
            let (top, bottom) = match &s.scroller {
                Some(sc) => {
                    let r = sc.get_bounding_client_rect();
                    (r.top(), r.bottom())
                }
                None => (
                    0.0,
                    window()
                        .inner_height()
                        .ok()
                        .and_then(|h| h.as_f64())
                        .unwrap_or(0.0),
                ),
            };
            let edge = 80.0;
            let speed = if s.y < top + edge {
                -((top + edge - s.y) / 5.0).ceil()
            } else if s.y > bottom - edge {
                ((s.y - (bottom - edge)) / 5.0).ceil()
            } else {
                0.0
            };
            if speed != 0.0 {
                match &s.scroller {
                    Some(sc) => sc.set_scroll_top(sc.scroll_top() + speed as i32),
                    None => window().scroll_by_with_x_and_y(0.0, speed),
                }
            }
            speed != 0.0
        };
        if scrolled {
            self.follow();
            self.hit();
        }
        let me = self.clone();
        *self.inner.raf.borrow_mut() = request_animation_frame_with_handle(move || me.tick()).ok();
    }

    fn detach(&self) {
        if let Some(f) = self.inner.cleanup.borrow_mut().take() {
            f();
        }
    }

    fn end(&self, commit: bool) {
        self.detach();
        let s = self.inner.live.borrow_mut().take();
        if let Some(h) = self.inner.raf.borrow_mut().take() {
            h.cancel();
        }
        let Some(mut s) = s else { return };
        if let Some(t) = s.timer.take() {
            t.clear();
        }
        set_user_select("");
        if let Some(body) = document().body() {
            let _ = body.style().set_property("-webkit-user-select", "");
        }
        if !s.started {
            return;
        }
        swallow_next_click();
        // Settle the card into its slot.
        if let Some(el) = self.el(&s.id) {
            set_style(&el, "transition", SETTLE);
            set_style(&el, "transform", "");
        }
        let fin = self.shown();
        self.drag_id.set(None);
        if commit && fin != self.inner.ids.get_untracked() {
            self.inner.on_commit.run(fin);
        } else if !commit {
            let rects = rect_map(&self.els());
            self.order.set(None);
            self.flip(rects);
            return;
        }
        self.order.set(None);
    }

    /// Window listeners for the life of one press.
    fn listen(&self) {
        let me = self.clone();
        let mv = window_listener("pointermove", false, move |e| {
            let Ok(e) = e.dyn_into::<web_sys::PointerEvent>() else {
                return;
            };
            let state = {
                let mut live = me.inner.live.borrow_mut();
                let Some(s) = live.as_mut() else { return };
                if e.pointer_id() != s.pointer_id {
                    return;
                }
                s.x = e.client_x() as f64;
                s.y = e.client_y() as f64;
                let moved = (s.x - s.x0).hypot(s.y - s.y0);
                (s.started, s.touch, moved)
            };
            let (started, touch, moved) = state;
            if !started {
                let editing = me.inner.editing.get_untracked();
                if editing && !touch && moved > MOUSE_SLOP {
                    me.begin();
                } else if moved > if touch { TOUCH_SLOP } else { MOUSE_SLOP } {
                    // Moved before the hold finished: a scroll or a click-drag, not ours.
                    me.end(false);
                    return;
                }
                if !me.inner.live.borrow().as_ref().is_some_and(|s| s.started) {
                    return;
                }
            }
            e.prevent_default();
            me.follow();
            me.hit();
        });
        // A finger that's dragging a card mustn't scroll the page.
        let me = self.clone();
        let touch = window_listener("touchmove", false, move |e| {
            if me.inner.live.borrow().as_ref().is_some_and(|s| s.started) {
                e.prevent_default();
            }
        });
        let me = self.clone();
        let up = window_listener("pointerup", true, move |e| {
            let id = e.dyn_ref::<web_sys::PointerEvent>().map(|p| p.pointer_id());
            let ours = me
                .inner
                .live
                .borrow()
                .as_ref()
                .is_none_or(|s| Some(s.pointer_id) == id);
            if ours {
                me.end(true);
            }
        });
        let me = self.clone();
        let cancel = window_listener("pointercancel", true, move |_| me.end(false));
        let me = self.clone();
        let key = window_listener("keydown", true, move |e| {
            if e.dyn_ref::<web_sys::KeyboardEvent>()
                .is_some_and(|k| k.key() == "Escape")
            {
                me.end(false);
            }
        });
        self.detach();
        *self.inner.cleanup.borrow_mut() = Some(Box::new(move || {
            mv();
            touch();
            up();
            cancel();
            key();
        }));
    }

    /// `on:pointerdown` on a card.
    pub fn on_pointer_down(&self, id: &str, e: &web_sys::PointerEvent) {
        if e.button() != 0 || self.inner.live.borrow().is_some() {
            return;
        }
        let no_drag = e
            .target()
            .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
            .and_then(|t| t.closest("[data-no-drag]").ok().flatten())
            .is_some();
        if no_drag {
            return;
        }
        let touch = e.pointer_type() != "mouse";
        let (x, y) = (e.client_x() as f64, e.client_y() as f64);
        let scroller = self.el(id).and_then(|el| scroll_parent(&el));
        *self.inner.live.borrow_mut() = Some(Live {
            id: id.to_string(),
            pointer_id: e.pointer_id(),
            touch,
            x0: x,
            y0: y,
            x,
            y,
            started: false,
            timer: None,
            off_x: 0.0,
            off_y: 0.0,
            tx: 0.0,
            ty: 0.0,
            scroller,
            last_swap: None,
        });
        let timer = if !self.inner.editing.get_untracked() {
            // Hold to edit: picks the card up straight away, like the iPhone.
            let me = SendWrapper::new(self.clone());
            set_timeout_with_handle(
                move || {
                    if me.inner.live.borrow().as_ref().is_none_or(|s| s.started) {
                        return;
                    }
                    me.inner.on_start_editing.run(());
                    // After edit mode has drawn its cards.
                    let me = me.clone();
                    request_animation_frame(move || me.begin());
                },
                Duration::from_millis(HOLD_TO_EDIT_MS),
            )
            .ok()
        } else if touch {
            let me = SendWrapper::new(self.clone());
            set_timeout_with_handle(
                move || {
                    if me.inner.live.borrow().as_ref().is_some_and(|s| !s.started) {
                        me.begin();
                    }
                },
                Duration::from_millis(HOLD_TO_DRAG_TOUCH_MS),
            )
            .ok()
        } else {
            // Mouse in edit mode: no text selection while it might become a drag.
            e.prevent_default();
            None
        };
        if let Some(s) = self.inner.live.borrow_mut().as_mut() {
            s.timer = timer;
        }
        self.listen();
    }

    /// Arrow keys move a focused card one place (edit mode).
    pub fn on_key_down(&self, id: &str, e: &web_sys::KeyboardEvent) {
        if !self.inner.editing.get_untracked() || e.target() != e.current_target() {
            return;
        }
        let step = arrow_step(&e.key());
        if step == 0 {
            return;
        }
        e.prevent_default();
        let Some(next) = step_order(&self.shown(), id, step) else {
            return;
        };
        self.inner.on_commit.run(next);
        let me = self.clone();
        let id = id.to_string();
        request_animation_frame(move || {
            if let Some(el) = me.el(&id) {
                let _ = el.focus();
            }
        });
    }

    /// A long-press menu would fight the hold-to-edit gesture.
    pub fn on_context_menu(&self, e: &web_sys::MouseEvent) {
        if self.inner.live.borrow().is_some() || self.inner.editing.get_untracked() {
            e.prevent_default();
        }
    }
}

/// The click that ends a drag mustn't also press the card under it. Gone
/// after one click, 450ms, or the next press (when the drop moved the card's
/// node the browser sends no click, and the next real tap must still work).
fn swallow_next_click() {
    use std::cell::Cell;
    let stop = Closure::<dyn Fn(web_sys::Event)>::new(|e: web_sys::Event| {
        e.prevent_default();
        e.stop_propagation();
    });
    let w = window();
    let opts = web_sys::AddEventListenerOptions::new();
    opts.set_capture(true);
    opts.set_once(true);
    let _ = w.add_event_listener_with_callback_and_add_event_listener_options(
        "click",
        stop.as_ref().unchecked_ref(),
        &opts,
    );
    let stop = Rc::new(stop);
    let done = Rc::new(Cell::new(false));
    let remove = {
        let (stop, done) = (Rc::clone(&stop), Rc::clone(&done));
        move || {
            if done.replace(true) {
                return;
            }
            let _ = window().remove_event_listener_with_callback_and_bool(
                "click",
                (*stop).as_ref().unchecked_ref(),
                true,
            );
        }
    };
    let on_press = {
        let remove = remove.clone();
        Closure::once_into_js(move |_: web_sys::Event| remove())
    };
    let _ = w.add_event_listener_with_callback_and_add_event_listener_options(
        "pointerdown",
        on_press.unchecked_ref(),
        &opts,
    );
    let held = SendWrapper::new((remove, stop, on_press));
    set_timeout(
        move || {
            let (remove, _stop, on_press) = held.take();
            remove();
            let _ = window().remove_event_listener_with_callback_and_bool(
                "pointerdown",
                on_press.unchecked_ref(),
                true,
            );
        },
        Duration::from_millis(450),
    );
}
