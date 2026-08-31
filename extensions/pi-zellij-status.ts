import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXTENSION_ID = "pie-zellij-status";
const PERMISSION_CONFIRMATION_EVENT = "pie-ez-pass:permission-confirmation:v1";
const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete";
const SUBAGENT_PROCESS_TERMINAL_EVENT = "subagent:process-terminal";
const IDLE_STATUS = "idle";
const WAITING_STATUS = "waiting";
type Status = "idle" | "running" | "waiting" | "subagent" | undefined;
type StatusLabel =
  | "☼ Idle"
  | "● Running"
  | "◷ Waiting"
  | "◆ Subagent"
  | `☼ I${number} / ● R${number} / ◷ W${number} / ◆ S${number}`;
type Pane = { id: number; title?: string; tab_id?: number; tab_name?: string };
type Tab = { tab_id: number; name?: string };

export default function piZellijStatus(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    skillPaths: [join(fileURLToPath(new URL("..", import.meta.url)), "skills")],
  }));

  // Cooperate with pi-subagents' child-runtime inventory when this extension
  // is loaded in a delegated Pi process. This is observability only; it does
  // not make any assumption about the child's tools or permissions.
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    pi.on("session_start", () => {
      pi.events.emit("subagent:acknowledge-extension", { id: EXTENSION_ID });
    });
  }

  const session = process.env.ZELLIJ_SESSION_NAME;
  const paneId = process.env.ZELLIJ_PANE_ID;
  if (!session || !paneId) return;
  const zellijSession = session;
  const currentPaneId = paneId;
  const numericPaneId = currentPaneId.startsWith("terminal_")
    ? currentPaneId.slice("terminal_".length)
    : currentPaneId;

  let idle = false;
  const permissionRequests = new Set<string>();
  const activeSubagents = new Set<string>();
  let updateQueue = Promise.resolve();

  const enqueueUpdate = () => {
    updateQueue = updateQueue.then(() => updateZellij()).catch(() => undefined);
  };

  const unsubscribePermissionConfirmation = pi.events.on(PERMISSION_CONFIRMATION_EVENT, (data: unknown) => {
    if (!isPermissionConfirmationPayload(data)) return;
    if (data.active) permissionRequests.add(data.requestId);
    else permissionRequests.delete(data.requestId);
    enqueueUpdate();
  });

  // pi-subagents emits these lifecycle events in the parent runtime. Keep the
  // run ids rather than a counter so duplicate events and parallel runs are
  // handled safely. A terminal event is also consumed as a crash/kill path.
  const startSubagent = (data: unknown) => {
    const id = eventId(data);
    if (id !== undefined) {
      activeSubagents.add(id);
      enqueueUpdate();
    }
  };
  const finishSubagent = (data: unknown) => {
    const id = eventId(data);
    if (id !== undefined && activeSubagents.delete(id)) enqueueUpdate();
  };
  const unsubscribeSubagentStarted = pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, startSubagent);
  const unsubscribeSubagentComplete = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, finishSubagent);
  const unsubscribeForegroundComplete = pi.events.on(SUBAGENT_FOREGROUND_COMPLETE_EVENT, finishSubagent);
  const unsubscribeProcessTerminal = pi.events.on(SUBAGENT_PROCESS_TERMINAL_EVENT, finishSubagent);

  const setIdle = () => {
    if (!idle) process.stdout.write("\x07");
    idle = true;
    enqueueUpdate();
  };

  const clearIdle = () => {
    if (!idle) return;
    idle = false;
    enqueueUpdate();
  };

  pi.on("input", () => {
    clearIdle();
  });

  pi.on("agent_settled", () => {
    setIdle();
  });

  pi.on("session_shutdown", async () => {
    unsubscribePermissionConfirmation();
    unsubscribeSubagentStarted();
    unsubscribeSubagentComplete();
    unsubscribeForegroundComplete();
    unsubscribeProcessTerminal();
    await updateQueue.catch(() => undefined);
    await clearZellijStatus().catch(() => undefined);
  });

  // A newly started Pi session contributes as idle immediately.
  idle = true;
  enqueueUpdate();

  function currentStatus(): Status {
    if (permissionRequests.size > 0) return "waiting";
    if (idle && activeSubagents.size > 0) return "subagent";
    if (idle) return "idle";
    return "running";
  }

  async function updateZellij(): Promise<void> {
    const panes = await listPanes();
    const ownPane = panes.find((pane) => String(pane.id) === numericPaneId);
    if (!ownPane || ownPane.tab_id === undefined) return;

    const status = currentStatus();
    await action("rename-pane", "--pane-id", currentPaneId, appendStatus(stripStatus(ownPane.title ?? "pi"), status));

    const refreshedPanes = await listPanes();
    const tabPanes = refreshedPanes.filter((pane) => pane.tab_id === ownPane.tab_id);
    const tab = await currentTab(ownPane.tab_id);
    const baseTabName = stripStatus(tab?.name ?? ownPane.tab_name ?? "tab");
    const tabStatus = aggregateTabStatus(tabPanes, numericPaneId, status);
    await action("rename-tab", "--tab-id", String(ownPane.tab_id), appendStatus(baseTabName, tabStatus));
  }

  async function clearZellijStatus(): Promise<void> {
    const panes = await listPanes();
    const ownPane = panes.find((pane) => String(pane.id) === numericPaneId);
    if (!ownPane || ownPane.tab_id === undefined) return;

    await action("rename-pane", "--pane-id", currentPaneId, stripStatus(ownPane.title ?? "pi"));

    const refreshedPanes = await listPanes();
    const tabPanes = refreshedPanes.filter((pane) => pane.tab_id === ownPane.tab_id && String(pane.id) !== numericPaneId);
    const tab = await currentTab(ownPane.tab_id);
    const baseTabName = stripStatus(tab?.name ?? ownPane.tab_name ?? "tab");
    const tabStatus = aggregateTabStatus(tabPanes, numericPaneId, undefined);
    await action("rename-tab", "--tab-id", String(ownPane.tab_id), appendStatus(baseTabName, tabStatus));
  }

  async function listPanes(): Promise<Pane[]> {
    const output = await zellij("action", "list-panes", "--json");
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) throw new Error("Unexpected zellij list-panes response");
    return parsed as Pane[];
  }

  async function currentTab(tabId: number): Promise<Tab | undefined> {
    const output = await zellij("action", "list-tabs", "--json");
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) throw new Error("Unexpected zellij list-tabs response");
    return (parsed as Tab[]).find((tab) => tab.tab_id === tabId);
  }

  async function action(...args: string[]): Promise<void> {
    await zellij("action", ...args);
  }

  async function zellij(...args: string[]): Promise<string> {
    const result = await execFileAsync("zellij", ["--session", zellijSession, ...args], { maxBuffer: 1024 * 1024 });
    return result.stdout;
  }
}

