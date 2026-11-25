//! Small serde helpers for zod shapes serde has no attribute for.

use std::fmt;
use std::marker::PhantomData;

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A JSON object kept in its key order, like a JS object read with
/// `Object.entries` (a repeated key keeps its first place, last value wins,
/// as `JSON.parse` does).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderedMap<V>(pub Vec<(String, V)>);

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<V> OrderedMap<V> {
    pub fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(k, _)| k.as_str())
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn insert(&mut self, key: String, value: V) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key, value)),
        }
    }
}

impl<V: Serialize> Serialize for OrderedMap<V> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for OrderedMap<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V2<V>(PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for V2<V> {
            type Value = OrderedMap<V>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut out = OrderedMap::default();
                while let Some((k, v)) = a.next_entry::<String, V>()? {
                    out.insert(k, v);
                }
                Ok(out)
            }
        }
        d.deserialize_map(V2(PhantomData))
    }
}

/// For zod `.nullable().optional()` fields where "left out" and `null` mean
/// different things (keep vs. clear): `None` = absent, `Some(None)` = null.
/// Use with `#[serde(default, deserialize_with = "serde_util::double_option",
/// skip_serializing_if = "Option::is_none")]`.
pub fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// JS `String.prototype.trim` (also strips U+FEFF, which `str::trim` keeps).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// JS `.length`: UTF-16 code units.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(0, n)` by UTF-16 code units (a split surrogate pair is dropped
/// whole rather than producing invalid UTF-8).
pub fn js_slice_to(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Patch {
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        v: Option<Option<String>>,
    }

    #[test]
    fn keeps_absent_and_null_apart() {
        let absent: Patch = serde_json::from_str("{}").unwrap();
        let null: Patch = serde_json::from_str(r#"{"v":null}"#).unwrap();
        let set: Patch = serde_json::from_str(r#"{"v":"x"}"#).unwrap();
        assert_eq!(absent.v, None);
        assert_eq!(null.v, Some(None));
        assert_eq!(set.v, Some(Some("x".into())));
        assert_eq!(serde_json::to_string(&absent).unwrap(), "{}");
        assert_eq!(serde_json::to_string(&null).unwrap(), r#"{"v":null}"#);
    }

    #[test]
    fn ordered_map_keeps_key_order() {
        let m: OrderedMap<u8> = serde_json::from_str(r#"{"z":1,"a":2,"z":3}"#).unwrap();
        assert_eq!(m.0, vec![("z".to_string(), 3), ("a".to_string(), 2)]);
        assert_eq!(serde_json::to_string(&m).unwrap(), r#"{"z":3,"a":2}"#);
        assert_eq!(m.get("a"), Some(&2));
    }

    #[test]
    fn js_strings() {
        assert_eq!(js_trim("\u{feff} a \n"), "a");
        assert_eq!(js_len("a😀"), 3);
        assert_eq!(js_slice_to("ab😀c", 3), "ab");
        assert_eq!(js_slice_to("ab😀c", 4), "ab😀");
        assert_eq!(js_slice_to("abc", 10), "abc");
    }
}
