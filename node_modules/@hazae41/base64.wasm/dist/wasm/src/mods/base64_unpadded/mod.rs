use wasm_bindgen::prelude::*;

use memory_wasm::Memory;

use crate::libs::jse::rjse;

#[wasm_bindgen]
pub fn base64_encode_unpadded(bytes: &Memory) -> String {
    use base64ct::{Base64Unpadded, Encoding};

    Base64Unpadded::encode_string(&bytes.inner)
}

#[wasm_bindgen]
pub fn base64_decode_unpadded(text: &str) -> Result<Memory, JsError> {
    use base64ct::{Base64Unpadded, Encoding};

    rjse!(Base64Unpadded::decode_vec(text).map(Memory::new))
}
