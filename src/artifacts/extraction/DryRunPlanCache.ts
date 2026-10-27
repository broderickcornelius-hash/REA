import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveAsarHeaderAdmission } from "../AsarHeader.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import type { DestinationCaseSensitivity } from "../ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  type ArtifactReaderTraversal,
} from "../ArtifactReader.js";
import { assertArtifactSelectedSource } from "../ArtifactSelectedSource.js";
import { SafeOutputTree } from "../SafeOutputTree.js";
import {
  DEFAULT_DRY_RUN_PLAN_ENTRY_LIMIT,
  type ArtifactCommand,
  type ArtifactExtractionPlan,
  type ArtifactExtractionPlanEntry,
  type ArtifactExtractionResult,
  type ArtifactNode,
  type ArtifactOccurrence,
} from "../../domain/artifactGraph.js";
import type { ArtifactInventorySnapshot } from "../../domain/artifactInventorySnapshot.js";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import {
  regularFileState,
  sameRegularFileState,
  type RegularFileState,
} from "../../filesystem/RegularFile.js";
import type { ArtifactExtractionInput } from "./ArtifactExtraction.js";

export const MAX_DRY_RUN_PLAN_PAGE_BYTES = 512 * 1024;
const MAX_PORTABLE_POSIX_PATH_BYTES = 1023;
const MAX_VALIDATED_DRY_RUN_CACHE_ENTRIES = 8;

export interface DryRunSelectedOccurrence {
  readonly occurrence: ArtifactOccurrence;
  readonly node: ArtifactNode;
}

export interface DryRunExtractedOccurrence {
  readonly artifact_id: string;
  readonly relative_path: string;
  readonly sha256: string;
  readonly bytes_written: number;
  readonly created: boolean;
}

export interface UnresolvedDryRunPlan {
  readonly byOccurrenceId: ReadonlyMap<string, string>;
  readonly limitations: readonly string[];
}

export interface BuiltDryRunPlanCatalog {
  readonly allEntries: readonly ArtifactExtractionPlanEntry[];
  readonly totals: ArtifactExtractionPlan["totals"];
  readonly maxEntryPathBytes: number;
}

export interface CachedDryRunSnapshot {
  readonly inventory: ArtifactInventorySnapshot;
  readonly selected: readonly DryRunSelectedOccurrence[];
  readonly extracted: readonly DryRunExtractedOccurrence[];
  readonly traversal: ArtifactReaderTraversal;
  readonly materializationProvenance: readonly ArtifactCommand[];
  readonly unresolvedPlan: UnresolvedDryRunPlan;
  readonly catalog: BuiltDryRunPlanCatalog;
}

interface CachedValidatedDryRunPlan {
  readonly sourceFileState: RegularFileState;
  readonly destinationParent: string;
  readonly outputRootLength: number;
  readonly outputRootByteLength: number;
  readonly caseSensitivity: DestinationCaseSensitivity;
  readonly snapshot: CachedDryRunSnapshot;
}

const validatedDryRunPlanCache = new Map<string, CachedValidatedDryRunPlan>();

const estimateDryRunPlanEntryBytes = (
  entry: ArtifactExtractionPlanEntry,
): number => {
  const pathBytes = Buffer.byteLength(
    JSON.stringify(entry.logical_path),
    "utf8",
  );
  const reasonBytes =
    entry.reason === null
      ? 4
      : Buffer.byteLength(JSON.stringify(entry.reason), "utf8");
  return (
    pathBytes +
    reasonBytes +
    (entry.status === "planned" ? pathBytes + 180 : 0) +
    240
  );
};

export const sliceDryRunPlanCatalog = (
  catalog: BuiltDryRunPlanCatalog,
  pageOptions: { readonly offset: number; readonly limit: number } = {
    offset: 0,
    limit: DEFAULT_DRY_RUN_PLAN_ENTRY_LIMIT,
  },
): ArtifactExtractionPlan => {
  const totalEntries = catalog.allEntries.length;
  const maxEnd = Math.min(totalEntries, pageOptions.offset + pageOptions.limit);
  const pagedEntries: ArtifactExtractionPlanEntry[] = [];
  let pageBytes = 0;
  for (let index = pageOptions.offset; index < maxEnd; index += 1) {
    const entry = catalog.allEntries[index]!;
    const entryBytes = estimateDryRunPlanEntryBytes(entry);
    if (
      pagedEntries.length > 0 &&
      pageBytes + entryBytes > MAX_DRY_RUN_PLAN_PAGE_BYTES
    )
      break;
    pagedEntries.push(entry);
    pageBytes += entryBytes;
  }
  const nextOffset =
    pageOptions.offset + pagedEntries.length < totalEntries
      ? pageOptions.offset + pagedEntries.length
      : null;
  return {
    entries: pagedEntries,
    page: {
      total_entries: totalEntries,
      offset: pageOptions.offset,
      limit: pageOptions.limit,
      returned_entries: pagedEntries.length,
      next_offset: nextOffset,
      truncated: nextOffset !== null || pageOptions.offset > 0,
    },
    totals: catalog.totals,
  };
};

