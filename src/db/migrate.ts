import { loadConfig } from "../config.ts";
import { ensureOrganization, migrateToLatest, openDatabase } from "./index.ts";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
await migrateToLatest(db);
await ensureOrganization(db, config.DEFAULT_ORG_SLUG, config.DEFAULT_ORG_NAME);
await db.destroy();
console.log("Migrations applied.");
