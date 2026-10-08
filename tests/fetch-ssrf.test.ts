import { describe, expect, test } from "vitest";
import { classifyIp } from "../src/fetch.js";

describe("fetch SSRF IP classification", () => {
  test.each([
    ["169.254.169.254", "block"],
    ["::ffff:169.254.169.254", "block"],
    ["::ffff:a9fe:a9fe", "block"],
    ["::ffff:7f00:1", "private"],
    ["::ffff:c0a8:101", "private"],
    ["::ffff:808:808", "public"],
    ["::1", "private"],
    ["fe80::1", "block"],
    ["2606:4700:4700::1111", "public"],
  ] as const)("classifies %s as %s", (address, verdict) => {
    expect(classifyIp(address)).toBe(verdict);
  });

  test("blocks the normalized literal from a mapped IPv6 URL", () => {
    const parsed = new URL("http://[::ffff:169.254.169.254]/");
    expect(classifyIp(parsed.hostname.replace(/^\[|\]$/g, ""))).toBe("block");
  });
});
