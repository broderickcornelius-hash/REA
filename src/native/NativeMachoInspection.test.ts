import { describe, expect, it } from "vitest";

import {
  CPU,
  LC,
  dylibCommand,
  fatImage,
  machoImage,
} from "../artifacts/apple/MachoImage.fixture.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";
import { parseMachoLayout, selectMachoSlice } from "./AppleMachoSelection.js";
import type { NativeCommandCapture } from "./CommandRunner.js";
import type { MachoSliceEncryption } from "../domain/apple/machoEncryption.js";
import { inspectMachoSchema } from "../domain/native/nativeInspection.js";
import {
  inspectNativeMacho,
  type MachoEncryptionRead,
} from "./NativeMachoInspection.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
  withOtoolMachHeader,
} from "../../tests/fixtures/nativeCommands.js";

const unreadEncryption = () =>
  Promise.resolve({
    status: "unread",
    reason: "not read in this test",
  } as const);

const capture = (tool: string, stdout: string): NativeCommandCapture => ({
  tool,
  executable: tool,
  executableSha256: "a".repeat(64),
  toolVersion: null,
  versionReason: null,
  arguments: [],
  stdout,
  stderr: "",
  stdoutBytes: stdout.length,
  stderrBytes: 0,
  exitCode: 0,
  signal: null,
});

const inspect = async (lipo: string, architecture: "x86" | "arm64") => {
  const commands: {
    readonly tool: string;
    readonly args: readonly string[];
  }[] = [];
  const result = await inspectNativeMacho({
    target: {
      kind: "executable",
      format: "mach-o",
      path: "/fixture/app",
      sha256: "b".repeat(64),
      architecture,
      availableArchitectures: ["x86", "arm64"],
    },
    run: (tool, args) => {
      commands.push({ tool, args });
      if (tool === "lipo") return Promise.resolve(ok(capture(tool, lipo)));
      return Promise.resolve(err(new AnalysisCancelledError("inspect_native")));
    },
    invocation: () => {
      throw new Error("invocation is not reached");
    },
    readEncryption: unreadEncryption,
  });
  return { result, commands };
};

describe("Mach-O tool architecture selection", () => {
  it("rejects a CPU lipo did not list instead of reading another slice", async () => {
    const { result, commands } = await inspect("architecture arm64\n", "x86");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisOutputError",
      reason: "lipo did not list i386; refusing to read another slice",
    });
    expect(commands.map(({ tool }) => tool)).toEqual(["lipo"]);
  });

  it("passes the arm64e slice lipo listed for an arm64 target", async () => {
    const { commands } = await inspect("architecture arm64e\n", "arm64");
    const otool = commands.find(({ tool }) => tool === "otool");
    expect(otool?.args).toEqual([
      "-h",
      "-l",
      "-arch",
      "arm64e",
      "/fixture/app",
    ]);
  });

  it.each([
    { names: ["arm64v8", "arm64e"], selected: "arm64e" },
    { names: ["arm64e", "arm64v8"], selected: "arm64e" },
    { names: ["arm64v8", "arm64e", "arm64"], selected: "arm64" },
    { names: ["arm64v8"], selected: "arm64v8" },
    { names: ["arm64v8", "arm64e.x1"], selected: "arm64v8" },
    { names: ["arm64e.x1", "arm64v8"], selected: "arm64v8" },
    { names: ["arm64v8", "arm64e.v1"], selected: "arm64e.v1" },
    { names: ["arm64e.v1", "arm64v8"], selected: "arm64e.v1" },
  ] as const)(
    "keeps inspection and dispatch on $selected for FAT order $names",
    async ({ names, selected }) => {
      const cpus = {
        arm64: CPU.arm64,
        arm64v8: { type: CPU.arm64.type, subtype: 1 },
        arm64e: CPU.arm64e,
        "arm64e.x1": { type: CPU.arm64.type, subtype: 0x8000000c },
        "arm64e.v1": { type: CPU.arm64.type, subtype: 0x81000002 },
      };
      const slices = names.map((name) => {
        const cpu = cpus[name];
        return {
          cpu,
          bytes: machoImage({
            cpu,
            commands: [dylibCommand(LC.LOAD_DYLIB, `/fixture/${name}.dylib`)],
          }),
        };
      });
      const fat = Buffer.from(fatImage(slices));
      const lipo = names
        .map(
          (name, index) =>
            `architecture ${name}\n cputype ${cpus[name].type}\n cpusubtype ${cpus[name].subtype}\n offset ${(index + 1) * 4096}\n size ${slices[index]?.bytes.length}\n align 2^12\n`,
        )
        .join("");
      const { commands } = await inspect(lipo, "arm64");
      expect(commands.find(({ tool }) => tool === "otool")?.args).toEqual([
        "-h",
        "-l",
        "-arch",
        selected.split(".")[0],
        "/fixture/app",
      ]);
      expect(commands.find(({ tool }) => tool === "dyld_info")?.args).toContain(
        selected,
      );
      expect(selectMachoSlice(fat, "arm64").slice).toBe(
        (names.findIndex((name) => name === selected) + 1) * 4096,
      );
      expect(parseMachoLayout(fat, "arm64").fixups.dylibs).toEqual([
        `/fixture/${selected}.dylib`,
      ]);
    },
  );
});

