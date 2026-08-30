import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXTENSION_ID = "pie-zellij-status";
const PERMISSION_CONFIRMATION_EVENT = "pie-ez-pass:permission-confirmation:v1";
const IDLE_STATUS = "idle";
const WAITING_STATUS = "waiting";
type Status = "idle" | "running" | "waiting" | undefined;
type StatusLabel =
  | "☼ Idle"
  | "● Running"
  | "◷ Waiting"
  | `I${number}/R${number}/W${number}`
  | `☼ Idle ${number} / ● Running ${number} / ◷ Waiting ${number}`;
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
  const numericPaneId = paneId.startsWith("terminal_") ? paneId.slice("terminal_".length) : paneId;

  let idle = false;
  const permissionRequests = new Set<string>();
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
    await updateQueue.catch(() => undefined);
    await clearZellijStatus().catch(() => undefined);
  });

  // A newly started Pi session contributes as idle immediately.
  idle = true;
  enqueueUpdate();

  function currentStatus(): Status {
    if (permissionRequests.size > 0) return "waiting";
    if (idle) return "idle";
    return "running";
  }

  async function updateZellij(): Promise<void> {
    const panes = await listPanes();
    const ownPane = panes.find((pane) => String(pane.id) === numericPaneId);
    if (!ownPane || ownPane.tab_id === undefined) return;

    const status = currentStatus();
    await action("rename-pane", "--pane-id", paneId, appendStatus(stripStatus(ownPane.title ?? "pi"), status));

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

    await action("rename-pane", "--pane-id", paneId, stripStatus(ownPane.title ?? "pi"));

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
    const result = await execFileAsync("zellij", ["--session", session, ...args], { maxBuffer: 1024 * 1024 });
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
  throw new Error("Cannot label an undefined status");
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
    return (status === IDLE_STATUS || status === "running" || status === WAITING_STATUS)
      && (colon < 0 || detail.length > 0)
      && !detail.includes("[")
      && !detail.includes("]");
  });
}

function isPaneStatus(suffix: string): suffix is "☼ Idle" | "● Running" | "◷ Waiting" {
  return suffix === "☼ Idle" || suffix === "● Running" || suffix === "◷ Waiting";
}

function isTabTally(suffix: string): suffix is `I${number}/R${number}/W${number}` | `☼ Idle ${number} / ● Running ${number} / ◷ Waiting ${number}` {
  if (/^☼ Idle \d+ \/ ● Running \d+ \/ ◷ Waiting \d+$/.test(suffix)) return true;

  const parts = suffix.split("/");
  if (parts.length !== 3) return false;
  return ["I", "R", "W"].every((prefix, index) => {
    const part = parts[index];
    if (!part || !part.startsWith(prefix)) return false;
    const count = part.slice(prefix.length);
    return count.length > 0 && Number.isInteger(Number(count)) && Number(count) >= 0;
  });
}

function statusFromTitle(title: string | undefined): Status {
  const suffix = title === undefined ? undefined : getStatusSuffix(title);
  if (suffix === undefined) return undefined;
  const statuses = suffix.split(", ").map(statusFromToken);
  if (statuses.includes(WAITING_STATUS)) return WAITING_STATUS;
  if (statuses.includes(IDLE_STATUS)) return IDLE_STATUS;
  return undefined;
}

function statusFromToken(token: string): Status {
  if (token === "☼ Idle") return "idle";
  if (token === "● Running") return "running";
  if (token === "◷ Waiting") return "waiting";

  const colon = token.indexOf(":");
  const status = colon < 0 ? token : token.slice(0, colon);
  if (status === WAITING_STATUS) return WAITING_STATUS;
  if (status === IDLE_STATUS) return IDLE_STATUS;
  if (status === "running") return "running";
  return undefined;
}

function aggregateTabStatus(panes: Pane[], ownPaneId: string, ownStatus: Status): StatusLabel | undefined {
  const counts = { idle: 0, running: 0, waiting: 0 };
  for (const pane of panes) {
    const status = String(pane.id) === ownPaneId
      ? ownStatus
      : statusFromTitle(pane.title);
    if (status === undefined) continue;
    counts[status]++;
  }
  const contributingPanes = counts.idle + counts.running + counts.waiting;
  if (contributingPanes === 0) return undefined;
  return `☼ Idle ${counts.idle} / ● Running ${counts.running} / ◷ Waiting ${counts.waiting}`;
}
