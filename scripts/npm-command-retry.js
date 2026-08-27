const RETRYABLE_NPM_FAILURE =
  /(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|429|502|503|504)/iu;

export function runNpmWithRetries({
  args,
  options,
  run,
  attempts = 3,
  writeRetry = (message) => process.stderr.write(message)
}) {
  let lastResult;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      lastResult = run("npm", args, {
        ...options,
        allowNonzero: true
      });
    } catch (error) {
      if (!isRetryableNpmFailure(String(error)) || attempt === attempts) {
        throw error;
      }
      writeRetry(`npm network failure; retrying (${attempt}/${attempts})...\n`);
      continue;
    }
    if (lastResult.status === 0) {
      return lastResult;
    }
    const output = `${lastResult.stdout}\n${lastResult.stderr}`;
    if (!isRetryableNpmFailure(output) || attempt === attempts) {
      break;
    }
    writeRetry(`npm network failure; retrying (${attempt}/${attempts})...\n`);
  }
  throw new Error([
    `npm ${args.join(" ")} exited with ${lastResult?.status}`,
    lastResult?.stdout,
    lastResult?.stderr
  ].filter(Boolean).join("\n").slice(-20_000));
}

export function isRetryableNpmFailure(output) {
  return RETRYABLE_NPM_FAILURE.test(output);
}
