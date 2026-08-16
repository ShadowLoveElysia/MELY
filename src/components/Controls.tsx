import { Check } from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  type ChangeEvent,
  type ReactNode,
} from "react";

const FieldLabelContext = createContext<string | undefined>(undefined);

interface FieldProps {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, className, children }: FieldProps) {
  const labelId = useId();
  return (
    <div className={className ? `field-row ${className}` : "field-row"}>
      <span id={labelId}>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
      <FieldLabelContext.Provider value={labelId}>
        <div className="field-row__control">{children}</div>
      </FieldLabelContext.Provider>
    </div>
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
  const inputId = useId();
  const fieldLabelId = useContext(FieldLabelContext);
  const percentage = ((value - min) / (max - min)) * 100;
  const commit = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) return;
    onChange(Math.min(max, Math.max(min, nextValue)));
  };

  return (
    <div className="slider-control">
      <input
        type="range"
        aria-labelledby={fieldLabelId}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--range-progress": `${percentage}%` } as React.CSSProperties}
        onChange={(event) => commit(Number(event.target.value))}
      />
      {editable ? (
        <label className="slider-number" htmlFor={inputId}>
          <input
            id={inputId}
            aria-labelledby={fieldLabelId}
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
  const fieldLabelId = useContext(FieldLabelContext);
  return (
    <select
      aria-labelledby={fieldLabelId}
      value={value}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
    >
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
  const fieldLabelId = useContext(FieldLabelContext);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={fieldLabelId}
      title={label}
      className={`toggle ${checked ? "toggle--checked" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span>{checked ? <Check size={11} strokeWidth={3} /> : null}</span>
    </button>
  );
}
