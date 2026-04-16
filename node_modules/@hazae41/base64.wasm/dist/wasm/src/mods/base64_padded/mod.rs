use wasm_bindgen::prelude::*;

use memory_wasm::Memory;

use crate::libs::jse::rjse;

#[wasm_bindgen]
pub fn base64_encode_padded(bytes: &Memory) -> String {
    use base64ct::{Base64, Encoding};

    Base64::encode_string(&bytes.inner)
}

#[wasm_bindgen]
pub fn base64_decode_padded(text: &str) -> Result<Memory, JsError> {
    use base64ct::{Base64, Encoding};

    rjse!(Base64::decode_vec(text).map(Memory::new))
}
