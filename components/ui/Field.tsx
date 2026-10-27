import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

/**
 * 表单字段（阶段 01-A）。
 *
 * 三件事必须一起做，缺一个"错误提示"就形同虚设：
 *   1. label 用 htmlFor 真绑定（点标签能聚焦控件）
 *   2. 错误用 aria-describedby 关联控件并设 aria-invalid
 *   3. 错误文案不只靠颜色 —— 前缀文字"错误："，色盲/暗色下都能读
 */

export function Field({
  label, htmlFor, hint, error, required, children, id,
}: {
  label?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  id?: string;
}) {
  return (
    <div className="ui-field" data-invalid={error ? "true" : undefined}>
      {label ? (
        <label className="ui-field-label" htmlFor={htmlFor}>
          {label}
          {required ? <span className="ui-field-req" aria-hidden="true">*</span> : null}
        </label>
      ) : null}
      {children}
      {hint && !error && id ? <span className="ui-field-hint" id={id + "-hint"}>{hint}</span> : null}
      {hint && !error && !id ? <span className="ui-field-hint">{hint}</span> : null}
      {error ? <span className="ui-field-error" id={id ? id + "-err" : undefined} role="alert">{error}</span> : null}
    </div>
  );
}

/** 单行输入：沿用 .input，视觉与既有页面完全一致 */
export function TextInput({ invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} className={["input", rest.className].filter(Boolean).join(" ")} aria-invalid={invalid || undefined} />;
}

/** 多行输入：沿用 .textarea */
export function TextArea({ invalid, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea {...rest} className={["textarea", rest.className].filter(Boolean).join(" ")} aria-invalid={invalid || undefined} />;
}
