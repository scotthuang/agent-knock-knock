import { dispatchDesktopCli, desktopListForCli } from "./desktop-cli-adapter.js";
import { dispatchCodexNativeCli, codexNativeListForCli } from "./codex-native-cli-adapter.js";

export { desktopListForCli } from "./desktop-cli-adapter.js";
export { codexNativeListForCli } from "./codex-native-cli-adapter.js";

/** Native resource IDs never fall through to terminal selectors. */
export async function dispatchLocalCodexCli(command: string | undefined, options: Record<string, unknown>): Promise<boolean> {
  return await dispatchCodexNativeCli(command, options) || await dispatchDesktopCli(command, options);
}

export async function localCodexListForCli(options: Record<string, unknown>) {
  const [native, desktop] = await Promise.all([codexNativeListForCli(options), desktopListForCli(options)]);
  return { ...native, ...desktop };
}
