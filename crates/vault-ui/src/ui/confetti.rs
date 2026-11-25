//! The debt-free `<Confetti>` burst (`Confetti` in DebtCalculator.tsx).

use leptos::prelude::*;

const CONFETTI_COLORS: [&str; 6] = [
    "#3ecf8e", "#43cfc0", "#6f8ef2", "#b47ef0", "#ec6a9c", "#d8b23c",
];

/// A one-shot burst of falling confetti (`confettiFall` in base.css).
#[component]
pub fn Confetti() -> impl IntoView {
    let rnd = js_sys::Math::random;
    let pieces = (0..28).map(|i| {
        let left = rnd() * 100.0;
        let delay = rnd() * 0.7;
        let duration = 1.8 + rnd() * 1.4;
        let color = CONFETTI_COLORS[i % CONFETTI_COLORS.len()];
        let size = 6.0 + rnd() * 6.0;
        let style = format!(
            "position: absolute; top: -14px; left: {left}%; width: {size}px; height: {}px; background: {color}; border-radius: 1px; animation: confettiFall {duration}s linear {delay}s",
            size * 0.42
        );
        view! { <span style=style></span> }
    });
    view! {
        <div aria-hidden="true" style="position: absolute; inset: 0; pointer-events: none; overflow: hidden">
            {pieces.collect_view()}
        </div>
    }
}
