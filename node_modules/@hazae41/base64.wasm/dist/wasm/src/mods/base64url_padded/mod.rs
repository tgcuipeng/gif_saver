use wasm_bindgen::prelude::*;

use memory_wasm::Memory;

use crate::libs::jse::rjse;

#[wasm_bindgen]
pub fn base64url_encode_padded(bytes: &Memory) -> String {
    use base64ct::{Base64Url, Encoding};

    Base64Url::encode_string(&bytes.inner)
}

#[wasm_bindgen]
pub fn base64url_decode_padded(text: &str) -> Result<Memory, JsError> {
    use base64ct::{Base64Url, Encoding};

    rjse!(Base64Url::decode_vec(text).map(Memory::new))
}
