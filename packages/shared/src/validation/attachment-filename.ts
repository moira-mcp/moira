/** The original bounded basename is retained; no normalization or header serialization happens here. */
export function isSafeAttachmentFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    Buffer.byteLength(value) <= 255 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 || character === "/" || character === "\\";
    })
  );
}
