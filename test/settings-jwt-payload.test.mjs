import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/renderer/pages/settings/decodeJwtPayload.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
});
const mod = { exports: {} };
new Function("exports", "module", outputText)(mod.exports, mod);
const { decodeJwtPayload } = mod.exports;
const tokenFor = (text) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(text).toString("base64url")}.signature`;

test("JWT diagnostics decode UTF-8 and nested claims without verifying signature or expiry", () => {
  const claims = { sub: "test", name: "测试用户", exp: 1, nested: { roles: ["reader"] } };
  assert.equal(decodeJwtPayload(`  ${tokenFor(JSON.stringify(claims))}\n`), JSON.stringify(claims, null, 2));
  assert.equal(decodeJwtPayload(tokenFor("{}")), "{}");
});

test("JWT diagnostics reject malformed tokens, UTF-8, JSON and non-object payloads", () => {
  for (const token of ["", "one.two", "a..c", "a.%%%.c", "a.a.c", "a._w.c", tokenFor("not json"), tokenFor("null"), tokenFor("[]"), tokenFor("42")]) {
    assert.throws(() => decodeJwtPayload(token));
  }
});
