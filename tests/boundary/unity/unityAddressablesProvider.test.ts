import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../../src/domain/analysisErrorCore.js";
import { UnityAddressablesProvider } from "../../../src/unity/UnityAddressablesProvider.js";
import {
  binaryCatalog,
  jsonCatalog,
  sampleCatalog,
} from "../../fixtures/unity/addressables.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** One-shot inspections keep the real reader's cleanup at one test boundary. */
const inspect = async (
  input: { path: string; hash_path?: string },
  limit?: number,
) => {
  const provider = new UnityAddressablesProvider(limit);
  try {
    return await provider.inspect(input);
  } finally {
    await provider.close();
  }
};

const write = async (name: string, bytes: Buffer | string) => {
  const directory = await createTestTempDirectory("rea-addressables-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

it.each([
  ["catalog.json", jsonCatalog()],
  ["catalog.bin", binaryCatalog(sampleCatalog(), { version: 3 })],
])(
  "reports %s with artifact identity and unchanged input bytes",
  async (name, bytes) => {
    const path = await write(name, bytes);
    const result = await inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.artifact).toEqual({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(result.value.hash_file).toBeNull();
    expect(result.value.keys).toHaveLength(7);
    expect(result.value.locations).toHaveLength(5);
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

it("records a selected catalog.hash and states that it is not recomputed", async () => {
  const path = await write("catalog.bin", binaryCatalog());
  const hashPath = join(path, "..", "catalog.hash");
  await writeFile(hashPath, "911a1ea20bb2c634df9e7052761a6bb2\n");
  const result = await inspect({ path, hash_path: hashPath });
  if (!result.ok) throw result.error;
  expect(result.value.hash_file).toMatchObject({
    artifact: { path: hashPath, bytes: 33 },
    text: "911a1ea20bb2c634df9e7052761a6bb2",
  });
  expect(result.value.limitations.join(" ")).toContain("not recomputed");
});

it("reports non-printable hash text as null instead of guessing", async () => {
  const path = await write("catalog.json", jsonCatalog());
  const hashPath = join(path, "..", "catalog.hash");
  await writeFile(hashPath, Buffer.from([0x00, 0xff, 0x41]));
  const result = await inspect({ path, hash_path: hashPath });
  if (!result.ok) throw result.error;
  expect(result.value.hash_file?.text).toBeNull();
});

it("keeps catalog identity on a missing hash file", async () => {
  const path = await write("catalog.json", jsonCatalog());
  const result = await inspect({
    path,
    hash_path: join(path, "..", "missing.hash"),
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisInputError);
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: {
      artifact: { path },
      inventory_status: "not-returned-as-complete",
      declared_row_counts: { keys: 7, locations: 5 },
      selected_hash_file: { identity_status: "unavailable" },
    },
  });
});

it.each([
  [
    binaryCatalog(sampleCatalog(), { version: 1 }),
    AnalysisUnsupportedTargetError,
  ],
  [Buffer.from("not a catalog"), AnalysisUnsupportedTargetError],
  [
    jsonCatalog(sampleCatalog(), {
      patch: (catalog) => delete catalog.m_ProviderIds,
    }),
    AnalysisInputError,
  ],
])(
  "maps format failures to typed errors with source identity (%#)",
  async (bytes, type) => {
    const path = await write("catalog.bin", bytes);
    const result = await inspect({ path });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(type);
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: { artifact: { path, bytes: bytes.length } },
    });
  },
);

it("refuses a report over budget during decoding with declared counts retained", async () => {
  const path = await write("catalog.bin", binaryCatalog());
  const result = await inspect({ path }, 900);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: { declared_row_counts: { keys: 7, locations: 5 } },
  });
});

/** More than one yield interval of keys. */
const largeCatalog = () => {
  const catalog = sampleCatalog();
  for (let index = 0; index < 600; index++)
    catalog.keys.push({
      key: { kind: "string", value: `k${index}` },
      locations: [0],
    });
  return catalog;
};

it("admits one inspection at a time and none after close", async () => {
  const path = await write("catalog.bin", binaryCatalog(largeCatalog()));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const provider = new UnityAddressablesProvider(undefined, () => gate);
  const first = provider.inspect({ path });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await provider.inspect({ path });
  expect(second.ok).toBe(false);
  if (!second.ok)
    expect(second.error).toBeInstanceOf(AnalysisResourceConstraintError);
  release();
  expect((await first).ok).toBe(true);
  await provider.close();
  const closed = await provider.inspect({ path });
  expect(closed.ok).toBe(false);
  if (!closed.ok)
    expect(closed.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
});

it("stops between decoding steps when cancelled", async () => {
  const path = await write("catalog.bin", binaryCatalog(largeCatalog()));
  const controller = new AbortController();
  const provider = new UnityAddressablesProvider(undefined, () => {
    controller.abort(new Error("stop"));
    return Promise.resolve();
  });
  try {
    const result = await provider.inspect(
      { path },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  } finally {
    await provider.close();
  }
});
