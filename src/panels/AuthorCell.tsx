import { authorInitials, authorLabel, authorShade } from "../author";
import { t } from "../i18n";

/** 그래프 행의 작성자: 머리글자 동그라미, 마우스를 올리면 "이름 <이메일>" */
export function AuthorCell({ name, email }: { name: string; email: string }) {
  const label = authorLabel(name, email) || t("작성자 정보 없음");
  return (
    <div className={`gauthor gauthor-${authorShade(name, email)}`} title={label} aria-label={label} role="img">
      {authorInitials(name, email)}
    </div>
  );
}
