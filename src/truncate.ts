/** Return a UTF-16 prefix without splitting a surrogate pair. */
export function charSafePrefix(str: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (str.length <= maxChars) return str;
  let end = maxChars;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return str.slice(0, end);
}
