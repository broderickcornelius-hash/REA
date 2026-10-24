import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  MAX_FIRMWARE_STAGING_BYTES,
  MAX_FIRMWARE_STAGING_ENTRIES,
} from "../../../src/domain/firmware/firmwareAnalysis.js";
import { inventoryFirmwareOutput } from "../../../src/firmware/FirmwareFiles.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/**
 * The ceiling recovery must be established by the refusal the inventory
 * actually throws, not only by the wording helper: a wiring change that passed
 * the schema ceiling where the selected value belongs, or that dropped the
 * remediation, would keep the helper test green.
 */

it("refuses staging bytes at the schema ceiling with the ceiling recovery", async () => {
  const root = await createTestTempDirectory("rea-firmware-ceiling-bytes-");
  // A sparse file reports its declared size without storing the bytes, so the
  // refusal is exercised at the real schema ceiling rather than a toy budget.
  const sparse = await open(join(root, "oversized.bin"), "w");
  try {
    await sparse.truncate(MAX_FIRMWARE_STAGING_BYTES + 1);
  } finally {
    await sparse.close();
  }

  const rejected = await inventoryFirmwareOutput(
    root,
    MAX_FIRMWARE_STAGING_BYTES,
    MAX_FIRMWARE_STAGING_ENTRIES,
    "extract_firmware",
  ).catch((cause: unknown) => cause);

  expect(rejected).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    resource: "capacity",
    retryable: false,
  });
  const projected = projectAnalysisError(rejected as never);
  expect(projected).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      reported_limits: { max_output_bytes: MAX_FIRMWARE_STAGING_BYTES },
    },
  });
  // The production refusal, not the helper alone, must carry ceiling recovery.
  expect(projected.remediation.action).toContain("not supported");
  expect(projected.remediation.action).not.toContain("Increase");
  expect(projected.remediation.action).toContain("smaller firmware byte range");
});

it("still offers a raise for a budget below the schema ceiling", async () => {
  const root = await createTestTempDirectory("rea-firmware-below-ceiling-");
  await writeFile(join(root, "one.bin"), "12");

  const rejected = await inventoryFirmwareOutput(
    root,
    1,
    MAX_FIRMWARE_STAGING_ENTRIES,
    "extract_firmware",
  ).catch((cause: unknown) => cause);

  const projected = projectAnalysisError(rejected as never);
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: { reported_limits: { max_output_bytes: 1 } },
  });
  expect(projected.remediation.action).toContain(
    `Increase max_output_bytes up to ${String(MAX_FIRMWARE_STAGING_BYTES)}`,
  );
  expect(projected.remediation.action).not.toContain("not supported");
});

// The entry ceiling needs more staged entries than the schema permits, so the
// at-ceiling entry wording stays covered by
// src/firmware/FirmwareStagingBudget.test.ts and the below-ceiling entry wiring
// by firmwareReportFiles.test.ts.
