import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createMuseProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  const provider = createMuseProvider({
    // Muse owns MCP configuration; Paseo injects its host MCP by default.
    // The session presents a notice whenever that injected config is not used.
    unsupportedMcpStrategy: "use-muse-native-config",
  });
  server.registerProvider(provider);
  return () => provider.dispose();
}
