//! Output filtering with `--filter-output` key paths such as `foo,bar.baz,a[0,3]`.

use serde_json::{Map, Value};

use crate::js;

/// One step of a filter path.
#[derive(Clone, Debug, PartialEq)]
pub enum Segment {
    /// An object key.
    Key(String),
    /// An array slice from `start` (inclusive) to `end` (exclusive).
    Slice {
        /// End index.
        end: f64,
        /// Start index.
        start: f64,
    },
}

/// Parses a filter expression into paths.
pub fn parse(expression: &str) -> Vec<Vec<Segment>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    for ch in expression.chars() {
        match ch {
            '[' => depth += 1,
            ']' => depth -= 1,
            _ => {}
        }
        if ch == ',' && depth == 0 {
            tokens.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }

    let keys = |text: &str, path: &mut Vec<Segment>| {
        for part in text.split('.').filter(|part| !part.is_empty()) {
            path.push(Segment::Key(part.to_owned()));
        }
    };
    tokens
        .iter()
        .map(|token| {
            let mut path = Vec::new();
            let mut remaining = token.as_str();
            while !remaining.is_empty() {
                let Some(open) = remaining.find('[') else {
                    keys(remaining, &mut path);
                    break;
                };
                keys(&remaining[..open], &mut path);
                let close = remaining[open..].find(']').map(|i| open + i);
                let inner = &remaining[open + 1..close.unwrap_or(remaining.len())];
                let mut bounds = inner.split(',');
                let start = js::to_number(bounds.next().unwrap_or_default());
                let end = bounds.next().map_or(f64::NAN, js::to_number);
                path.push(Segment::Slice { end, start });
                remaining = close.map_or("", |close| &remaining[close + 1..]);
                remaining = remaining.strip_prefix('.').unwrap_or(remaining);
            }
            path
        })
        .collect()
}

/// Applies filter paths to a value and returns the filtered copy. `None` means `undefined`.
pub fn apply(data: &Value, paths: &[Vec<Segment>]) -> Option<Value> {
    if paths.is_empty() {
        return Some(data.clone());
    }
    if let [path] = paths
        && let [Segment::Key(key)] = path.as_slice()
    {
        return match data {
            Value::Array(items) => Some(Value::Array(
                items
                    .iter()
                    .map(|item| apply(item, paths).unwrap_or(Value::Null))
                    .collect(),
            )),
            Value::Object(_) => match get(data, key) {
                Some(value @ (Value::Object(_) | Value::Array(_))) => {
                    let mut out = Map::new();
                    out.insert(key.clone(), value);
                    Some(Value::Object(out))
                }
                value => value,
            },
            _ => None,
        };
    }
    if let Value::Array(items) = data {
        return Some(Value::Array(
            items
                .iter()
                .map(|item| apply(item, paths).unwrap_or(Value::Null))
                .collect(),
        ));
    }
    let mut out = Value::Object(Map::new());
    for path in paths {
        merge(&mut out, data, path, 0);
    }
    Some(out)
}

/// Slices an array as `Array.prototype.slice` does.
fn slice(items: &[Value], start: f64, end: f64) -> Vec<Value> {
    let from = js::relative_index(start, items.len());
    let to = js::relative_index(end, items.len());
    items.get(from..to.max(from)).unwrap_or_default().to_vec()
}

/// Copies the value at `segments[index..]` from `data` into `target`, an object or array.
fn merge(target: &mut Value, data: &Value, segments: &[Segment], index: usize) {
    let Some(Segment::Key(key)) = segments.get(index) else {
        return;
    };
    let Some(value) = get(data, key) else {
        return;
    };
    match segments.get(index + 1) {
        None => set(target, key, value),
        Some(Segment::Slice { end, start }) => {
            let Value::Array(items) = &value else {
                return;
            };
            let sliced = slice(items, *start, *end);
            if index + 2 >= segments.len() {
                set(target, key, Value::Array(sliced));
                return;
            }
            let mapped = sliced
                .iter()
                .map(|item| {
                    let mut sub = Value::Object(Map::new());
                    merge(&mut sub, item, segments, index + 2);
                    sub
                })
                .collect();
            set(target, key, Value::Array(mapped));
        }
        Some(Segment::Key(_)) => {
            if !value.is_object() && !value.is_array() {
                return;
            }
            // Existing objects and arrays are reused; anything else is replaced.
            if !get_mut(target, key).is_some_and(|entry| entry.is_object() || entry.is_array()) {
                set(target, key, Value::Object(Map::new()));
            }
            if let Some(entry) = get_mut(target, key) {
                merge(entry, &value, segments, index + 1);
            }
        }
    }
}

/// Reads a property as JavaScript does: object keys, and the indices and `length` of arrays.
fn get(data: &Value, key: &str) -> Option<Value> {
    match data {
        Value::Array(items) if key == "length" => Some(items.len().into()),
        Value::Array(items) => index(key).and_then(|index| items.get(index)).cloned(),
        data => data.get(key).cloned(),
    }
}

/// Returns a mutable object property or array element.
fn get_mut<'a>(target: &'a mut Value, key: &str) -> Option<&'a mut Value> {
    match target {
        Value::Array(items) => index(key).and_then(|index| items.get_mut(index)),
        target => target.get_mut(key),
    }
}

/// Writes a property as JavaScript does. Arrays take indices, filling holes with `null`, and
/// `length`; other array properties are not serialized, so they are dropped.
fn set(target: &mut Value, key: &str, value: Value) {
    let Value::Array(items) = target else {
        // `merge` writes only into objects and arrays.
        target
            .as_object_mut()
            .map(|map| map.insert(key.to_owned(), value));
        return;
    };
    if let Some(index) = index(key) {
        if items.len() <= index {
            items.resize(index + 1, Value::Null);
        }
        if let Some(item) = items.get_mut(index) {
            *item = value;
        }
    } else if key == "length"
        && let Some(len) = value.as_u64().and_then(|len| usize::try_from(len).ok())
    {
        items.resize(len, Value::Null);
    }
}

/// Parses a canonical array index.
fn index(key: &str) -> Option<usize> {
    js::array_index(key).and_then(|index| usize::try_from(index).ok())
}
