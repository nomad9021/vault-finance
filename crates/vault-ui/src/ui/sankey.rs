//! `<Sankey>`: packages/ui/src/charts/Sankey.tsx. Same SVG markup, classes
//! and inline styles; the layout maths is `vault_core::sankey::layout`.
//!
//! Click a node or flow to focus it (the card around the chart draws the
//! drill-in panel). With `on_reorder`, bars drag up and down their column:
//! a mouse straight away, a finger after a short hold so a swipe still
//! scrolls, and a press that doesn't move stays a click.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use leptos::prelude::*;
use send_wrapper::SendWrapper;
use vault_core::sankey::{
    self as core, column_ids, drag_column, flow_key, link_path, merge_column_order, rgba, Datum,
    Layout, LinkDatum, SankeyNodeKind, NW, W,
};
use wasm_bindgen::JsCast;

use super::listen::window_listener;

const HOLD_TO_DRAG_TOUCH: Duration = Duration::from_millis(220);

const LABEL_STYLE: &str =
    "font-family: var(--font-heading); font-weight: 600; font-size: 12.5px; fill: var(--color-text)";
const MUTED_STYLE: &str =
    "font-family: var(--font-body); font-weight: 400; font-size: 11.5px; fill: var(--color-neutral-500)";

#[component]
pub fn Sankey(
    #[prop(into)] nodes: Signal<Vec<Datum>>,
    #[prop(into)] links: Signal<Vec<LinkDatum>>,
    /// Value formatter for node captions.
    format: Callback<f64, String>,
    #[prop(into)] focus: Signal<Option<String>>,
    on_focus: Callback<Option<String>>,
    /// Tint links by category colour; hub-grey otherwise.
    #[prop(default = true)]
    colorful: bool,
    #[prop(default = "#9397ab")] hub_color: &'static str,
    #[prop(into, default = Signal::stored("Cash flow diagram".to_string()))] aria_label: Signal<
        String,
    >,
    /// The person's own top-to-bottom order of nodes (only the order within
    /// a column matters); unlisted nodes keep their automatic place.
    #[prop(optional, into)]
    order: Option<Signal<Vec<String>>>,
    /// Makes the bars draggable; called with the new order on drop.
    #[prop(optional)]
    on_reorder: Option<Callback<Vec<String>>>,
) -> impl IntoView {
    let order = order.unwrap_or_else(|| Signal::stored(Vec::new()));
    let hover = RwSignal::new(None::<usize>);
    let live_order = RwSignal::new(None::<Vec<String>>);
    let active_order = Memo::new(move |_| live_order.get().unwrap_or_else(|| order.get()));
    let geo = Memo::new(move |_| core::layout(&nodes.get(), &links.get(), &active_order.get()));
    let svg = NodeRef::<leptos::svg::Svg>::new();
    let drag = NodeDrag::new(svg, geo, live_order, order, on_reorder);
    let movable = on_reorder.is_some();
    // A per-instance id so two charts on a page don't share gradients.
    let seed = format!("{:x}", (js_sys::Math::random() * 2_176_782_336.0) as u64);

    let color_by_id = Memo::new(move |_| {
        nodes.with(|ns| {
            ns.iter()
                .map(|n| (n.id.clone(), n.color.clone()))
                .collect::<HashMap<_, _>>()
        })
    });
    let depth_by_id = Memo::new(move |_| {
        nodes.with(|ns| {
            ns.iter()
                .map(|n| (n.id.clone(), n.depth))
                .collect::<HashMap<_, _>>()
        })
    });
    let neighbors = Memo::new(move |_| links.with(|ls| core::neighbors(ls)));
    let root_total = Memo::new(move |_| nodes.with(|ns| core::root_total(ns)));
    let link_color = move |id: &str| -> String {
        if colorful {
            color_by_id
                .with_untracked(|m| m.get(id).cloned())
                .unwrap_or_else(|| hub_color.to_string())
        } else {
            hub_color.to_string()
        }
    };

    let body = move || {
        let g = geo.get();
        // Read so colours follow the data even when the geometry doesn't change.
        color_by_id.track();
        let depths = depth_by_id.get();

        let defs = g
            .links
            .iter()
            .enumerate()
            .map(|(i, l)| {
                let key = flow_key(&l.from, &l.to, &depths);
                let c1 = l.color.clone().unwrap_or_else(|| {
                    if l.from == key {
                        link_color(key)
                    } else {
                        hub_color.into()
                    }
                });
                let c2 = l.color.clone().unwrap_or_else(|| {
                    if l.to == key {
                        link_color(key)
                    } else {
                        hub_color.into()
                    }
                });
                view! {
                    <linearGradient id=format!("flow-{seed}-{i}") gradientUnits="userSpaceOnUse"
                        x1=l.sx x2=l.tx y1="0" y2="0">
                        <stop offset="0%" stop-color=rgba(&c1, 0.55) />
                        <stop offset="100%" stop-color=rgba(&c2, 0.55) />
                    </linearGradient>
                }
            })
            .collect_view();

        let paths = g
            .links
            .iter()
            .enumerate()
            .map(|(i, l)| {
                let (from, to) = (l.from.clone(), l.to.clone());
                let key = flow_key(&l.from, &l.to, &depths).to_string();
                let hot = move || {
                    focus.with(|f| f.as_deref() == Some(&from) || f.as_deref() == Some(&to))
                };
                let opacity = move || {
                    let hot = hot();
                    if focus.with(Option::is_some) && !hot {
                        "0.1"
                    } else if hover.get() == Some(i) || hot {
                        "1"
                    } else {
                        "0.72"
                    }
                };
                view! {
                    <path d=link_path(l) fill=format!("url(#flow-{seed}-{i})") opacity=opacity
                        style="cursor: pointer; transition: opacity .2s"
                        on:click=move |_| on_focus.run(Some(key.clone()))
                        on:mouseenter=move |_| hover.set(Some(i))
                        on:mouseleave=move |_| hover.set(None) />
                }
            })
            .collect_view();

        let total = root_total.get_untracked();
        let bars = g
            .nodes
            .iter()
            .map(|n| {
                let d = &n.datum;
                // Income sources and the hub label to the RIGHT of their bar;
                // every spending node to the LEFT, so the deepest column's
                // captions grow inward.
                let right = d.depth == 0 || d.kind == SankeyNodeKind::Hub;
                let anchor = if right { "start" } else { "end" };
                let lx = if right { n.x + NW + 10.0 } else { n.x - 10.0 };
                let cy = n.y + n.h / 2.0;
                let caption = core::caption(d, total, |v| format.run(v));
                let id = d.id.clone();
                let opacity = {
                    let id = id.clone();
                    move || {
                        focus.with(|f| match f {
                            Some(f) if *f != id
                                && !neighbors.with(|nb| nb.get(f).is_some_and(|s| s.contains(&id))) =>
                            {
                                "0.3"
                            }
                            _ => "1",
                        })
                    }
                };
                let dragging = {
                    let id = id.clone();
                    move || drag.drag_id.with(|d| d.as_deref() == Some(&id))
                };
                let transform = {
                    let dragging = dragging.clone();
                    move || dragging().then(|| format!("translate(0, {})", drag.offset.get()))
                };
                let cursor = {
                    let dragging = dragging.clone();
                    move || {
                        if !movable {
                            "cursor: pointer"
                        } else if dragging() {
                            "cursor: grabbing"
                        } else {
                            "cursor: grab"
                        }
                    }
                };
                let down = {
                    let (drag, id) = (drag.clone(), id.clone());
                    move |e: web_sys::PointerEvent| {
                        if movable {
                            drag.on_pointer_down(&id, &e);
                        }
                    }
                };
                let click = {
                    let (drag, id) = (drag.clone(), id.clone());
                    move |_| {
                        if drag.consume_click() {
                            return;
                        }
                        let next = (focus.get_untracked().as_deref() != Some(&id)).then(|| id.clone());
                        on_focus.run(next);
                    }
                };
                view! {
                    <g opacity=opacity class=movable.then_some("sankey-node-movable")
                        data-dragging=move || dragging().then_some("true")
                        data-no-drag=movable.then_some("")
                        transform=transform style=cursor
                        on:pointerdown=down on:click=click>
                        // Bigger invisible target than the thin bar: the bar plus its label.
                        <rect x=if right { n.x - 6.0 } else { n.x - 190.0 } y=n.y.min(cy - 18.0)
                            width=196.0 + NW height=n.h.max(36.0) fill="transparent" />
                        <rect x=n.x y=n.y width=NW height=n.h rx="1.5" fill=link_color(&d.id) />
                        <text x=lx y=cy - 3.0 text-anchor=anchor style=LABEL_STYLE>{d.label.clone()}</text>
                        <text x=lx y=cy + 12.0 text-anchor=anchor style=MUTED_STYLE>{caption}</text>
                    </g>
                }
            })
            .collect_view();

        view! {
            <defs>{defs}</defs>
            {paths}
            {bars}
        }
    };

    view! {
        <svg node_ref=svg class="chart-reveal" viewBox=move || format!("0 0 {W} {}", geo.with(|g| g.height))
            style="width: 100%; height: auto; display: block; overflow: visible"
            role="img" aria-label=aria_label>
            {body}
        </svg>
    }
}

