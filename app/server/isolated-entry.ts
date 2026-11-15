import { assertIsolatedConfig, installIsolatedEgressGuard, LOCAL_JWT_SECRET, LOCAL_SESSION_SECRET } from "./isolated-guard";

// There are deliberately no static application imports above this boundary.
const config = assertIsolatedConfig();
process.env.NODE_ENV = "test";
process.env.HOST = config.host;
process.env.PORT = String(config.appPort);
process.env.SESSION_SECRET = LOCAL_SESSION_SECRET;
process.env.JWT_SECRET = LOCAL_JWT_SECRET;
installIsolatedEgressGuard(config);
void import("./index").catch(() => {
  console.error("LBA_ISOLATED_START_FAILED: inspect the local test configuration and schema; no provider credentials are permitted");
  process.exitCode = 1;
});
