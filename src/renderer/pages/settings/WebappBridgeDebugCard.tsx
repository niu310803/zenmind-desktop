import { useMemo, useState } from "react";
import { Button, Input, Modal, Table } from "antd";
import {
  WEBAPP_BRIDGE_VERSION,
  WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES,
  WEBAPP_BRIDGE_RESERVED_CAPABILITIES,
  WEBAPP_BRIDGE_CAPABILITY_ACTIONS,
  WEBAPP_PUBLIC_ACTIONS,
  WEBAPP_AGENT_ACTIONS
} from "../../../shared/webapp-bridge";
import { useI18n } from "../../i18n/useI18n";
import { getWebappBridgeExample } from "./webappBridgeExamples";

const aliases = Object.entries({ ...WEBAPP_PUBLIC_ACTIONS, ...WEBAPP_AGENT_ACTIONS });
const rows = [
  ...WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES.map((id) => ({
    id,
    reserved: false,
    methods: [...new Set(WEBAPP_BRIDGE_CAPABILITY_ACTIONS[id].flatMap((action) => [
      action, ...aliases.filter(([, target]) => target === action).map(([name]) => name)
    ]).concat(id === "auth.session" ? ["auth.isAvailable", "auth.createSession"] : []))]
  })),
  ...WEBAPP_BRIDGE_RESERVED_CAPABILITIES.map((id) => ({ id, reserved: true, methods: [] as string[] }))
];

export function WebappBridgeDebugCard() {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [selectedMethod, setSelectedMethod] = useState("");
  const [parameters, setParameters] = useState("");
  const selectedExample = getWebappBridgeExample(selectedMethod);
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => [row.id, ...row.methods].some((value) => value.toLowerCase().includes(query)));
  }, [search]);
  const interfaceRows = filteredRows.flatMap((row) => {
    const methods = row.methods.length ? row.methods : [""];
    return methods.map((method, index) => ({
      ...row,
      key: `${row.id}:${method}`,
      method,
      rowSpan: index === 0 ? methods.length : 0
    }));
  });

  return (
    <section className="data-root-card settings-debug-panel settings-app-bridge-panel">
      <div className="settings-debug-panel-head">
        <h2>{t("settings.debug.categories.appBridge")}</h2>
        <code>WebApp Bridge v{WEBAPP_BRIDGE_VERSION}</code>
      </div>
      <p className="page-copy">{t("settings.debug.appBridge.description")}</p>
      <Input.Search value={search} allowClear onChange={(event) => setSearch(event.target.value)} placeholder={t("settings.debug.appBridge.search")} aria-label={t("settings.debug.appBridge.search")} />
      {[false, true].map((reserved) => <section className="settings-app-bridge-group" key={String(reserved)}>
        <h3>{t(reserved ? "settings.debug.appBridge.reserved" : "settings.debug.appBridge.implemented")}</h3>
        <Table rowKey="key" size="small" tableLayout="fixed" pagination={false} dataSource={interfaceRows.filter((row) => row.reserved === reserved)} columns={[
        { title: t("settings.debug.appBridge.capability"), width: "18%", dataIndex: "id", onCell: (row) => ({ rowSpan: row.rowSpan }), render: (id: string) => <code>{id}</code> },
        { title: t("settings.debug.appBridge.interfaces"), width: "35%", dataIndex: "method", render: (method: string) => method ? (
            <button type="button" className="settings-app-bridge-method-link" onClick={() => {
              setSelectedMethod(method);
              setParameters(JSON.stringify(getWebappBridgeExample(method)?.args ?? {}, null, 2));
            }}><code>{method}</code></button>
          ) : "—" },
        { title: t("settings.debug.appBridge.interfaceDescription"), dataIndex: "method", render: (method: string) => {
          const example = getWebappBridgeExample(method);
          return example ? t(example.description) : "—";
        } }
      ]} />
      </section>)}
      <Modal open={Boolean(selectedMethod)} title={selectedMethod} onCancel={() => setSelectedMethod("")} width={640} footer={null}>
        <div className="settings-debug-dialog-body">
          {selectedExample ? <p>{t(selectedExample.description)}</p> : null}
          <p>{t("settings.debug.appBridge.exampleHint")}</p>
          <label className="settings-debug-field">
            <span>{t("settings.debug.appBridge.parameters")}</span>
            <Input.TextArea className="settings-debug-textarea" value={parameters} onChange={(event) => setParameters(event.target.value)} autoSize={{ minRows: 6, maxRows: 20 }} spellCheck={false} />
          </label>
          <Button onClick={() => void window.electronAPI.clipboard.writeText(parameters)}>{t("settings.debug.appBridge.copyParameters")}</Button>
        </div>
      </Modal>
    </section>
  );
}
