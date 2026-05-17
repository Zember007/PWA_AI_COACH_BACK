import { config } from "./config.js";
import { buildApp } from "./app.js";

const app = await buildApp();

await app.listen({ port: config.PORT, host: "0.0.0.0" });

