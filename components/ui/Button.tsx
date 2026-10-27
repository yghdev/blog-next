"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ComponentProps } from "react";
import Link from "next/link";

/**
 * 按钮（阶段 01-A 追加型基础组件）。
 *
 * 为什么不复用 .btn 类而再包一层：.btn 系列已经是全站视觉事实标准，这一层
 * **只做语义收敛**（variant/size 的合法组合 + 一致的 disabled/loading 行为），
 * 渲染结果仍是同一批类名，所以现有页面看起来不会有任何变化。
 *
 * 硬约束（docs/design-system.md B 端门禁）：
 *   1. 一个操作区最多一个 primary —— 组件无法运行时校验，但只暴露
 *      primary/secondary/danger/ghost 四档，逼调用方想清楚。
 *   2. danger 是"浅底深字 + 语义色边框"，绝不做主色铺红。
 *   3. loading 时禁用点击，但不改变宽度（只加一个转圈），否则批量操作
 *      点下去按钮会横向跳一下。
 */

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "md" | "sm";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn btn-primary",
  secondary: "btn",
  danger: "btn btn-danger",
  ghost: "btn btn-ghost",
};

function classes(variant: ButtonVariant, size: ButtonSize, extra?: string) {
  return [VARIANT_CLASS[variant], size === "sm" ? "btn-sm" : "", extra ?? ""].filter(Boolean).join(" ");
}

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
  className?: string;
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  children,
  className,
  disabled,
  type = "button",
  ...rest
}: CommonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      type={type}
      className={classes(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

/** 跳转型按钮：外观一致，语义是链接（可新标签打开、可被爬虫跟随） */
export function ButtonLink({
  href, variant = "secondary", size = "md", children, className, ...rest
}: CommonProps & { href: string } & Omit<ComponentProps<typeof Link>, "href" | "className" | "children">) {
  return (
    <Link {...rest} href={href} className={classes(variant, size, className)}>
      {children}
    </Link>
  );
}

/** 行内小转圈：用 currentColor，跟随按钮语义色自动变色 */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 12, height: 12, flexShrink: 0,
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "ui-spin .7s linear infinite",
      }}
    />
  );
}
