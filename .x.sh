#!/usr/bin/env bash
cd /mnt/e/agentWork/server-management/blog-next
git add -A 2>/dev/null
git commit -m "chore: 清理临时脚本" 2>&1 | tail -2
echo '--- status ---'
git status --porcelain
echo '--- log ---'
git log --oneline -2
