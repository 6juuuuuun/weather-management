import type { ReactNode } from "react";
import "./components.css";

export function Modal({
  title,
  desc,
  onClose,
  footer,
  children,
}: {
  title: string;
  desc?: string;
  onClose: () => void;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-header">
          <div>
            <h2 id="modal-title" className="modal-title">
              {title}
            </h2>
            {desc && <p className="modal-desc">{desc}</p>}
          </div>
          <button type="button" className="modal-close" aria-label="닫기" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
