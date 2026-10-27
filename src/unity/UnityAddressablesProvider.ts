import { setImmediate } from "node:timers/promises";
import {
  completedStableArtifact,
  readStableArtifact,
  type StableArtifactSnapshot,
} from "../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  assertArtifactReadActive,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { UnityAddressablesPort } from "../application/unity/UnityAddressablesPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { createEvidence } from "../domain/evidence.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  unityAddressablesSchema,
  type UnityAddressables,
  type UnityAddressablesProviderInput,
} from "../domain/unity/unityAddressables.js";
import { createUnityAddressablesAdmission } from "./UnityAddressablesAdmission.js";
import { readUnityAddressablesCatalogSteps } from "./UnityAddressablesCatalog.js";
import { UnityAddressablesFormatFailure } from "./UnityAddressablesFormat.js";

/** Bundled format reader identity; the catalog format version is a separate observed fact. */
export const UNITY_ADDRESSABLES_PROVIDER_IDENTITY = {
  id: "unity-addressables",
  name: "REA Unity Addressables catalog reader",
  version: "1",
} as const;
const OPERATION = "inspect_unity_addressables";
// Shipped catalogs are kilobytes to tens of megabytes.
const INPUT_BYTES = 256 * 1024 * 1024;
// catalog.hash holds one Hash128 string.
const HASH_BYTES = 4096;
const OUTPUT_BYTES = 64 * 1024 * 1024;

type Artifact = UnityAddressables["artifact"];
type Field = "path" | "hash_path";
interface Observed {
  artifact?: Artifact;
  counts?: { keys: number; locations: number };
  hash?: Artifact;
}

interface FailureSite {
  readonly path: string;
  readonly field: Field;
  readonly maximum: number;
}

const formatFailure = (
  cause: UnityAddressablesFormatFailure,
  { path, field }: FailureSite,
): AnalysisError => {
  switch (cause.kind) {
    case "capacity":
      return new AnalysisResourceConstraintError(
        OPERATION,
        "capacity",
        cause.message,
        {},
        {
          cause,
          ...fixedAllowanceOptions(
            "The Unity Addressables catalog allowance",
            "count",
          ),
        },
      );
    case "unsupported":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        cause.message,
        {
          cause,
        },
      );
    case "malformed":
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: [field],
          reason: "invalid_format",
          message: `Selected catalog ${path} is malformed: ${cause.message}`,
        },
      ]);
  }
};

/** Typed refusal for a bounded stable read; undefined leaves the cause to later mappings. */
const readFailure = (
  cause: ArtifactReaderFailure,
  { path, field, maximum }: FailureSite,
): AnalysisError | undefined => {
  switch (cause.reason) {
    case "integrity":
      return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
        cause,
      });
    case "cancelled":
      return new AnalysisCancelledError(OPERATION, {
        cause: artifactFileCancellationCause(cause),
      });
    case "limit":
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { maximum_input_bytes: maximum },
        {
          cause,
          ...fixedAllowanceOptions(
            "the fixed Unity Addressables input allowance",
            "input",
          ),
        },
      );
    case "path":
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: [field], reason: "invalid_format", message: cause.message },
      ]);
    default:
      return undefined;
  }
};

const UNREADABLE_PATH_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "EISDIR",
]);

const systemFailure = (
  cause: Error & { code: unknown },
  { path, field }: FailureSite,
): AnalysisError | undefined => {
  const code = String(cause.code);
  if (code === "EACCES" || code === "EPERM")
    return new AnalysisAccessDeniedError(OPERATION, path, code, { cause });
  if (!UNREADABLE_PATH_CODES.has(code)) return undefined;
  return new AnalysisInputError(OPERATION, { cause }, [
    {
      path: [field],
      reason: "invalid_value",
      message: `Selected artifact could not be read (${code}): ${path}.`,
    },
  ]);
};

