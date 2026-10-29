"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Facet } from "@/lib/post-facets";
import { IconClose } from "./editor-icons";

/**
 * 分类 / 标签的「芯片 + 自动补全」输入。
 *
 * 为什么不是两个普通文本框：
 *   - 旧实现是「逗号分隔的字符串」，用户看不出自己到底加了几个；
 *   - 分类与标签都是**已有数据**，应该能直接选，而不是默写；
 *   - 删除必须是一次明确动作（点 × 或退格），而不是靠删逗号猜边界。
 *
 * 候选来自 lib/post-facets（真实内容），组件本身不认识任何业务词。
 *
 * 键盘：↑↓ 移动、Enter 选中或创建、Esc 关闭、Backspace 空输入时删最后一个。
 * 可访问性：输入框是 combobox，候选项是 listbox/option，焦点始终留在输入框，
 * 用 aria-activedescendant 指过去 —— 这样中文输入法不会被抢焦点打断。
 */
export function TokenField({
  id, label, values, suggestions, placeholder, hint, max = 20, onChange,
}: {
  id?: string;
  label: string;
  values: string[];
  suggestions: Facet[];
  placeholder?: string;
  hint?: string;
  max?: number;
  onChange: (next: string[]) => void;
}) {
  const autoId = useId();
  const fieldId = id ?? "token-" + autoId;
  const listId = fieldId + "-list";
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const atMax = values.length >= max;

  const options = useMemo(() => {
    const seen = new Set(values);
    const q = query.trim().toLowerCase();
    const out = suggestions
      .filter((s) => !seen.has(s.name))
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .slice(0, 8);
    // 输入了站内还没有的词时，仍给一条「创建」出口 —— 否则用户会以为不能新建
    const canCreate = q.length > 0 && !suggestions.some((s) => s.name.toLowerCase() === q) && !seen.has(query.trim());
    return { list: out, canCreate };
  }, [suggestions, values, query]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); }, []);

  function add(name: string) {
    const clean = name.trim().replace(/[,，]/g, "");
    if (!clean || atMax) return;
    if (values.some((v) => v.toLowerCase() === clean.toLowerCase())) {
      setQuery("");
      setOpen(false);
      return;
    }
    onChange([...values, clean]);
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  }

  function remove(name: string) {
    onChange(values.filter((v) => v !== name));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // 中文输入法组字期间的按键一律不拦：否则回车确认候选词会被当成"创建标签"
    if (e.nativeEvent.isComposing) return;
    const total = options.list.length + (options.canCreate ? 1 : 0);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (total ? (i + 1) % total : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (total ? (i - 1 + total) % total : 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && active < options.list.length && options.list[active]) add(options.list[active].name);
      else if (query.trim()) add(query);
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if ((e.key === "," || e.key === "，") && query.trim()) {
      e.preventDefault();
      add(query);
      return;
    }
    if (e.key === "Backspace" && !query && values.length) {
      remove(values[values.length - 1]);
    }
  }

  return (
    <div className="editor-field">
      <label className="editor-field-label" htmlFor={fieldId}>
        <span>{label}</span>
        <span className="editor-field-count">{values.length}/{max}</span>
      </label>
      <div className="editor-token-wrap" ref={wrapRef}>
        <div
          className={"editor-token-field" + (open ? " is-open" : "") + (atMax ? " is-max" : "")}
          onClick={() => inputRef.current?.focus()}
        >
          {values.map((v) => (
            <span className="editor-token" key={v}>
              {v}
              <button
                type="button"
                aria-label={"移除" + label + " " + v}
                onClick={(e) => { e.stopPropagation(); remove(v); }}
              >
                <IconClose size={12} />
              </button>
            </span>
          ))}
          {!atMax ? (
            <input
              id={fieldId}
              ref={inputRef}
              className="editor-token-input"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                !open ? undefined
                  : active < options.list.length && options.list[active] ? listId + "-" + active
                  : options.canCreate ? listId + "-create"
                  : undefined
              }
              value={query}
              placeholder={values.length ? "" : placeholder}
              onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => {
                if (blurTimer.current) clearTimeout(blurTimer.current);
                setOpen(true);
              }}
              onBlur={() => {
                // 延迟关闭：让候选项的 mousedown 先落地
                blurTimer.current = setTimeout(() => {
                  setOpen(false);
                  if (query.trim()) add(query);
                }, 140);
              }}
              onKeyDown={onKeyDown}
              autoComplete="off"
            />
          ) : null}
        </div>

        {open && (options.list.length || options.canCreate) ? (
          <ul className="editor-suggest" id={listId} role="listbox" aria-label={label + "候选项"}>
            {options.list.map((o, i) => (
              <li
                key={o.name}
                id={listId + "-" + i}
                role="option"
                aria-selected={i === active}
                className={i === active ? "is-active" : undefined}
                // mousedown 而不是 click：blur 会先触发，click 来不及选中
                onMouseDown={(e) => { e.preventDefault(); add(o.name); }}
                onMouseEnter={() => setActive(i)}
              >
                <span>{o.name}</span>
                <span className="editor-suggest-count">{o.count}</span>
              </li>
            ))}
            {options.canCreate ? (
              <li
                id={listId + "-create"}
                role="option"
                aria-selected={active === options.list.length}
                className={"is-create" + (active === options.list.length ? " is-active" : "")}
                onMouseDown={(e) => { e.preventDefault(); add(query); }}
                onMouseEnter={() => setActive(options.list.length)}
              >
                <span>创建「{query.trim()}」</span>
                <span className="editor-suggest-count">新建</span>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>

      {hint ? <span className="editor-field-hint">{hint}</span> : null}
    </div>
  );
}
