process.env.BLOG_TEST_NEXT_STUBS = "1";
// 通过 register() 挂载解析钩子（--experimental-loader 已废弃）
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./loader.mjs", pathToFileURL(import.meta.dirname + "/"));