const failureForPrimary = (
  cause: unknown,
  path: string,
  field: Field,
  maximum: number,
): AnalysisError => {
  const site = { path, field, maximum };
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof UnityAddressablesFormatFailure)
    return formatFailure(cause, site);
  const typed =
    cause instanceof ArtifactReaderFailure
      ? readFailure(cause, site)
      : cause instanceof Error && "code" in cause
        ? systemFailure(cause, site)
        : undefined;
  return (
    typed ??
    new ProviderAdapterError(
      UNITY_ADDRESSABLES_PROVIDER_IDENTITY.id,
      OPERATION,
      {
        cause,
        diagnostics: {
          path,
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      },
    )
  );
};

const failureFor = (
  cause: unknown,
  path: string,
  signal: AbortSignal | undefined,
  field: Field = "path",
  maximum = INPUT_BYTES,
): AnalysisError => {
  const primary =
    cause instanceof ArtifactFileCleanupFailure &&
    cause.fileCleanupFailure.outcome.kind === "failed"
      ? failureForPrimary(
          cause.fileCleanupFailure.outcome.cause,
          path,
          field,
          maximum,
        )
      : cause instanceof ArtifactFileCleanupFailure && signal?.aborted
        ? new AnalysisCancelledError(OPERATION, { cause: signal.reason })
        : failureForPrimary(cause, path, field, maximum);
  if (
    cause instanceof ArtifactReaderFailure &&
    cause.partialObservation !== undefined &&
    primary.partialObservation === undefined
  )
    primary.retainPartialObservation(cause.partialObservation);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    UNITY_ADDRESSABLES_PROVIDER_IDENTITY.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  const error = analysisErrorWithCleanupFailure(primary, cleanup, OPERATION);
  bindArtifactFileCleanup(cause, error);
  return error;
};

const completeReportRecovery =
  "The Unity Addressables complete-report allowance is a fixed report allowance. No complete catalog inventory is retained. Source facts already observed stay with this refusal, and complete CLI JSON does not raise the allowance. Repeating the unchanged request fails the same way.";

const reportLimit = (path: string, maximumBytes: number) =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "memory",
    `The complete Addressables catalog report for ${path} exceeds the retained report budget; no complete inventory is retained.`,
    { maximum_report_bytes: maximumBytes },
    { retryable: false, remediationAction: completeReportRecovery },
  );

const sourceArtifact = (
  path: string,
  snapshot: StableArtifactSnapshot,
): Artifact => ({
  path,
  sha256: snapshot.sha256,
  bytes: snapshot.bytes.length,
});

/** Source identity survives a failed inventory without claiming decoded coverage. */
const catalogSourceEvidence = (
  artifact: Artifact,
  counts: { keys: number; locations: number } | undefined,
  hash: { path: string; artifact?: Artifact } | undefined,
) =>
  createEvidence(
    { path: artifact.path, sha256: artifact.sha256, format: "file" },
    UNITY_ADDRESSABLES_PROVIDER_IDENTITY,
    {
      operation: "observe_unity_addressables_source",
      predicateType: "rea.unity-addressables-source",
      parameters: {
        path: artifact.path,
        ...(hash === undefined ? {} : { hash_path: hash.path }),
      },
      result: {
        artifact,
        inventory_status: "not-returned-as-complete",
        ...(counts === undefined ? {} : { declared_row_counts: { ...counts } }),
        ...(hash === undefined
          ? {}
          : {
              selected_hash_file: {
                path: hash.path,
                identity_status:
                  hash.artifact === undefined ? "unavailable" : "observed",
                ...(hash.artifact === undefined
                  ? {}
                  : {
                      sha256: hash.artifact.sha256,
                      bytes: hash.artifact.bytes,
                    }),
              },
            }),
      },
      confidence: "observed",
      limitations: [
        "This partial source observation does not contain a complete catalog inventory. Row counts, when present, are the key and location counts the catalog declares; their rows were not all decoded.",
      ],
      locations: [
        { kind: "artifact-path", path: artifact.path },
        { kind: "file-offset-range", start: 0, end: artifact.bytes },
      ],
    },
  );

