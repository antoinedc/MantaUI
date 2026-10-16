// The `manta` OpenCode V2 plugin: registers every Manta tool (the V2 twins of
// docs/opencode-tools/*.ts) plus todo_write. Nothing installs this yet — Phase 4
// copies the directory into $XDG_CONFIG_HOME/opencode/plugins/manta/.
//
// Tools are thin registrars over manta-server (see lib/server.ts). The V2
// execute context carries sessionID/messageID but not the directory, so each
// call resolves it through lib/context.ts (per-location plugin instance).

import { Plugin } from "@opencode/plugin";
import { resolveToolContext, type ExecuteContextLike } from "./lib/context.ts";
import { allTools } from "./tools/index.ts";

export default Plugin.define({
  id: "manta",
  async setup(ctx) {
    // Transforms replay on every registry rebuild, so the callback only does
    // synchronous registration over data captured here.
    await ctx.tool.transform((editor: any) => {
      for (const def of allTools) {
        editor.add({
          name: def.name,
          description: def.description,
          input: def.input,
          // V2 folds plugin tools into "Code Mode" by default: the model then
          // calls them from JavaScript inside one generic `execute` tool, and
          // the transcript shows `execute` + metadata.toolCalls instead of a
          // part per tool (observed on 2.0.30). `codemode: false` lists each
          // tool directly, so a call is a tool part named exactly like V1
          // (`schedule_create`, `todo_write`, `media_show`, …) with the input in
          // state.input — what the Manta renderer and the Phase 2 todos mapper
          // key on. Cost: the 45 schemas ride every request, as they did on V1.
          options: { codemode: false },
          async execute(input: unknown, context: ExecuteContextLike) {
            const toolContext = await resolveToolContext(ctx, context);
            return { content: await def.execute(input, toolContext) };
          },
        });
      }
    });
  },
});
