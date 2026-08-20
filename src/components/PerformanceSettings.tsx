import { AlertTriangle } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { PerformanceCapabilities } from "../core/performancePreferences";
import { useI18n } from "../i18n/I18nProvider";

export type PerformanceSettingsCapabilities = Pick<
  PerformanceCapabilities,
  | "physicalCores"
  | "logicalProcessors"
  | "availableParallelism"
  | "recommendedThreads"
  | "physicalCountReliable"
  | "maximumThreads"
>;

export interface PerformanceSettingsProps {
  capabilities: PerformanceSettingsCapabilities;
  mode: "auto" | "manual";
  configuredThreads: number;
  activeThreads: number | null;
  processing: boolean;
  nativeJobAvailable: boolean;
  memorySuggestedThreads?: number | null;
  onThreadsChange: (threads: number) => void;
  onRestoreAuto: () => void;
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function normalizePerformanceThreadInput(
  input: string | number,
  maximumThreads: number,
): number | null {
  const value = typeof input === "number" ? input : Number(input.trim());
  if (!Number.isFinite(value) || (typeof input === "string" && input.trim() === "")) return null;
  return clampInteger(value, 1, Math.max(1, Math.floor(maximumThreads)));
}

export function PerformanceSettings({
  capabilities,
  mode,
  configuredThreads,
  activeThreads,
  processing,
  nativeJobAvailable,
  memorySuggestedThreads = null,
  onThreadsChange,
  onRestoreAuto,
}: PerformanceSettingsProps) {
  const { t, number } = useI18n();
  const headingId = useId();
  const helperId = useId();
  const groupLabelId = useId();
  const rangeId = useId();
  const numberId = useId();
  const skipNextNumberBlurRef = useRef(false);
  const maximumThreads = Math.max(1, Math.floor(capabilities.maximumThreads));
  const recommendedThreads = clampInteger(capabilities.recommendedThreads, 1, maximumThreads);
  const selectedThreads = clampInteger(configuredThreads, 1, maximumThreads);
  const normalizedActiveThreads = activeThreads === null
    ? null
    : Math.max(1, Math.round(activeThreads));
  const reservedPhysicalCores = Math.max(
    0,
    Math.floor(capabilities.physicalCores) - Math.min(selectedThreads, Math.floor(capabilities.physicalCores)),
  );
  const [numberDraft, setNumberDraft] = useState(String(selectedThreads));
  const [numberInputFocused, setNumberInputFocused] = useState(false);
  const progress = maximumThreads === 1
    ? 100
    : ((selectedThreads - 1) / (maximumThreads - 1)) * 100;
  const exceedsRecommended = mode === "manual" && selectedThreads > recommendedThreads;
  const exceedsMemorySuggestion = memorySuggestedThreads !== null
    && selectedThreads > Math.max(1, Math.floor(memorySuggestedThreads));

  useEffect(() => {
    if (!numberInputFocused) setNumberDraft(String(selectedThreads));
  }, [numberInputFocused, selectedThreads]);

  const cancelNumberInput = () => {
    setNumberInputFocused(false);
    setNumberDraft(String(selectedThreads));
  };

  const commitNumberInput = () => {
    setNumberInputFocused(false);
    const nextThreads = normalizePerformanceThreadInput(numberDraft, maximumThreads);
    if (nextThreads === null) {
      setNumberDraft(String(selectedThreads));
      return;
    }
    setNumberDraft(String(nextThreads));
    onThreadsChange(nextThreads);
  };

  const updateFromRange = (value: number) => {
    const nextThreads = normalizePerformanceThreadInput(value, maximumThreads);
    if (nextThreads === null) return;
    setNumberDraft(String(nextThreads));
    onThreadsChange(nextThreads);
  };

  const restoreAuto = () => {
    setNumberInputFocused(false);
    setNumberDraft(String(recommendedThreads));
    onRestoreAuto();
  };

  return (
    <section className="performance-settings" aria-labelledby={headingId} data-processing={processing || undefined}>
      <header className="performance-settings__header">
        <span>
          <strong id={headingId}>{t("performance.title")}</strong>
          <small>{t("performance.scope")}</small>
        </span>
        <span className={`performance-settings__mode performance-settings__mode--${mode}`}>
          {t(mode === "auto" ? "performance.mode.auto" : "performance.mode.manual")}
        </span>
      </header>

      <p id={helperId} className="performance-settings__helper">
        {t("performance.helper")}
      </p>

      <p className="performance-settings__backend" role="note">
        {t(nativeJobAvailable ? "performance.backend.ready" : "performance.backend.pending")}
      </p>

      <div className="performance-settings__hardware">
        <span>
          {t(
            capabilities.physicalCountReliable
              ? "performance.hardware.detected"
              : "performance.hardware.estimated",
            {
              physical: number(capabilities.physicalCores),
              logical: number(capabilities.logicalProcessors),
            },
          )}
        </span>
        {capabilities.availableParallelism < capabilities.logicalProcessors ? (
          <small>{t("performance.hardware.processLimit", {
            count: number(capabilities.availableParallelism),
          })}</small>
        ) : null}
      </div>

      <div
        className="performance-settings__controls"
        role="group"
        aria-labelledby={groupLabelId}
        aria-describedby={helperId}
      >
        <div className="performance-settings__range-label">
          <label id={groupLabelId} htmlFor={rangeId}>{t("performance.selectThreads")}</label>
          <output htmlFor={rangeId}>{t("performance.threadValue", { count: number(selectedThreads) })}</output>
        </div>
        <input
          id={rangeId}
          className="performance-settings__range"
          type="range"
          min={1}
          max={maximumThreads}
          step={1}
          value={selectedThreads}
          aria-valuetext={t("performance.threadAriaValue", { count: number(selectedThreads) })}
          style={{ "--performance-range-progress": `${progress}%` } as CSSProperties}
          onChange={(event) => updateFromRange(event.currentTarget.valueAsNumber)}
        />

        <label className="performance-settings__number" htmlFor={numberId}>
          <span>{t("performance.exactThreads")}</span>
          <span className="performance-settings__number-input">
            <input
              id={numberId}
              type="number"
              inputMode="numeric"
              min={1}
              max={maximumThreads}
              step={1}
              value={numberDraft}
              aria-describedby={helperId}
              onFocus={() => {
                skipNextNumberBlurRef.current = false;
                setNumberInputFocused(true);
              }}
              onChange={(event) => setNumberDraft(event.currentTarget.value)}
              onBlur={() => {
                if (skipNextNumberBlurRef.current) {
                  skipNextNumberBlurRef.current = false;
                  return;
                }
                commitNumberInput();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  skipNextNumberBlurRef.current = true;
                  cancelNumberInput();
                  event.currentTarget.blur();
                }
              }}
            />
            <span aria-hidden="true">{t("performance.threadUnit")}</span>
          </span>
        </label>
      </div>

      <dl className="performance-settings__recommendations">
        <div>
          <dt>{t("performance.autoRecommendation")}</dt>
          <dd>{t("performance.autoRecommendationValue", { count: number(recommendedThreads) })}</dd>
        </div>
        {memorySuggestedThreads !== null ? (
          <div>
            <dt>{t("performance.memoryRecommendation")}</dt>
            <dd>{t("performance.threadValue", {
              count: number(Math.max(1, Math.floor(memorySuggestedThreads))),
            })}</dd>
          </div>
        ) : null}
      </dl>

      {exceedsRecommended || exceedsMemorySuggestion ? (
        <p className="performance-settings__warning">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {exceedsMemorySuggestion
              ? t(nativeJobAvailable
                ? "performance.warning.memory"
                : "performance.warning.memoryPending")
              : t(nativeJobAvailable
                ? "performance.warning.recommended"
                : "performance.warning.recommendedPending")}
          </span>
        </p>
      ) : null}

      <div className="performance-settings__status" role="status" aria-live="polite" aria-atomic="true">
        {processing && normalizedActiveThreads !== null ? (
          <>
            <span>{t("performance.status.currentTask", { count: number(normalizedActiveThreads) })}</span>
            <small>{t("performance.status.appliesNext")}</small>
          </>
        ) : processing && !nativeJobAvailable ? (
          <>
            <span>{t("performance.status.webWorkerCurrent")}</span>
          </>
        ) : (
          <span>{t("performance.status.idle")}</span>
        )}
      </div>

      <div className="performance-settings__readout">
        {processing && normalizedActiveThreads !== null ? (
          <span>{t("performance.status.nextTask", { count: number(selectedThreads) })}</span>
        ) : processing && !nativeJobAvailable ? (
          <span>{t("performance.status.savedNative", { count: number(selectedThreads) })}</span>
        ) : (
          <span>{t("performance.status.configured", { count: number(selectedThreads) })}</span>
        )}
        <span>
          {t(
            capabilities.physicalCountReliable
              ? "performance.status.reserved"
              : "performance.status.reservedEstimated",
            { count: number(reservedPhysicalCores) },
          )}
        </span>
      </div>

      <button
        type="button"
        className="performance-settings__restore"
        disabled={mode === "auto" && selectedThreads === recommendedThreads}
        onClick={restoreAuto}
      >
        {t("performance.restoreAuto")}
      </button>
    </section>
  );
}