function isPermissionConfirmationPayload(data: unknown): data is { requestId: string; active: boolean } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const payload = data as Record<string, unknown>;
  return typeof payload.requestId === "string" && payload.requestId.length > 0
    && typeof payload.active === "boolean";
}

function stripStatus(name: string): string {
  // Remove suffixes we have appended. Repeat to repair names produced by the
  // previous implementation, which could leave nested suffixes behind.
  let base = name;
  let suffix = getStatusSuffix(base);
  while (suffix !== undefined) {
    base = base.slice(0, base.lastIndexOf(" ["));
    suffix = getStatusSuffix(base);
  }
  return base;
}

function appendStatus(name: string, status: Status | StatusLabel): string {
  if (!status) return name;
  const label = typeof status === "string" && (isPaneStatus(status) || isTabTally(status))
    ? status
    : statusLabel(status as Status);
  return `${name} [${label}]`;
}

function statusLabel(status: Status): StatusLabel {
  if (status === "idle") return "☼ Idle";
  if (status === "running") return "● Running";
  if (status === "waiting") return "◷ Waiting";
  if (status === "subagent") return "◆ Subagent";
  throw new Error("Cannot label an undefined status");
}

function eventId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const payload = data as Record<string, unknown>;
  if (typeof payload.id === "string" && payload.id.length > 0) return payload.id;
  if (typeof payload.runId === "string" && payload.runId.length > 0) return payload.runId;
  return undefined;
}