describe("Mach-O inspection container format", () => {
  const runInspection = async (lipo: string) => {
    const runner = new NativeFixtureRunner({ lipo });
    return inspectNativeMacho({
      target: nativeMachoTarget("/fixture/app"),
      run: (tool, args) => runner.run(tool, args),
      invocation: (capture) => ({
        tool: capture.tool,
        command: [capture.executable, ...capture.arguments],
        tool_version: capture.toolVersion,
        version_reason: capture.versionReason,
        executable_sha256: capture.executableSha256,
        exit: { code: capture.exitCode, signal: capture.signal },
        stdout_bytes: capture.stdoutBytes,
        stderr_bytes: capture.stderrBytes,
      }),
      readEncryption: unreadEncryption,
    });
  };

  it.each([
    {
      framing: "one-slice FAT",
      lipo: `Fat header in: /fixture/app\nfat_magic 0xcafebabe\nnfat_arch 1\narchitecture arm64\n cputype CPU_TYPE_ARM64\n cpusubtype CPU_SUBTYPE_ARM64_ALL\n offset 4096\n size 128\n align 2^12\n`,
      expected: "mach-o-universal",
    },
    {
      framing: "thin",
      lipo: "Non-fat file: /fixture/app is architecture: arm64\n",
      expected: "mach-o",
    },
  ] as const)("reports parsed $framing framing", async ({ lipo, expected }) => {
    const result = await runInspection(lipo);
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ format: expected });
  });

  it("does not call a lazy-info payload dependency exhaustive", async () => {
    const runner = new NativeFixtureRunner({
      lipo: "Non-fat file: /fixture/app is architecture: arm64\n",
      "otool:-h": withOtoolMachHeader(
        [
          "Load command 0",
          "      cmd LC_LOAD_DYLIB",
          "  cmdsize 56",
          "         name /usr/lib/libSystem.B.dylib (offset 24)",
          "   time stamp 2 Thu Jan  1 00:00:02 1970",
          "      current version 1.0.0",
          "compatibility version 1.0.0",
          "Load command 1",
          "      cmd LC_LAZY_LOAD_DYLIB_INFO",
          "  cmdsize 16",
          "    dataoff 49304",
          "   datasize 56",
        ].join("\n"),
      ),
    });
    const result = await inspectNativeMacho({
      target: nativeMachoTarget("/fixture/app"),
      run: (tool, args) => runner.run(tool, args),
      readEncryption: unreadEncryption,
      invocation: (captured) => ({
        tool: captured.tool,
        command: [captured.executable, ...captured.arguments],
        tool_version: captured.toolVersion,
        version_reason: captured.versionReason,
        executable_sha256: captured.executableSha256,
        exit: { code: captured.exitCode, signal: captured.signal },
        stdout_bytes: captured.stdoutBytes,
        stderr_bytes: captured.stderrBytes,
      }),
    });
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({
      load_commands: {
        items: [{ kind: "LC_LOAD_DYLIB" }, { kind: "LC_LAZY_LOAD_DYLIB_INFO" }],
      },
      dependencies: {
        exhaustive: false,
        total: null,
        items: [
          {
            path: "/usr/lib/libSystem.B.dylib",
            kind: "LC_LOAD_DYLIB",
          },
        ],
        limitations: [expect.stringContaining("1 LC_LAZY_LOAD_DYLIB_INFO")],
      },
    });
  });
});

