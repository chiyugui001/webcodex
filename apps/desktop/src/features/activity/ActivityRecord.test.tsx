import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LocaleProvider } from "../../i18n/locale";
import type { ActivityEntry } from "../../models/topology";
import { ActivityRecord } from "./ActivityRecord";
import { SystemActivity } from "./SystemActivity";

const failure: ActivityEntry = {
  sequence: 17,
  timestamp_ms: 1_789_890_000_123,
  source: "regular_tunnel",
  tunnel_profile_id: "fixture-tunnel-profile",
  level: "error",
  event_kind: "operation_failed",
  message: `Connection refused at fixture-host:1420\n${"诊断内容 ".repeat(40)}\nCredential: [redacted]\nEND-OF-RECORDED-MESSAGE`,
};

beforeEach(() => {
  localStorage.setItem("webcodex.desktop.locale", "en-US");
});

function disclosure(label: HTMLElement) {
  const summary = label.closest("summary");
  if (!summary) throw new Error("Expected an activity disclosure summary");
  return { summary, record: summary.parentElement as HTMLDetailsElement };
}

function field(record: HTMLElement, name: string) {
  const term = within(record).getByText(name, { selector: "dt" });
  return term.nextElementSibling?.querySelector("pre");
}

describe("activity record details", () => {
  it("keeps system rows compact until clicked and preserves the complete recorded message", async () => {
    render(<LocaleProvider><SystemActivity activity={[failure]} /></LocaleProvider>);
    const { summary, record } = disclosure(screen.getByText("Details"));
    expect(record).not.toHaveAttribute("open");
    expect(record.querySelector("dl")).toBeNull();
    summary.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    await waitFor(() => expect(field(record, "message")?.textContent).toBe(failure.message));
    expect(record).toHaveAttribute("open");
    expect(field(record, "sequence")?.textContent).toBe("17");
    expect(field(record, "timestamp_ms")?.textContent).toBe(String(failure.timestamp_ms));
    expect(field(record, "source")?.textContent).toBe("regular_tunnel");
    expect(field(record, "level")?.textContent).toBe("error");
    expect(field(record, "event_kind")?.textContent).toBe("operation_failed");
    expect(field(record, "tunnel_profile_id")?.textContent).toBe("fixture-tunnel-profile");
    fireEvent.click(summary);
    await waitFor(() => expect(record.querySelector("dl")).toBeNull());
    expect(record).not.toHaveAttribute("open");
  });

  it("preserves structured fields, null, false and zero and renders strings as text", async () => {
    const payload = {
      message: '<img src="fixture" onerror="throw new Error()">\nsecond line',
      paths: ["src/long path/文件.ts", "src/second.ts"],
      result: { exit_code: 0, completed: false },
      empty: "", optional: undefined, absent: null, count: 0, meaningful: false,
    };
    render(<LocaleProvider><ActivityRecord record={payload} summaryClassName="workspace-timeline-row"><strong>Recorded event</strong></ActivityRecord></LocaleProvider>);
    const { summary, record } = disclosure(screen.getByText("Recorded event"));
    fireEvent.click(summary);
    await waitFor(() => expect(field(record, "message")?.textContent).toBe(payload.message));
    expect(field(record, "paths")?.textContent).toBe(JSON.stringify(payload.paths, null, 2));
    expect(field(record, "result")?.textContent).toBe(JSON.stringify(payload.result, null, 2));
    expect(field(record, "empty")?.textContent).toBe("");
    expect(field(record, "absent")?.textContent).toBe("null");
    expect(field(record, "count")?.textContent).toBe("0");
    expect(field(record, "meaningful")?.textContent).toBe("false");
    expect(within(record).queryByText("optional", { selector: "dt" })).not.toBeInTheDocument();
    expect(record.querySelector("img")).toBeNull();
  });

  it("searches recorded messages, event kinds and profile IDs without changing filters", () => {
    const process: ActivityEntry = { ...failure, sequence: 18, level: "info", event_kind: "process_started", message: "routine-process-marker" };
    render(<LocaleProvider><SystemActivity activity={[failure, process]} /></LocaleProvider>);
    const search = screen.getByRole("searchbox");
    for (const query of ["FIXTURE-HOST:1420", "operation_failed", "fixture-tunnel-profile", "END-OF-RECORDED-MESSAGE"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getAllByText("Details")).toHaveLength(1);
    }
    fireEvent.change(search, { target: { value: "routine-process-marker" } });
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Show process details/ }));
    expect(screen.getAllByText("Details")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "Warnings and errors only" }));
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getAllByText("Details")).toHaveLength(1);
  });

  it("keeps an expanded system record attached to its sequence when new activity arrives", async () => {
    const view = render(<LocaleProvider><SystemActivity activity={[failure]} /></LocaleProvider>);
    const { summary, record } = disclosure(screen.getByText("Details"));
    fireEvent.click(summary);
    await waitFor(() => expect(field(record, "sequence")?.textContent).toBe("17"));
    const next = { ...failure, sequence: 18, message: "New record" };
    view.rerender(<LocaleProvider><SystemActivity activity={[failure, next]} /></LocaleProvider>);
    const records = screen.getAllByText("Details").map(label => disclosure(label).record);
    expect(records[0]).not.toHaveAttribute("open");
    expect(records[0].querySelector("dl")).toBeNull();
    expect(records[1]).toBe(record);
    expect(records[1]).toHaveAttribute("open");
    expect(field(records[1], "message")?.textContent).toBe(failure.message);
  });

  it("localizes the disclosure and explains the existing runtime limits in Chinese", async () => {
    localStorage.setItem("webcodex.desktop.locale", "zh-CN");
    render(<LocaleProvider><SystemActivity activity={[failure]} /></LocaleProvider>);
    fireEvent.click(screen.getByText("详情"));
    expect(await screen.findByText("仅显示已记录的字段；内容可能已由运行时脱敏或截断。")).toBeVisible();
  });
});
