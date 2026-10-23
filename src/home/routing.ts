import type { FilesPort } from "@fungi.computer/knapsack";
import { z } from "zod";

const computerLocator = z
  .url({ protocol: /^computer$/ })
  .transform((value) => new URL(value))
  .refine(
    (value) =>
      !value.username &&
      !value.password &&
      !value.port &&
      !value.search &&
      !value.hash,
    "Computer file locators cannot contain credentials, ports, queries or fragments",
  );

/** URI names select captured ports; they cannot create or widen authority. */
export function homeFilesRouting(
  connections: ReadonlyMap<string, FilesPort>,
  home: FilesPort,
): FilesPort {
  function resolve(locator: string) {
    const explicit = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(locator);
    const uri = explicit ? computerLocator.parse(locator) : null;
    const mount = uri === null ? "home" : decodeURIComponent(uri.hostname);
    const port = mount === "home" ? home : connections.get(mount);
    if (port === undefined)
      throw new Error(`Files connection unavailable: ${mount}`);
    // A URI's leading slash separates the mount from its root-relative path.
    // The selected port still owns containment and its filesystem root.
    const path =
      uri === null ? locator : decodeURIComponent(uri.pathname.slice(1)) || ".";
    const locate = (resultPath: string) => {
      if (uri === null) return resultPath;
      const result = new URL(uri);
      result.pathname = resultPath.split("/").map(encodeURIComponent).join("/");
      return result.href;
    };
    return { port, path, locate };
  }
  const routing: FilesPort = {
    read: async (input, context) => {
      const { port, path } = resolve(input.path);
      const result = await port.read({ ...input, path }, context);
      return { ...result, path: input.path };
    },
    list: async (input, context) => {
      const { port, path, locate } = resolve(input.path);
      return locateSearch(
        await port.list({ ...input, path }, context),
        input.path,
        locate,
      );
    },
    glob: async (input, context) => {
      const { port, path, locate } = resolve(input.path);
      return locateSearch(
        await port.glob({ ...input, path }, context),
        input.path,
        locate,
      );
    },
    grep: async (input, context) => {
      const { port, path, locate } = resolve(input.path);
      return locateSearch(
        await port.grep({ ...input, path }, context),
        input.path,
        locate,
      );
    },
    replace: async (input, context) => {
      const { port, path } = resolve(input.path);
      const result = await port.replace({ ...input, path }, context);
      return { ...result, path: input.path };
    },
  };
  // Patches use the selected Home's native engine and jail. URI routing does
  // not introduce a second patch parser.
  const patch = home.patch?.bind(home);
  return patch === undefined ? routing : { ...routing, patch };
}

function locateSearch(
  result: Awaited<ReturnType<FilesPort["list"]>>,
  path: string,
  locate: (path: string) => string,
) {
  return {
    ...result,
    path,
    results: result.results.map((found) => ({
      ...found,
      path: locate(found.path),
    })),
  };
}
