//! S3/R2 access (port of steps/s3Client.ts): SigV4 signing, the R2 client over reqwest
//! (`ObjectStore`) and the bits of S3 XML it reads and writes.
//!
//! Design: SigV4 is implemented here (`sigv4.rs`, checked against the AWS documentation test
//! vectors) on top of `ring`, the crypto provider the app already links for rustls, instead of
//! `aws-sdk-s3` (a very large dependency tree whose default TLS stack is aws-lc-rs, which needs
//! cmake/NASM on Windows) or the `aws-sigv4` crate (pulls the aws-smithy runtime types for one
//! function). Transport is the app's existing reqwest + rustls/ring stack.

pub mod client;
pub mod sigv4;
pub mod xml;

pub use client::{
    max_attempts, R2Client, R2ClientFactory, R2ClientOptions, CONNECTION_TIMEOUT, REGION,
    SOCKET_TIMEOUT,
};
