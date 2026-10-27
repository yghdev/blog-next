/**
 * 浏览器测试的环境前置检查。
 *
 * 为什么需要这个文件：浏览器类测试依赖两个**与代码无关**的环境条件，
 * 缺任何一个都会让整套测试红，而报错信息不指向真实原因。
 *
 *   1. Chromium 的系统动态库：libnspr4 / libnss3 / libasound2。
 *      缺失时报 `error while loading shared libraries: libnspr4.so`，
 *      错误发生在 launch 阶段，看上去像"测试框架坏了"。
 *
 *   2. 中文字体（CJK）。这个更隐蔽：**不报错，而是让断言算错**。
 *      `.ui-tab` 只设了 `min-height: var(--tap)`（44px），**宽度由文字撑开**。
 *      没有中文字体时，"文章"两字回退到 DejaVu 之类的西文字体，实测宽度
 *      43.73px，触发 `width < 44` 的热区断言失败；而日志里 `Math.round`
 *      又把 43.73 显示成 44，于是报出"44×44 却小于 44"这种自相矛盾的信息。
 *
 *      装 Noto CJK 后同一控件实测 54×44，通过。
 *
 * 所以这里做的是**把前提显式化**：缺字体时直接给出"该装什么"的报错，
 * 而不是让下一个人在"44 < 44"的断言里反复排查。
 */
import { execFileSync } from "node:child_process";

/** 用 fc-list 统计中文字体数量；返回 null 表示无法判定（没有 fontconfig）。 */
function countCjkFonts() {
  try {
    const out = execFileSync("fc-list", [":lang=zh"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter((x) => x.trim()).length;
  } catch {
    // fc-list 不存在（Windows / macOS / 精简容器）—— 无法判定，不阻塞。
    return null;
  }
}

/**
 * 断言存在中文字体。缺字体时抛出**可执行**的错误信息。
 *
 * 关闭方式：设置 SKIP_FONT_CHECK=1（仅供明确知道自己环境的人临时绕过）。
 * **CI 下该开关无效** —— 否则"跳过检查"会变成"让不稳定的断言继续算错"，
 * 等于把这道防线自己拆掉。
 */
export function assertCjkFonts() {
  const bypassRequested = process.env.SKIP_FONT_CHECK === "1";
  const inCi = Boolean(process.env.CI);

  if (bypassRequested && inCi) {
    throw new Error(
      "SKIP_FONT_CHECK=1 在 CI 下被拒绝：CI 必须安装中文字体（见 .github/workflows/ci.yml）。" +
        "跳过检查会让基于文字宽度的断言以错误原因失败，掩盖真实问题。",
    );
  }
  if (bypassRequested) {
    console.log("INFO prereqs: SKIP_FONT_CHECK=1，跳过中文字体检查");
    return;
  }

  const n = countCjkFonts();
  if (n === null) {
    console.log("INFO prereqs: 未找到 fc-list（非 Linux 或未安装 fontconfig），跳过中文字体检查");
    return;
  }
  if (n > 0) return;

  throw new Error(
    [
      "浏览器测试前置条件缺失：系统里没有任何中文字体（`fc-list :lang=zh` 返回 0 条）。",
      "",
      "这会让中文控件的宽度按回退字体测量，导致热区断言算出 43.73px < 44 而失败，",
      "而日志取整后又显示成 44 —— 报错是 '44×44 却小于 44'，与真实原因完全无关。",
      "",
      "修复（任选其一）：",
      "  Ubuntu/Debian:  sudo apt-get install -y fonts-noto-cjk",
      "  Fedora/RHEL:    sudo dnf install -y google-noto-sans-cjk-ttc-fonts",
      "  macOS:          系统自带中文字体，若报此错请检查 FONTCONFIG_FILE 是否被覆盖",
      "",
      "确认已生效:  fc-match \"sans-serif:lang=zh-cn\"   应返回某个中文等宽/黑体，而不是 DejaVu",
      "",
      "确实需要绕过时设 SKIP_FONT_CHECK=1（会导致基于文字宽度的断言不可信）。",
    ].join("\n"),
  );
}

/**
 * 把 Chromium 启动失败翻译成可执行的提示。
 *
 * 原始报错是一大坨 Playwright 日志，其中真正有用的只有最后那行
 * `error while loading shared libraries: xxx`。
 */
export async function launchChromium(chromium, options = {}) {
  assertCjkFonts();

  try {
    return await chromium.launch(options);
  } catch (error) {
    const text = String(error && error.message ? error.message : error);
    const missing = text.match(/error while loading shared libraries: ([^:\s]+)/);
    if (!missing) throw error;

    throw new Error(
      [
        "浏览器测试前置条件缺失：Chromium 无法启动，缺少系统库 " + missing[1] + "。",
        "",
        "修复：npx playwright install --with-deps chromium",
        "（该命令会装上 libnspr4 / libnss3 / libasound2 等 Chromium 依赖；",
        "  需要 sudo 权限。CI 里由 ci.yml 的同名步骤覆盖。）",
        "",
        "原始错误：",
        text,
      ].join("\n"),
    );
  }
}
