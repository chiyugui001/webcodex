import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "../../models/topology";
import { LocaleProvider } from "../../i18n/locale";
import { PRODUCT_LOCALES, PRODUCT_MESSAGES, productText } from "../../i18n/product";
import { ProjectsPanel } from "../projects/ProjectsPanel";
import { ActivityPanel } from "../activity/ActivityPanel";
import { ExtensionsPanel } from "../extensions/ExtensionsPanel";
import { WorkspaceProvider, sameProjectPath, sessionTitle } from "./WorkspaceContext";
import { ChatgptObservation, observationTime } from "./WorkspaceStatus";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
const api = vi.hoisted(() => ({ runnerSettings: vi.fn(), updateRunnerSettings: vi.fn(), restartOwnedRunner: vi.fn(), addRunnerPlugin: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../../lib/desktop-api", () => ({ desktopApi: api }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const alpha = { id: "agent:mini:alpha", path: "C:\\work\\alpha", name: "alpha", connected: true, sessions: { active_sessions: 2, latest_updated_at: 100 } };
const beta = { id: "agent:mini:beta", path: "C:\\work\\beta", name: "beta", connected: true, sessions: { active_sessions: 0, latest_updated_at: 90 } };
const session = { project_id: alpha.id, project_name: "alpha", session_id: "wc_sess_1234567890123456", title: "Fix export workflow", lifecycle: "active", updated_at: 100, running_call: false, running_jobs: 1, running_jobs_complete: true,
  overview: { attention: { open_todos: 2, open_questions: 1, open_risks: 0 }, reported_progress: { text: "Review the export changes", reported_at: 90 } }, last_activity: { kind: "Edited", state: "succeeded", summary: "Updated export handler" },
};
const windowRow = { client_window_key: "window-001", source: "chatgpt", last_project: alpha.id, last_seen_at_ms: 100_000, last_meaningful_activity_at_ms: 100_000, active_count: 1, linked_session_count: 1 };
const state = {
  project: { path: alpha.path, runtime_project_id: alpha.id, is_git_repository: true, valid: true },
  saved_projects: [{ path: alpha.path, runtime_project_id: alpha.id }, { path: beta.path, runtime_project_id: beta.id }],
  readiness: { runtime_ready: true, server: "ready", runner: "ready", exposure: "none" },
  topology: { server: { kind: "local" }, runner: { kind: "local" }, experience: "full" },
  current_operation: null, chatgpt_activity: { observed: false, last_meaningful_activity_at_ms: null },
} as unknown as DesktopState;
const overview = { client_id: "mini", connected: true, projects: [alpha, beta], visible_project_count: 2, projects_truncated: false, recent_sessions: { sessions: [session], truncated: false, scan_truncated: false } };
const wrap = (children: React.ReactNode, selected = state) => <LocaleProvider><WorkspaceProvider state={selected}>{children}</WorkspaceProvider></LocaleProvider>;

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); localStorage.setItem("webcodex.desktop.locale", "en-US");
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.runnerSettings.mockResolvedValue({ target: { client_id: "mini", config_path: "fixture.toml", server_url: "http://localhost" }, paths: { instruction_files: [], skill_roots: [] }, plugin_ids: [], can_restart: true });
  native.invoke.mockImplementation(async (_command, { request }) => {
    switch (request.kind) {
      case "overview": return overview;
      case "windows": return { windows: [windowRow] };
      case "project_git": return { branch: "feat/export", clean: false, git_available: true, non_git_project: false, files: [{ path: "src/export.ts", status: " M" }] };
      case "window": return { ...windowRow, linked_sessions: [{ project: alpha.id, workflow_session_id: session.session_id, title: session.title }], activity: [{ tool_name: "apply_text_edits", meaningful: true, project: alpha.id, status: "succeeded", started_at_ms: 90_000, ended_at_ms: 100_000 }] };
      case "session": return { ...session, activity: [{ kind: "Edited", state: "succeeded", summary: "Updated export handler", tool: "apply_text_edits", paths: ["src/export.ts"], job_id: "wc_job_export_check", started_at: 90, finished_at: 100 }] };
      case "extensions": return { project: alpha.id, runner: "mini", can_reload_plugins: true,
        instructions: { files: [{ source_scope: "project", path: "AGENTS.md", fingerprint: "revision-one", total_lines: 2 }], scan_complete: true },
        skills: { available: true, catalog: { skills: [{ skill_id: "skill-1", name: "Review changes", description: "Review project changes", source_scope: "project" }] } },
        plugins: { available: true, catalog: { plugins: [{ id: "sample", name: "Sample provider", status: "ready", tool_count: 3 }] } },
      };
      case "instruction": return { content: "# Project instructions\nUse existing tests.", truncated: false };
      case "plugin_reload": return { reloaded: true };
      default: throw new Error("Unexpected workspace query: " + request.kind);
    }
  });
});
afterEach(cleanup);

