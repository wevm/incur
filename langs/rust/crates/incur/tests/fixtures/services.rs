//! Mirror of the fixture plumbing in `fixtures.ts`: the fake network, the upstream API, the fake
//! MCP server, and the OpenAPI documents.

use incur::{Body, Error};
use serde_json::{Map, Value, json};

/// A response with a body and headers.
fn respond(status: u16, headers: &[(&str, &str)], body: Body) -> http::Response<Body> {
    let mut builder = http::Response::builder().status(status);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(body).unwrap()
}

/// A JSON response, as the fixture's `json` helper builds.
fn json_response(value: &Value, status: u16) -> http::Response<Body> {
    respond(
        status,
        &[("content-type", "application/json")],
        Body::from(value.to_string()),
    )
}

/// A text response, which the Fetch API labels as UTF-8 text.
fn text_response(text: &'static str, status: u16) -> http::Response<Body> {
    respond(
        status,
        &[("content-type", "text/plain;charset=UTF-8")],
        Body::from(text),
    )
}

/// Returns the URL of a request as host, path, and decoded query pairs.
fn parts(request: &http::Request<Body>) -> (String, String, Vec<(String, String)>) {
    let uri = request.uri();
    let host = uri
        .authority()
        .map(|a| a.as_str().to_owned())
        .unwrap_or_default();
    let query = uri
        .query()
        .map(|q| {
            q.split('&')
                .filter(|p| !p.is_empty())
                .map(|pair| {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    (decode(k), decode(v))
                })
                .collect()
        })
        .unwrap_or_default();
    (host, uri.path().to_owned(), query)
}

