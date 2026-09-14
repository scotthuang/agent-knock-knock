#!/usr/bin/env node

import process from "node:process";

import { runConnectorReleaseCheckCli } from "../../../scripts/connector-release-check.js";

process.exitCode = runConnectorReleaseCheckCli({
  connector: "pi",
});