describe("product workspace task flows", () => {
  it.each([
    ["drive", String.raw`\\?\E:\02_ts30x-v2`, String.raw`E:\02_ts30x-v2`],
    ["UNC", String.raw`\\?\UNC\server\share\02_ts30x-v2`, String.raw`\\server\share\02_ts30x-v2`],
  ])("merges extended Windows %s paths with saved projects and keeps the live current row", async (_kind, livePath, savedPath) => {
    const liveProjects = [
      { ...alpha, id: "agent:mini:webcodex", name: "webcodex", path: String.raw`\\?\F:\webcodex` },
      { ...beta, id: "agent:mini:ts30x", name: "02_ts30x-v2", path: livePath },
      { ...beta, id: "agent:mini:obsibian", name: "obsibian", path: String.raw`\\?\F:\obsibian` },
    ];
    const selected = { ...state,
      project: { ...state.project!, path: savedPath, runtime_project_id: liveProjects[1].id },
      saved_projects: [
        { ...state.project!, path: String.raw`F:\webcodex`, runtime_project_id: liveProjects[0].id },
        { ...state.project!, path: savedPath, runtime_project_id: liveProjects[1].id },
      ],
    };
    const normal = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name, value) => value.request.kind === "overview"
      ? Promise.resolve({ ...overview, projects: liveProjects, visible_project_count: 3 }) : normal(name, value));
    const open = vi.fn();
    const view = render(wrap(<ProjectsPanel state={selected} onChooseProject={vi.fn()} onSelectProject={open} />, selected));
    await screen.findByText("2 active sessions");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("heading", { level: 1, name: "Projects 3" })).toBeInTheDocument();
    const current = screen.getByRole("listitem", { name: "02_ts30x-v2" });
    expect(within(current).getByText("Current")).toBeInTheDocument();
    expect(await within(current).findByText("feat/export")).toBeInTheDocument();
    expect(within(current).getByText("0 active sessions")).toBeInTheDocument();
    expect(within(current).queryByText("Not checked")).not.toBeInTheDocument();
    expect(screen.getAllByText("Current")).toHaveLength(1);
    fireEvent.click(within(current).getByRole("button", { name: "Open Project 02_ts30x-v2" }));
    expect(open).toHaveBeenCalledWith(livePath);
    const switched = { ...selected, project: selected.saved_projects[0] };
    view.rerender(wrap(<ProjectsPanel state={switched} onChooseProject={vi.fn()} onSelectProject={open} />, switched));
    await screen.findByText("2 active sessions");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(within(screen.getByRole("listitem", { name: "webcodex" })).getByText("Current")).toBeInTheDocument();
    expect(screen.getAllByText("Current")).toHaveLength(1);
  });
  it("shows every project with branch/activity and keeps other projects when switching current", async () => {
    const open = vi.fn(); const add = vi.fn();
    const view = render(wrap(<ProjectsPanel state={state} onChooseProject={add} onSelectProject={open} />));
    await screen.findByText("2 active sessions"); expect(await screen.findAllByText("feat/export")).toHaveLength(2);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Open Project beta" })); expect(open).toHaveBeenCalledWith(beta.path);
    const switched = { ...state, project: { ...state.project!, path: beta.path, runtime_project_id: beta.id } };
    view.rerender(wrap(<ProjectsPanel state={switched} onChooseProject={add} onSelectProject={open} />, switched));
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: "beta" })).getByText("Current")).toBeInTheDocument());
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Add Project" })); expect(add).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search projects" }), { target: { value: "ALPHA" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
  it("opens a Window's associated Workflow Session and presents product activity rather than a ledger", async () => {
    render(wrap(<ActivityPanel activity={[]} />));
    expect(screen.getByRole("tab", { name: "Windows" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(await screen.findByRole("button", { name: /Windows · window-001/ }));
    const detail = await screen.findByRole("dialog", { name: "Windows · window-001" });
    fireEvent.click(await within(detail).findByRole("button", { name: /Fix export workflow/ }));
    const workflow = await screen.findByRole("dialog", { name: "Fix export workflow" });
    await within(workflow).findByText("Review the export changes");
    expect(within(workflow).getByText("Updated export handler")).toBeInTheDocument();
    expect(within(workflow).getByText("src/export.ts", { selector: ".changed-files span" })).toBeInTheDocument();
    expect(workflow).not.toHaveTextContent("apply_text_edits");
    expect(native.invoke).toHaveBeenCalledWith("workspace_query", { request: { kind: "session", project: alpha.id, session_id: session.session_id } });
    fireEvent.click(within(workflow).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("tab", { name: "Workflow Sessions" }));
    expect(await screen.findByRole("button", { name: /Fix export workflow/ })).toHaveTextContent("Active jobs 1");
    expect(screen.getByRole("tab", { name: "System" })).toHaveAttribute("aria-selected", "false");
  });
  it("expands a Window activity into recorded tool details without another request", async () => {
    render(wrap(<ActivityPanel activity={[]} />));
    fireEvent.click(await screen.findByRole("button", { name: /Windows · window-001/ }));
    const dialog = await screen.findByRole("dialog", { name: "Windows · window-001" });
    const label = await within(dialog).findByText("Editing files");
    const summary = label.closest("summary")!;
    const record = summary.parentElement!;
    expect(record.querySelector("dl")).toBeNull();
    const requests = native.invoke.mock.calls.length;
    fireEvent.click(summary);
    expect(await within(record).findByText("apply_text_edits", { selector: "pre" })).toBeVisible();
    expect(within(record).getByText(alpha.id, { selector: "pre" })).toBeVisible();
    expect(within(record).getByText("90000", { selector: "pre" })).toBeVisible();
    expect(native.invoke).toHaveBeenCalledTimes(requests);
    fireEvent.click(summary);
    await waitFor(() => expect(record.querySelector("dl")).toBeNull());
  });
  it("expands Workflow Session activity into its recorded paths, tool and job", async () => {
    render(wrap(<ActivityPanel activity={[]} />));
    fireEvent.click(screen.getByRole("tab", { name: "Workflow Sessions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix export workflow/ }));
    const dialog = await screen.findByRole("dialog", { name: "Fix export workflow" });
    const label = await within(dialog).findByText("Updated export handler");
    const summary = label.closest("summary")!;
    const record = summary.parentElement!;
    expect(record.querySelector("dl")).toBeNull();
    fireEvent.click(summary);
    expect(await within(record).findByText("apply_text_edits", { selector: "pre" })).toBeVisible();
    expect(within(record).getByText("wc_job_export_check", { selector: "pre" })).toBeVisible();
    expect(within(record).getByText(/src\/export.ts/, { selector: "pre" })).toHaveTextContent('"src/export.ts"');
    expect(within(record).getByText("100", { selector: "pre" })).toBeVisible();
  });
  it("opens effective instructions, lists real Skills and reloads a provider only on request", async () => {
    render(wrap(<ExtensionsPanel state={state} onState={vi.fn()} />));
    fireEvent.click(await screen.findByRole("button", { name: "Open AGENTS.md" }));
    const document = await screen.findByRole("dialog", { name: "AGENTS.md" });
    await within(document).findByText(/Use existing tests/);
    expect(native.invoke).toHaveBeenCalledWith("workspace_query", { request: { kind: "instruction", project: alpha.id, source_scope: "project", path: "AGENTS.md", fingerprint: "revision-one" } });
    fireEvent.click(within(document).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("tab", { name: "Skills" })); expect(screen.getByText("Review changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "MCP Providers" }));
    fireEvent.click(screen.getByText("Advanced: Native Tool Plugins", { selector: "summary" }));
    expect(screen.getByText(/3 tools/)).toBeInTheDocument();
    expect(native.invoke.mock.calls.some(([, value]) => value.request.kind === "plugin_reload")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("workspace_query", { request: { kind: "plugin_reload", project: alpha.id, plugin: "sample" } }));
    expect(api.restartOwnedRunner).not.toHaveBeenCalled();
  });
  it("rejects an older workspace result after a project switch", async () => {
    let complete!: (value: unknown) => void;
    const delayed = new Promise(resolve => { complete = resolve; }); const normal = native.invoke.getMockImplementation()!;
    let overviewCalls = 0;
    native.invoke.mockImplementation((name, value) => value.request.kind === "overview" && overviewCalls++ === 0 ? delayed : normal(name, value));
    const view = render(wrap(<ProjectsPanel state={state} onChooseProject={vi.fn()} onSelectProject={vi.fn()} />));
    await waitFor(() => expect(overviewCalls).toBe(1));
    const switched = { ...state, project: { ...state.project!, path: beta.path, runtime_project_id: beta.id } };
    view.rerender(wrap(<ProjectsPanel state={switched} onChooseProject={vi.fn()} onSelectProject={vi.fn()} />, switched));
    await screen.findByText("2 active sessions");
    await act(async () => { complete({ ...overview, projects: [{ ...alpha, id: "agent:old:other", name: "Stale project", path: "/old" }] }); });
    expect(screen.queryByText("Stale project")).not.toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: "beta" })).getByText("Current")).toBeInTheDocument();
  });
  it("uses timestamps, never inferred ChatGPT presence", () => {
    const view = render(<LocaleProvider><ChatgptObservation state={state} /></LocaleProvider>);
    expect(screen.getByText("No ChatGPT activity observed yet")).toBeInTheDocument();
    view.rerender(<LocaleProvider><ChatgptObservation state={{ ...state, chatgpt_activity: { observed: true, last_meaningful_activity_at_ms: Date.now() - 120_000 } }} /></LocaleProvider>);
    expect(screen.getByText(/Last ChatGPT activity/)).toHaveTextContent("2 minutes ago");
    expect(screen.queryByText(/connected|disconnected|Waiting for ChatGPT/i)).not.toBeInTheDocument();
  });
});

describe("cross-platform product vocabulary", () => {
  it.each([
    [String.raw`\\?\E:\02_ts30x-v2`, String.raw`E:\02_ts30x-v2`],
    [String.raw`\\?\F:\WebCodex`, "f:/webcodex/"],
    [String.raw`\\?\UNC\SERVER\Share\Repo`, String.raw`\\server\share\repo`],
    [String.raw`\\?\UNC\SERVER\Share`, String.raw`\\server\share`],
    ["\\\\?\\C:\\", "c:/"],
  ])("matches extended Windows paths %s and %s in either direction", (a, b) => {
    expect(sameProjectPath(a, b)).toBe(true);
    expect(sameProjectPath(b, a)).toBe(true);
  });
  it.each([
    [String.raw`\\?\E:\repo`, String.raw`F:\repo`],
    [String.raw`\\?\UNC\server\share\repo`, String.raw`\\other\share\repo`],
    [String.raw`\\?\UNC\server\share\repo`, String.raw`\\server\other\repo`],
    [String.raw`\\?\Volume{fixture}\repo`, String.raw`Volume{fixture}\repo`],
    [String.raw`\\.\C:\repo`, String.raw`C:\repo`],
    [String.raw`\\?\C:repo`, "C:repo"],
    [String.raw`\\?\C:\repo.`, String.raw`C:\repo.`],
    ["\\\\?\\C:\\repo ", "C:\\repo "],
    [String.raw`\\?\C:\parent\..\repo`, String.raw`C:\parent\..\repo`],
    [String.raw`\\?\C:\repo/child`, String.raw`C:\repo/child`],
    ["c:/", "c:"],
    ["/work/Repo", "/work/repo"],
    ["/work/repo\\", "/work/repo"],
  ])("keeps distinct Windows namespaces or literal paths separate: %s and %s", (a, b) => {
    expect(sameProjectPath(a, b)).toBe(false);
    expect(sameProjectPath(b, a)).toBe(false);
  });
  it("matches Windows drive and UNC paths without collapsing Unix case or root", () => {
    expect(sameProjectPath("C:\\Work\\Repo\\", "c:/work/repo")).toBe(true);
    expect(sameProjectPath("\\\\SERVER\\Share\\Repo", "\\\\server\\share\\repo\\")).toBe(true);
    expect(sameProjectPath("/", "/")).toBe(true);
    expect(sameProjectPath("/work/A", "/work/a")).toBe(false);
    expect(sameProjectPath("", "")).toBe(false);
  });
  it("has a non-empty value for every product term in all six supported Desktop languages", () => {
    for (const [key, values] of Object.entries(PRODUCT_MESSAGES)) {
      expect(values, key).toHaveLength(PRODUCT_LOCALES.length);
      for (const locale of PRODUCT_LOCALES) expect(productText(locale, key as keyof typeof PRODUCT_MESSAGES).trim(), `${locale}:${key}`).not.toBe("");
    }
    expect(sessionTitle("A short title\n\nLong root instruction")).toBe("A short title");
    expect(sessionTitle("x".repeat(4000)).length).toBe(110);
    expect(observationTime(60_000, "en-US", 120_000)).toBe("1 minute ago");
  });
});
