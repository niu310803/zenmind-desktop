import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: 'export * from "./src/renderer/pages/settings/webappBridgeExamples"; export * from "./src/shared/webapp-bridge";',
    resolveDir: process.cwd(),
    loader: "ts"
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm"
});
const catalog = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

test("every advertised WebApp interface and alias has a description and parameter template", () => {
  const methods = new Set([
    ...Object.values(catalog.WEBAPP_BRIDGE_CAPABILITY_ACTIONS).flat(),
    ...Object.keys(catalog.WEBAPP_AGENT_ACTIONS),
    ...Object.keys(catalog.WEBAPP_PUBLIC_ACTIONS),
    "auth.isAvailable", "auth.createSession"
  ]);
  for (const method of methods) {
    const example = catalog.getWebappBridgeExample(method);
    assert.ok(example, `missing example for ${method}`);
    assert.ok(example.description.startsWith("settings.debug.appBridge.method."));
    assert.equal(typeof example.args, "object");
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(example.args)));
  }
});

test("aliases share canonical parameters and no-argument methods use an empty object", () => {
  assert.deepEqual(catalog.getWebappBridgeExample("agent.query"), catalog.getWebappBridgeExample("desktop.assistant.chat"));
  assert.deepEqual(catalog.getWebappBridgeExample("desktop.dialog.selectFiles"), catalog.getWebappBridgeExample("desktop.native.dialog.selectFiles"));
  assert.deepEqual(catalog.getWebappBridgeExample("desktop.theme.get").args, {});
  assert.equal(catalog.getWebappBridgeExample("desktop.window.close"), undefined);
});
