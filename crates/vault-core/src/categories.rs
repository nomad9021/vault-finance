//! Mirrors packages/shared/src/schemas/categories.ts.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CategoryKind {
    Expense,
    Income,
}

impl CategoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Expense => "expense",
            Self::Income => "income",
        }
    }
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

/// `a.localeCompare(b)` for the names the app sorts: case is ignored first
/// (so "apple" sits beside "Apple"), then lower case comes before upper case,
/// as ICU's root collation orders plain text.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let fold = |s: &str| s.chars().flat_map(char::to_lowercase).collect::<String>();
    fold(a).cmp(&fold(b)).then_with(|| {
        for (x, y) in a.chars().zip(b.chars()) {
            if x != y {
                // Lower case first.
                return y.is_lowercase().cmp(&x.is_lowercase());
            }
        }
        a.len().cmp(&b.len())
    })
}

/// `a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)`.
pub fn sibling_order(a: &Category, b: &Category) -> Ordering {
    a.sort_order
        .cmp(&b.sort_order)
        .then_with(|| locale_compare(&a.name, &b.name))
}

/// `createCategory` body.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCategoryRequest {
    pub name: String,
    pub color: String,
    pub parent_category_id: Option<String>,
    pub kind: CategoryKind,
}

/// `updateCategory` body: only the fields set go over;
/// `parent_category_id: Some(None)` sends `null` (back to the top level).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCategoryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_category_id: Option<Option<String>>,
}

/// Where a drop lands relative to the row under the pointer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropZone {
    Before,
    After,
    Inside,
}

impl DropZone {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
            Self::Inside => "inside",
        }
    }
}

/// The arranger's zones: the top and bottom 30% of a row place before and
/// after it, the middle tucks inside.
pub fn arranger_zone(top: f64, bottom: f64, y: f64) -> DropZone {
    let h = bottom - top;
    if y < top + h * 0.3 {
        DropZone::Before
    } else if y > bottom - h * 0.3 {
        DropZone::After
    } else {
        DropZone::Inside
    }
}

/// Children of `parent` of one kind, in sibling order.
pub fn children_of<'a>(
    all: &'a [Category],
    parent: Option<&str>,
    kind: CategoryKind,
) -> Vec<&'a Category> {
    let mut v: Vec<&Category> = all
        .iter()
        .filter(|c| c.parent_category_id.as_deref() == parent && c.kind == kind)
        .collect();
    v.sort_by(|a, b| sibling_order(a, b));
    v
}

/// `id` is `ancestor` or somewhere inside it (50 levels at most, so a
/// corrupt cycle can't hang).
pub fn is_within(all: &[Category], id: Option<&str>, ancestor: &str) -> bool {
    let by_id = |id: &str| all.iter().find(|c| c.id == id);
    let mut cur = id.and_then(by_id);
    let mut n = 0;
    while let Some(c) = cur {
        if n >= 50 {
            break;
        }
        if c.id == ancestor {
            return true;
        }
        cur = c.parent_category_id.as_deref().and_then(by_id);
        n += 1;
    }
    false
}

/// Whether `drag` may be dropped on `target` (a category id, or
/// "top:<kind>" for the back-to-top-level strip): same kind, and never
/// inside itself.
pub fn can_drop(all: &[Category], drag: &str, target: &str, zone: DropZone) -> bool {
    let d = all.iter().find(|c| c.id == drag);
    if let Some(kind) = target.strip_prefix("top:") {
        return d.is_some_and(|d| d.kind.as_str() == kind);
    }
    let t = all.iter().find(|c| c.id == target);
    let (Some(d), Some(t)) = (d, t) else {
        return false;
    };
    if d.kind != t.kind {
        return false;
    }
    let parent = if zone == DropZone::Inside {
        Some(t.id.as_str())
    } else {
        t.parent_category_id.as_deref()
    };
    !is_within(all, parent, &d.id)
}

/// Move `id` to before/after `target` in a flat list of ids.
pub fn reorder(ids: &[String], id: &str, target: &str, after: bool) -> Vec<String> {
    if id == target {
        return ids.to_vec();
    }
    let mut rest: Vec<String> = ids.iter().filter(|x| *x != id).cloned().collect();
    let Some(at) = rest.iter().position(|x| x == target) else {
        return ids.to_vec();
    };
    rest.insert(if after { at + 1 } else { at }, id.to_string());
    rest
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

#[cfg(test)]
mod arranger_tests {
    use super::*;

    #[test]
    fn compares_names_like_locale_compare() {
        assert_eq!(locale_compare("apple", "Banana"), Ordering::Less);
        assert_eq!(locale_compare("Banana", "apple"), Ordering::Greater);
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
        assert_eq!(locale_compare("Food", "Food"), Ordering::Equal);
        assert_eq!(locale_compare("Food", "Food & drink"), Ordering::Less);
    }

    fn c(id: &str, parent: Option<&str>, kind: CategoryKind, order: i64) -> Category {
        Category {
            id: id.into(),
            name: id.into(),
            icon: None,
            color: "#888888".into(),
            parent_category_id: parent.map(Into::into),
            sort_order: order,
            kind,
            is_system: false,
        }
    }

    #[test]
    fn arranges_the_tree() {
        use CategoryKind::*;
        let all = vec![
            c("food", None, Expense, 1),
            c("rent", None, Expense, 0),
            c("groc", Some("food"), Expense, 0),
            c("pay", None, Income, 0),
        ];
        let ids = |v: Vec<&Category>| v.into_iter().map(|c| c.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(children_of(&all, None, Expense)), ["rent", "food"]);
        assert_eq!(ids(children_of(&all, None, Income)), ["pay"]);
        assert!(is_within(&all, Some("groc"), "food"));
        assert!(!is_within(&all, Some("rent"), "food"));
        assert!(!is_within(&all, None, "food"));
        // Not into its own subtree, not across kinds.
        assert!(!can_drop(&all, "food", "groc", DropZone::Inside));
        assert!(!can_drop(&all, "food", "groc", DropZone::Before));
        assert!(can_drop(&all, "groc", "rent", DropZone::Inside));
        assert!(!can_drop(&all, "pay", "rent", DropZone::Before));
        assert!(can_drop(&all, "groc", "top:expense", DropZone::Before));
        assert!(!can_drop(&all, "groc", "top:income", DropZone::Before));

        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            reorder(&s(&["a", "b", "c"]), "c", "a", false),
            s(&["c", "a", "b"])
        );
        assert_eq!(
            reorder(&s(&["a", "b", "c"]), "a", "b", true),
            s(&["b", "a", "c"])
        );
        assert_eq!(reorder(&s(&["a", "b"]), "a", "x", true), s(&["a", "b"]));

        assert_eq!(arranger_zone(0.0, 100.0, 10.0), DropZone::Before);
        assert_eq!(arranger_zone(0.0, 100.0, 50.0), DropZone::Inside);
        assert_eq!(arranger_zone(0.0, 100.0, 90.0), DropZone::After);
    }

    #[test]
    fn sends_only_what_changed() {
        let to_top = UpdateCategoryRequest {
            parent_category_id: Some(None),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&to_top).unwrap(),
            r#"{"parentCategoryId":null}"#
        );
        let rename = UpdateCategoryRequest {
            name: Some("Food".into()),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&rename).unwrap(),
            r#"{"name":"Food"}"#
        );
    }
}