/** catalog.hash text: printable ASCII with trailing whitespace removed, else null. */
const hashText = (bytes: Buffer): string | null => {
  const text = bytes.toString("latin1").replace(/\s+$/u, "");
  return /^[\x20-\x7e]*$/u.test(text) ? text : null;
};

/** Report limitations per decoded format; hash wording appears only when a hash file was read. */
const catalogLimitations = (
  format: UnityAddressables["format"],
  hashFile: boolean,
): string[] => [
  "Only Addressables content catalogs are decoded: JSON catalogs (key, bucket, entry and extra data) and binary catalogs with header version 2 (Addressables 2.x) or 3 (Addressables 4.x). Binary version 1 from the optional 1.21/1.22 binary define is unsupported.",
  "Keys, locations, provider ids, resource types and bundle hash, CRC, name and size are observed catalog content. No asset bundle is opened, so bundle bytes, CRC agreement and asset contents are not verified.",
  "Internal ids keep runtime placeholders such as {UnityEngine.AddressableAssets.Addressables.RuntimePath}; their runtime values, and any InternalIdTransformFunc or remote catalog override, are unknown.",
  format === "json"
    ? "Dependencies are derived the way the runtime locator resolves them: the locations of the entry's dependency key. Prefix-compressed internal ids are expanded from m_InternalIdPrefixes."
    : "Dependencies are the location records in each binary dependency array. dependency_hash is the stored field; the runtime computes its own value from the array offset.",
  "Location data other than asset bundle request options reports its serialized type name only.",
  ...(!hashFile
    ? []
    : [
        "catalog.hash is a caller-selected file whose text is reported as is; it is not recomputed or compared with the catalog bytes.",
      ]),
];

/** Stable in-process decoding without subprocesses, temporary files, network access or bundle reads. */
export class UnityAddressablesProvider implements UnityAddressablesPort {
  readonly identity = UNITY_ADDRESSABLES_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();
  #inspecting = false;
  #admissionStopped = false;

  /** `outputBytes` exists so tests can reach the guard with small files. */
  constructor(
    private readonly outputBytes: number = OUTPUT_BYTES,
    private readonly yieldControl: () => Promise<void> = setImmediate,
  ) {}

