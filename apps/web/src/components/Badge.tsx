import "./components.css";

export type BadgeGrade = "watch" | "warning";

const GRADE_LABEL: Record<BadgeGrade, string> = {
  watch: "주의보",
  warning: "경보",
};

export function Badge({ grade }: { grade: BadgeGrade }) {
  return (
    <span className={`badge badge-${grade}`}>
      <span className="badge-dot" aria-hidden="true" />
      {GRADE_LABEL[grade]}
    </span>
  );
}
