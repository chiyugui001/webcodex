import { useState, type ReactNode } from "react";
import { useProduct } from "../../i18n/product";

// Inspect the bounded record already supplied by the runtime; expanding never
// fetches raw logs or changes the runtime's redaction and retention rules.
export function ActivityRecord({ record, summaryClassName, children }: {
  record: object;
  summaryClassName: string;
  children: ReactNode;
}) {
  const p = useProduct();
  const [expanded, setExpanded] = useState(false);
  return <details className="activity-record" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className={summaryClassName}>
      {children}
      <span className="activity-record-toggle">{p("details")} <span aria-hidden="true">▸</span></span>
    </summary>
    {expanded && <div className="activity-record-content">
      <p className="workspace-notice">{p("recordedDetailsNote")}</p>
      <dl>{Object.entries(record).filter(([, value]) => value !== undefined).map(([name, value]) => <div key={name}>
        <dt>{name}</dt>
        <dd><pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></dd>
      </div>)}</dl>
    </div>}
  </details>;
}
