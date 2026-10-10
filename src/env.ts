import { config as dotenvConfig } from "dotenv";

// Shared by the Node preload and normal configuration. Never fall back to a
// development .env when a deployed environment was selected.
const nodeEnv = process.env.NODE_ENV;
const envFile = nodeEnv === "staging" ? ".env.staging" : nodeEnv === "production" ? ".env.prod" : undefined;
dotenvConfig(envFile ? { path: envFile } : {});
