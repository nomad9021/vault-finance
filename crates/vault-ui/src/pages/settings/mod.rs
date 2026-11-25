//! Settings (apps/desktop/src/screens/shell/SettingsPage.tsx), in tabs.
//! Invited members only see what's theirs to change; the server, updates,
//! system checks, members and the admin console live in owner-only tabs.
//! The last tab is remembered on this device.

use leptos::prelude::*;
use leptos::task::spawn_local;

use crate::host::use_host;
use crate::ui::Tabs;

mod admin;
mod categories;
mod household;
mod members;
pub mod part_b;
mod profile;
mod rules;
mod updates;

use admin::AdminLaunchRow;
use categories::CategoryTreeSection;
use household::HouseholdSection;
use members::MembersSection;
use part_b::{
    AiMemorySection, AiSection, AppearanceSection, AutoLockSection, BankSection, BiometricSection,
    HomeScreenSection, NetworkSection, PasswordSection, ReviewSection, ServerSection,
    SessionsSection, SystemStatusSection, TrustedDevicesSection, TwoFactorSection,
};
use profile::ProfileSection;
use rules::CategorizationRulesSection;
use updates::{ServerUpdateSection, UpdatesSection};

const SETTINGS_TABS: &[(&str, &str)] = &[
    ("general", "General"),
    ("money", "Money"),
    ("ai", "AI"),
    ("security", "Security"),
    ("connection", "Connection"),
    ("members", "Members"),
    ("admin", "Server & admin"),
];
/// What a member sees: the tabs without the owner-only ones.
const MEMBER_TABS: &[(&str, &str)] = &[
    ("general", "General"),
    ("money", "Money"),
    ("ai", "AI"),
    ("security", "Security"),
    ("connection", "Connection"),
];
const SETTINGS_TAB_KEY: &str = "settings-tab";

/// The tab called `t` in `tabs`, if there is one.
fn valid(tabs: &'static [(&'static str, &'static str)], t: Option<&str>) -> Option<&'static str> {
    let t = t?;
    tabs.iter().find(|(v, _)| *v == t).map(|(v, _)| *v)
}

#[component]
pub fn SettingsPage() -> impl IntoView {
    let host = use_host();
    let app = host.app_state();
    let is_owner = Memo::new(move |_| app.with(|a| a.is_owner()));
    let tabs = move || {
        if is_owner.get() {
            SETTINGS_TABS
        } else {
            MEMBER_TABS
        }
    };
    let initial_tab = host.filter.tab.clone();
    let from_link = valid(tabs(), initial_tab.as_deref());
    let tab = RwSignal::new(from_link.unwrap_or("general"));

    if from_link.is_none() {
        let host = host.clone();
        spawn_local(async move {
            let saved = host.load_value(SETTINGS_TAB_KEY).await;
            if let Some(t) = valid(tabs(), saved.as_deref()) {
                tab.try_set(t);
            }
        });
    }

    // Remember the choice on this device (React's `choose`).
    let first = StoredValue::new(true);
    Effect::new({
        let host = host.clone();
        move || {
            let t = tab.get();
            if first.get_value() {
                first.set_value(false);
                return;
            }
            host.save_value(SETTINGS_TAB_KEY, t);
        }
    });

    view! {
        <div class="page" style="max-width: 780px">
            {move || {
                let items = tabs();
                view! { <Tabs items=items value=tab aria_label="Settings sections" /> }
            }}
            {move || match tab.get() {
                "general" => view! {
                    <ProfileSection />
                    <HomeScreenSection />
                    <AppearanceSection />
                    <ReviewSection />
                    <HouseholdSection />
                    <UpdatesSection />
                }.into_any(),
                "money" => view! {
                    <CategoryTreeSection />
                    <CategorizationRulesSection />
                    <BankSection />
                }.into_any(),
                "ai" => view! {
                    <AiSection />
                    <AiMemorySection />
                }.into_any(),
                "security" => view! {
                    <AutoLockSection />
                    <BiometricSection />
                    <PasswordSection />
                    <TwoFactorSection />
                    <TrustedDevicesSection />
                    <SessionsSection />
                }.into_any(),
                "connection" => view! {
                    <ServerSection />
                    <NetworkSection />
                }.into_any(),
                "members" if is_owner.get() => view! { <MembersSection /> }.into_any(),
                "admin" if is_owner.get() => view! {
                    <SystemStatusSection />
                    <ServerUpdateSection />
                    <AdminLaunchRow />
                }.into_any(),
                _ => ().into_any(),
            }}
        </div>
    }
}
