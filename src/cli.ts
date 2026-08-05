import { runPostBuild } from "./post-build";

const HELP = `offline-postbuild — generate the offline layer for a built SPA

Reads offline.json, then inside the build directory:
  - writes build-timestamp.txt
  - collects critical/lazy assets by the config patterns
  - writes critical-assets.json
  - generates and minifies the service worker (sw-min.js)
  - injects the offline bootstrap script into index.html (idempotent)

Usage:
  offline-postbuild [--config <path>]

Options:
  -c, --config <path>   Path to offline.json (default: ./offline.json)
  -h, --help            Show this help
`;

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  let configPath = "./offline.json";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config" || arg === "-c") {
      const value = args[++i];
      if (!value) throw new Error("[offline-postbuild] --config needs a path");
      configPath = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      return;
    } else {
      throw new Error(`[offline-postbuild] unknown argument "${arg}" — see --help`);
    }
  }
  await runPostBuild({ configPath, log: (message) => console.log(message) });
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    message.startsWith("[offline-postbuild]") ? message : `[offline-postbuild] ${message}`,
  );
  process.exitCode = 1;
});