function getStatusSuffix(name: string): string | undefined {
  const start = name.lastIndexOf(" [");
  if (start < 0 || !name.endsWith("]")) return undefined;
  const suffix = name.slice(start + 2, -1);
  return isStatusSuffix(suffix) ? suffix : undefined;
}

function isStatusSuffix(suffix: string): boolean {
  if (!suffix) return false;
  if (isPaneStatus(suffix) || isTabTally(suffix)) return true;
  return suffix.split(", ").every((token) => {
    const colon = token.indexOf(":");
    const status = colon < 0 ? token : token.slice(0, colon);
    const detail = colon < 0 ? "" : token.slice(colon + 1);
    return (status === IDLE_STATUS || status === "running" || status === WAITING_STATUS || status === "subagent")
      && (colon < 0 || detail.length > 0)
      && !detail.includes("[")
      && !detail.includes("]");
  });
}

function isPaneStatus(suffix: string): suffix is "☼ Idle" | "● Running" | "◷ Waiting" | "◆ Subagent" {
  return suffix === "☼ Idle" || suffix === "● Running" || suffix === "◷ Waiting" || suffix === "◆ Subagent";
}

function isTabTally(suffix: string): suffix is `☼ I${number} / ● R${number} / ◷ W${number} / ◆ S${number}` {
  if (/^☼ I\d+ \/ ● R\d+ \/ ◷ W\d+ \/ ◆ S\d+$/.test(suffix)) return true;
  // Recognise formats emitted by earlier versions so they are replaced.
  if (/^☼ Idle \d+ \/ ● Running \d+ \/ ◷ Waiting \d+$/.test(suffix)) return true;
  const parts = suffix.split("/");
  return parts.length === 3 && ["I", "R", "W"].every((prefix, index) => {
    const part = parts[index];
    const count = part?.slice(prefix.length);
    return part?.startsWith(prefix) === true && count !== undefined && /^\d+$/.test(count);
  });
}

function statusFromTitle(title: string | undefined): Status {
  const suffix = title === undefined ? undefined : getStatusSuffix(title);
  if (suffix === undefined) return undefined;
  const statuses = suffix.split(", ").map(statusFromToken);
  if (statuses.includes(WAITING_STATUS)) return WAITING_STATUS;
  if (statuses.includes("subagent")) return "subagent";
  if (statuses.includes(IDLE_STATUS)) return IDLE_STATUS;
  return undefined;
}

function statusFromToken(token: string): Status {
  if (token === "☼ Idle") return "idle";
  if (token === "● Running") return "running";
  if (token === "◷ Waiting") return "waiting";
  if (token === "◆ Subagent") return "subagent";

  const colon = token.indexOf(":");
  const status = colon < 0 ? token : token.slice(0, colon);
  if (status === WAITING_STATUS) return WAITING_STATUS;
  if (status === IDLE_STATUS) return IDLE_STATUS;
  if (status === "running") return "running";
  if (status === "subagent") return "subagent";
  return undefined;
}

function aggregateTabStatus(panes: Pane[], ownPaneId: string, ownStatus: Status): StatusLabel | undefined {
  const counts = { idle: 0, running: 0, waiting: 0, subagent: 0 };
  for (const pane of panes) {
    const status = String(pane.id) === ownPaneId
      ? ownStatus
      : statusFromTitle(pane.title);
    if (status === undefined) continue;
    counts[status]++;
  }
  const contributingPanes = counts.idle + counts.running + counts.waiting + counts.subagent;
  if (contributingPanes === 0) return undefined;
  return `☼ I${counts.idle} / ● R${counts.running} / ◷ W${counts.waiting} / ◆ S${counts.subagent}`;
}
