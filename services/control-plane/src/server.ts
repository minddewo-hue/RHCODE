import { createControlPlane } from "./app.js";

const controlPlane = await createControlPlane({ logLevel: process.env.LOG_LEVEL || "info" });

try {
  await controlPlane.start({
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8790),
  });
} catch (error) {
  controlPlane.app.log.error(error);
  process.exit(1);
}