/// A press on a bar, from pointer-down until release.
struct Live {
    id: String,
    pointer_id: i32,
    touch: bool,
    x0: f64,
    y0: f64,
    started: bool,
    timer: Option<TimeoutHandle>,
    /// Pointer y (diagram units) minus the node's centre when picked up.
    grab: f64,
    order: Vec<String>,
}

struct DragInner {
    live: RefCell<Option<Live>>,
    click_block: Cell<bool>,
    cleanup: RefCell<Option<Box<dyn FnOnce()>>>,
}

/// `useNodeDrag`: the diagram re-lays itself out under the pointer, so the
/// flows follow live; the order is handed to `on_drop` on release.
#[derive(Clone)]
struct NodeDrag {
    svg: NodeRef<leptos::svg::Svg>,
    geo: Memo<Layout>,
    drag_id: RwSignal<Option<String>>,
    offset: RwSignal<f64>,
    live_order: RwSignal<Option<Vec<String>>>,
    order: Signal<Vec<String>>,
    on_drop: Option<Callback<Vec<String>>>,
    inner: SendWrapper<Rc<DragInner>>,
}

impl NodeDrag {
    fn new(
        svg: NodeRef<leptos::svg::Svg>,
        geo: Memo<Layout>,
        live_order: RwSignal<Option<Vec<String>>>,
        order: Signal<Vec<String>>,
        on_drop: Option<Callback<Vec<String>>>,
    ) -> Self {
        let inner = Rc::new(DragInner {
            live: RefCell::new(None),
            click_block: Cell::new(false),
            cleanup: RefCell::new(None),
        });
        let held = SendWrapper::new(Rc::clone(&inner));
        on_cleanup(move || {
            if let Some(f) = held.cleanup.borrow_mut().take() {
                f();
            }
        });
        NodeDrag {
            svg,
            geo,
            drag_id: RwSignal::new(None),
            offset: RwSignal::new(0.0),
            live_order,
            order,
            on_drop,
            inner: SendWrapper::new(inner),
        }
    }