describe("Mach-O UUID reconciliation", () => {
  const validUuid = "01234567-89AB-CDEF-0123-456789ABCDEF";

  const runInspection = async (
    dwarfdump: string,
    otoolUuids: readonly string[] = [validUuid],
    targetPath = "/fixture/app",
  ) => {
    const runner = new NativeFixtureRunner({
      dwarfdump,
      otool: withOtoolMachHeader(
        otoolUuids
          .map(
            (uuid, index) =>
              `Load command ${index}\n      cmd LC_UUID\n  cmdsize 24\n     uuid ${uuid}`,
          )
          .join("\n"),
      ),
    });
    const result = await inspectNativeMacho({
      target: nativeMachoTarget(targetPath),
      run: (tool, args) => runner.run(tool, args),
      readEncryption: unreadEncryption,
      invocation: (capture) => ({
        tool: capture.tool,
        command: [capture.executable, ...capture.arguments],
        tool_version: capture.toolVersion,
        version_reason: capture.versionReason,
        executable_sha256: capture.executableSha256,
        exit: { code: capture.exitCode, signal: capture.signal },
        stdout_bytes: capture.stdoutBytes,
        stderr_bytes: capture.stderrBytes,
      }),
    });
    return result;
  };

  it("keeps a valid otool UUID when dwarfdump is malformed and reports the limitation", async () => {
    const result = await runInspection("UUID: A (arm64) /fixture/app\n");
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: validUuid });
    expect(result.value.limitations).toContain(
      'dwarfdump --uuid returned malformed UUID "A"; using the unambiguous otool LC_UUID.',
    );
  });

  it("does not choose between conflicting valid UUIDs", async () => {
    const result = await runInspection(
      `UUID: FEDCBA98-7654-3210-FEDC-BA9876543210 (arm64) /fixture/app\n`,
    );
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: null });
    expect(result.value.limitations).toContain(
      `dwarfdump --uuid (FEDCBA98-7654-3210-FEDC-BA9876543210) conflicts with otool LC_UUID (${validUuid}); the image UUID is unknown.`,
    );
  });

  it("accepts matching UUIDs with different case and preserves dwarfdump spelling", async () => {
    const lower = validUuid.toLowerCase();
    const result = await runInspection(`UUID: ${lower} (arm64) /fixture/app\n`);
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: lower });
  });

  it("uses a valid dwarfdump UUID when otool has no UUID observation", async () => {
    const result = await runInspection(
      `UUID: ${validUuid} (arm64) /fixture/app\n`,
      [],
    );
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: validUuid });
  });

  it("frames a path containing a newline and UUID-like text as one dwarfdump row", async () => {
    const path =
      "/fixture/\nUUID: FEDCBA98-7654-3210-FEDC-BA9876543210 (arm64) fake";
    const result = await runInspection(
      `UUID: ${validUuid} (arm64) ${path}\n`,
      [validUuid],
      path,
    );
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: validUuid });
  });

  it("keeps a conflict between duplicate valid LC_UUID commands unknown despite dwarfdump", async () => {
    const result = await runInspection(
      `UUID: ${validUuid} (arm64) /fixture/app\n`,
      [validUuid, "FEDCBA98-7654-3210-FEDC-BA9876543210"],
      "/fixture/app",
    );
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: null });
    expect(result.value.limitations).toContain(
      `otool returned conflicting LC_UUID values ${JSON.stringify(validUuid)} and ${JSON.stringify("FEDCBA98-7654-3210-FEDC-BA9876543210")}`,
    );
  });

  it("keeps conflicting duplicate dwarfdump rows unknown despite otool", async () => {
    const conflictingUuid = "FEDCBA98-7654-3210-FEDC-BA9876543210";
    const result = await runInspection(
      `UUID: ${validUuid} (arm64) /fixture/app\nUUID: ${conflictingUuid} (arm64) /fixture/app\n`,
    );
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: null });
    expect(result.value.limitations).toContain(
      "dwarfdump --uuid returned conflicting UUIDs for selected architecture arm64",
    );
  });
});

