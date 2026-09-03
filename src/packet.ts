/** Chat payload ceiling; short messages are left-packed, long ones truncated, nothing padded. */
export const CHAT_PAYLOAD_BYTES = 16;

export function isPrintableAscii(value: number): boolean {
  return value >= 0x20 && value <= 0x7e;
}

/** Keeps only printable ASCII and truncates to CHAT_PAYLOAD_BYTES characters; not padded, so a
 * short message's frame leaves spare capacity for the transmitter to spend on redundancy instead. */
export function encodeChatMessage(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    if (bytes.length >= CHAT_PAYLOAD_BYTES) break;
    const code = character.charCodeAt(0) & 0xff;
    if (!isPrintableAscii(code)) continue;
    bytes.push(code);
  }
  return Uint8Array.from(bytes);
}

/** Turns a decoded chat payload back into text; undefined if it isn't valid printable ASCII. */
export function decodeChatMessage(data: Uint8Array | string): string | undefined {
  const bytes =
    typeof data === 'string' ? Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff) : data;
  if (bytes.length < 1 || bytes.length > CHAT_PAYLOAD_BYTES) return undefined;

  let text = '';
  for (const byte of bytes) {
    if (!isPrintableAscii(byte)) return undefined;
    text += String.fromCharCode(byte);
  }
  return text;
}