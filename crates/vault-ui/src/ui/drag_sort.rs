//! `useDragSort` (apps/desktop/src/lib/dragSort.ts): drag and drop on pointer
//! events, so it works the same with a mouse, a trackpad and a finger. Grab a
//! handle, move, let go over another item; the caller decides what
//! before/after/inside means. Items mark themselves with `data-drop-id`; the
//! dragged one follows the pointer and stops catching it, so the item
//! underneath is the target. The nearest scroller scrolls near its edges.

use std::cell::RefCell;
use std::rc::Rc;

use leptos::prelude::*;
use send_wrapper::SendWrapper;
use vault_core::categories::DropZone;
use wasm_bindgen::JsCast;

use super::listen::window_listener;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DragState {
    pub dx: f64,
    pub dy: f64,
}

struct Live {
    id: String,
    x0: f64,
    y0: f64,
    x: f64,
    y: f64,
    scroller: Option<web_sys::HtmlElement>,
    over: Option<(String, DropZone)>,
}

type ZoneFor = dyn Fn(&web_sys::DomRect, f64, f64, &str) -> DropZone;
type CanDrop = dyn Fn(&str, &str, DropZone) -> bool;
type OnDrop = dyn Fn(String, String, DropZone);

struct Inner {
    live: RefCell<Option<Live>>,
    raf: RefCell<Option<AnimationFrameRequestHandle>>,
    cleanup: RefCell<Option<Box<dyn FnOnce()>>>,
    zone_for: Box<ZoneFor>,
    can_drop: Box<CanDrop>,
    on_drop: Box<OnDrop>,
}

#[derive(Clone)]
pub struct DragSort {
    /// The id being dragged, and how far it has moved.
    pub drag: RwSignal<Option<(String, DragState)>>,
    pub over: RwSignal<Option<(String, DropZone)>>,
    inner: SendWrapper<Rc<Inner>>,
}

impl DragSort {
    pub fn new(
        zone_for: impl Fn(&web_sys::DomRect, f64, f64, &str) -> DropZone + 'static,
        can_drop: impl Fn(&str, &str, DropZone) -> bool + 'static,
        on_drop: impl Fn(String, String, DropZone) + 'static,
    ) -> Self {
        let inner = Rc::new(Inner {
            live: RefCell::new(None),
            raf: RefCell::new(None),
            cleanup: RefCell::new(None),
            zone_for: Box::new(zone_for),
            can_drop: Box::new(can_drop),
            on_drop: Box::new(on_drop),
        });
        let this = DragSort {
            drag: RwSignal::new(None),
            over: RwSignal::new(None),
            inner: SendWrapper::new(inner),
        };
        let me = SendWrapper::new(this.clone());
        on_cleanup(move || me.detach());
        this
    }

    fn detach(&self) {
        if let Some(h) = self.inner.raf.borrow_mut().take() {
            h.cancel();
        }
        if let Some(f) = self.inner.cleanup.borrow_mut().take() {
            f();
        }
    }

    fn stop(&self, commit: bool) {
        let s = self.inner.live.borrow_mut().take();
        self.detach();
        self.drag.set(None);
        self.over.set(None);
        set_user_select("");
        if let Some(Live {
            id,
            over: Some((target, zone)),
            ..
        }) = s.filter(|_| commit)
        {
            (self.inner.on_drop)(id, target, zone);
        }
    }

    fn hit(&self, x: f64, y: f64) {
        let Some(drag_id) = self.inner.live.borrow().as_ref().map(|s| s.id.clone()) else {
            return;
        };
        let el = document()
            .element_from_point(x as f32, y as f32)
            .and_then(|e| e.closest("[data-drop-id]").ok().flatten());
        let mut next = None;
        if let Some(el) = el {
            if let Some(id) = el.get_attribute("data-drop-id").filter(|id| *id != drag_id) {
                let zone = (self.inner.zone_for)(&el.get_bounding_client_rect(), x, y, &id);
                if (self.inner.can_drop)(&drag_id, &id, zone) {
                    next = Some((id, zone));
                }
            }
        }
        if let Some(s) = self.inner.live.borrow_mut().as_mut() {
            s.over = next.clone();
        }
        if self.over.get_untracked() != next {
            self.over.set(next);
        }
    }

    /// Scroll while held near the top or bottom edge.
    fn tick(&self) {
        let step = {
            let mut live = self.inner.live.borrow_mut();
            let Some(s) = live.as_mut() else { return };
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
            let edge = 70.0;
            let speed = if s.y < top + edge {
                -((top + edge - s.y) / 6.0).ceil()
            } else if s.y > bottom - edge {
                ((s.y - (bottom - edge)) / 6.0).ceil()
            } else {
                0.0
            };
            if speed != 0.0 {
                match &s.scroller {
                    Some(sc) => sc.set_scroll_top(sc.scroll_top() + speed as i32),
                    None => window().scroll_by_with_x_and_y(0.0, speed),
                }
                s.y0 -= speed;
                Some((s.id.clone(), s.x, s.y, s.x - s.x0, s.y - s.y0))
            } else {
                None
            }
        };
        if let Some((id, x, y, dx, dy)) = step {
            self.drag.set(Some((id, DragState { dx, dy })));
            self.hit(x, y);
        }
        let me = self.clone();
        *self.inner.raf.borrow_mut() = request_animation_frame_with_handle(move || me.tick()).ok();
    }

