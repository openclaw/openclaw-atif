import { describe, expect, it } from "vitest";
import { stableCompactStringify, stableStringify } from "../src/stable-json.js";

describe("stableStringify", () => {
  it("preserves nested own __proto__ keys in both formats", () => {
    const value: unknown = JSON.parse('{"z":0,"__proto__":{"b":2,"a":1},"a":[{"__proto__":3}]}');
    const compact = '{"__proto__":{"a":1,"b":2},"a":[{"__proto__":3}],"z":0}';
    expect(stableCompactStringify(value)).toBe(compact);
    expect(stableStringify(value)).toBe(`${JSON.stringify(JSON.parse(compact), null, 2)}\n`);
  });
  it("sorts nested keys, preserves arrays, and omits undefined object fields", () => {
    expect(stableStringify({ z: 1, a: { y: 2, x: undefined }, list: [{ b: 2, a: 1 }] })).toBe(
      '{\n  "a": {\n    "y": 2\n  },\n  "list": [\n    {\n      "a": 1,\n      "b": 2\n    }\n  ],\n  "z": 1\n}\n',
    );
  });
});
