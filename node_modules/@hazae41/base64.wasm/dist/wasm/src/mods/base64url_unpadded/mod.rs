use wasm_bindgen::prelude::*;

use memory_wasm::Memory;

use crate::libs::jse::rjse;

#[wasm_bindgen]
pub fn base64url_encode_unpadded(bytes: &Memory) -> String {
    use base64ct::{Base64UrlUnpadded, Encoding};

    Base64UrlUnpadded::encode_string(&bytes.inner)
}

#[wasm_bindgen]
pub fn base64url_decode_unpadded(text: &str) -> Result<Memory, JsError> {
    use base64ct::{Base64UrlUnpadded, Encoding};

    rjse!(Base64UrlUnpadded::decode_vec(text).map(Memory::new))
}