/// Decodes a form-encoded component.
fn decode(text: &str) -> String {
    let bytes = text.replace('+', " ").into_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match hex {
            Some(byte) if bytes[i] == b'%' => {
                out.push(byte);
                i += 3;
            }
            _ => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The fake network every outgoing request lands on: `hosted.test` reaches the upstream API,
/// `registry.test` is a fake npm registry, and other hosts fail.
pub(crate) async fn network(request: http::Request<Body>) -> Result<http::Response<Body>, Error> {
    let (host, path, _) = parts(&request);
    if host == "hosted.test" {
        return upstream(request).await;
    }
    if host == "registry.test" {
        let name = decode(&path[1..]);
        if name == "missing" {
            return Ok(text_response("Not Found", 404));
        }
        let latest = if name == "stale" { "0.1.0" } else { "2.0.0" };
        return Ok(json_response(
            &json!({ "name": name, "dist-tags": { "latest": latest } }),
            200,
        ));
    }
    Err(Error::from("fetch failed"))
}

/// The upstream API behind fetch-backed and OpenAPI commands. Routes on the last path segment;
/// unknown routes echo the request.
pub(crate) async fn upstream(request: http::Request<Body>) -> Result<http::Response<Body>, Error> {
    let (_, path, query) = parts(&request);
    let route = path.rsplit('/').next().unwrap_or_default().to_owned();
    Ok(match route.as_str() {
        "openapi.json" => json_response(&mini_spec(), 200),
        "users" => json_response(
            &json!({ "users": [
                { "name": "Alice", "email": "alice@example.com", "role": "admin" },
                { "name": "Bob", "email": "bob@example.com", "role": "user" },
                { "name": "Carol", "email": "carol@example.com", "role": "user" },
            ] }),
            200,
        ),
        "text" => text_response("plain text body", 200),
        "fail" => json_response(
            &json!({ "error": { "code": "NOT_FOUND", "message": "No such thing" } }),
            404,
        ),
        "bad" => json_response(
            &json!({ "message": "Bad input", "error": { "code": 7 } }),
            400,
        ),
        "bad-object" => json_response(&json!({ "message": { "detail": "Bad input" } }), 422),
        "boom" => text_response("Internal failure", 500),
        "down" => json_response(&json!({ "status": "down" }), 503),
        "empty" => respond(204, &[], Body::empty()),
        "stream" => respond(
            200,
            &[("content-type", "application/x-ndjson")],
            Body::from("{\"n\":1}\n\nnot json\n{\"n\":2}\n{\"n\":3}"),
        ),
        "sse" => respond(
            200,
            &[("content-type", "text/event-stream")],
            Body::from("data: {\"n\":1}\n\n"),
        ),
        _ => {
            let method = request.method().to_string();
            let mut headers: Vec<(String, String)> = Vec::new();
            for (name, value) in request.headers() {
                let value = value.to_str().unwrap_or_default().to_owned();
                match headers.iter_mut().find(|(n, _)| n == name.as_str()) {
                    Some((_, existing)) => {
                        existing.push_str(", ");
                        existing.push_str(&value);
                    }
                    None => headers.push((name.as_str().to_owned(), value)),
                }
            }
            headers.sort_by(|a, b| a.0.cmp(&b.0));
            let text = request.into_body().text().await;
            let body = if text.is_empty() {
                Value::Null
            } else {
                serde_json::from_str(&text).unwrap_or(Value::String(text))
            };
            let mut search = Map::new();
            for (key, value) in query {
                search.insert(key, Value::String(value));
            }
            let headers = headers
                .into_iter()
                .map(|(k, v)| (k, Value::String(v)))
                .collect::<Map<_, _>>();
            json_response(
                &json!({
                    "method": method,
                    "path": path,
                    "query": search,
                    "headers": headers,
                    "body": body,
                }),
                200,
            )
        }
    })
}

/// A one-operation OpenAPI document served by the upstream API at any `openapi.json`.
pub(crate) fn mini_spec() -> Value {
    json!({
        "openapi": "3.1.0",
        "info": { "title": "Mini", "version": "1.0.0" },
        "paths": {
            "/ping": { "get": { "operationId": "ping", "summary": "Ping the API" } },
            "/ping/{id}": {
                "post": {
                    "operationId": "pingOne",
                    "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }],
                },
            },
        },
    })
}

/// Request bodies composed with `oneOf`, `anyOf`, and `allOf`, flattened into options.
pub(crate) fn composed_spec() -> Value {
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Composed",
            "version": "1.0.0"
        },
        "components": {
            "securitySchemes": {},
            "schemas": {
                "Ref": {
                    "type": "object",
                    "properties": {
                        "ref": {
                            "type": "string",
                            "description": "Git ref"
                        }
                    }
                },
                "Node": {
                    "type": "object",
                    "properties": {
                        "label": {
                            "type": "string"
                        }
                    },
                    "allOf": [
                        {
                            "$ref": "#/components/schemas/Node"
                        }
                    ]
                },
                "Left": {
                    "properties": {
                        "left": {
                            "type": "string"
                        }
                    },
                    "allOf": [
                        {
                            "$ref": "#/components/schemas/Right"
                        }
                    ]
                },
                "Right": {
                    "properties": {
                        "right": {
                            "type": "string"
                        }
                    },
                    "allOf": [
                        {
                            "$ref": "#/components/schemas/Left"
                        }
                    ]
                }
            }
        },
        "paths": {
            "/events": {
                "post": {
                    "operationId": "createEvent",
                    "summary": "Create an event",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "oneOf": [
                                        {
                                            "allOf": [
                                                {
                                                    "$ref": "#/components/schemas/Ref"
                                                },
                                                {
                                                    "properties": {
                                                        "kind": {
                                                            "const": "push"
                                                        },
                                                        "at": {
                                                            "type": "string"
                                                        },
                                                        "version": {
                                                            "const": 1
                                                        },
                                                        "meta": {
                                                            "const": null
                                                        }
                                                    },
                                                    "required": [
                                                        "kind",
                                                        "ref"
                                                    ]
                                                }
                                            ]
                                        },
                                        {
                                            "type": "object",
                                            "properties": {
                                                "kind": {
                                                    "const": "tag"
                                                },
                                                "name": {
                                                    "type": "string"
                                                },
                                                "at": {
                                                    "type": "integer"
                                                },
                                                "version": {
                                                    "const": 2
                                                },
                                                "meta": {
                                                    "const": "x"
                                                }
                                            },
                                            "required": [
                                                "kind",
                                                "name"
                                            ]
                                        },
                                        {
                                            "type": "string"
                                        },
                                        true
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            "/items": {
                "post": {
                    "operationId": "createItem",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "id": {
                                            "type": "string",
                                            "description": "Item id"
                                        },
                                        "qty": {
                                            "type": "integer"
                                        }
                                    },
                                    "allOf": [
                                        {
                                            "type": "object",
                                            "properties": {
                                                "id": {
                                                    "type": "string"
                                                },
                                                "qty": {
                                                    "type": "integer",
                                                    "minimum": 1
                                                }
                                            },
                                            "required": [
                                                "id"
                                            ]
                                        },
                                        {
                                            "type": "object",
                                            "properties": {
                                                "note": {
                                                    "type": "string"
                                                }
                                            }
                                        },
                                        true
                                    ],
                                    "anyOf": [
                                        {
                                            "type": [
                                                "object",
                                                "null"
                                            ],
                                            "properties": {
                                                "count": {
                                                    "type": "integer"
                                                }
                                            }
                                        },
                                        {
                                            "type": "object",
                                            "properties": {
                                                "count": {
                                                    "type": "integer"
                                                }
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            "/policy": {
                "put": {
                    "operationId": "setPolicy",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "anyOf": [
                                        {
                                            "type": "object",
                                            "properties": {
                                                "enabled": {
                                                    "const": false
                                                }
                                            },
                                            "required": [
                                                "enabled"
                                            ]
                                        },
                                        {
                                            "type": "object",
                                            "properties": {
                                                "enabled": {
                                                    "const": true
                                                },
                                                "limit": {
                                                    "type": "integer",
                                                    "default": 10
                                                }
                                            },
                                            "required": [
                                                "enabled",
                                                "limit"
                                            ]
                                        }
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            "/rpc": {
                "post": {
                    "operationId": "rpc",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "anyOf": [
                                        {
                                            "type": "object",
                                            "properties": {
                                                "method": {
                                                    "type": "string"
                                                },
                                                "params": {
                                                    "type": "array"
                                                }
                                            },
                                            "required": [
                                                "method"
                                            ]
                                        },
                                        {
                                            "type": "array",
                                            "items": {
                                                "type": "object"
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            "/nodes": {
                "post": {
                    "operationId": "createNode",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "$ref": "#/components/schemas/Node"
                                }
                            }
                        }
                    }
                }
            },
            "/pair": {
                "post": {
                    "operationId": "createPair",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "allOf": [
                                        {
                                            "$ref": "#/components/schemas/Left"
                                        },
                                        {
                                            "$ref": "#/components/schemas/Right"
                                        },
                                        {
                                            "$ref": "#/components/schemas/Ref"
                                        },
                                        {
                                            "$ref": "#/components/schemas/Ref"
                                        }
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            "/notes": {
                "post": {
                    "operationId": "createNote",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "text": {
                                            "type": "string",
                                            "description": "Note text"
                                        },
                                        "tag": {
                                            "type": "string",
                                            "description": "Tag"
                                        }
                                    },
                                    "required": [
                                        "text"
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            "/flex": {
                "patch": {
                    "operationId": "updateFlex",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "note": {
                                            "type": "string"
                                        }
                                    },
                                    "anyOf": [
                                        {
                                            "type": "object",
                                            "properties": {
                                                "kind": {
                                                    "type": "string"
                                                }
                                            },
                                            "required": [
                                                "kind"
                                            ]
                                        },
                                        true
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            "/stock": {
                "put": {
                    "operationId": "setStock",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "qty": {
                                            "type": "integer",
                                            "default": 5
                                        },
                                        "level": {
                                            "type": "string",
                                            "default": "low"
                                        },
                                        "mode": {
                                            "enum": [
                                                "auto",
                                                "manual"
                                            ],
                                            "default": "auto"
                                        }
                                    },
                                    "required": [
                                        "qty"
                                    ],
                                    "allOf": [
                                        {
                                            "properties": {
                                                "qty": {
                                                    "type": "integer",
                                                    "minimum": 1
                                                },
                                                "level": {
                                                    "type": "string",
                                                    "default": "high"
                                                },
                                                "mode": {
                                                    "type": "string"
                                                }
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            "/raw": {
                "post": {
                    "operationId": "raw",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "oneOf": [
                                        {
                                            "type": "array"
                                        },
                                        {
                                            "type": "string"
                                        },
                                        false
                                    ]
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

/// An OpenAPI document covering parameters, bodies, security, refs, and versions.
pub(crate) fn pet_spec() -> Value {
    let pet_id = json!({
        "name": "petId",
        "in": "path",
        "required": true,
        "description": "Pet id",
        "schema": { "type": "integer" },
    });
    json!({
        "openapi": "3.1.0",
        "info": { "title": "Pets", "version": "1.0.0" },
        "security": [{ "apiKey": [] }],
        "components": {
            "securitySchemes": {
                "apiKey": { "type": "apiKey", "in": "header", "name": "X-Api-Key", "description": "API key" },
                "bearer": { "type": "http", "scheme": "bearer" },
                "basic": { "type": "http", "scheme": "Basic", "description": "Basic credentials" },
                "query": { "type": "apiKey", "in": "query", "name": "key" },
                "oauth": { "type": "oauth2" },
            },
            "schemas": {
                "Pet": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Pet name" },
                        "age": { "type": "integer", "minimum": 0 },
                        "tags": { "type": "array", "items": { "type": "string" } },
                        "owner": { "type": "object", "properties": { "id": { "type": "string" } } },
                    },
                    "required": ["name"],
                },
            },
            "parameters": {
                "Limit": {
                    "name": "limit",
                    "in": "query",
                    "description": "Max results",
                    "schema": { "type": "integer", "minimum": 1, "maximum": 50 },
                },
            },
        },
        "paths": {
            "/": { "get": { "operationId": "index", "summary": "API index" } },
            "/pets": {
                "get": {
                    "operationId": "listPets",
                    "summary": "List pets",
                    "description": "Lists every pet in the store.",
                    "parameters": [
                        { "$ref": "#/components/parameters/Limit" },
                        {
                            "name": "status",
                            "in": "query",
                            "required": true,
                            "schema": { "type": "string", "enum": ["available", "sold"] },
                        },
                        { "name": "vaccinated", "in": "query", "schema": { "type": "boolean" } },
                        { "name": "X-Trace", "in": "header", "description": "Trace id", "schema": { "type": "string" } },
                    ],
                },
                "post": {
                    "operationId": "createPet",
                    "summary": "Create a pet",
                    "security": [{ "bearer": [] }],
                    "requestBody": {
                        "required": true,
                        "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Pet" } } },
                    },
                },
            },
            "/pets/{petId}": {
                "get": { "operationId": "getPet", "summary": "Get a pet", "parameters": [pet_id] },
                "delete": { "operationId": "deletePet", "parameters": [pet_id], "security": [] },
                "put": {
                    "summary": "Replace a pet",
                    "parameters": [pet_id],
                    "security": [{ "basic": [] }, { "query": [] }, { "oauth": [] }, { "unknown": [] }],
                    "requestBody": {
                        "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Pet" } } },
                    },
                },
            },
            "/pets/{petId}/fail": { "get": { "operationId": "failPet", "parameters": [pet_id] } },
            "/store/text": { "get": { "operationId": "storeText", "description": "Plain text" } },
            "/store/bad": {
                "post": { "operationId": "storeBad", "summary": "Rejected", "description": "Rejected" },
            },
            "/store/boom": { "post": { "operationId": "storeBoom" } },
            "/search": {
                "get": {
                    "operationId": "search",
                    "summary": "Search",
                    "parameters": [
                        {
                            "name": "q",
                            "in": "query",
                            "required": true,
                            "schema": { "type": "string", "pattern": format!("^{}$", "[a-z]".repeat(40)), "example": "abc" },
                        },
                        { "name": "since", "in": "query", "schema": { "type": "string", "format": "date-time" } },
                        { "name": "score", "in": "query", "schema": { "type": ["number", "null"] } },
                    ],
                },
            },
            "/v1/users": { "get": { "operationId": "listUsersV1", "summary": "List users (v1)" } },
            "/v2/users": { "get": { "operationId": "listUsersV2", "summary": "List users (v2)" } },
            "/v2/users/{id}": {
                "patch": {
                    "operationId": "updateUser",
                    "summary": "Update a user",
                    "parameters": [
                        { "name": "id", "in": "path", "required": true, "schema": { "type": "string" } },
                        { "name": "limit", "in": "query", "schema": { "type": "integer" } },
                        { "name": "limit", "in": "header", "required": true, "schema": { "type": "string" } },
                        { "name": "Limit", "in": "header", "schema": { "type": "string" } },
                    ],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "header-limit": { "type": "string" },
                                        "active": { "type": "boolean", "description": "Active flag" },
                                    },
                                    "required": ["active"],
                                },
                            },
                        },
                    },
                },
            },
        },
    })
}

/// A fake streamable-HTTP MCP server with canned tool results.
pub(crate) async fn fake_mcp(request: http::Request<Body>) -> Result<http::Response<Body>, Error> {
    let headers = request.headers().clone();
    let message: Value = serde_json::from_str(&request.into_body().text().await).unwrap();
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let reply = |result: Value, extra: &[(&str, &str)]| {
        let mut all = vec![("content-type", "application/json")];
        all.extend_from_slice(extra);
        let mut body = Map::new();
        body.insert("jsonrpc".into(), "2.0".into());
        if !id.is_null() {
            body.insert("id".into(), id.clone());
        }
        body.insert("result".into(), result);
        respond(200, &all, Body::from(Value::Object(body).to_string()))
    };
    let text = |items: &[&str]| {
        reply(
            json!({ "content": items.iter().map(|t| json!({ "type": "text", "text": t })).collect::<Vec<_>>() }),
            &[],
        )
    };
    let method = message["method"].as_str().unwrap_or_default();
    match method {
        "initialize" => {
            return Ok(reply(
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "fake", "version": "1.0.0" },
                }),
                &[("mcp-session-id", "fake-session")],
            ));
        }
        "notifications/initialized" => return Ok(respond(202, &[], Body::empty())),
        "tools/list" => {
            return Ok(reply(
                json!({ "tools": [
                    {
                        "name": "structured",
                        "description": "Structured result",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "count": { "type": "integer", "description": "Count" },
                                "label": { "type": "string" },
                                "on": { "type": "boolean" },
                                "ratio": { "type": ["number", "null"] },
                                "tags": { "type": ["array", "null"], "items": { "type": "string" } },
                            },
                            "required": ["count"],
                        },
                        "outputSchema": { "type": "object", "properties": { "total": { "type": "number" } } },
                        "annotations": { "readOnlyHint": true },
                    },
                    { "name": "headers", "description": "Echo MCP headers" },
                    { "name": "texts", "description": "Two text items", "outputSchema": { "type": "string" } },
                    { "name": "words", "description": "Non-JSON text" },
                    { "name": "none", "description": "No content" },
                    { "name": "tool-error", "description": "Tool error result" },
                    { "name": "silent-error", "description": "Tool error without text" },
                    { "name": "rpc-error", "description": "JSON-RPC error" },
                    { "name": "http-error", "description": "HTTP error" },
                    { "name": "sse", "description": "SSE response" },
                    { "name": "sse-other", "description": "SSE without a matching message" },
                    { "name": "empty-body", "description": "Empty response body" },
                ] }),
                &[],
            ));
        }
        _ => {}
    }
    let args = message
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map_or(Value::Null, |v| Value::String(v.to_owned()))
    };
    Ok(match message.pointer("/params/name").and_then(Value::as_str) {
        Some("structured") => {
            let count = match &args["count"] {
                Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
                Value::String(s) => s.trim().parse().unwrap_or(f64::NAN),
                _ => f64::NAN,
            };
            let total = count * 2.0;
            #[expect(clippy::cast_possible_truncation, reason = "Whole totals are small.")]
            let total = if !total.is_finite() {
                Value::Null
            } else if total.fract() == 0.0 {
                json!(total as i64)
            } else {
                json!(total)
            };
            reply(
                json!({
                    "content": [{ "type": "text", "text": "ignored" }],
                    "structuredContent": { "total": total, "args": args },
                }),
                &[],
            )
        }
        Some("headers") => text(&[&json!({
            "session": header("mcp-session-id"),
            "version": header("mcp-protocol-version"),
            "custom": header("x-custom"),
            "accept": header("accept"),
        })
        .to_string()]),
        Some("texts") => text(&["first", "second"]),
        Some("words") => text(&["just words"]),
        Some("none") => reply(json!({}), &[]),
        Some("tool-error") => reply(
            json!({ "content": [{ "type": "text", "text": "remote failed" }], "isError": true }),
            &[],
        ),
        Some("silent-error") => reply(
            json!({ "content": [{ "type": "image", "data": "" }], "isError": true }),
            &[],
        ),
        Some("rpc-error") => respond(
            200,
            &[("content-type", "application/json")],
            Body::from(
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "rpc failed" } })
                    .to_string(),
            ),
        ),
        Some("http-error") => text_response("unavailable", 503),
        Some("sse") => {
            let result = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "content": [{ "type": "text", "text": "{\"via\":\"sse\"}" }] },
            });
            respond(
                200,
                &[("content-type", "text/event-stream")],
                Body::from(format!(
                    "event: message\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}}\n\ndata: {result}\n\n"
                )),
            )
        }
        Some("sse-other") => respond(
            200,
            &[("content-type", "text/event-stream")],
            Body::from("data: {\"jsonrpc\":\"2.0\",\"id\":\"other\",\"result\":{}}\n\n"),
        ),
        _ => respond(200, &[("content-type", "application/json")], Body::empty()),
    })
}
