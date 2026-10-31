import { loadConfig } from "./config.ts";
import { buildApp } from "./app.ts";

const config = loadConfig();
const { app } = await buildApp({ config });

const host = config.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
await app.listen({ port: config.PORT, host });
app.log.info(`Planning Center callback URL: ${config.PCO_REDIRECT_URI}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0));
  });
}
