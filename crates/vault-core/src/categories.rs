//! Mirrors packages/shared/src/schemas/categories.ts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CategoryKind {
    Expense,
    Income,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub color: String,
    pub parent_category_id: Option<String>,
    /// Manual display order among siblings; lower sorts first.
    pub sort_order: i64,
    pub kind: CategoryKind,
    pub is_system: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryListResponse {
    pub categories: Vec<Category>,
}

/// `CreateCategoryRequest` as the Income page sends it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCategoryBody {
    pub name: String,
    pub color: String,
    pub kind: CategoryKind,
}

/// `UpdateCategoryRequest` with just a new name.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameCategoryBody {
    pub name: String,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const SAMPLE: &str = r##"{
      "categories": [
        {"id":"7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","name":"Groceries","icon":"cart","color":"#3ecf8e",
         "parentCategoryId":null,"sortOrder":0,"kind":"expense","isSystem":false},
        {"id":"8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e","name":"Side Income","icon":null,"color":"#43cfc0",
         "parentCategoryId":null,"sortOrder":1,"kind":"income","isSystem":false},
        {"id":"9c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f","name":"Salary","icon":"briefcase","color":"#6f8ef2",
         "parentCategoryId":null,"sortOrder":1,"kind":"income","isSystem":true},
        {"id":"0d4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a","name":"Gifts","icon":null,"color":"#b47ef0",
         "parentCategoryId":null,"sortOrder":0,"kind":"income","isSystem":false}
      ]
    }"##;

    #[test]
    fn parses_server_shape() {
        let r: CategoryListResponse = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(r.categories.len(), 4);
        assert_eq!(r.categories[0].kind, CategoryKind::Expense);
        assert_eq!(r.categories[2].kind, CategoryKind::Income);
        assert!(r.categories[2].is_system);
        assert_eq!(r.categories[1].icon, None);
        assert_eq!(r.categories[3].sort_order, 0);
    }

    #[test]
    fn bodies_match_the_api() {
        let create = CreateCategoryBody {
            name: "New source".into(),
            color: "#3ecf8e".into(),
            kind: CategoryKind::Income,
        };
        assert_eq!(
            serde_json::to_string(&create).unwrap(),
            r##"{"name":"New source","color":"#3ecf8e","kind":"income"}"##
        );
        let rename = RenameCategoryBody { name: "Job".into() };
        assert_eq!(serde_json::to_string(&rename).unwrap(), r#"{"name":"Job"}"#);
    }
}
