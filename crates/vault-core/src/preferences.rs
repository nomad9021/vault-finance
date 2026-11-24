//! The Sankey part of `UserPreferences` (packages/shared/src/schemas/user.ts).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// The person's own top-to-bottom order of Sankey nodes, shared by every diagram.
    #[serde(default)]
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
}
