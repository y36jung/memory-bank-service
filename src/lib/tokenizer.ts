import { get_encoding, type Tiktoken } from 'tiktoken';

let _encoding: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!_encoding) {
    // get_encoding is synchronous and initialises the WASM module on first call.
    _encoding = get_encoding('cl100k_base');
  }
  return _encoding;
}

export function countTokens(text: string): number {
  return getEncoder().encode(text).length;
}
