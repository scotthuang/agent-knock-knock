export interface DoctorCommandCheck {
  command: string;
  available: boolean;
  version_supported?: boolean;
}

export interface DoctorCapabilitySummary {
  coreOk: boolean;
  transportOk: boolean;
  tmux: {
    available: boolean;
    recommended: true;
    agents: string[];
    requires: string[];
  };
  acp: {
    available: boolean;
    client: "acpx";
    agents: string[];
    requires: string[];
  };
}

export function evaluateDoctorCapabilities(
  checks: readonly DoctorCommandCheck[]
): DoctorCapabilitySummary {
  const checkByCommand = new Map(checks.map((check) => [check.command, check]));
  const nodeCheck = checkByCommand.get("node");
  const coreOk = nodeCheck?.available === true &&
    nodeCheck.version_supported === true &&
    checkByCommand.get("openclaw")?.available === true;
  const availableAgents = ["codex", "claude", "cursor"]
    .filter((agent) => checkByCommand.get(agent)?.available === true);
  const tmuxAgents = availableAgents.filter((agent) => agent !== "cursor");
  const tmux = {
    available: checkByCommand.get("tmux")?.available === true && tmuxAgents.length > 0,
    recommended: true as const,
    agents: tmuxAgents,
    requires: ["tmux", "codex or claude"]
  };
  const acp = {
    available: checkByCommand.get("acpx")?.available === true && availableAgents.length > 0,
    client: "acpx" as const,
    agents: availableAgents,
    requires: ["acpx", "codex, claude, or cursor"]
  };
  return {
    coreOk,
    transportOk: tmux.available || acp.available,
    tmux,
    acp
  };
}
