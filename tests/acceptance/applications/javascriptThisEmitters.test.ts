import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "preserves separate class sides and possible local-base event candidates through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-this-emitters-");
    await writeFile(
      join(root, "main.mjs"),
      `
      class Base {
        run() { this.on('ready', () => {}); }
        static run() { this.on('ready', () => {}); }
      }
      class Other {
        run() { this.on('ready', () => {}); }
        static run() { this.on('ready', () => {}); }
      }
      class Child extends (flag ? Base : Other) {
        run() { this.emit('ready'); }
        static run() { this.emit('ready'); }
      }
      class ExternalA extends external { field = this.on('ready', () => {}); }
      class ExternalB extends external { field = this.emit('ready'); }
      class Sides {
        field = this.on('sides', () => {});
        static field = this.emit('sides');
      }
      const stable = createEmitter();
      stable.on('ready', () => {}); stable.emit('ready');
      `,
    );
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--artifact-format",
        "directory",
        "--json",
      ],
      timeoutMs: 60_000,
    });
    expect(response.exitCode).toBe(0);
    const contract = toolContract("analyze_javascript_application");
    const cliEvidence = contract.outputSchema.parse(response.json);
    const cliGraph = javascriptApplicationAnalysisResultSchema.parse(
      cliEvidence.normalized_result,
    ).semantic_graph;
    const client = new Client({ name: "this-emitters-e2e", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: root, format: "directory" },
      });
      expect(result.isError).not.toBe(true);
      const evidence = contract.outputSchema.parse(result.structuredContent);
      const text = result.content.find((item) => item.type === "text");
      if (text?.type !== "text") throw new Error("Missing MCP text result");
      expect(contract.outputSchema.parse(JSON.parse(text.text))).toEqual(
        evidence,
      );
      const graph = javascriptApplicationAnalysisResultSchema.parse(
        evidence.normalized_result,
      ).semantic_graph;
      expect(graph).toEqual(cliGraph);
      const ready = graph.nodes.filter(
        (n) => n.kind === "event" && n.properties.event_name === "ready",
      );
      expect(ready).toHaveLength(5);
      const eventRelations = (id: string) =>
        graph.relations.filter(
          (r) =>
            ["registers-listener", "dispatches-candidate"].includes(
              r.relation,
            ) &&
            (r.source_node_id === id || r.target_node_id === id),
        );
      const stable = ready.find((n) =>
        String(n.properties.emitter_key).startsWith("binding:"),
      );
      if (stable === undefined) throw new Error("Stable emitter was lost");
      expect(eventRelations(stable.node_id).map((r) => r.resolution)).toEqual([
        "resolved",
        "resolved",
      ]);
      const receivers = ready.filter((n) => n !== stable);
      expect(
        receivers.map((n) => eventRelations(n.node_id).length).sort(),
      ).toEqual([1, 1, 3, 3]);
      for (const event of receivers) {
        expect(
          eventRelations(event.node_id).every(
            (r) => r.resolution === "candidate",
          ),
        ).toBe(true);
        expect(
          graph.unknowns.some(
            (u) => u.family === "event" && u.node_id === event.node_id,
          ),
        ).toBe(true);
      }
      const sides = graph.nodes.filter(
        (n) => n.kind === "event" && n.properties.event_name === "sides",
      );
      expect(sides).toHaveLength(2);
      for (const event of sides) {
        expect(eventRelations(event.node_id)).toHaveLength(1);
        expect(eventRelations(event.node_id)[0]?.resolution).toBe("candidate");
      }
      await client.ping();
    } finally {
      await client.close();
      await transport.close();
    }
  },
  120_000,
);
