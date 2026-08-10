import { Check } from "lucide-react";
import type { ChangeEvent, ReactNode } from "react";

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="field-row">
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </label>
  );
}

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  editable?: boolean;
  onChange: (value: number) => void;
}

export function Slider({ value, min, max, step = 1, unit = "", editable = false, onChange }: SliderProps) {
  const percentage = ((value - min) / (max - min)) * 100;
  const commit = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) return;
    onChange(Math.min(max, Math.max(min, nextValue)));
  };

  return (
    <div className="slider-control">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--range-progress": `${percentage}%` } as React.CSSProperties}
        onChange={(event) => commit(Number(event.target.value))}
      />
      {editable ? (
        <label className="slider-number">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => commit(event.currentTarget.valueAsNumber)}
          />
          {unit ? <span>{unit}</span> : null}
        </label>
      ) : (
        <output>
          {value}
          {unit}
        </output>
      )}
    </div>
  );
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}

export function Select({ value, onChange, children }: SelectProps) {
  return (
    <select value={value} onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}>
      {children}
    </select>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`toggle ${checked ? "toggle--checked" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span>{checked ? <Check size={11} strokeWidth={3} /> : null}</span>
    </button>
  );
}
