import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { imageStyleOptions, type ImageStyle } from "./image-styles";

export function ImageStylePicker({
  value,
  onChange,
  label = "绘画风格预设",
  inherited,
  fallback,
  disabled = false,
}: {
  value: string;
  onChange: (id: string, preset?: ImageStyle) => void;
  label?: string;
  inherited?: string;
  fallback?: ImageStyle;
  disabled?: boolean;
}) {
  const prefs = useLiveQuery(() => db.preferences.get("preferences"), []);
  const options = imageStyleOptions(prefs?.imageStylePresets);
  if (fallback && !options.some((p) => p.id === fallback.id))
    options.push(fallback);
  return (
    <label className="field image-style-picker">
      {label}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) =>
          onChange(
            e.target.value,
            options.find((p) => p.id === e.target.value),
          )
        }
      >
        {inherited && <option value="">{inherited}</option>}
        {value &&
          value !== "custom-only" &&
          !options.some((p) => p.id === value) && (
            <option value={value}>已保存的专用画风</option>
          )}
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="custom-only">仅使用自定义画风</option>
      </select>
    </label>
  );
}