const dryRunCacheSourceKey = (
  sourcePath: string,
  input: ArtifactExtractionInput,
): string =>
  JSON.stringify([
    sourcePath,
    absoluteCallerPath(input.selectedPath ?? input.inputPath),
    input.inputFormat,
    input.platform ?? process.platform,
    input.integrityPolicy,
    input.asarHeaderAdmission ?? resolveAsarHeaderAdmission(input.environment),
  ]);

export const cacheValidatedDryRunPlan = async ({
  sourcePath,
  input,
  resolvedOutputRoot,
  caseSensitivity,
  snapshot,
  signal,
}: {
  readonly sourcePath: string;
  readonly input: ArtifactExtractionInput;
  readonly resolvedOutputRoot: string;
  readonly caseSensitivity: DestinationCaseSensitivity;
  readonly snapshot: CachedDryRunSnapshot;
  readonly signal: AbortSignal | undefined;
}): Promise<void> => {
  if (snapshot.inventory.occurrences.some((item) => item.unpacked === true))
    return;
  abortIfNeeded(signal);
  const sourceStats = await lstat(sourcePath);
  abortIfNeeded(signal);
  if (!sourceStats.isFile()) return;
  const key = dryRunCacheSourceKey(sourcePath, input);
  validatedDryRunPlanCache.delete(key);
  if (validatedDryRunPlanCache.size >= MAX_VALIDATED_DRY_RUN_CACHE_ENTRIES) {
    const oldestKey = validatedDryRunPlanCache.keys().next().value;
    if (oldestKey !== undefined) validatedDryRunPlanCache.delete(oldestKey);
  }
  validatedDryRunPlanCache.set(key, {
    sourceFileState: regularFileState(sourceStats),
    destinationParent: dirname(resolvedOutputRoot),
    outputRootLength: resolvedOutputRoot.length,
    outputRootByteLength: Buffer.byteLength(resolvedOutputRoot, "utf8"),
    caseSensitivity,
    snapshot,
  });
};

export const tryReuseValidatedDryRunPlan = async ({
  input,
  sourcePath,
  signal,
  buildResult,
}: {
  readonly input: ArtifactExtractionInput;
  readonly sourcePath: string;
  readonly signal: AbortSignal | undefined;
  readonly buildResult: (
    snapshot: CachedDryRunSnapshot,
  ) => ArtifactExtractionResult;
}): Promise<ArtifactExtractionResult | undefined> => {
  const key = dryRunCacheSourceKey(sourcePath, input);
  const cached = validatedDryRunPlanCache.get(key);
  if (cached === undefined) return undefined;
  abortIfNeeded(signal);
  const currentStats = await lstat(sourcePath);
  abortIfNeeded(signal);
  if (
    !currentStats.isFile() ||
    !sameRegularFileState(cached.sourceFileState, currentStats) ||
    (input.expectedRootSha256 !== undefined &&
      input.expectedRootSha256 !==
        cached.snapshot.inventory.manifest.root_sha256)
  ) {
    validatedDryRunPlanCache.delete(key);
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact root changed after dry-run plan validation: ${sourcePath}`,
    );
  }
  const destination = await SafeOutputTree.checkDestination(input.outputRoot, {
    resourceScope: input.resourceScope,
  });
  abortIfNeeded(signal);
  const resolvedOutputRoot =
    destination.canonicalOutput ?? absoluteCallerPath(input.outputRoot);
  const outputByteLength = Buffer.byteLength(resolvedOutputRoot, "utf8");
  const nearPathLengthLimit =
    (input.platform ?? process.platform) === "win32" ||
    Math.max(outputByteLength, cached.outputRootByteLength) +
      cached.snapshot.catalog.maxEntryPathBytes +
      1 >
      MAX_PORTABLE_POSIX_PATH_BYTES;
  if (
    dirname(resolvedOutputRoot) !== cached.destinationParent ||
    destination.caseSensitivity !== cached.caseSensitivity ||
    (nearPathLengthLimit &&
      (resolvedOutputRoot.length !== cached.outputRootLength ||
        outputByteLength !== cached.outputRootByteLength))
  )
    return undefined;
  if (input.expectedRootSha256 !== undefined)
    await assertArtifactSelectedSource(sourcePath, input.selectedPath);
  return buildResult(cached.snapshot);
};
