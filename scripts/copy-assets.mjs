import { cp, mkdir } from "node:fs/promises";

await mkdir("public/dashboard", { recursive: true });
await Promise.all([
  cp("index.html", "public/index.html"),
  cp("dashboard/index.html", "public/dashboard/index.html"),
]);