    /// Client y to diagram units.
    fn to_y(&self, client_y: f64) -> f64 {
        let m = self
            .svg
            .get_untracked()
            .and_then(|el| el.dyn_into::<web_sys::SvgGraphicsElement>().ok())
            .and_then(|el| el.get_screen_ctm());
        match m {
            Some(m) => (client_y - m.f() as f64) / m.d() as f64,
            None => client_y,
        }
    }

    fn update(&self, client_y: f64) {
        let (id, grab) = match &*self.inner.live.borrow() {
            Some(s) if s.started => (s.id.clone(), s.grab),
            _ => return,
        };
        let g = self.geo.get_untracked();
        let Some(me) = g.node(&id).cloned() else {
            return;
        };
        let want = self.to_y(client_y) - grab; // desired centre
        if let Some(ids) = drag_column(&g, &id, want) {
            let next = {
                let mut live = self.inner.live.borrow_mut();
                let Some(s) = live.as_mut() else { return };
                s.order = merge_column_order(&s.order, &ids);
                s.order.clone()
            };
            self.live_order.set(Some(next));
        }
        // Follow the pointer from wherever the layout now puts the node.
        let placed = self.geo.get_untracked().node(&id).cloned().unwrap_or(me);
        self.offset.set(want - placed.center());
    }