    /// `onPointerDown` for the grab handle.
    pub fn on_handle_down(&self, id: &str, e: &web_sys::PointerEvent) {
        if e.button() != 0 {
            return;
        }
        e.prevent_default();
        e.stop_propagation();
        let (x, y) = (e.client_x() as f64, e.client_y() as f64);
        let scroller = e
            .current_target()
            .and_then(|t| t.dyn_into::<web_sys::HtmlElement>().ok())
            .and_then(|el| scroll_parent(&el));
        self.detach();
        *self.inner.live.borrow_mut() = Some(Live {
            id: id.to_string(),
            x0: x,
            y0: y,
            x,
            y,
            scroller,
            over: None,
        });
        set_user_select("none");
        self.drag
            .set(Some((id.to_string(), DragState { dx: 0.0, dy: 0.0 })));

        let me = self.clone();
        let mv = window_listener("pointermove", false, move |ev| {
            let Ok(ev) = ev.dyn_into::<web_sys::PointerEvent>() else {
                return;
            };
            let (x, y) = (ev.client_x() as f64, ev.client_y() as f64);
            let moved = {
                let mut live = me.inner.live.borrow_mut();
                let Some(s) = live.as_mut() else { return };
                s.x = x;
                s.y = y;
                (s.id.clone(), x - s.x0, y - s.y0)
            };
            ev.prevent_default();
            me.drag.set(Some((
                moved.0,
                DragState {
                    dx: moved.1,
                    dy: moved.2,
                },
            )));
            me.hit(x, y);
        });
        let me = self.clone();
        let up = window_listener("pointerup", true, move |_| me.stop(true));
        let me = self.clone();
        let cancel = window_listener("pointercancel", true, move |_| me.stop(false));
        let me = self.clone();
        let key = window_listener("keydown", true, move |ev| {
            if ev
                .dyn_ref::<web_sys::KeyboardEvent>()
                .is_some_and(|k| k.key() == "Escape")
            {
                me.stop(false);
            }
        });
        *self.inner.cleanup.borrow_mut() = Some(Box::new(move || {
            mv();
            up();
            cancel();
            key();
        }));
        let me = self.clone();
        *self.inner.raf.borrow_mut() = request_animation_frame_with_handle(move || me.tick()).ok();
    }

    /// The handle's style: `touch-action: none` and a grab cursor.
    pub fn handle_style(&self, id: String) -> impl Fn() -> String + Send + Sync + 'static {
        let drag = self.drag;
        move || {
            let grabbing = drag.with(|d| d.as_ref().is_some_and(|(d, _)| *d == id));
            format!(
                "touch-action: none; cursor: {}",
                if grabbing { "grabbing" } else { "grab" }
            )
        }
    }

    /// `data-dragging` on an item.
    pub fn dragging(
        &self,
        id: String,
    ) -> impl Fn() -> Option<&'static str> + Send + Sync + 'static {
        let drag = self.drag;
        move || {
            drag.with(|d| d.as_ref().is_some_and(|(d, _)| *d == id))
                .then_some("true")
        }
    }

    /// `data-drop` on an item: the zone the pointer is over.
    pub fn drop_zone(
        &self,
        id: String,
    ) -> impl Fn() -> Option<&'static str> + Send + Sync + 'static {
        let over = self.over;
        move || {
            over.with(|o| {
                o.as_ref()
                    .filter(|(o, _)| *o == id)
                    .map(|(_, z)| z.as_str())
            })
        }
    }

    /// An item's style: its own `extra`, plus following the pointer while
    /// it's dragged.
    pub fn item_style(
        &self,
        id: String,
        extra: String,
    ) -> impl Fn() -> String + Send + Sync + 'static {
        let drag = self.drag;
        move || {
            drag.with(|d| match d {
                Some((d, s)) if *d == id => format!(
                    "transform: translate({}px, {}px); pointer-events: none; z-index: 50; position: relative; box-shadow: var(--shadow-lg); opacity: 0.92; {extra}",
                    s.dx, s.dy
                ),
                _ => extra.clone(),
            })
        }
    }
}

pub(super) fn set_user_select(v: &str) {
    if let Some(body) = document().body() {
        let _ = body.style().set_property("user-select", v);
    }
}

/// The nearest ancestor that scrolls vertically.
pub fn scroll_parent(el: &web_sys::HtmlElement) -> Option<web_sys::HtmlElement> {
    let mut cur = el.parent_element();
    while let Some(e) = cur {
        let oy = window()
            .get_computed_style(&e)
            .ok()
            .flatten()
            .and_then(|s| s.get_property_value("overflow-y").ok())
            .unwrap_or_default();
        if (oy == "auto" || oy == "scroll") && e.scroll_height() > e.client_height() {
            return e.dyn_into::<web_sys::HtmlElement>().ok();
        }
        cur = e.parent_element();
    }
    None
}
