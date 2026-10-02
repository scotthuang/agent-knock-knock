import {
  type TestContext
} from "node:test";

const declaredTests: CodexNoRolloutTestDefinition[] = [];

export function test(
  name: string,
  body: (context: TestContext) => void | Promise<void>
): void {
  declaredTests.push({ name, body });
}

export function codexNoRolloutTestDefinitions(
): readonly CodexNoRolloutTestDefinition[] {
  return declaredTests;
}

export interface CodexNoRolloutTestDefinition {
  readonly name: string;
  readonly body: (context: TestContext) => void | Promise<void>;
}
