#!/usr/bin/env bash
cd /mnt/e/agentWork/server-management/blog-next
git add -A
git commit -m "chore: 清理临时脚本" 2>&1 | tail -2
git status --porcelain
echo '--- 版本戳重打 ---'
node scripts/stamp-version.mjs
