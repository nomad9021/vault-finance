//! `ProfileSection`: your name, colour and profile picture — shown in the
//! header, on the login screen and to your household.

use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use vault_core::user::{UpdateMeRequest, User};
use wasm_bindgen::{JsCast, JsValue};

use crate::host::{use_host, HostCtx};
use crate::ui::{Avatar, Button, Card, Field};

const PROFILE_COLORS: [&str; 8] = [
    "#8a94a6", "#9184d9", "#6f8ef2", "#43cfc0", "#3ecf8e", "#d8b23c", "#f08a4b", "#ec6a9c",
];

/// Square-crop and shrink a picture to 256×256 JPEG in the app, so uploads
/// stay small.
async fn to_avatar_data_url(file: &web_sys::File) -> Result<String, JsValue> {
    let promise = window().create_image_bitmap_with_blob(file)?;
    let bitmap: web_sys::ImageBitmap = wasm_bindgen_futures::JsFuture::from(promise)
        .await?
        .dyn_into()?;
    let (w, h) = (bitmap.width() as f64, bitmap.height() as f64);
    let side = w.min(h);
    let canvas: web_sys::HtmlCanvasElement = document().create_element("canvas")?.dyn_into()?;
    canvas.set_width(256);
    canvas.set_height(256);
    let ctx: web_sys::CanvasRenderingContext2d =
        canvas.get_context("2d")?.ok_or(JsValue::NULL)?.dyn_into()?;
    ctx.draw_image_with_image_bitmap_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
        &bitmap,
        (w - side) / 2.0,
        (h - side) / 2.0,
        side,
        side,
        0.0,
        0.0,
        256.0,
        256.0,
    )?;
    bitmap.close();
    canvas.to_data_url_with_type_and_encoder_options("image/jpeg", &JsValue::from_f64(0.85))
}

#[component]
pub fn ProfileSection() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let user = Memo::new(move |_| app.with(|a| a.user.clone()));
    let display_name =
        Memo::new(move |_| user.with(|u| u.as_ref().map(|u| u.display_name.clone())));
    let name = RwSignal::new(display_name.get_untracked().unwrap_or_default());
    Effect::new(move || name.set(display_name.get().unwrap_or_default()));
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let file_ref = NodeRef::<html::Input>::new();

    let update = {
        let host = host.clone();
        move |body: UpdateMeRequest| {
            let host = host.clone();
            busy.set(true);
            error.set(None);
            spawn_local(async move {
                match host
                    .try_call::<User>("updateMe", &[HostCtx::arg(&body)])
                    .await
                {
                    Ok(next) => host.set_user(&next),
                    Err(e) => {
                        error.try_set(Some(if e.is_api_request() {
                            e.message
                        } else {
                            "Couldn't save your profile.".into()
                        }));
                    }
                }
                busy.try_set(false);
            });
        }
    };

    let pick = {
        let update = update.clone();
        move |file: Option<web_sys::File>| {
            let Some(file) = file else { return };
            let update = update.clone();
            spawn_local(async move {
                match to_avatar_data_url(&file).await {
                    Ok(url) => update(UpdateMeRequest {
                        avatar_image: Some(Some(url)),
                        ..Default::default()
                    }),
                    Err(_) => {
                        error.try_set(Some("That file couldn't be read as a picture.".into()));
                    }
                }
            });
        }
    };

    move || {
        let u = user.get()?;
        let has_image = u.avatar_image.as_deref().is_some_and(|s| !s.is_empty());
        let current_color = u.avatar_color.clone();
        let current_name = u.display_name.clone();
        let update_remove = update.clone();
        let update_color = update.clone();
        let update_name = update.clone();
        let pick = pick.clone();
        let unchanged = {
            let current_name = current_name.clone();
            move || {
                let n = name.get();
                let t = n.trim();
                t.is_empty() || t == current_name
            }
        };
        let unchanged_submit = unchanged.clone();
        Some(view! {
            <Card kicker="You" title="Your profile">
                <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap">
                    <Avatar name=u.display_name.clone() color=u.avatar_color.clone()
                        image=u.avatar_image.clone().unwrap_or_default() size=72 />
                    <div style="display: flex; flex-direction: column; gap: 8px">
                        <div style="display: flex; gap: 8px; flex-wrap: wrap">
                            <Button variant="secondary" icon="upload" disabled=busy
                                on_click=move || {
                                    if let Some(el) = file_ref.get_untracked() {
                                        el.click();
                                    }
                                }>
                                {if has_image { "Change photo" } else { "Add a photo" }}
                            </Button>
                            {has_image.then(|| view! {
                                <Button variant="ghost" disabled=busy on_click=move || update_remove(UpdateMeRequest {
                                    avatar_image: Some(None),
                                    ..Default::default()
                                })>
                                    "Remove photo"
                                </Button>
                            })}
                            <input node_ref=file_ref type="file" accept="image/jpeg,image/png,image/webp" hidden
                                on:change=move |e| {
                                    let input: web_sys::HtmlInputElement = event_target(&e);
                                    pick(input.files().and_then(|f| f.get(0)));
                                    input.set_value("");
                                } />
                        </div>
                        <div style="display: flex; gap: 6px" role="radiogroup" aria-label="Profile colour">
                            {PROFILE_COLORS.iter().map(|&c| {
                                let selected = current_color == c;
                                let update_color = update_color.clone();
                                let border = if selected { "2px solid var(--color-text)" } else { "2px solid transparent" };
                                view! {
                                    <button role="radio" aria-checked=if selected { "true" } else { "false" }
                                        aria-label=format!("Colour {c}") disabled=busy
                                        on:click=move |_| update_color(UpdateMeRequest {
                                            avatar_color: Some(c.to_string()),
                                            ..Default::default()
                                        })
                                        style=format!("width: 22px; height: 22px; border-radius: 50%; background: {c}; cursor: pointer; border: {border}; box-shadow: 0 0 0 1px var(--color-divider)")>
                                    </button>
                                }
                            }).collect_view()}
                        </div>
                    </div>
                </div>
                <form style="display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap"
                    on:submit=move |e| {
                        e.prevent_default();
                        if !unchanged_submit() {
                            update_name(UpdateMeRequest {
                                display_name: Some(name.get_untracked().trim().to_string()),
                                ..Default::default()
                            });
                        }
                    }>
                    <div style="flex: 1; min-width: 200px">
                        <Field label="Display name" value=name max_length=100 />
                    </div>
                    <button type="submit" class="btn btn-secondary"
                        disabled=move || busy.get() || unchanged()>
                        "Save name"
                    </button>
                </form>
                {move || error.get().map(|e| view! {
                    <p role="alert" style="color: var(--color-negative); font-size: var(--text-sm)">{e}</p>
                })}
            </Card>
        })
    }
}