    fn finish(&self, commit: bool) {
        let s = self.inner.live.borrow_mut().take();
        let cleanup = self.inner.cleanup.borrow_mut().take();
        if let Some(f) = cleanup {
            f();
        }
        let Some(mut s) = s else { return };
        if let Some(t) = s.timer.take() {
            t.clear();
        }
        if !s.started {
            return;
        }
        self.inner.click_block.set(true);
        let inner = SendWrapper::new(Rc::clone(&self.inner));
        set_timeout(
            move || inner.click_block.set(false),
            Duration::from_millis(400),
        );
        self.drag_id.set(None);
        self.offset.set(0.0);
        let before = self.order.get_untracked().join("|");
        if commit && s.order.join("|") != before {
            if let Some(f) = self.on_drop {
                f.run(s.order);
            }
        }
        self.live_order.set(None);
    }

    fn start(&self) {
        let (id, y0) = match &*self.inner.live.borrow() {
            Some(s) => (s.id.clone(), s.y0),
            None => return,
        };
        let g = self.geo.get_untracked();
        let column = column_ids(&g, &id);
        let Some(me) = g.node(&id).filter(|_| column.len() >= 2) else {
            self.finish(false);
            return;
        };
        let grab = self.to_y(y0) - me.center();
        // Freeze the current column order so the automatic ordering can't
        // shuffle mid-drag.
        let order = merge_column_order(&self.order.get_untracked(), &column);
        if let Some(s) = self.inner.live.borrow_mut().as_mut() {
            s.started = true;
            s.grab = grab;
            s.order = order.clone();
        }
        self.live_order.set(Some(order));
        self.drag_id.set(Some(id));
        self.offset.set(0.0);
    }

    fn on_pointer_down(&self, id: &str, e: &web_sys::PointerEvent) {
        if self.on_drop.is_none() || e.button() != 0 || self.inner.live.borrow().is_some() {
            return;
        }
        let touch = e.pointer_type() != "mouse";
        *self.inner.live.borrow_mut() = Some(Live {
            id: id.to_string(),
            pointer_id: e.pointer_id(),
            touch,
            x0: e.client_x() as f64,
            y0: e.client_y() as f64,
            started: false,
            timer: None,
            grab: 0.0,
            order: self.order.get_untracked(),
        });
        if touch {
            let me = self.clone();
            let timer = set_timeout_with_handle(
                move || {
                    let waiting = me.inner.live.borrow().as_ref().is_some_and(|s| !s.started);
                    if waiting {
                        me.start();
                    }
                },
                HOLD_TO_DRAG_TOUCH,
            )
            .ok();
            if let Some(s) = self.inner.live.borrow_mut().as_mut() {
                s.timer = timer;
            }
        }

        let me = self.clone();
        let mv = window_listener("pointermove", false, move |ev| {
            let Ok(ev) = ev.dyn_into::<web_sys::PointerEvent>() else {
                return;
            };
            let (started, touch, moved) = match &*me.inner.live.borrow() {
                Some(s) if ev.pointer_id() == s.pointer_id => (
                    s.started,
                    s.touch,
                    (ev.client_x() as f64 - s.x0).hypot(ev.client_y() as f64 - s.y0),
                ),
                _ => return,
            };
            if !started {
                if !touch && moved > 4.0 {
                    me.start();
                } else if touch && moved > 8.0 {
                    // A scroll.
                    me.finish(false);
                    return;
                }
                if !me.inner.live.borrow().as_ref().is_some_and(|s| s.started) {
                    return;
                }
            }
            ev.prevent_default();
            me.update(ev.client_y() as f64);
        });
        let me = self.clone();
        let up = window_listener("pointerup", true, move |_| me.finish(true));
        let me = self.clone();
        let cancel = window_listener("pointercancel", true, move |_| me.finish(false));
        let me = self.clone();
        let touch_move = window_listener("touchmove", false, move |ev| {
            if me.inner.live.borrow().as_ref().is_some_and(|s| s.started) {
                ev.prevent_default();
            }
        });
        let me = self.clone();
        let key = window_listener("keydown", true, move |ev| {
            if ev
                .dyn_ref::<web_sys::KeyboardEvent>()
                .is_some_and(|k| k.key() == "Escape")
            {
                me.finish(false);
            }
        });
        *self.inner.cleanup.borrow_mut() = Some(Box::new(move || {
            mv();
            up();
            cancel();
            touch_move();
            key();
        }));
    }

    /// True once after a drag, so the release doesn't also count as a click.
    fn consume_click(&self) -> bool {
        if !self.inner.click_block.get() {
            return false;
        }
        self.inner.click_block.set(false);
        true
    }
}
