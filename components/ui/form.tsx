"use client";

import type { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode } from "react";

/* ── Input ── */
type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  className?: string;
};

export function Input({ className, ...rest }: InputProps) {
  return <input className={`ui-input ${className ?? ""}`} {...rest} />;
}

/* ── Textarea ── */
type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  className?: string;
};

export function Textarea({ className, ...rest }: TextareaProps) {
  return <textarea className={`ui-textarea ${className ?? ""}`} {...rest} />;
}

/* ── Select ── */
type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  className?: string;
  children: ReactNode;
};

export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={`ui-select ${className ?? ""}`} {...rest}>
      {children}
    </select>
  );
}

/* ── Toggle ── */
export function Toggle({
  checked,
  onChange,
  className,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`ui-toggle ${className ?? ""}`}
      data-ui="toggle"
      data-checked={checked ? "" : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle-knob" />
    </button>
  );
}

/* ── Slider (param row with label + value display) ── */
export function Slider({
  label,
  value,
  displayValue,
  hint,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  displayValue?: string;
  hint?: string;
}) {
  return (
    <div className={`ui-slider-row ${className ?? ""}`}>
      <span className="ui-slider-label">{label}</span>
      <input type="range" className="ui-slider" data-ui="slider" value={value} {...rest} />
      {displayValue !== undefined && <span className="ui-slider-value">{displayValue}</span>}
      {hint && <span className="ui-slider-hint">{hint}</span>}
    </div>
  );
}

/* ── Avatar Upload ── */
export function AvatarUpload({
  src,
  onClick,
  className,
}: {
  src?: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button type="button" className={`ui-avatar-upload ${className ?? ""}`} onClick={onClick}>
      {src ? (
        <img src={src} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} />
      ) : (
        <span className="ui-avatar-upload-placeholder">+</span>
      )}
      <span className="ui-avatar-upload-overlay">更换</span>
    </button>
  );
}

/* ── Color Input ── */
export function ColorInput({
  value,
  onChange,
  label,
  className,
}: {
  value: string;
  onChange: (color: string) => void;
  label?: string;
  className?: string;
}) {
  return (
    <label className={`ui-color-input ${className ?? ""}`}>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {label && <span>{label}</span>}
    </label>
  );
}
