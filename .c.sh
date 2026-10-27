#!/usr/bin/env bash
cd /mnt/e/agentWork/server-management/blog-next
git add -A
git commit -m "fix(storage): 收窄 keyFromUrl 参数类型，补齐测试配置字段

构建期的 tsc 会检查 tests/，而 npm test 用 strip-types 不检查 ——
所以 'pathStyle 必填' 这个改动只在 next build 时暴露。
keyFromUrl 实际只用 cdnDomain，收窄成 { cdnDomain: string } 后
调用方与测试都不需要构造完整配置。" 2>&1 | tail -3
git log --oneline -2
git status --porcelain
