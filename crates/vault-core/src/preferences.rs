//! `UserPreferences` (packages/shared/src/schemas/user.ts): settings stored
//! on the server so they follow the person to every device.

use serde::{Deserialize, Serialize};

use crate::dashboard::{DashboardWidget, SankeyView};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// Dashboard widgets in order; unknown ids are ignored, missing ones appended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dashboard: Option<Vec<DashboardWidget>>,
    /// Which cash-flow diagram the dashboard leads with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sankey_view: Option<SankeyView>,
    /// The person's own top-to-bottom order of Sankey nodes, shared by every diagram.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sankey_order: Option<Vec<String>>,
}

/// `savePreferences({ sankeyOrder })`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SankeyOrderBody<'a> {
    pub sankey_order: &'a [String],
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard::Span;

    #[test]
    fn reads_and_writes_the_sankey_order() {
        let p: Preferences = serde_json::from_str(
            r#"{"dashboard":[{"id":"sankey","hidden":false}],"sankeyOrder":["cat:a","hub"]}"#,
        )
        .unwrap();
        assert_eq!(p.sankey_order.unwrap(), ["cat:a", "hub"]);
        assert_eq!(
            serde_json::from_str::<Preferences>("{}")
                .unwrap()
                .sankey_order,
            None
        );
        let order = vec!["x".to_string()];
        assert_eq!(
            serde_json::to_string(&SankeyOrderBody {
                sankey_order: &order
            })
            .unwrap(),
            r#"{"sankeyOrder":["x"]}"#
        );
    }

    #[test]
    fn reads_the_dashboard_layout_and_view() {
        let p: Preferences = serde_json::from_str(
            r#"{"dashboard":[{"id":"guilt-free","hidden":false,"span":12},{"id":"investments","hidden":true},
                {"id":"bills","span":6}],"sankeyView":"both"}"#,
        )
        .unwrap();
        let d = p.dashboard.as_ref().unwrap();
        assert_eq!(d.len(), 3);
        assert!(d[1].hidden && !d[2].hidden);
        assert_eq!(d[2].span, Some(Span::Half));
        assert_eq!(p.sankey_view, Some(SankeyView::Both));
        assert_eq!(
            serde_json::to_string(&Preferences {
                sankey_view: Some(SankeyView::Combined),
                ..Default::default()
            })
            .unwrap(),
            r#"{"sankeyView":"combined"}"#
        );
    }
}