describe("Mach-O slice command scheduling", () => {
  const SLICE_TOOLS = ["otool", "nm", "dyld_info", "dyld_info", "dwarfdump"];

  /** Finish later-launched slice commands first and record overlap. */
  const reorderingRunner = (failing: ReadonlySet<string> = new Set()) => {
    const fixtures = new NativeFixtureRunner();
    let inFlight = 0;
    let maxInFlight = 0;
    let launched = 0;
    const run = async (tool: string, args: readonly string[]) => {
      if (tool === "lipo") return fixtures.run(tool, args);
      const order = launched++;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      for (let turn = 0; turn < 12 - order * 2; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      if (failing.has(tool))
        return err(new AnalysisOutputError("inspect_macho", `${tool} failed`));
      return fixtures.run(tool, args);
    };
    return { run, maxInFlight: () => maxInFlight };
  };

  const inspectWith = (run: ReturnType<typeof reorderingRunner>["run"]) =>
    inspectNativeMacho({
      target: nativeMachoTarget("/fixture/app"),
      run,
      readEncryption: unreadEncryption,
      invocation: (capture) => ({
        tool: capture.tool,
        command: [capture.executable, ...capture.arguments],
        tool_version: capture.toolVersion,
        version_reason: capture.versionReason,
        executable_sha256: capture.executableSha256,
        exit: { code: capture.exitCode, signal: capture.signal },
        stdout_bytes: capture.stdoutBytes,
        stderr_bytes: capture.stderrBytes,
      }),
    });

  it("runs independent slice commands together and keeps provenance in declared order", async () => {
    const runner = reorderingRunner();
    const result = await inspectWith(runner.run);
    if (!result.ok) throw result.error;
    expect(runner.maxInFlight()).toBe(SLICE_TOOLS.length + 1);
    expect(result.value.result).toMatchObject({
      provenance: ["lipo", ...SLICE_TOOLS, "vtool"].map((tool) => ({
        tool,
      })),
    });
  });

  it("reports the first failing slice command in declared order", async () => {
    const runner = reorderingRunner(new Set(["nm", "dwarfdump"]));
    const result = await inspectWith(runner.run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ reason: "nm failed" });
  });
});

