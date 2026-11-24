//! `c.elicit`: asks the user of a 2026-07-28 MCP client for input while a command runs as a tool.
//!
//! MCP tool calls are stateless: a call that needs input stops the command and answers
//! `input_required`, and the client retries the call with the answer. The command reruns, and its
//! `n`th elicitation reads the answer keyed `elicit-n`. Earlier answers ride in `requestState`,
//! since a retry carries only the answers to the latest request.

use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::errors::Error;
use crate::schema::{self, Schema};
use crate::{js, parser};

/// How the user answered an elicitation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// The user submitted the form, or agreed to open the URL.
    Accept,
    /// The user declined.
    Decline,
    /// The user dismissed the request.
    Cancel,
}

/// The user's answer to an elicitation. It serializes as TypeScript's answer does.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Elicited<T> {
    /// How the user answered.
    pub action: Action,
    /// The submitted fields of an accepted form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<T>,
}

/// Asks the user of a 2026-07-28 MCP client for input while a command runs as a tool. Outside
/// MCP, and when the client does not support the mode, calls fail with `ELICITATION_UNSUPPORTED`.
#[derive(Clone, Debug, Default)]
pub struct Elicit(Arc<Mutex<State>>);

/// The answers one call carries and what it still needs.
#[derive(Debug, Default)]
struct State {
    /// The client's `elicitation` capability, or `None` outside 2026-07-28 MCP.
    declared: Option<Map<String, Value>>,
    /// Answers keyed by input request.
    responses: Map<String, Value>,
    /// The number of elicitations so far.
    index: usize,
    /// The `input_required` result the first unanswered elicitation produced.
    pending: Option<Value>,
}

impl Elicit {
    /// Creates elicitation for a 2026-07-28 tool call with the request's client capabilities and
    /// `params`.
    pub(crate) fn mcp(capabilities: Option<&Value>, params: &Map<String, Value>) -> Self {
        let declared = capabilities
            .and_then(|c| c.get("elicitation"))
            .and_then(Value::as_object)
            .cloned();
        let mut responses = Map::new();
        if let Some(Value::String(state)) = params.get("requestState")
            && let Ok(Value::Object(parsed)) = crate::json::parse(state)
        {
            responses = parsed;
        }
        // Like the SDK, drop input responses that are not bare result objects.
        if let Some(Value::Object(given)) = params.get("inputResponses") {
            for (key, entry) in given {
                if let Value::Object(entry_map) = entry
                    && !entry_map.contains_key("method")
                    && !entry_map.contains_key("result")
                {
                    responses.insert(key.clone(), entry.clone());
                }
            }
        }
        Self(Arc::new(Mutex::new(State {
            declared,
            responses,
            ..State::default()
        })))
    }

    /// The `input_required` result of a call that needs input.
    pub(crate) fn pending(&self) -> Option<Value> {
        self.state().pending.clone()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Asks for structured, non-sensitive input with a flat struct of primitive fields. Code
    /// before the call runs again on each retry.
    ///
    /// # Errors
    ///
    /// Returns `ELICITATION_UNSUPPORTED` when the client cannot answer, and `INPUT_REQUIRED` while
    /// the answer is pending. Return either with `?`.
    pub fn form<T: Schema + DeserializeOwned>(&self, message: &str) -> Result<Elicited<T>, Error> {
        let ty = T::schema();
        let json = schema::json_schema(&ty);
        let mut requested = Map::new();
        requested.insert("type".into(), "object".into());
        let properties = json.get("properties").cloned().unwrap_or_else(|| json!({}));
        // Clients may omit defaulted fields, as the input side of the schema allows.
        let required: Vec<Value> = json
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|key| {
                properties[key.as_str().unwrap_or_default()]
                    .get("default")
                    .is_none()
            })
            .cloned()
            .collect();
        requested.insert("properties".into(), properties);
        if !required.is_empty() {
            requested.insert("required".into(), required.into());
        }
        let params = json!({ "message": message, "requestedSchema": requested });
        self.ask("form", params, |action, response| {
            if action != Action::Accept {
                return Some(Elicited {
                    action,
                    content: None,
                });
            }
            let content = response.get("content")?.as_object()?;
            let parsed = parser::validate(&ty, content).ok()?;
            let content = serde_json::from_value(parsed).ok()?;
            Some(Elicited {
                action,
                content: Some(content),
            })
        })
    }

    /// Sends the user to a URL for input that must not pass through the client, such as
    /// credentials or payment. `Accept` means the user agreed to open it, not that the
    /// interaction finished.
    ///
    /// # Errors
    ///
    /// Returns `ELICITATION_UNSUPPORTED` when the client cannot answer, and `INPUT_REQUIRED` while
    /// the answer is pending.
    pub fn url(&self, message: &str, url: &str) -> Result<Elicited<()>, Error> {
        let params = json!({ "message": message, "url": url });
        self.ask("url", params, |action, _| {
            Some(Elicited {
                action,
                content: None,
            })
        })
    }

    fn ask<R>(
        &self,
        mode: &str,
        params: Value,
        read: impl FnOnce(Action, &Map<String, Value>) -> Option<R>,
    ) -> Result<R, Error> {
        let mut state = self.state();
        let key = format!("elicit-{}", state.index);
        state.index += 1;
        let supported = state.declared.as_ref().is_some_and(|declared| {
            declared.contains_key(mode) || (mode == "form" && !declared.contains_key("url"))
        });
        if !supported {
            return Err(Error::new(
                "ELICITATION_UNSUPPORTED",
                format!("Elicitation requires an MCP client that supports {mode} elicitation."),
            )
            .retryable(false));
        }
        let response = state
            .responses
            .get(&key)
            .and_then(Value::as_object)
            .cloned();
        let action = match response.as_ref().and_then(|r| r.get("action")) {
            Some(Value::String(action)) if action == "accept" => Some(Action::Accept),
            Some(Value::String(action)) if action == "decline" => Some(Action::Decline),
            Some(Value::String(action)) if action == "cancel" => Some(Action::Cancel),
            _ => None,
        };
        if let (Some(action), Some(response)) = (action, &response)
            && let Some(value) = read(action, response)
        {
            return Ok(value);
        }
        if state.pending.is_none() {
            let mut answered = Map::new();
            for i in 0..state.index - 1 {
                let earlier = format!("elicit-{i}");
                if let Some(value) = state.responses.get(&earlier) {
                    answered.insert(earlier, value.clone());
                }
            }
            let mut request = Map::new();
            request.insert("mode".into(), mode.into());
            if let Value::Object(params) = params {
                request.extend(params);
            }
            let mut pending = Map::new();
            pending.insert("resultType".into(), "input_required".into());
            let mut requests = Map::new();
            requests.insert(
                key,
                json!({ "method": "elicitation/create", "params": request }),
            );
            pending.insert("inputRequests".into(), requests.into());
            if !answered.is_empty() {
                pending.insert(
                    "requestState".into(),
                    js::stringify(&Value::Object(answered)).into(),
                );
            }
            state.pending = Some(Value::Object(pending));
        }
        Err(Error::new("INPUT_REQUIRED", "Waiting for the user to respond.").retryable(false))
    }
}