  /** Stop admission, then release every open file; cleanup failures keep their resources. */
  async close(): Promise<void> {
    this.#admissionStopped = true;
    await this.#resources.close().catch((cause: unknown) => {
      if (!(cause instanceof ArtifactReaderFailure) || !cause.cleanup)
        throw cause;
      const { resources, reason } = cause.cleanup;
      const error = new ProviderCleanupError(
        UNITY_ADDRESSABLES_PROVIDER_IDENTITY.id,
        resources,
        { reason },
        { cause, operation: OPERATION },
      );
      bindArtifactFileCleanup(cause, error);
      throw error;
    });
  }

  /** Admission order: caller cancellation, then a closed reader, then the one active inspection. */
  #refusal(signal: AbortSignal | undefined): AnalysisError | undefined {
    if (signal?.aborted)
      return new AnalysisCancelledError(OPERATION, { cause: signal.reason });
    if (this.#admissionStopped)
      return new AnalysisCapabilityUnavailableError(
        UNITY_ADDRESSABLES_PROVIDER_IDENTITY.id,
        OPERATION,
        "Unity Addressables catalog reader is closed",
        {
          remediationAction:
            "This reader has stopped admitting inspections. Create a new Unity Addressables catalog reader to inspect again. Repeating the request on this reader fails the same way.",
        },
      );
    if (!this.#inspecting) return undefined;
    return new AnalysisResourceConstraintError(
      OPERATION,
      "capacity",
      "Only one Unity Addressables catalog inspection is admitted per reader.",
      { maximum_concurrent_inspections: 1 },
      {
        remediationAction:
          "Retry after the active Unity Addressables catalog inspection on this reader completes.",
      },
    );
  }

  /** Read every key and location from one stable catalog snapshot. */
  async inspect(
    input: UnityAddressablesProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnityAddressables, AnalysisError>> {
    const refused = this.#refusal(options?.signal);
    if (refused !== undefined) return err(refused);
    this.#inspecting = true;
    const observed: Observed = {};
    const selectedHash = () =>
      input.hash_path === undefined
        ? undefined
        : {
            path: input.hash_path,
            ...(observed.hash === undefined ? {} : { artifact: observed.hash }),
          };
    try {
      return await this.#resources.run(async () => {
        const snapshot = await this.#readArtifact(
          input.path,
          INPUT_BYTES,
          options?.signal,
          (artifact) => {
            observed.artifact = artifact;
          },
        );
        const artifact = sourceArtifact(input.path, snapshot);
        assertArtifactReadActive(options?.signal);
        const limit = this.outputBytes;
        const admission = createUnityAddressablesAdmission(limit, () => {
          throw reportLimit(input.path, limit);
        });
        const steps = readUnityAddressablesCatalogSteps(snapshot.bytes, {
          ...admission,
          beforeRows: (counts) => {
            observed.counts = counts;
            admission.beforeRows(counts);
          },
        });
        let step = steps.next();
        while (!step.done) {
          await this.yieldControl();
          assertArtifactReadActive(options?.signal);
          step = steps.next();
        }
        const decoded = step.value;
        const hashFile = await this.#readHashFile(
          input,
          artifact,
          observed,
          options?.signal,
        );
        if (hashFile !== null && "error" in hashFile)
          return err(hashFile.error);
        const report = {
          ...decoded,
          artifact,
          hash_file: hashFile,
          limitations: catalogLimitations(decoded.format, hashFile !== null),
        };
        if (jsonValueByteLength(report, limit) > limit)
          throw reportLimit(input.path, limit);
        const parsed = unityAddressablesSchema.safeParse(report);
        if (!parsed.success)
          throw new AnalysisOutputError(
            OPERATION,
            "Unity Addressables catalog reader produced inconsistent key or location indices.",
            { cause: parsed.error },
          );
        assertArtifactReadActive(options?.signal);
        return ok(parsed.data);
      });
    } catch (cause: unknown) {
      const failure = failureFor(cause, input.path, options?.signal);
      if (observed.artifact !== undefined)
        failure.partialObservation = catalogSourceEvidence(
          observed.artifact,
          observed.counts,
          selectedHash(),
        );
      return err(failure);
    } finally {
      this.#inspecting = false;
    }
  }

  /** Optional catalog.hash: a failure keeps the catalog identity it already observed. */
  async #readHashFile(
    input: UnityAddressablesProviderInput,
    artifact: Artifact,
    observed: Observed,
    signal: AbortSignal | undefined,
  ): Promise<UnityAddressables["hash_file"] | { error: AnalysisError }> {
    if (input.hash_path === undefined) return null;
    try {
      const hash = await this.#readArtifact(
        input.hash_path,
        HASH_BYTES,
        signal,
        (value) => {
          observed.hash = value;
        },
      );
      assertArtifactReadActive(signal);
      return {
        artifact: sourceArtifact(input.hash_path, hash),
        text: hashText(hash.bytes),
      };
    } catch (cause: unknown) {
      const error = failureFor(
        cause,
        input.hash_path,
        signal,
        "hash_path",
        HASH_BYTES,
      );
      error.partialObservation = catalogSourceEvidence(
        artifact,
        observed.counts,
        {
          path: input.hash_path,
          ...(observed.hash === undefined ? {} : { artifact: observed.hash }),
        },
      );
      return { error };
    }
  }

  /** Report the identity of every completed read, including one whose cleanup then failed. */
  async #readArtifact(
    path: string,
    maximum: number,
    signal: AbortSignal | undefined,
    observe: (artifact: Artifact) => void,
  ): Promise<StableArtifactSnapshot> {
    const snapshot = await readStableArtifact(
      path,
      maximum,
      signal,
      undefined,
      this.#resources,
    ).catch((cause: unknown) => {
      const completed = completedStableArtifact(cause);
      if (completed !== undefined) observe(sourceArtifact(path, completed));
      throw cause;
    });
    observe(sourceArtifact(path, snapshot));
    return snapshot;
  }
}