describe("Mach-O encryption reporting", () => {
  const slice = (
    overrides: Partial<MachoSliceEncryption> = {},
  ): MachoSliceEncryption => ({
    architecture: null,
    cpu_type: 16777228,
    cpu_subtype: 0,
    container_file_offset: 32768,
    size: 8192,
    status: "absent",
    reason: null,
    commands: [],
    range: null,
    ...overrides,
  });
  const encrypted = (start: number, end: number) =>
    slice({
      status: "encrypted",
      commands: [
        {
          kind: "LC_ENCRYPTION_INFO_64",
          index: 1,
          cmdsize: 24,
          cryptoff: start,
          cryptsize: end - start,
          cryptid: 1,
          pad: 0,
        },
      ],
      range: {
        content: "ciphertext",
        slice_start: start,
        slice_end: end,
        container_start: 32768 + start,
        container_end: 32768 + end,
        mapping: { status: "mapped", fragments: [], sections: [] },
      },
    });
  const inspectEncryption = async (encryption: MachoEncryptionRead) => {
    const runner = new NativeFixtureRunner();
    const result = await inspectNativeMacho({
      target: nativeMachoTarget("/fixture/app"),
      run: (tool, args) => runner.run(tool, args),
      readEncryption: () => Promise.resolve(encryption),
      invocation: (capture) => ({
        tool: capture.tool,
        command: [capture.executable, ...capture.arguments],
        tool_version: capture.toolVersion,
        version_reason: capture.versionReason,
        executable_sha256: capture.executableSha256,
        exit: { code: capture.exitCode, signal: capture.signal },
        stdout_bytes: capture.stdoutBytes,
        stderr_bytes: capture.stderrBytes,
      }),
    });
    if (!result.ok) throw result.error;
    return {
      encryption: inspectMachoSchema.parse(result.value.result).encryption,
      limitations: result.value.limitations,
    };
  };

  it("labels every slice with the lipo record at its offset and names ciphertext bytes", async () => {
    const x86 = slice({
      cpu_type: 16777223,
      cpu_subtype: 3,
      container_file_offset: 16384,
      size: 4096,
    });
    const { encryption, limitations } = await inspectEncryption({
      status: "parsed",
      slices: [x86, encrypted(4096, 6144)],
    });
    expect(encryption).toMatchObject({ total: 2, exhaustive: true });
    expect(encryption.items.map(({ architecture }) => architecture)).toEqual([
      "x86_64",
      "arm64",
    ]);
    expect(limitations).toContain(
      "Bytes 36864-38912 (input file offsets, end exclusive) of the arm64 slice are ciphertext (cryptid 1); disassembly, decompilation, strings and references derived from them do not describe program code.",
    );
  });

  it("leaves a slice lipo did not describe unlabeled", async () => {
    const { encryption, limitations } = await inspectEncryption({
      status: "parsed",
      slices: [
        slice({
          container_file_offset: 49152,
          status: "malformed",
          reason: "load commands is truncated",
        }),
      ],
    });
    expect(encryption.items[0]?.architecture).toBeNull();
    expect(limitations).toContain(
      "Encryption status of the slice at offset 49152 is malformed: load commands is truncated.",
    );
  });

  it("does not mark bytes as ciphertext for an empty encrypted range", async () => {
    const { limitations } = await inspectEncryption({
      status: "parsed",
      slices: [encrypted(4096, 4096)],
    });
    expect(limitations).toContain(
      "The arm64 slice declares encryption (cryptid 1) over an empty range; no bytes are marked as ciphertext.",
    );
    expect(limitations.some((line) => line.includes("are ciphertext"))).toBe(
      false,
    );
  });

  it("keeps encryption unknown when the bytes were not read", async () => {
    const { encryption, limitations } = await inspectEncryption({
      status: "unread",
      reason: "the target could not be opened for reading (ENOENT)",
    });
    expect(encryption).toEqual({
      items: [],
      total: null,
      exhaustive: false,
      limitations: [
        "Encryption load commands were not read: the target could not be opened for reading (ENOENT)",
      ],
    });
    expect(limitations).toContain(
      "Encryption load commands were not read: the target could not be opened for reading (ENOENT)",
    );
  });
});

it.each(["10", "DSYM", "2"])(
  "classifies the unbacked-text dyld refusal using observed file type %s",
  async (fileType) => {
    const diagnostic =
      "section '__TEXT/__text' has offset=0 but is not a zero-fill section type\n";
    const runner = new NativeFixtureRunner({
      otool: [
        "Mach header",
        "magic cputype cpusubtype caps filetype ncmds sizeofcmds flags",
        `0xfeedfacf 16777228 0 0x00 ${fileType} 0 0 0x0`,
      ].join("\n"),
    });
    const result = await inspectNativeMacho({
      target: nativeMachoTarget("/fixture/debug-companion"),
      run: async (tool, args, _signal, acceptNonZeroIf) => {
        const captured = await runner.run(tool, args);
        if (!captured.ok || tool !== "dyld_info") return captured;
        const refused = {
          ...captured.value,
          stdout: diagnostic,
          stdoutBytes: Buffer.byteLength(diagnostic),
          exitCode: 1,
        };
        if (acceptNonZeroIf?.(refused)) return ok(refused);
        return err(
          new AnalysisOutputError("inspect_macho", "unaccepted native failure"),
        );
      },
      readEncryption: unreadEncryption,
      invocation: () => {
        throw new Error(
          "Refused target does not produce inspection provenance",
        );
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe(
      fileType === "2"
        ? "AnalysisOutputError"
        : "AnalysisUnsupportedTargetError",
    );
    expect(result.error.capturedOutput).toMatchObject({
      stdout: diagnostic,
      exit_code: 1,
    });
  },
);
