import type { MouseEventHandler, ReactNode } from "react";
import "./components.css";

export type ButtonVariant = "primary" | "ghost" | "hero";

export function Button({
  variant = "primary",
  onClick,
  children,
  type = "button",
  disabled,
}: {
  variant?: ButtonVariant;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
