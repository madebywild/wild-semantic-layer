import { defineConfig } from "tsup";

export default defineConfig({
  // `node:sqlite` is available only under the `node:` scheme. tsup 8 otherwise removes the
  // protocol from built-in imports, producing an invalid bare `sqlite` package import.
  removeNodeProtocol: false,
});
