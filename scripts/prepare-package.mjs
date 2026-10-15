import { URL } from "node:url";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const destination = new URL(".botanical/package/", root);
const manifest = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const files = manifest.files;
delete manifest.scripts;
delete manifest.botanical;
delete manifest.devDependencies;
delete manifest.publishConfig;
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const path of files) {
  const target = new URL(path, destination);
  await mkdir(new URL("./", target), { recursive: true });
  await cp(new URL(path, root), target, { recursive: true });
}
await writeFile(
  new URL("package.json", destination),
  JSON.stringify(manifest, null, 2) + "\n",
);
