import { useId } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  "aria-label"?: string;
}

/** Nocturne `.seg` segmented control on native radio inputs. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ...aria
}: SegmentedProps<T>) {
  const name = useId();
  return (
    <div className="seg" role="radiogroup" aria-label={aria["aria-label"]}>
      {options.map((opt) => (
        <label className="seg-opt" key={opt.value}>
          <input
            type="radio"
            name={name}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}
