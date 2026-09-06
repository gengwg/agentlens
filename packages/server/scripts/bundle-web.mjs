// Copy the built dashboard next to the compiled server so the published
// package ships one self-contained tree.
import { cpSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "..", "web", "dist");
if (!existsSync(src)) {
  console.error("packages/web/dist missing; run npm run build -w packages/web first");
  process.exit(1);
}
cpSync(src, join(root, "dist", "web"), { recursive: true });
cpSync(join(root, "..", "..", "README.md"), join(root, "README.md"));
chmodSync(join(root, "dist", "index.js"), 0o755);
