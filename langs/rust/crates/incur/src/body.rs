//! HTTP bodies for [`Cli::fetch`](crate::Cli::fetch) and fetch handlers.

use std::convert::Infallible;
use std::fmt;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Bytes, BytesMut};
use futures_core::Stream;
use http_body::Frame;

/// An HTTP body: complete bytes or a stream of chunks.
///
/// It implements [`http_body::Body`], so responses from [`Cli::fetch`](crate::Cli::fetch) plug
/// into hyper, axum, and other servers built on the `http` crate.
pub struct Body(Inner);

/// The representation of a [`Body`].
enum Inner {
    /// Complete bytes, taken once read.
    Full(Option<Bytes>),
    /// Chunks produced over time.
    Stream(Pin<Box<dyn Stream<Item = Bytes> + Send>>),
}

impl Body {
    /// Creates an empty body.
    pub fn empty() -> Self {
        Self(Inner::Full(None))
    }

    /// Creates a body from a stream of chunks.
    pub fn stream<S>(chunks: S) -> Self
    where
        S: Stream<Item = Bytes> + Send + 'static,
    {
        Self(Inner::Stream(Box::pin(chunks)))
    }

    /// Reads the whole body.
    pub async fn bytes(self) -> Bytes {
        collect(self).await.unwrap_or_default()
    }

    /// Reads the whole body as UTF-8 text, replacing invalid sequences.
    pub async fn text(self) -> String {
        String::from_utf8_lossy(&self.bytes().await).into_owned()
    }
}

impl Default for Body {
    fn default() -> Self {
        Self::empty()
    }
}

impl fmt::Debug for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            Inner::Full(bytes) => f.debug_tuple("Body").field(bytes).finish(),
            Inner::Stream(_) => f.write_str("Body(Stream)"),
        }
    }
}

impl From<Bytes> for Body {
    fn from(bytes: Bytes) -> Self {
        Self(Inner::Full((!bytes.is_empty()).then_some(bytes)))
    }
}

impl From<String> for Body {
    fn from(text: String) -> Self {
        Bytes::from(text).into()
    }
}

impl From<&'static str> for Body {
    fn from(text: &'static str) -> Self {
        Bytes::from_static(text.as_bytes()).into()
    }
}

impl From<Vec<u8>> for Body {
    fn from(bytes: Vec<u8>) -> Self {
        Bytes::from(bytes).into()
    }
}

impl http_body::Body for Body {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        match &mut self.0 {
            Inner::Full(bytes) => Poll::Ready(bytes.take().map(|bytes| Ok(Frame::data(bytes)))),
            Inner::Stream(chunks) => chunks
                .as_mut()
                .poll_next(cx)
                .map(|chunk| chunk.map(|bytes| Ok(Frame::data(bytes)))),
        }
    }

    fn is_end_stream(&self) -> bool {
        matches!(self.0, Inner::Full(None))
    }
}

/// Reads every data frame of a body.
///
/// # Errors
///
/// Returns the body's error message when reading fails.
pub(crate) async fn collect<B>(body: B) -> Result<Bytes, String>
where
    B: http_body::Body,
    B::Error: fmt::Display,
{
    let mut body = std::pin::pin!(body);
    let mut out = BytesMut::new();
    while let Some(frame) = std::future::poll_fn(|cx| body.as_mut().poll_frame(cx)).await {
        let frame = frame.map_err(|error| error.to_string())?;
        if let Ok(data) = frame.into_data() {
            bytes::BufMut::put(&mut out, data);
        }
    }
    Ok(out.freeze())
}
