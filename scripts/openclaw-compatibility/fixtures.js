import fs from "node:fs";
import path from "node:path";

export function createFakeExecutables(caseRoot) {
  const binDir = path.join(caseRoot, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const values = {
    tmux: { filename: "tmux", version: "tmux 3.5a" },
    codex: { filename: "codex", version: "codex-cli 0.107.0" },
    claude: { filename: "claude", version: "2.1.218" }
  };
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      const executable = path.join(binDir, value.filename);
      fs.writeFileSync(
        executable,
        `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(value.version)});\n`,
        { encoding: "utf8", mode: 0o755 }
      );
      fs.chmodSync(executable, 0o755);
      return [name, executable];
    })
  );
}
